const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

const app = buildTestApp();
const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);

// GET /api/dashboard/sap-status is what the app's top bar shows: this
// workspace's SAP connection and when it last answered. The SapLog rows below
// are seeded history — preconditions, not states the API is meant to produce.

const log = (clientId, status, minutesAgo, extra = {}) => asTenant(() => prisma.sapLog.create({
  data: {
    clientId,
    vendorId: 'VND-STATUS',
    type: 'BAPI',
    direction: 'OUTBOUND',
    name: 'BAPI_PO_GETDETAIL',
    status,
    timestamp: new Date(Date.now() - minutesAgo * 60 * 1000),
    ...extra,
  },
}), clientId);

describe('GET /api/dashboard/sap-status', () => {
  it('reports an idle workspace as unknown, not healthy', async () => {
    const admin = await createAdminUser({ email: 'sap-status-idle@example.com' });
    const res = await auth(admin.token)(request(app).get('/api/dashboard/sap-status'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.lastSyncAt).toBeNull();
  });

  it('reports healthy traffic with the time of the last successful call', async () => {
    const admin = await createAdminUser({ email: 'sap-status-ok@example.com' });
    await log('CLT-0001', 'SUCCESS', 30);
    await log('CLT-0001', 'SUCCESS', 5);

    const res = await auth(admin.token)(request(app).get('/api/dashboard/sap-status'));

    expect(res.body.status).toBe('healthy');
    expect(new Date(res.body.lastSyncAt).getTime()).toBeGreaterThan(Date.now() - 6 * 60 * 1000);
    expect(res.body.environment).toBe('sandbox');
  });

  it('reports failing when most recent calls fail, without exposing SAP error text', async () => {
    const admin = await createAdminUser({ email: 'sap-status-fail@example.com' });
    await log('CLT-0001', 'SUCCESS', 60);
    await log('CLT-0001', 'FAILED', 10, { errorMessage: 'RFC_ERROR_SYSTEM_FAILURE host sap-prd-01' });
    await log('CLT-0001', 'FAILED', 5, { errorMessage: 'RFC_ERROR_SYSTEM_FAILURE host sap-prd-01' });

    const res = await auth(admin.token)(request(app).get('/api/dashboard/sap-status'));

    expect(res.body.status).toBe('failing');
    expect(JSON.stringify(res.body)).not.toContain('RFC_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('sap-prd-01');
  });

  it('reads only the caller\'s own workspace', async () => {
    const admin = await createAdminUser({ email: 'sap-status-own@example.com' });
    await createTenantUser({ role: ROLES.CLIENT_ADMIN, clientId: 'CLT-0002', email: 'sap-status-other@example.com' });
    await log('CLT-0002', 'FAILED', 5);

    const res = await auth(admin.token)(request(app).get('/api/dashboard/sap-status'));

    expect(res.body.status).toBe('unknown');
    expect(res.body.calls).toBe(0);
  });

  it('is available to a supplier, who sees the same workspace status', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_sap_status_1', gstin: '27AAAAA3101A1Z1' }, { onboarded: true });
    await log('CLT-0001', 'SUCCESS', 2);

    const res = await auth(supplier.token)(request(app).get('/api/dashboard/sap-status'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });
});
