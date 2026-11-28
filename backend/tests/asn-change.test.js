const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createTenantUser, asTenant, setTenantSettings, gstinFor } = require('./helpers');
const { claim } = require('../jobs/queue');
const { processJob } = require('../jobs/worker');
const { getSapAdapterForClient, invalidateSapAdapter } = require('../sap');
const createInboundDelivery = require('../jobs/handlers/createInboundDelivery');
const { ROLES } = require('../config/roles');

// Changing a sent shipment notice (ASN design D6): PUT /asns/:asnId takes the
// whole shipment again and replaces it, under every rule a new one meets.
//
// Seeding note (AGENTS.md): purchase orders and the SAP vendor code are
// preconditions. Shipments, approvals, deliveries and changes go through the
// API and the job handler.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const order = (id, { quantity = 100, sapPoNumber = null } = {}) => asTenant(() => prisma.purchaseOrder.create({
  data: {
    id, vendorId: 'vendor_chg_a', sapPoNumber,
    items: { create: [
      { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity, unitPrice: 10, netValue: quantity * 10, plant: '1100' },
      { clientId: 'CLT-0001', line: 20, materialCode: 'MAT-002', description: 'Nuts', quantity, unitPrice: 2, netValue: quantity * 2, plant: '1100' },
    ] },
  },
}));

const setup = async ({ sapPoNumber } = {}) => {
  const supplier = await registerVendor(app, {
    vendorId: 'vendor_chg_a', companyName: 'Change Supplier Pvt Ltd', gstin: gstinFor('27AAAAA1231A1Z'), pan: 'AAAAA1231A', email: 'chg-a@example.com',
  }, { onboarded: true });
  await asTenant(() => prisma.vendor.updateMany({ where: { vendorId: 'vendor_chg_a' }, data: { sapVendorCode: '1120250081' } }));
  await order('PO-2026-CH1', { sapPoNumber });
  await order('PO-2026-CH2', { sapPoNumber: sapPoNumber && '4500022899' });
  for (const id of ['PO-2026-CH1', 'PO-2026-CH2']) {
    // eslint-disable-next-line no-await-in-loop
    expect((await request(app).put(`/api/pos/${id}/acknowledge`).set(auth(supplier.token))).status).toBe(200);
  }
  const admin = await createTenantUser({ role: ROLES.CLIENT_ADMIN, email: 'chg-admin@example.com' });
  return { supplier, admin };
};

const body = (items, overrides = {}) => ({
  invoiceReference: 'INV/CH/1',
  invoiceDate: new Date().toISOString(),
  invoiceValue: 1180,
  carrierName: 'Safexpress',
  trackingNumber: 'LR1',
  items,
  ...overrides,
});
const line = (poId, lineNo, shippedQuantity) => ({ poId, line: lineNo, shippedQuantity });

const ship = (token, items, overrides) => request(app).post('/api/asns').set(auth(token)).send(body(items, overrides));
const change = (token, id, items, overrides) => request(app).put(`/api/asns/${id}`).set(auth(token)).send(body(items, overrides));
const poStatus = async (id) => (await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id } }))).status;

