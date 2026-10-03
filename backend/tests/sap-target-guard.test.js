const guard = require('../sap/networkGuard');
const { createS4ODataDriver, validateConfig } = require('../sap/drivers/s4odata.driver');

// 1.10 — the SAP gateway URL is configured by an operator and called from the
// portal's own network position. Pointed at 169.254.169.254 it would read the
// cloud's instance-metadata credentials; at 127.0.0.1 or 10.x, services that
// were never meant to be reachable from the internet. The portal refuses those
// targets at the moment it calls out, unless the host is on an explicit
// allow-list for an on-premises SAP.

const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

afterEach(() => {
  guard.resetResolver();
  delete process.env.SAP_ALLOWED_PRIVATE_HOSTS;
  delete global.fetch;
});

describe('assertSafeTarget', () => {
  const blocked = [
    ['loopback', 'http://127.0.0.1:8080/sap'],
    ['loopback, shorthand integer form', 'http://2130706433/sap'],
    ['loopback, hex octets', 'http://0x7f.1/sap'],
    ['IPv6 loopback', 'http://[::1]/sap'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['link-local', 'http://169.254.10.10/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6 metadata address', 'http://[::ffff:a9fe:a9fe]/'],
    ['10.0.0.0/8', 'https://10.1.2.3/'],
    ['172.16.0.0/12', 'https://172.20.0.5/'],
    ['192.168.0.0/16', 'https://192.168.1.10/'],
    ['carrier-grade NAT', 'https://100.64.0.1/'],
    ['"this network"', 'http://0.0.0.0/'],
    ['IPv6 unique-local, which holds the AWS IPv6 metadata address', 'http://[fd00:ec2::254]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['localhost by name', 'http://localhost:3000/'],
    ['localhost with a trailing dot', 'http://localhost./'],
  ];

  it.each(blocked)('refuses %s', async (_label, url) => {
    await expect(guard.assertSafeTarget(url)).rejects.toMatchObject({ code: 'sap_target_blocked' });
  });

  it('refuses a public-looking hostname that resolves to a private address', async () => {
    guard.setResolver(resolvesTo('10.0.0.7'));
    await expect(guard.assertSafeTarget('https://sap.attacker.example/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
  });

  it('refuses a hostname when ANY of its addresses is private', async () => {
    guard.setResolver(resolvesTo('203.0.113.9', '169.254.169.254'));
    await expect(guard.assertSafeTarget('https://sap.attacker.example/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
  });

  it('refuses a hostname that does not resolve, rather than guessing', async () => {
    guard.setResolver(async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); });
    await expect(guard.assertSafeTarget('https://nowhere.example/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
  });

  it('refuses a scheme other than http(s)', async () => {
    await expect(guard.assertSafeTarget('file:///etc/passwd')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    await expect(guard.assertSafeTarget('gopher://203.0.113.9/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
  });

  it('allows a public address, by literal and by name', async () => {
    await expect(guard.assertSafeTarget('http://103.206.131.27:8081/ZCL_ME48/vendor')).resolves.toBeDefined();
    guard.setResolver(resolvesTo('203.0.113.9'));
    await expect(guard.assertSafeTarget('https://s4.example.com/')).resolves.toBeDefined();
  });

  describe('SAP_ALLOWED_PRIVATE_HOSTS', () => {
    it('lets an on-premises SAP at a listed private address through', async () => {
      process.env.SAP_ALLOWED_PRIVATE_HOSTS = '10.20.0.15';
      await expect(guard.assertSafeTarget('https://10.20.0.15:44300/')).resolves.toBeDefined();
      await expect(guard.assertSafeTarget('https://10.20.0.16:44300/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    });

    it('accepts a CIDR range', async () => {
      process.env.SAP_ALLOWED_PRIVATE_HOSTS = '10.20.0.0/16, 192.168.50.0/24';
      await expect(guard.assertSafeTarget('https://10.20.99.1/')).resolves.toBeDefined();
      await expect(guard.assertSafeTarget('https://192.168.50.4/')).resolves.toBeDefined();
      await expect(guard.assertSafeTarget('https://10.21.0.1/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    });

    it('accepts an internal hostname, and then permits what that name resolves to', async () => {
      process.env.SAP_ALLOWED_PRIVATE_HOSTS = 'sap.corp.internal';
      guard.setResolver(resolvesTo('10.20.0.15'));
      await expect(guard.assertSafeTarget('https://sap.corp.internal/')).resolves.toBeDefined();
      await expect(guard.assertSafeTarget('https://other.corp.internal/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    });

    it('never opens the link-local / metadata range, whatever the list says', async () => {
      process.env.SAP_ALLOWED_PRIVATE_HOSTS = '169.254.169.254,169.254.0.0/16,0.0.0.0/0';
      await expect(guard.assertSafeTarget('http://169.254.169.254/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    });

    it('ignores a malformed entry rather than treating it as "allow everything"', async () => {
      process.env.SAP_ALLOWED_PRIVATE_HOSTS = '*, 10.0.0.0/99, ,';
      await expect(guard.assertSafeTarget('https://10.1.2.3/')).rejects.toMatchObject({ code: 'sap_target_blocked' });
    });
  });
});

describe('the S/4 driver, at request time', () => {
  const driverAt = (baseUrl) => createS4ODataDriver({ config: { baseUrl, sapClient: '800', companyCode: '1000' }, secrets: {} });

  it('does not issue the request to the metadata address', async () => {
    global.fetch = jest.fn(async () => { throw new Error('the request must never be sent'); });
    await expect(driverAt('http://169.254.169.254').vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } }))
      .rejects.toMatchObject({ code: 'sap_target_blocked' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not issue the GET-with-body request (MIRO display) to a private address either', async () => {
    const http = require('http');
    const spy = jest.spyOn(http, 'request');
    try {
      await expect(driverAt('http://10.0.0.5').vendorMiroDisplay({ vendor: { sapVendorCode: '1120250010' } }))
        .rejects.toMatchObject({ code: 'sap_target_blocked' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('does not follow a redirect from an allowed host into a private one', async () => {
    global.fetch = jest.fn(async (url, options) => {
      expect(options.redirect).toBe('manual');
      return { status: 302, statusText: 'Found', ok: false, headers: { get: () => 'http://169.254.169.254/' }, text: async () => '' };
    });
    await expect(driverAt('http://103.206.131.27:8081').vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } }))
      .rejects.toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('validateConfig — saving a connection', () => {
  const base = { sapClient: '100', companyCode: '1000' };

  it.each(['http://169.254.169.254', 'http://127.0.0.1:8000', 'https://10.0.0.5', 'http://localhost'])(
    'refuses a base URL of %s before it is ever saved', (baseUrl) => {
      const errors = validateConfig({ ...base, baseUrl }, { environment: 'sandbox' });
      expect(errors.baseUrl).toMatch(/private|internal|not allowed/i);
    },
  );

  it('accepts a private literal once it is on the allow-list', () => {
    process.env.SAP_ALLOWED_PRIVATE_HOSTS = '10.0.0.5';
    expect(validateConfig({ ...base, baseUrl: 'https://10.0.0.5' }, { environment: 'sandbox' })).toEqual({});
  });

  it('leaves a hostname to the request-time check', () => {
    expect(validateConfig({ ...base, baseUrl: 'https://s4.example.com' }, { environment: 'sandbox' })).toEqual({});
  });
});
