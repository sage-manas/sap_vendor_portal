const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createTenantUser, createPlatformUser } = require('./helpers');

const app = buildTestApp();

// The x-vendor-id header used to authenticate a request whenever NODE_ENV was
// not production. It is gone in every environment (ADR-0010) — the JWT is the
// only identity the API accepts.
describe('protect middleware', () => {
  let vendor;

  beforeEach(async () => {
    ({ vendor } = await registerVendor(app));
  });

  it('ignores x-vendor-id entirely and answers 401', async () => {
    const res = await request(app).get('/api/rfqs').set('x-vendor-id', vendor.vendorId);
    expect(res.status).toBe(401);
  });

  it('still ignores it in production', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app).get('/api/rfqs').set('x-vendor-id', vendor.vendorId);
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('rejects requests with no token at all', async () => {
    const res = await request(app).get('/api/rfqs');
    expect(res.status).toBe(401);
  });

  it('accepts a supplier JWT and scopes the request to that supplier', async () => {
    const { token } = await registerVendor(
      app,
      { vendorId: 'vendor_scope_1', email: 'scope@example.com', gstin: '27AABCB1234F1Z6' },
      { onboarded: true },
    );
    const res = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('refuses a platform operator at a tenant endpoint', async () => {
    const { token } = await createPlatformUser();
    const res = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('answers 404 — not 403 — when a tenant account calls the platform plane', async () => {
    const { token } = await createTenantUser({ role: 'client_admin' });
    const res = await request(app).get('/api/platform/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('rejects a token whose role no longer matches the account', async () => {
    const { token, user } = await createTenantUser({ role: 'buyer' });
    const { asTenant } = require('./helpers');
    await asTenant(async () => {
      const { prisma } = require('../db/prisma');
      await prisma.user.update({ where: { pk: user.pk }, data: { role: 'finance' } });
    });

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
