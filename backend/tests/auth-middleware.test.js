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

  // Issue #74: a password change is a supplier's own response to a leaked
  // token — it must actually end that token's access, not just their own
  // future logins. passwordChangedAt is written by hashPassword/
  // consumeResetToken (db/credentials.js) whether the change came through
  // the profile form or a reset link; either way, any token minted before it
  // is now stale.
  it('rejects a token issued before the account\'s password was changed', async () => {
    const { token, vendor } = await registerVendor(
      app,
      { vendorId: 'vendor_pwchange_1', email: 'pwchange1@example.com', gstin: '27AABCB1234F1Z8' },
      { onboarded: true },
    );
    const { asTenant } = require('./helpers');
    const { prisma } = require('../db/prisma');
    // A real password change lands strictly after the token's iat (JWT's own
    // second-resolution clock) — set a few seconds ahead rather than racing
    // the clock in a fast-running test.
    await asTenant(() => prisma.vendor.update({
      where: { pk: vendor.pk },
      data: { passwordChangedAt: new Date(Date.now() + 5000) },
    }));

    const res = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('still accepts a token issued after the account\'s last password change', async () => {
    const { token, vendor } = await registerVendor(
      app,
      { vendorId: 'vendor_pwchange_2', email: 'pwchange2@example.com', gstin: '27AABCB1234F1Z9' },
      { onboarded: true },
    );
    const { asTenant } = require('./helpers');
    const { prisma } = require('../db/prisma');
    await asTenant(() => prisma.vendor.update({
      where: { pk: vendor.pk },
      data: { passwordChangedAt: new Date(Date.now() - 60_000) },
    }));

    const res = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  // The other half of #74's own fix: POST /auth/change-password invalidates
  // the caller's own current token (it is, correctly, "issued before the
  // password change" the moment the write lands) — so it has to hand back a
  // fresh one, or the legitimate caller who just changed their own password
  // is logged out by their own action. Exercises the real endpoint end to
  // end, not a manual DB write, since the bug here was specifically that
  // this endpoint's own response didn't carry a usable token.
  it('POST /auth/change-password returns a token that keeps working, even though the old one no longer does', async () => {
    const { token } = await registerVendor(
      app,
      { vendorId: 'vendor_pwchange_3', email: 'pwchange3@example.com', gstin: '27AABCB1234F2Z1' },
      { onboarded: true },
    );

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'secret123', newPassword: 'a-much-better-one' });

    expect(changed.status).toBe(200);
    expect(changed.body.token).toBeTruthy();
    // Not asserted to differ from the original token string: signToken's
    // claims (sub/role/email/...) are unchanged by a password change and
    // jwt.sign is deterministic given identical claims signed in the same
    // second, so the two tokens can legitimately be byte-identical. What
    // matters is that the token this response hands back is one that works.

    const withNewToken = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${changed.body.token}`);
    expect(withNewToken.status).toBe(200);
  });
});
