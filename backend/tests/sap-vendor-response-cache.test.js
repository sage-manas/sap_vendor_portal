// Issue #69: vendorPoGrnDisplay/vendorMiroDisplay answer for a vendor's
// entire order/MIRO history — 22-84s and ~0.5MB for 173 orders, per the
// driver's own documented sandbox timings — and used to be called once per
// ASN/invoice watch, per job attempt. Twenty open shipments for one vendor
// on a one-minute cadence meant twenty of these calls, not one. Both methods
// now share one in-flight/short-lived response per vendor code.
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');

/**
 * Same http.request stub as tests/sap-po-company-code.test.js, extended to
 * count calls and to let a test control per-call success/failure.
 */
const mockHttpRequest = (respond) => {
  const http = require('http');
  const original = http.request;
  let calls = 0;
  http.request = (url, options, callback) => {
    calls += 1;
    const thisCall = calls;
    const req = {
      write: () => {},
      end: () => {
        const { status = 200, body = '[]' } = respond(thisCall) || {};
        callback({
          statusCode: status,
          statusMessage: status === 200 ? 'OK' : 'Error',
          on: (event, handler) => {
            if (event === 'data') handler(Buffer.from(body));
            if (event === 'end') handler();
          },
        });
      },
      on: () => {},
      destroy: () => {},
    };
    return req;
  };
  return {
    callCount: () => calls,
    restore: () => { http.request = original; },
  };
};

const poRow = (poNumber) => ({
  PO_NUMBER: poNumber, PO_DATE: '01.01.2026', BUYER_NAME: 'Buyer',
  SHIP_TO_CITY: 'Pune', SHIP_TO_STATE: 'MH', COM_CODE: '1000', CURRENCY: 'INR',
  PO_LINE_ITEMS: [],
});

const driverFor = (config = {}) => createS4ODataDriver({
  config: { baseUrl: 'http://sandbox', sapClient: '800', companyCode: '1000', ...config },
  secrets: {},
});

describe('vendorPoGrnDisplay response cache (issue #69)', () => {
  it('N concurrent calls for the same vendor produce one SAP call, not N', async () => {
    const mock = mockHttpRequest(() => ({ status: 200, body: JSON.stringify([poRow('4500000001')]) }));
    const driver = driverFor();
    try {
      const results = await Promise.all([
        driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
        driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
        driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
      ]);

      expect(mock.callCount()).toBe(1);
      expect(results.every((r) => r.data.orders[0].poNumber === '4500000001')).toBe(true);
    } finally { mock.restore(); }
  });

  it('a sequential re-call within the cache window reuses the same answer', async () => {
    const mock = mockHttpRequest(() => ({ status: 200, body: JSON.stringify([poRow('4500000001')]) }));
    const driver = driverFor({ vendorResponseCacheMs: 60_000 });
    try {
      await driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
      await driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });

      expect(mock.callCount()).toBe(1);
    } finally { mock.restore(); }
  });

  it('does not share the cache across different vendors', async () => {
    const mock = mockHttpRequest((call) => ({ status: 200, body: JSON.stringify([poRow(`450000000${call}`)]) }));
    const driver = driverFor();
    try {
      const [a, b] = await Promise.all([
        driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
        driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0002' } }),
      ]);

      expect(mock.callCount()).toBe(2);
      expect(a.data.orders[0].poNumber).not.toBe(b.data.orders[0].poNumber);
    } finally { mock.restore(); }
  });

  it('expires after the configured window, so a real change still surfaces', async () => {
    const mock = mockHttpRequest(() => ({ status: 200, body: JSON.stringify([poRow('4500000001')]) }));
    const driver = driverFor({ vendorResponseCacheMs: 10 });
    try {
      await driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });

      expect(mock.callCount()).toBe(2);
    } finally { mock.restore(); }
  });

  it('does not cache a failed call — the next call retries immediately', async () => {
    const mock = mockHttpRequest((call) => (call === 1 ? { status: 500, body: '' } : { status: 200, body: JSON.stringify([poRow('4500000001')]) }));
    const driver = driverFor();
    try {
      await expect(driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } })).rejects.toThrow();
      const result = await driver.vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });

      expect(mock.callCount()).toBe(2);
      expect(result.data.orders[0].poNumber).toBe('4500000001');
    } finally { mock.restore(); }
  });
});

describe('vendorMiroDisplay response cache (issue #69)', () => {
  const miroRow = (docNo) => ({
    INV_DOC_NO: docNo, FISCAL_YEAR: '2026', DOC_TYPE: 'RE', DOC_DATE: '20260101',
    POST_DATE: '20260102', REFERENCE: '4500000001', COM_CODE: '1000', CURRENCY: 'INR',
    GROSS_AMOUNT: '1180', TAXABLE_AMOUNT: '1000', TAX_CODE: 'G1', PAYMENT_TERM: 'NET30', ITEM: [],
  });

  it('N concurrent calls for the same vendor produce one SAP call, not N', async () => {
    const mock = mockHttpRequest(() => ({ status: 200, body: JSON.stringify([miroRow('1900000001')]) }));
    const driver = driverFor();
    try {
      const results = await Promise.all([
        driver.vendorMiroDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
        driver.vendorMiroDisplay({ vendor: { sapVendorCode: 'VEN0001' } }),
      ]);

      expect(mock.callCount()).toBe(1);
      expect(results.every((r) => r.data.documents[0].miroDoc === '1900000001')).toBe(true);
    } finally { mock.restore(); }
  });
});
