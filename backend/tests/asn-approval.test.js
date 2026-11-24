const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createTenantUser, asTenant, setTenantSettings } = require('./helpers');
const { ROLES } = require('../config/roles');

// The tenant admin approves every supplier's shipment notice before it goes
// to SAP (the user's decision on the ASN design doc). A workspace setting,
// on by default: shipments.asnApprovalRequired.
//
// Seeding note (AGENTS.md): the purchase order is a precondition. Shipments,
// approvals and rejections go through the API.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const setup = async () => {
  const supplier = await registerVendor(app, {
    vendorId: 'vendor_appr_a', companyName: 'Approval Supplier Pvt Ltd', gstin: '27AAAAA9991A1Z1', pan: 'AAAAA9991A', email: 'appr-a@example.com',
  }, { onboarded: true });
  await asTenant(() => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-APR1', vendorId: 'vendor_appr_a',
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, unitPrice: 10, netValue: 1000, plant: '1100' }] },
    },
  }));
  expect((await request(app).put('/api/pos/PO-2026-APR1/acknowledge').set(auth(supplier.token))).status).toBe(200);
  const admin = await createTenantUser({ role: ROLES.CLIENT_ADMIN, email: 'appr-admin@example.com' });
  return { supplier, admin };
};

let invoiceSeq = 0;
const ship = (token, quantity = 60, overrides = {}) => request(app).post('/api/asns').set(auth(token)).send({
  invoiceReference: `INV/AP/${(invoiceSeq += 1)}`,
  invoiceDate: new Date().toISOString(),
  invoiceValue: 1180,
  carrierName: 'Safexpress',
  trackingNumber: 'LR1',
  items: [{ poId: 'PO-2026-APR1', line: 10, shippedQuantity: quantity }],
  ...overrides,
});

const job = (kind, asnId) => withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { dedupeKey: `${kind}:CLT-0001:${asnId}` } }));
const row = (id) => asTenant(() => prisma.aSN.findFirst({ where: { id } }));

describe('a workspace that approves shipment notices (the default)', () => {
  it('holds a new ASN for the tenant admin, with nothing sent to SAP', async () => {
    const { supplier } = await setup();

    const res = await ship(supplier.token);

    expect(res.status).toBe(201);
    expect(res.body.asn.status).toBe('Pending Approval');
    expect(res.body.message).toMatch(/for approval/);
    expect(await job('awaitGoodsReceipt', res.body.asn.id)).toBeNull();
    expect(await job('createInboundDelivery', res.body.asn.id)).toBeNull();
    expect((await row(res.body.asn.id)).sapSyncState).toBe('local');
  });

  it('holds its quantity and its invoice number while it waits', async () => {
    const { supplier } = await setup();
    await ship(supplier.token, 60, { invoiceReference: 'INV/HELD' });

    expect((await ship(supplier.token, 41)).status).toBe(400);
    expect((await ship(supplier.token, 10, { invoiceReference: 'INV/HELD' })).status).toBe(400);
  });

  it('goes to SAP on approval, and records who approved it', async () => {
    const { supplier, admin } = await setup();
    const { body } = await ship(supplier.token);

    const res = await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.asn).toMatchObject({ status: 'Submitted', approvedBy: 'appr-admin@example.com' });
    expect(await job('awaitGoodsReceipt', body.asn.id)).toMatchObject({ status: 'pending' });
    expect(await job('createInboundDelivery', body.asn.id)).toMatchObject({ status: 'pending' });
    expect((await row(body.asn.id)).sapSyncState).toBe('pending');
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.approved' } }));
    expect(audit.meta).toMatchObject({ vendorId: 'vendor_appr_a', poIds: ['PO-2026-APR1'] });
  });

  it('cannot be approved twice', async () => {
    const { supplier, admin } = await setup();
    const { body } = await ship(supplier.token);
    await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(admin.token));

    expect((await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(admin.token))).status).toBe(400);
  });

  it('on rejection frees its quantity and invoice number, and keeps the reason', async () => {
    const { supplier, admin } = await setup();
    const { body } = await ship(supplier.token, 100, { invoiceReference: 'INV/REJ' });

    const res = await request(app).post(`/api/asns/${body.asn.id}/reject`).set(auth(admin.token)).send({ reason: 'Quantity does not match our schedule' });

    expect(res.status).toBe(200);
    expect(res.body.asn).toMatchObject({ status: 'Rejected', rejectionReason: 'Quantity does not match our schedule', rejectedBy: 'appr-admin@example.com' });
    const po = await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: 'PO-2026-APR1' } }));
    expect(po.status).toBe('Acknowledged');
    expect((await ship(supplier.token, 100, { invoiceReference: 'INV/REJ' })).status).toBe(201);
  });

  it('needs a reason to reject', async () => {
    const { supplier, admin } = await setup();
    const { body } = await ship(supplier.token);

    expect((await request(app).post(`/api/asns/${body.asn.id}/reject`).set(auth(admin.token)).send({ reason: ' ' })).status).toBe(400);
  });

  it('can still be withdrawn by the supplier while it waits', async () => {
    const { supplier, admin } = await setup();
    const { body } = await ship(supplier.token);

    expect((await request(app).post(`/api/asns/${body.asn.id}/cancel`).set(auth(supplier.token)).send({ reason: 'Changed plans' })).status).toBe(200);
    expect((await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(admin.token))).status).toBe(400);
  });
});

describe('who decides', () => {
  it.each([
    ['buyer', ROLES.BUYER],
    ['finance', ROLES.FINANCE],
  ])('not %s', async (label, role) => {
    const { supplier } = await setup();
    const { body } = await ship(supplier.token);
    const { token } = await createTenantUser({ role, email: `${label}@example.com` });

    expect((await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(token))).status).toBe(403);
    expect((await request(app).post(`/api/asns/${body.asn.id}/reject`).set(auth(token)).send({ reason: 'x' })).status).toBe(403);
  });

  it('not the supplier', async () => {
    const { supplier } = await setup();
    const { body } = await ship(supplier.token);

    expect((await request(app).post(`/api/asns/${body.asn.id}/approve`).set(auth(supplier.token))).status).toBe(403);
  });
});

describe('a workspace that does not approve shipment notices', () => {
  it('sends a new ASN to SAP at once', async () => {
    const { supplier } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });

    const res = await ship(supplier.token);

    expect(res.body.asn.status).toBe('Submitted');
    expect(await job('awaitGoodsReceipt', res.body.asn.id)).toMatchObject({ status: 'pending' });
  });
});