describe('changing a shipment waiting for approval', () => {
  it('replaces its lines and details, counting nothing of its own against it', async () => {
    const { supplier } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 60)]);

    // 100 ordered: 60 is this shipment's own, so 100 is still open to it.
    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 100), line('PO-2026-CH1', 20, 5)], { vehicleNumber: 'HR55AB1234' });

    expect(res.status).toBe(200);
    expect(res.body.asn).toMatchObject({ id: asn.id, status: 'Pending Approval', vehicleNumber: 'HR55AB1234', invoiceReference: 'INV/CH/1' });
    expect(res.body.asn.items.map((item) => [item.line, item.shippedQuantity])).toEqual([[10, 100], [20, 5]]);
  });

  it('still cannot take quantity another shipment holds', async () => {
    const { supplier } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 30)]);
    await ship(supplier.token, [line('PO-2026-CH1', 10, 60)], { invoiceReference: 'INV/CH/2' });

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 41)]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/still open to ship \(40\)/);
  });

  it('moving every line to another order steps the first order back', async () => {
    const { supplier } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    expect(await poStatus('PO-2026-CH1')).toBe('Dispatched');

    await change(supplier.token, asn.id, [line('PO-2026-CH2', 10, 10)]);

    expect(await poStatus('PO-2026-CH1')).toBe('Acknowledged');
    expect(await poStatus('PO-2026-CH2')).toBe('Dispatched');
  });

  it('keeps the attachments it is sent, and lets go of the rest', async () => {
    const { supplier } = await setup();
    const upload = async (name) => (await request(app).post('/api/uploads').set(auth(supplier.token))
      .field('linkedTo', 'ASN').attach('file', Buffer.from('%PDF-1.4 x'), name)).body.documentId;
    const [kept, dropped, added] = [await upload('a.pdf'), await upload('b.pdf'), await upload('c.pdf')];
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)], { documentIds: [kept, dropped] });

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 10)], { documentIds: [kept, added] });

    expect(res.body.asn.documents.map((doc) => doc.documentId).sort()).toEqual([kept, added].sort());
    const freed = await asTenant(() => prisma.document.findFirst({ where: { pk: dropped } }));
    expect(freed.asnId).toBeNull();
  });

  it('records the lines before and after', async () => {
    const { supplier } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);

    await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 12)]);

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.changed' } }));
    expect(audit.meta).toMatchObject({ before: ['PO-2026-CH1/10: 10'], after: ['PO-2026-CH1/10: 12'], resubmitted: false });
  });
});

describe('a rejected shipment, changed', () => {
  it('goes back to the tenant admin, without the old rejection', async () => {
    const { supplier, admin } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    await request(app).post(`/api/asns/${asn.id}/reject`).set(auth(admin.token)).send({ reason: 'Wrong quantity' });

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 8)]);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/for approval again/);
    expect(res.body.asn).toMatchObject({ status: 'Pending Approval', rejectionReason: null });
    expect(await poStatus('PO-2026-CH1')).toBe('Dispatched');
  });
});

describe('what cannot be changed', () => {
  it('a cancelled or received shipment', async () => {
    const { supplier } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    await request(app).post(`/api/asns/${asn.id}/cancel`).set(auth(supplier.token)).send({ reason: 'x' });

    expect((await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 5)])).status).toBe(400);
  });

  it('another supplier\'s shipment', async () => {
    const { supplier } = await setup();
    const other = await registerVendor(app, {
      vendorId: 'vendor_chg_b', companyName: 'Other Pvt Ltd', gstin: gstinFor('27AAAAA1232A1Z'), pan: 'AAAAA1232A', email: 'chg-b@example.com',
    }, { onboarded: true });
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);

    expect((await change(other.token, asn.id, [line('PO-2026-CH1', 10, 5)])).status).toBe(404);
  });
});

describe('a shipment SAP holds an inbound delivery for', () => {
  // Approval off, so it goes to SAP on submit; the delivery job is run as the
  // worker would run it.
  const delivered = async (supplier) => {
    await setTenantSettings({ 'shipments.asnApprovalRequired': false });
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10), line('PO-2026-CH1', 20, 4)]);
    await asTenant(async () => createInboundDelivery({
      job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() },
      adapter: await getSapAdapterForClient('CLT-0001'),
    }));
    const row = await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(row.sapInboundDelivery).toBeTruthy();
    return row;
  };

  it('is changed in SAP, then here', async () => {
    const { supplier } = await setup({ sapPoNumber: '4500022828' });
    const asn = await delivered(supplier);

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 7)]);

    expect(res.status).toBe(200);
    const log = await asTenant(() => prisma.sapLog.findFirst({ where: { name: 'ZINB_DELIVERY_CHANGE' } }));
    expect(log.documentRef).toBe(asn.sapInboundDelivery);
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.changed' } }));
    expect(audit.meta.sapInboundDelivery).toBe(asn.sapInboundDelivery);
  });

  it('cannot take a line the delivery does not have', async () => {
    const { supplier } = await setup({ sapPoNumber: '4500022828' });
    const asn = await delivered(supplier);

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 7), line('PO-2026-CH2', 10, 1)]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot take new lines \(PO-2026-CH2:10\)/);
  });

  it('is refused, with nothing changed, when the connection cannot change it', async () => {
    const { supplier } = await setup({ sapPoNumber: '4500022828' });
    const asn = await delivered(supplier);
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800', companyCode: '1000' } },
    }));
    invalidateSapAdapter();

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 7)]);

    expect(res.status).toBe(409);
    const items = await asTenant(() => prisma.asnItem.findMany({ where: { asnPk: asn.pk }, orderBy: { line: 'asc' } }));
    expect(items.map((item) => Number(item.shippedQuantity))).toEqual([10, 4]);
  });
});

