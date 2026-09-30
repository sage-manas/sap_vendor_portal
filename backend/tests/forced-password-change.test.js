const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { allRoutes } = require('./routeTable');
const {
  registerVendor, createTenantUser, createOperatorSession, asTenant,
} = require('./helpers');

const app = buildTestApp();

// `mustChangePassword` was only ever reported to the UI. An account still on
// the temporary password it was provisioned with could skip the change screen
// and call every endpoint directly. The server now refuses everything except
// reading its own session and changing the password.

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const NEW_PASSWORD = 'Sturdy-Passw0rd!';

const REFUSED = { reason: 'password_change_required' };

describe('server-side forced password change', () => {
  describe('tenant staff', () => {
    it('cannot use the tenant API while on the temporary password', async () => {
      const { token } = await createTenantUser({ role: 'client_admin', mustChangePassword: true });

      for (const path of ['/api/workspace/overview', '/api/dashboard/summary', '/api/users', '/api/pos']) {
        const res = await request(app).get(path).set(bearer(token));
        expect({ path, status: res.status, reason: res.body.reason }).toEqual({ path, status: 403, ...REFUSED });
      }
    });

    it('can still read its own session, which is how the UI learns it must change', async () => {
      const { token } = await createTenantUser({ role: 'client_admin', mustChangePassword: true });

      const res = await request(app).get('/api/auth/me').set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.auth.mustChangePassword).toBe(true);
    });

    it('is let back in once the password is changed', async () => {
      const { token } = await createTenantUser({ role: 'client_admin', mustChangePassword: true });

      const changed = await request(app)
        .post('/api/auth/change-password')
        .set(bearer(token))
        .send({ currentPassword: 'secret123', newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(200);

      const res = await request(app).get('/api/workspace/overview').set(bearer(changed.body.token));
      expect(res.status).toBe(200);
    });

    it('an account that is not flagged is unaffected', async () => {
      const { token } = await createTenantUser({ role: 'client_admin' });
      expect((await request(app).get('/api/workspace/overview').set(bearer(token))).status).toBe(200);
    });
  });

  describe('suppliers', () => {
    it('cannot use the supplier API while on the temporary password', async () => {
      const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
      // No API leaves a supplier holding both a usable password and the flag
      // (staff-created suppliers get one nobody knows), so the flag is the
      // precondition here rather than the thing produced.
      await asTenant(() => prisma.vendor.update({ where: { pk: vendor.pk }, data: { mustChangePassword: true } }));

      for (const path of ['/api/pos', '/api/vendors/profile', '/api/invoices']) {
        const res = await request(app).get(path).set(bearer(token));
        expect({ path, status: res.status, reason: res.body.reason }).toEqual({ path, status: 403, ...REFUSED });
      }
      expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(200);
    });
  });

  describe('platform operators', () => {
    it('cannot use the console while on the temporary password, even with MFA cleared', async () => {
      const { token } = await createOperatorSession({ mustChangePassword: true });

      const res = await request(app).get('/api/platform/tenants').set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('password_change_required');
    });

    it('cannot enrol MFA before changing the password, but can read its session and change it', async () => {
      const { token } = await createOperatorSession({ mustChangePassword: true });

      const enrol = await request(app).post('/api/platform/auth/mfa/enrol').set(bearer(token)).send({});
      expect(enrol.status).toBe(403);
      expect(enrol.body.reason).toBe('password_change_required');

      expect((await request(app).get('/api/platform/auth/me').set(bearer(token))).status).toBe(200);

      const changed = await request(app)
        .post('/api/platform/auth/change-password')
        .set(bearer(token))
        .send({ currentPassword: 'secret123', newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(200);

      expect((await request(app).get('/api/platform/tenants').set(bearer(changed.body.token))).status).toBe(200);
    });
  });

  // The exemption is a property of the route's guard, so the whole list of
  // exempt routes can be read off the router. Adding to it is a security
  // decision and belongs in review.
  it('exactly four routes are open to an account that must change its password', () => {
    const exempt = allRoutes
      .filter((route) => route.handlers.some((handler) => handler.allowsPendingPasswordChange))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(exempt).toEqual([
      'GET /auth/me',
      'GET /platform/auth/me',
      'POST /auth/change-password',
      'POST /platform/auth/change-password',
    ]);
  });
});
