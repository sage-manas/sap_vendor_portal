const request = require('supertest');
const { bootstrap, BootstrapRefused, REQUIRED_ENV } = require('../scripts/bootstrap-production');
const { rawPrisma } = require('../db/prisma');
const { createTenantUser, registerVendor } = require('./helpers');
const buildTestApp = require('./testApp');

// A new production database gets its platform admin and nothing else: no demo
// tenant, no sample suppliers. The Jest setup seeds a CLT-0001 client before
// every test (every code path resolves a tenant), so each test that wants a
// fresh database clears it first, the way a real one has none.

const app = buildTestApp();
const production = () => ({
  NODE_ENV: 'production',
  ...Object.fromEntries(REQUIRED_ENV.map((key) => [key, 'x'])),
});
const emptyDatabase = async () => { await rawPrisma.client.deleteMany({}); };
const counts = async () => ({
  clients: await rawPrisma.client.count(),
  vendors: await rawPrisma.vendor.count(),
  users: await rawPrisma.user.count(),
  operators: await rawPrisma.platformUser.count(),
});

describe('bootstrap-production', () => {
  it('creates one super admin and nothing else in a fresh database', async () => {
    await emptyDatabase();
    const { operator, temporaryPassword } = await bootstrap({ email: 'Ops@Example.com', env: production() });

    expect(await counts()).toEqual({ clients: 0, vendors: 0, users: 0, operators: 1 });
    expect(operator).toMatchObject({ email: 'ops@example.com', role: 'super_admin', status: 'Active', mustChangePassword: true });
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);
    const stored = await rawPrisma.platformUser.findFirst({ where: { pk: operator.pk }, omit: { password: false } });
    expect(stored.password).not.toContain(temporaryPassword);
    expect(stored.password.startsWith('$2')).toBe(true);
  });

  it('the generated password signs the admin in, and forces a change', async () => {
    await emptyDatabase();
    const { temporaryPassword } = await bootstrap({ email: 'ops@example.com', env: production() });

    const res = await request(app).post('/api/platform/auth/login').send({ email: 'ops@example.com', password: temporaryPassword });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mustChangePassword: true, next: 'change_password' });
  });

  it('refuses outside production', async () => {
    await emptyDatabase();
    await expect(bootstrap({ email: 'ops@example.com', env: { ...production(), NODE_ENV: 'development' } })).rejects.toThrow(BootstrapRefused);
    expect((await counts()).operators).toBe(0);
  });

  it('refuses when the production environment is incomplete, naming what is missing', async () => {
    await emptyDatabase();
    const env = production();
    delete env.PORTAL_BASE_DOMAIN;
    delete env.SMTP_HOST;
    await expect(bootstrap({ email: 'ops@example.com', env })).rejects.toThrow(/PORTAL_BASE_DOMAIN, SMTP_HOST/);
  });

  it('refuses a database that already holds a tenant, a supplier or staff', async () => {
    // The Jest setup leaves CLT-0001 in place: that alone is "not fresh".
    await expect(bootstrap({ email: 'ops@example.com', env: production() })).rejects.toThrow(/not a fresh database \(1 clients\)/);

    await createTenantUser({ role: 'client_admin' });
    await registerVendor(app, {}, { onboarded: true });
    await expect(bootstrap({ email: 'ops@example.com', env: production() })).rejects.toThrow(/vendors/);
    expect((await counts()).operators).toBe(0);
  });

  it('refuses to run twice', async () => {
    await emptyDatabase();
    await bootstrap({ email: 'ops@example.com', env: production() });
    await expect(bootstrap({ email: 'other@example.com', env: production() })).rejects.toThrow(/1 operators/);
  });

  it('requires an email address', async () => {
    await expect(bootstrap({ email: '', env: production() })).rejects.toThrow(/--email/);
  });
});
