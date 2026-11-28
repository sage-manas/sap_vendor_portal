const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createTenantUser, asTenant, setTenantSettings, gstinFor } = require('./helpers');
const { ROLES } = require('../config/roles');
const { markFailed } = require('../jobs/syncState');
const { todayIn } = require('../utils/usage');

// The buying organisation's ASN monitor (ASN design screen B1): due today at a
// plant, waiting for approval, SAP errors, overdue. And the tenant admin's
// retry for a shipment SAP stopped on.
//
// Seeding note (AGENTS.md): orders are preconditions. Shipments, approvals and
// SAP failures come from the API and the job runtime's own bookkeeping
// (markFailed is what jobs/worker.js calls on an error).

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const order = (id, plant) => asTenant(() => prisma.purchaseOrder.create({
  data: {
    id, vendorId: 'vendor_mon_a',
    items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, unitPrice: 10, netValue: 1000, plant }] },
  },
}));

const setup = async () => {
  const supplier = await registerVendor(app, {
    vendorId: 'vendor_mon_a', companyName: 'Monitor Supplier Pvt Ltd', gstin: gstinFor('27AAAAA3331A1Z'), pan: 'AAAAA3331A', email: 'mon-a@example.com',
  }, { onboarded: true });
  await order('PO-2026-MN1', '1100');
  await order('PO-2026-MN2', '1200');
  for (const id of ['PO-2026-MN1', 'PO-2026-MN2']) {
    // eslint-disable-next-line no-await-in-loop
    expect((await request(app).put(`/api/pos/${id}/acknowledge`).set(auth(supplier.token))).status).toBe(200);
  }
  const admin = await createTenantUser({ role: ROLES.CLIENT_ADMIN, email: 'mon-admin@example.com' });
  return { supplier, admin };
};

let seq = 0;
const today = () => todayIn('Asia/Kolkata');
const dayOffset = (n) => new Date(Date.parse(`${today()}T00:00:00.000Z`) + n * 86400000).toISOString();
const ship = (token, poId, eta, overrides = {}) => request(app).post('/api/asns').set(auth(token)).send({
  invoiceReference: `INV/MN/${(seq += 1)}`,
  invoiceDate: dayOffset(-3),
  invoiceValue: 118,
  shipDate: dayOffset(-3),
  estimatedDeliveryDate: eta,
  carrierName: 'Safexpress',
  trackingNumber: 'LR1',
  items: [{ poId, line: 10, shippedQuantity: 1 }],
  ...overrides,
});
const monitor = (token, query = '') => request(app).get(`/api/asns/monitor${query}`).set(auth(token));
const ids = (rows) => rows.map((row) => row.id);

describe('the ASN monitor', () => {
  it('sorts shipments into due today, waiting for approval and overdue', async () => {
    const { supplier, admin } = await setup();
    const dueToday = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(0))).body.asn;
    const late = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(-1))).body.asn;
    const later = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(2))).body.asn;
    const waiting = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(0))).body.asn;
    for (const asn of [dueToday, late, later]) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post(`/api/asns/${asn.id}/approve`).set(auth(admin.token));
    }

    const res = await monitor(admin.token);

    expect(res.status).toBe(200);
    expect(res.body.today).toBe(today());
    expect(ids(res.body.expected)).toEqual([dueToday.id]);
    expect(ids(res.body.pendingApproval)).toEqual([waiting.id]);
    expect(ids(res.body.overdue)).toEqual([late.id]);
    expect(res.body.expected[0].vendorName).toBe('Monitor Supplier Pvt Ltd');
  });

  it('looks at another day, and one plant', async () => {
    const { supplier } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const at1100 = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(2))).body.asn;
    const at1200 = (await ship(supplier.token, 'PO-2026-MN2', dayOffset(2))).body.asn;
    const { token } = await createTenantUser({ role: ROLES.BUYER, email: 'mon-buyer@example.com' });

    const both = await monitor(token, `?date=${dayOffset(2).slice(0, 10)}`);
    const one = await monitor(token, `?date=${dayOffset(2).slice(0, 10)}&plant=1200`);

    expect(ids(both.body.expected).sort()).toEqual([at1100.id, at1200.id].sort());
    expect(ids(one.body.expected)).toEqual([at1200.id]);
    expect(both.body.plants).toEqual(['1100', '1200']);
  });

  it('lists a shipment SAP stopped on, with why', async () => {
    const { supplier, admin } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const asn = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(1))).body.asn;
    await asTenant(() => markFailed('awaitGoodsReceipt', { asnId: asn.id }, 'gateway down'));

    const res = await monitor(admin.token);

    expect(res.body.sapErrors).toEqual([expect.objectContaining({ id: asn.id, sapError: 'gateway down' })]);
  });

  it('lists a shipment whose inbound delivery job gave up', async () => {
    const { supplier, admin } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const asn = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(1))).body.asn;
    // What jobs/worker.js leaves behind when the job exhausts its attempts.
    await withoutTenantScope(() => rawPrisma.sapJob.update({
      where: { dedupeKey: `createInboundDelivery:CLT-0001:${asn.id}` },
      data: { status: 'abandoned', lastError: 'SAP refused: PO item blocked' },
    }));

    const res = await monitor(admin.token);

    expect(res.body.sapErrors).toEqual([expect.objectContaining({ id: asn.id, sapError: 'SAP refused: PO item blocked' })]);
  });

  it('refuses a bad date', async () => {
    const { admin } = await setup();
    expect((await monitor(admin.token, '?date=21-11-2026')).status).toBe(400);
  });

  it('is not open to a supplier — it covers every supplier', async () => {
    const { supplier } = await setup();
    expect((await monitor(supplier.token)).status).toBe(403);
  });
});

describe('retrying SAP for a shipment', () => {
  it('restarts the jobs that stopped and puts the shipment back to pending', async () => {
    const { supplier, admin } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const asn = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(1))).body.asn;
    const key = `createInboundDelivery:CLT-0001:${asn.id}`;
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { dedupeKey: key }, data: { status: 'abandoned', lastError: 'x' } }));
    await asTenant(() => markFailed('awaitGoodsReceipt', { asnId: asn.id }, 'gateway down'));

    const res = await request(app).post(`/api/asns/${asn.id}/retry`).set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.asn.sapSyncState).toBe('pending');
    const job = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { dedupeKey: key } }));
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
    expect(ids((await monitor(admin.token)).body.sapErrors)).toEqual([]);
  });

  it('says so when nothing has stopped', async () => {
    const { supplier, admin } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const asn = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(1))).body.asn;

    expect((await request(app).post(`/api/asns/${asn.id}/retry`).set(auth(admin.token))).status).toBe(400);
  });

  it('is the tenant admin\'s', async () => {
    const { supplier } = await setup();
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const asn = (await ship(supplier.token, 'PO-2026-MN1', dayOffset(1))).body.asn;
    const { token } = await createTenantUser({ role: ROLES.BUYER, email: 'mon-buyer2@example.com' });

    expect((await request(app).post(`/api/asns/${asn.id}/retry`).set(auth(token))).status).toBe(403);
  });
});
