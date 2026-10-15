const request = require('supertest');
const buildTestApp = require('./testApp');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { realmFromRequest } = require('../utils/resolveClient');
const { registerVendor, seedClient, baseVendor, createTenantUser } = require('./helpers');
const { drainBackground } = require('../utils/background');
const logger = require('../utils/logger');

// PORTAL_TENANCY_MODE=account (ADR-0044): one address for every tenant. The
// account that signs in names its own workspace, so the hostname is not read;
// a tenant's branding and self-registration come from a `?workspace=<slug>`
// link. These suites pin what that mode decides, and that it decides nothing
// about who an account belongs to.

const app = buildTestApp();

const withEnv = async (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  try { return await fn(); } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
};

const inAccountMode = (fn, extra = {}) => withEnv({ PORTAL_TENANCY_MODE: 'account', ...extra }, fn);

describe('realm resolution under account tenancy', () => {
  const realm = (req) => inAccountMode(() => realmFromRequest(req));

  it('reads the workspace from the link, not from the hostname', async () => {
    expect(await realm({ headers: { host: 'vp.example.com' }, query: { workspace: 'northwind' } }))
      .toEqual({ slug: 'northwind', source: 'link' });
  });

  it('names no workspace without a link, however much the hostname looks like one', async () => {
    for (const host of ['northwind.vendorconnect.io', 'vp.example.com', 'localhost', '10.0.12.4']) {
      expect(await realm({ headers: { host }, query: {} })).toEqual({ slug: null, source: 'none' });
    }
    // A bare request object (no query at all) is not a crash.
    expect(await realm({ headers: { host: 'vp.example.com' } })).toEqual({ slug: null, source: 'none' });
  });

  it('does not let x-client-slug choose a workspace, in production or out of it', async () => {
    for (const NODE_ENV of ['test', 'production']) {
      expect(await inAccountMode(
        () => realmFromRequest({ headers: { host: 'localhost', 'x-client-slug': 'northwind' }, query: {} }),
        { NODE_ENV },
      )).toEqual({ slug: null, source: 'none' });
    }
  });

  it('normalises case and surrounding space', async () => {
    expect(await realm({ headers: {}, query: { workspace: '  Northwind ' } }))
      .toEqual({ slug: 'northwind', source: 'link' });
  });

  it.each([
    ['too short', 'a'],
    ['path traversal', '../admin'],
    ['a path', 'north/wind'],
    ['an empty value', ''],
    ['a leading hyphen', '-northwind'],
    ['an array (workspace=a&workspace=b)', ['northwind', 'contoso']],
    ['an object', { slug: 'northwind' }],
  ])('treats %s as no workspace', async (_label, value) => {
    expect(await realm({ headers: {}, query: { workspace: value } })).toEqual({ slug: null, source: 'none' });
  });

  it('leaves subdomain tenancy exactly as it was when the mode is unset or named explicitly', async () => {
    const req = { headers: { host: 'northwind.vendorconnect.io' } };
    expect(realmFromRequest(req)).toEqual({ slug: 'northwind', source: 'subdomain' });
    expect(await withEnv({ PORTAL_TENANCY_MODE: 'subdomain' }, () => realmFromRequest(req)))
      .toEqual({ slug: 'northwind', source: 'subdomain' });
  });
});

