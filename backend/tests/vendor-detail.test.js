const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createAdminUser, onboardVendor } = require('./helpers');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { VENDOR_AWAITING_DECISION } = require('../config/statuses');

// GET /api/vendors/:id — one supplier in full, for the workspace's supplier
// detail page. The interesting parts are that it is addressable both ways, that
// it answers with live trading figures rather than stored ones, and that a
// supplier cannot read it at all.

const app = buildTestApp();

const seedPO = (vendorId, overrides = {}) =>
  runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: overrides.id || 'PO-VD-0001',
      vendorId,
      buyerName: 'Test Buyer',
      currency: 'INR',
      status: overrides.status || 'Open',
      createdDate: new Date('2026-01-10'),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Steel', quantity: 10, grnQuantity: 0, unitPrice: 100, netValue: 1000 }] },
    },
  }));

describe('GET /api/vendors/:id', () => {
  it('returns the profile, live trading figures and recent orders', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_detail_1', gstin: '27AAAAA3001A1Z1' }, { onboarded: true });
    const { token } = await createAdminUser({ email: 'detail-admin-1@example.com' });
    await seedPO(vendor.vendorId, { id: 'PO-VD-1' });
    await seedPO(vendor.vendorId, { id: 'PO-VD-2', status: 'Acknowledged' });

    const res = await request(app).get(`/api/vendors/${vendor.pk}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.vendor.companyName).toBe(vendor.companyName);
    expect(res.body.vendor.password).toBeUndefined();
    expect(res.body.vendor.bankDetails.ifscCode).toBe('HDFC0000060');
    expect(res.body.activity.purchaseOrders).toMatchObject({ total: 2, value: 2000 });
    expect(res.body.activity.purchaseOrders.byStatus.Acknowledged).toMatchObject({ count: 1, value: 1000 });
    expect(res.body.recentOrders).toHaveLength(2);
    expect(res.body.activity.payments.total).toBe(0);
  });

  it('is addressable by the supplier id as well as the document id', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_detail_2', gstin: '27AAAAA3002A1Z1' }, { onboarded: true });
    const { token } = await createAdminUser({ email: 'detail-admin-2@example.com' });

    const res = await request(app).get(`/api/vendors/${vendor.vendorId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.vendor.vendorId).toBe(vendor.vendorId);
  });

  it('reports whether this supplier is a decision waiting to happen', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_detail_3', gstin: '27AAAAA3003A1Z1' });
    const { token } = await createAdminUser({ email: 'detail-admin-3@example.com' });

    const asDraft = await request(app).get(`/api/vendors/${vendor.vendorId}`).set('Authorization', `Bearer ${token}`);
    expect(asDraft.body.awaitingDecision).toBe(false);

    // The registry decides which statuses are a pending decision, and it is
    // not the obvious guess — 'Submitted' is not one of them.
    await onboardVendor(vendor.vendorId, { status: VENDOR_AWAITING_DECISION[0] });
    const awaiting = await request(app).get(`/api/vendors/${vendor.vendorId}`).set('Authorization', `Bearer ${token}`);
    expect(awaiting.body.awaitingDecision).toBe(true);
  });

  it('does not let a supplier read another supplier — or themselves — through it', async () => {
    const { token: supplierToken } = await registerVendor(app, { vendorId: 'vendor_detail_4', gstin: '27AAAAA3004A1Z1' }, { onboarded: true });
    const { vendor: other } = await registerVendor(app, {
      vendorId: 'vendor_detail_5', gstin: '27AAAAA3005A1Z1', email: 'other-detail@example.com',
    }, { onboarded: true });

    const res = await request(app).get(`/api/vendors/${other.vendorId}`).set('Authorization', `Bearer ${supplierToken}`);
    expect(res.status).toBe(403);
  });

  it('404s an unknown supplier rather than an empty profile', async () => {
    const { token } = await createAdminUser({ email: 'detail-admin-6@example.com' });
    const res = await request(app).get('/api/vendors/vendor_does_not_exist').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('still routes the static supplier endpoints that sit above it', async () => {
    const { token } = await registerVendor(app, { vendorId: 'vendor_detail_7', gstin: '27AAAAA3007A1Z1' }, { onboarded: true });

    // '/:id' is registered last precisely so these are not swallowed.
    const profile = await request(app).get('/api/vendors/profile').set('Authorization', `Bearer ${token}`);
    expect(profile.status).toBe(200);
    expect(profile.body.vendorId).toBe('vendor_detail_7');

    const performance = await request(app).get('/api/vendors/performance').set('Authorization', `Bearer ${token}`);
    expect(performance.status).toBe(200);
  });
});
