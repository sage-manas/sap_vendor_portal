const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser, asTenant } = require('./helpers');
const { VENDOR_STATUS } = require('../config/statuses');

const app = buildTestApp();

// Moves a registered supplier along the onboarding lifecycle without going
// through submit (which would schedule SAP work this suite does not care about).
const setStatus = (vendorId, status) =>
  asTenant(() => prisma.vendor.updateMany({ where: { vendorId }, data: { status } }));

const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('a supplier cannot widen their own scope with ?all=true', () => {
  it('GET /api/rfqs?all=true still returns only RFQs they were invited to', async () => {
    const { token, vendor } = await registerVendor(app);
    await setStatus(vendor.vendorId, VENDOR_STATUS.APPROVED);

    await asTenant(async () => {
      await prisma.rFQ.create({
        data: {
          id: 'RFQ-2026-901',
          description: 'Theirs',
          deadlineDate: new Date(Date.now() + 7 * 86400000),
          invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: vendor.vendorId, name: vendor.companyName }] },
        },
      });
      await prisma.rFQ.create({
        data: {
          id: 'RFQ-2026-902',
          description: "A competitor's",
          deadlineDate: new Date(Date.now() + 7 * 86400000),
          invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: 'VND-99999', name: 'Someone else' }] },
        },
      });
    });

    const res = await request(app).get('/api/rfqs?all=true').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.rfqs.map((rfq) => rfq.id)).toEqual(['RFQ-2026-901']);
  });

  it('GET /api/logs?all=true still returns only their own SAP log entries', async () => {
    const { token, vendor } = await registerVendor(app);
    await setStatus(vendor.vendorId, VENDOR_STATUS.APPROVED);

    await asTenant(() => prisma.sapLog.createMany({
      data: [
        { vendorId: vendor.vendorId, type: 'BAPI', direction: 'OUTBOUND', name: 'THEIRS', payload: '{}' },
        // A competitor's vendor-master payload — this is the one that carries
        // bank account numbers, and the reason the leak mattered.
        { vendorId: 'VND-99999', type: 'BAPI', direction: 'OUTBOUND', name: 'VENDOR_CREATE', payload: '{"accountNumber":"123456789012"}' },
      ],
    }));

    const res = await request(app).get('/api/logs?all=true').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.map((log) => log.name)).toEqual(['THEIRS']);
  });

  it('lets tenant staff see the whole tenant on both endpoints', async () => {
    const { vendor } = await registerVendor(app);
    const { token: adminToken } = await createAdminUser();

    await asTenant(() => prisma.rFQ.create({
      data: {
        id: 'RFQ-2026-903',
        description: 'Not addressed to the admin',
        deadlineDate: new Date(Date.now() + 7 * 86400000),
        invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: vendor.vendorId, name: vendor.companyName }] },
      },
    }));
    await asTenant(() => prisma.sapLog.create({
      data: { vendorId: vendor.vendorId, type: 'BAPI', direction: 'OUTBOUND', name: 'ANYTHING', payload: '{}' },
    }));

    const rfqs = await request(app).get('/api/rfqs').set(auth(adminToken));
    expect(rfqs.status).toBe(200);
    expect(rfqs.body.rfqs).toHaveLength(1);

    // Staff used to get an empty list here: the query pinned itself to
    // `vendorId: null` whenever ?all=true was absent.
    const logs = await request(app).get('/api/logs').set(auth(adminToken));
    expect(logs.status).toBe(200);
    expect(logs.body).toHaveLength(1);
  });
});

describe('the transacting modules are closed until registration is submitted', () => {
  const CLOSED = [
    ['get', '/api/rfqs'],
    ['get', '/api/pos'],
    ['get', '/api/grns'],
    ['get', '/api/invoices'],
    ['get', '/api/payments'],
    ['get', '/api/asns'],
    ['get', '/api/logs'],
    ['get', '/api/chats'],
    ['get', '/api/reports/metrics'],
  ];

  it.each(CLOSED)('refuses %s %s for a Draft supplier', async (method, path) => {
    const { token } = await registerVendor(app);

    const res = await request(app)[method](path).set(auth(token));

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('registration_incomplete');
  });

  it('refuses a Draft supplier the write paths too, not just the reads', async () => {
    const { token } = await registerVendor(app);

    const bid = await request(app)
      .post('/api/rfqs/RFQ-2026-001/bid')
      .set(auth(token))
      .send({ unitPrices: { 1: 100 }, gstRate: 18 });

    expect(bid.status).toBe(403);
    expect(bid.body.reason).toBe('registration_incomplete');
  });

  it('leaves the registration form, its uploads and the dashboard open', async () => {
    const { token } = await registerVendor(app);

    const profile = await request(app).get('/api/vendors/profile').set(auth(token));
    expect(profile.status).toBe(200);

    const uploads = await request(app).get('/api/uploads').set(auth(token));
    expect(uploads.status).toBe(200);

    const dashboard = await request(app).get('/api/dashboard/summary').set(auth(token));
    expect(dashboard.status).toBe(200);
  });

  it.each([
    VENDOR_STATUS.PENDING_APPROVAL,
    VENDOR_STATUS.UNDER_REVIEW,
    VENDOR_STATUS.APPROVED,
  ])('opens them again once the supplier is %s', async (status) => {
    const { token, vendor } = await registerVendor(app);
    await setStatus(vendor.vendorId, status);

    const res = await request(app).get('/api/rfqs').set(auth(token));

    expect(res.status).toBe(200);
  });

  // A rejected supplier never reaches this gate: Vendor.canAuthenticate() closes
  // the door at `protect`, which is the stronger refusal. VENDOR_PRE_SUBMISSION
  // still lists Rejected — it is a true statement about the record, and the day
  // rejection becomes recoverable in-session this gate is already right.
  it('turns a rejected supplier away at authentication, before the gate', async () => {
    const { token, vendor } = await registerVendor(app);
    await setStatus(vendor.vendorId, VENDOR_STATUS.REJECTED);

    const res = await request(app).get('/api/rfqs').set(auth(token));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not active/i);
  });

  it('never applies to tenant staff, who are not onboarding', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/rfqs').set(auth(token));

    expect(res.status).toBe(200);
  });
});

describe('a temporary password is reported on every session, not just at login', () => {
  it('GET /api/auth/me carries mustChangePassword for a provisioned admin', async () => {
    const { token } = await createAdminUser({ mustChangePassword: true });

    const res = await request(app).get('/api/auth/me').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.auth.mustChangePassword).toBe(true);
  });

  it('reports false once the password has been changed', async () => {
    const { token } = await createAdminUser({ mustChangePassword: true });

    await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'secret123', newPassword: 'a-much-better-one' });

    const res = await request(app).get('/api/auth/me').set(auth(token));

    expect(res.body.auth.mustChangePassword).toBe(false);
  });
});