describe('GET /api/auth/workspace under account tenancy', () => {
  it('describes no workspace — and is not an error — when there is no link', async () => {
    const res = await inAccountMode(() => request(app).get('/api/auth/workspace').set('host', 'vp.example.com'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, workspace: null, tenancy: 'account' });
  });

  it('describes the tenant a link names', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });

    const res = await inAccountMode(() => request(app).get('/api/auth/workspace?workspace=northwind'));

    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({ slug: 'northwind', companyName: 'Northwind Traders' });
  });

  it('is not steered by a subdomain', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });

    const res = await inAccountMode(() => request(app).get('/api/auth/workspace').set('host', 'northwind.vp.example.com'));

    expect(res.body.workspace).toBeNull();
  });

  it('answers 404 for a link to a tenant that does not exist, and for a suspended one alike', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await withoutTenantScope(() => rawPrisma.client.updateMany({ where: { clientId: 'CLT-0002' }, data: { status: 'Suspended' } }));

    const unknown = await inAccountMode(() => request(app).get('/api/auth/workspace?workspace=nobody'));
    const suspended = await inAccountMode(() => request(app).get('/api/auth/workspace?workspace=northwind'));

    expect(unknown.status).toBe(404);
    expect(suspended.status).toBe(404);
    expect(suspended.body.error).toBe(unknown.body.error);
  });
});

describe('login under account tenancy', () => {
  it('signs a supplier in at the bare address, with no workspace link at all', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/login')
      .set('host', 'vp.example.com')
      .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password }));

    expect(res.status).toBe(200);
    expect(res.body.vendor.clientId).toBe('CLT-0002');
    // The sign-in screen is told whose workspace it just entered.
    expect(res.body.workspace).toMatchObject({ slug: 'northwind', companyName: 'Northwind Traders' });
  });

  it('signs tenant staff in the same way', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });
    const { user } = await createTenantUser({ clientId: 'CLT-0002', email: 'admin@northwind.example' });

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/login')
      .set('host', 'vp.example.com')
      .send({ vendorIdOrEmail: user.email, password: 'secret123' }));

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@northwind.example');
    expect(res.body.workspace).toMatchObject({ slug: 'northwind', companyName: 'Northwind Traders' });
  });

  it("puts an account in its own tenant even when it arrives through another tenant's link", async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });
    await seedClient({ clientId: 'CLT-0003', slug: 'contoso', companyName: 'Contoso' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    // Northwind's supplier follows a link that Contoso shared.
    const res = await inAccountMode(() => request(app)
      .post('/api/auth/login?workspace=contoso')
      .set('host', 'vp.example.com')
      .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password }));

    expect(res.status).toBe(200);
    expect(res.body.vendor.clientId).toBe('CLT-0002');
    expect(res.body.workspace.slug).toBe('northwind');
  });

  it('still answers a wrong password and an unknown account with the same refusal', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    const wrongPassword = await inAccountMode(() => request(app)
      .post('/api/auth/login')
      .send({ vendorIdOrEmail: baseVendor.email, password: 'not-the-password' }));
    const unknownAccount = await inAccountMode(() => request(app)
      .post('/api/auth/login')
      .send({ vendorIdOrEmail: 'nobody@example.com', password: 'whatever-1A' }));

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error).toBe('Invalid credentials');
    expect(unknownAccount.body.error).toBe('Invalid credentials');
  });

  it('does not sign anyone in to a suspended tenant', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });
    await withoutTenantScope(() => rawPrisma.client.updateMany({ where: { clientId: 'CLT-0002' }, data: { status: 'Suspended' } }));

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/login')
      .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password }));

    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  it('keeps the subdomain answer for subdomain tenancy: the bare address is nowhere to sign in', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    const res = await withEnv({ PORTAL_BASE_DOMAIN: 'vp.example.com', NODE_ENV: 'production', PORTAL_TENANCY_MODE: undefined }, () =>
      request(app)
        .post('/api/auth/login')
        .set('host', 'vp.example.com')
        .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password }));

    expect(res.status).toBe(404);
    expect(res.body.workspace).toBeUndefined();
  });
});