// The user's decision: every change to an approved shipment is approved again.
describe('an approved shipment, changed (approval on)', () => {
  const approve = (admin, id) => request(app).post(`/api/asns/${id}/approve`).set(auth(admin.token));
  const sapChanges = () => asTenant(() => prisma.sapLog.count({ where: { name: 'ZINB_DELIVERY_CHANGE' } }));

  it('goes back to the tenant admin', async () => {
    const { supplier, admin } = await setup();
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    expect((await approve(admin, asn.id)).status).toBe(200);

    const res = await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 12)]);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/for approval again/);
    expect(res.body.asn).toMatchObject({ status: 'Pending Approval', approvedAt: null });
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.changed' } }));
    expect(audit.meta.reapproval).toBe(true);
  });

  it('leaves SAP\'s delivery alone until approved, then changes it', async () => {
    const { supplier, admin } = await setup({ sapPoNumber: '4500022828' });
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10), line('PO-2026-CH1', 20, 4)]);
    await approve(admin, asn.id);
    await asTenant(async () => createInboundDelivery({
      job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() },
      adapter: await getSapAdapterForClient('CLT-0001'),
    }));
    const delivered = await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(delivered.sapLines).toEqual([
      { poId: 'PO-2026-CH1', line: 10, shippedQuantity: 10, uom: 'EA' },
      { poId: 'PO-2026-CH1', line: 20, shippedQuantity: 4, uom: 'EA' },
    ]);

    await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 7)]);
    expect(await sapChanges()).toBe(0);
    expect((await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id } }))).sapLines).toEqual(delivered.sapLines);

    const res = await approve(admin, asn.id);

    expect(res.status).toBe(200);
    expect(await sapChanges()).toBe(1);
    const after = await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(after.status).toBe('Submitted');
    expect(after.sapLines).toEqual([{ poId: 'PO-2026-CH1', line: 10, shippedQuantity: 7, uom: 'EA' }]);
  });

  it('is not approved when SAP cannot take the change', async () => {
    const { supplier, admin } = await setup({ sapPoNumber: '4500022828' });
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    await approve(admin, asn.id);
    await asTenant(async () => createInboundDelivery({
      job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() },
      adapter: await getSapAdapterForClient('CLT-0001'),
    }));
    await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 7)]);
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800', companyCode: '1000' } },
    }));
    invalidateSapAdapter();

    const res = await approve(admin, asn.id);

    expect(res.status).toBe(409);
    expect((await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id } }))).status).toBe('Pending Approval');
  });

  it('restarts the delivery job that finished while the change waited', async () => {
    const { supplier, admin } = await setup({ sapPoNumber: '4500022828' });
    const { body: { asn } } = await ship(supplier.token, [line('PO-2026-CH1', 10, 10)]);
    await approve(admin, asn.id);
    await change(supplier.token, asn.id, [line('PO-2026-CH1', 10, 8)]);
    // The worker meets the delivery job while the change waits: nothing to
    // announce, so it finishes. (Only that job: the goods-receipt watch keeps
    // running too, and the mock warehouse would receive the goods.)
    const claimed = await claim('test-worker', 20);
    await processJob(claimed.find((j) => j.kind === 'createInboundDelivery' && j.args.asnId === asn.id));
    const job = () => withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { dedupeKey: `createInboundDelivery:CLT-0001:${asn.id}` } }));
    expect((await job()).status).toBe('succeeded');

    await approve(admin, asn.id);

    expect((await job()).status).toBe('pending');
  });
});
