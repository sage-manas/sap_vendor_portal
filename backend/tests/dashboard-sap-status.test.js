const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');
const { resetSapStatusCache } = require('../controllers/dashboard.controller');

// GET /api/dashboard/sap-status is what the app's top bar shows: this
// workspace's SAP connection and when it last answered. The SapLog rows below
// are seeded history — preconditions, not states the API is meant to produce.
//
// A test tenant has no SapConnection, so it runs the built-in simulator. Most
// cases here are about reading real traffic, so they stand in a real-driver
// adapter; `useSimulator()` puts the actual default back.
let mockAdapterOverride = null;
jest.mock('../sap', () => {
  const actual = jest.requireActual('../sap');
  return {
    ...actual,
    getSapAdapterForClient: (clientId) => (mockAdapterOverride ? Promise.resolve(mockAdapterOverride) : actual.getSapAdapterForClient(clientId)),
  };
});
const useRealDriver = (circuit = 'closed') => {
  mockAdapterOverride = { driver: 's4odata', environment: 'sandbox', circuit: () => ({ state: circuit }) };
};
const useSimulator = () => { mockAdapterOverride = null; };

const app = buildTestApp();
const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);

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

const statusFor = async (token) => auth(token)(request(app).get('/api/dashboard/sap-status'));

beforeEach(() => {
  resetSapStatusCache();
  useRealDriver();
});

describe('GET /api/dashboard/sap-status', () => {
  it('reports an idle workspace as unknown, not healthy', async () => {
    const admin = await createAdminUser({ email: 'sap-status-idle@example.com' });
    const res = await statusFor(admin.token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.lastSyncAt).toBeNull();
  });

  it('reports healthy traffic with the time of the last successful call', async () => {
    const admin = await createAdminUser({ email: 'sap-status-ok@example.com' });
    await log('CLT-0001', 'SUCCESS', 30);
    await log('CLT-0001', 'SUCCESS', 5);

    const res = await statusFor(admin.token);

    expect(res.body.status).toBe('healthy');
    expect(new Date(res.body.lastSyncAt).getTime()).toBeGreaterThan(Date.now() - 6 * 60 * 1000);
    expect(res.body.environment).toBe('sandbox');
  });

  it('reports failing when most recent calls fail, without exposing SAP error text', async () => {
    const admin = await createAdminUser({ email: 'sap-status-fail@example.com' });
    await log('CLT-0001', 'SUCCESS', 60);
    await log('CLT-0001', 'FAILED', 10, { errorMessage: 'RFC_ERROR_SYSTEM_FAILURE host sap-prd-01' });
    await log('CLT-0001', 'FAILED', 5, { errorMessage: 'RFC_ERROR_SYSTEM_FAILURE host sap-prd-01' });

    const res = await statusFor(admin.token);

    expect(res.body.status).toBe('failing');
    expect(JSON.stringify(res.body)).not.toContain('RFC_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('sap-prd-01');
  });

  it('reports failing while the circuit breaker is open, whatever the counts say', async () => {
    const admin = await createAdminUser({ email: 'sap-status-breaker@example.com' });
    useRealDriver('open');
    await log('CLT-0001', 'SUCCESS', 5);

    expect((await statusFor(admin.token)).body.status).toBe('failing');
  });

  it('ignores KYC and internal SYS rows — they are not SAP traffic', async () => {
    const admin = await createAdminUser({ email: 'sap-status-kyc@example.com' });
    await log('CLT-0001', 'SUCCESS', 30);
    await log('CLT-0001', 'FAILED', 5, { type: 'KYC', name: 'GSTIN_VERIFY' });
    await log('CLT-0001', 'FAILED', 4, { type: 'KYC', name: 'PAN_VERIFY' });
    await log('CLT-0001', 'SUCCESS', 1, { type: 'SYS', name: 'SAP_DOCUMENT_LEDGER_CHANGED' });

    const res = await statusFor(admin.token);

    expect(res.body.status).toBe('healthy');
    expect(res.body.calls).toBe(1);
    // The SYS row is newer, but it never reached SAP.
    expect(new Date(res.body.lastSyncAt).getTime()).toBeLessThan(Date.now() - 20 * 60 * 1000);
  });

  it('leaves calls still awaiting SAP\'s answer out of the rate', async () => {
    const admin = await createAdminUser({ email: 'sap-status-pending@example.com' });
    await log('CLT-0001', 'FAILED', 10);
    await log('CLT-0001', 'PENDING', 5);
    await log('CLT-0001', 'PENDING', 4);

    const res = await statusFor(admin.token);

    expect(res.body.calls).toBe(1);
    expect(res.body.status).toBe('failing');
  });

  it('says a workspace on the built-in simulator is simulated, not connected', async () => {
    const admin = await createAdminUser({ email: 'sap-status-sim@example.com' });
    useSimulator();
    await log('CLT-0001', 'SUCCESS', 5);

    expect((await statusFor(admin.token)).body.status).toBe('simulated');
  });

  it('reads only the caller\'s own workspace', async () => {
    const admin = await createAdminUser({ email: 'sap-status-own@example.com' });
    await createTenantUser({ role: ROLES.CLIENT_ADMIN, clientId: 'CLT-0002', email: 'sap-status-other@example.com' });
    await log('CLT-0002', 'FAILED', 5);

    const res = await statusFor(admin.token);

    expect(res.body.status).toBe('unknown');
    expect(res.body.calls).toBe(0);
  });

  it('gives a supplier the workspace state but only their own call counts and last sync', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_sap_status_1', gstin: '27AAAAA3101A1Z1' }, { onboarded: true });
    await log('CLT-0001', 'SUCCESS', 50, { vendorId: 'vendor_sap_status_1' });
    // Another supplier's very recent activity: it must not show through.
    await log('CLT-0001', 'SUCCESS', 1, { vendorId: 'VND-SOMEONE-ELSE' });
    await log('CLT-0001', 'SUCCESS', 2, { vendorId: 'VND-SOMEONE-ELSE' });

    const res = await statusFor(supplier.token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.scope).toBe('supplier');
    expect(res.body.calls).toBe(1);
    expect(new Date(res.body.lastSyncAt).getTime()).toBeLessThan(Date.now() - 40 * 60 * 1000);
  });
});