describe('registration under account tenancy', () => {
  it('lands the supplier in the tenant the link names', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/register?workspace=northwind')
      .set('host', 'vp.example.com')
      .send(baseVendor));

    expect(res.status).toBe(202);
    await drainBackground();
    const created = await withoutTenantScope(() => rawPrisma.vendor.findFirst({ where: { email: baseVendor.email } }));
    expect(created.clientId).toBe('CLT-0002');
  });

  it('answers 404, and creates nothing, when there is no link to say which tenant', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/register')
      .set('host', 'vp.example.com')
      .send(baseVendor));

    expect(res.status).toBe(404);
    await drainBackground();
    expect(await withoutTenantScope(() => rawPrisma.vendor.findFirst({ where: { email: baseVendor.email } }))).toBeNull();
  });

  it('answers 404 for a link to a tenant that does not exist', async () => {
    const res = await inAccountMode(() => request(app)
      .post('/api/auth/register?workspace=nobody')
      .send(baseVendor));

    expect(res.status).toBe(404);
  });

  it('is not steered by a subdomain or by x-client-slug', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });

    const res = await inAccountMode(() => request(app)
      .post('/api/auth/register')
      .set('host', 'northwind.vp.example.com')
      .set('x-client-slug', 'northwind')
      .send(baseVendor));

    expect(res.status).toBe(404);
  });
});

describe('boot validation of the tenancy mode', () => {
  const validate = async (vars) => withEnv(
    {
      PORT: '5000', DATABASE_URL: 'postgresql://x', FRONTEND_URL: 'https://vp.example.com',
      NODE_ENV: 'production', PORTAL_BASE_DOMAIN: undefined, PORTAL_TENANCY_MODE: undefined,
      JWT_SECRET: 'j'.repeat(40), INTERNAL_KEY: 'i'.repeat(40), MASTER_KEY: 'm'.repeat(40),
      STORAGE_ALLOW_LOCAL: 'true',
      ...vars,
    },
    () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        require('../config/validateEnv')();
        return 'booted';
      } catch (error) {
        return error.message;
      } finally {
        exit.mockRestore();
        quiet.mockRestore();
      }
    },
  );

  it('refuses a mode it does not know rather than quietly choosing the other one', async () => {
    expect(await validate({ PORTAL_TENANCY_MODE: 'accounts', PORTAL_BASE_DOMAIN: 'vp.example.com' })).toBe('exit:1');
  });

  it('still requires PORTAL_BASE_DOMAIN in production under subdomain tenancy', async () => {
    expect(await validate({})).toBe('exit:1');
    expect(await validate({ PORTAL_TENANCY_MODE: 'subdomain' })).toBe('exit:1');
  });

  it('does not require PORTAL_BASE_DOMAIN under account tenancy, where the hostname is never read', async () => {
    expect(await validate({ PORTAL_TENANCY_MODE: 'account' })).toBe('booted');
  });

  // #253: outside production neither variable is required, and the resolver no
  // longer invents a tenant when both are absent. Nothing else about that
  // deployment looks wrong — it boots, and then answers "Unknown workspace" —
  // so boot is where it has to be said.
  describe('subdomain tenancy with no workspace configured at all', () => {
    const warningsFrom = async (vars) => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        // The suite pins DEFAULT_CLIENT_SLUG (tests/env.js); these cases own it.
        await validate({ NODE_ENV: 'test', DEFAULT_CLIENT_SLUG: undefined, ...vars });
        return warn.mock.calls.flat().join('\n');
      } finally {
        warn.mockRestore();
      }
    };

    it('warns at boot rather than falling back silently', async () => {
      expect(await warningsFrom({})).toMatch(/PORTAL_BASE_DOMAIN.*DEFAULT_CLIENT_SLUG/);
    });

    it('stays quiet once either variable names the workspace', async () => {
      expect(await warningsFrom({ PORTAL_BASE_DOMAIN: 'vp.example.com' })).toBe('');
      expect(await warningsFrom({ DEFAULT_CLIENT_SLUG: 'legacy' })).toBe('');
    });

    it('stays quiet under account tenancy, where neither variable is read', async () => {
      expect(await warningsFrom({ PORTAL_TENANCY_MODE: 'account' })).toBe('');
    });
  });
});
