const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');
const awaitGoodsReceiptHandler = require('../jobs/handlers/awaitGoodsReceipt');
const createInboundDelivery = require('../jobs/handlers/createInboundDelivery');

// One shipment across several of a supplier's orders for one plant (ASN
// design V2): one invoice, one truck, one inbound delivery, received in SAP
// order by order.
//
// Seeding note (AGENTS.md): the purchase orders are preconditions. Shipments,
// cancellations and receipts are produced through the API and the job
// handlers.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const supplier = (suffix) => registerVendor(app, {
  vendorId: `vendor_multi_${suffix}`,
  companyName: `Multi Supplier ${suffix.toUpperCase()} Pvt Ltd`,
  gstin: suffix === 'a' ? '27AAAAA8881A1Z1' : '27AAAAA8882A1Z1',
  pan: suffix === 'a' ? 'AAAAA8881A' : 'AAAAA8882A',
  email: `multi-${suffix}@example.com`,
}, { onboarded: true });

const order = (id, vendorId, { plant = '1100', currency = 'INR', sapPoNumber = null } = {}) => asTenant(() => prisma.purchaseOrder.create({
  data: {
    id, vendorId, currency, sapPoNumber,
    items: { create: [
      { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, unitPrice: 10, netValue: 1000, plant },
      { clientId: 'CLT-0001', line: 20, materialCode: 'MAT-002', description: 'Nuts', quantity: 50, unitPrice: 4, netValue: 200, plant },
    ] },
  },
}));

const acknowledge = async (token, poId) => {
  expect((await request(app).put(`/api/pos/${poId}/acknowledge`).set(auth(token))).status).toBe(200);
};

const setup = async (options = {}) => {
  const a = await supplier('a');
  await order('PO-2026-M1', 'vendor_multi_a', options.first);
  await order('PO-2026-M2', 'vendor_multi_a', options.second);
  await acknowledge(a.token, 'PO-2026-M1');
  await acknowledge(a.token, 'PO-2026-M2');
  return a;
};

let invoiceSeq = 0;
const shipment = (items, overrides = {}) => ({
  invoiceReference: `INV/M/${(invoiceSeq += 1)}`,
  invoiceDate: new Date().toISOString(),
  invoiceValue: 1180,
  shipDate: new Date().toISOString(),
  estimatedDeliveryDate: new Date(Date.now() + 3 * 86400000).toISOString(),
  carrierName: 'Safexpress',
  vehicleNumber: 'HR55AB1234',
  items,
  ...overrides,
});

const ship = (token, items, overrides) => request(app).post('/api/asns').set(auth(token)).send(shipment(items, overrides));
const both = [
  { poId: 'PO-2026-M1', line: 10, shippedQuantity: 40 },
  { poId: 'PO-2026-M2', line: 20, shippedQuantity: 30 },
];
const poStatus = async (id) => (await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id } }))).status;

// The receipt job, against an adapter that answers for the orders named.
const receive = (asn, receiptsByPo) => asTenant(() => awaitGoodsReceiptHandler({
  job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() },
  adapter: {
    awaitGoodsReceipt: async ({ asn: forOrder, po }, handler) => {
      const receipt = receiptsByPo[po.id];
      if (!receipt) return false;
      await handler({
        grnId: 'GRN-2026-5000000001', sapMigoDoc: '5000000001', sapDocYear: 2026, postingDate: new Date(), receivedBy: 'SAP',
        items: forOrder.items.map((item) => ({
          line: item.line, materialCode: item.materialCode, receivedQuantity: receipt, acceptedQuantity: receipt, rejectedQuantity: 0, uom: 'EA',
        })),
      });
      return true;
    },
  },
}));

describe('a shipment across several orders', () => {
  it('is one shipment, with each line naming its order and the plant they share', async () => {
    const a = await setup();

    const res = await ship(a.token, both);

    expect(res.status).toBe(201);
    expect(res.body.asn.plant).toBe('1100');
    expect(res.body.asn.items.map((item) => [item.poId, item.line])).toEqual([['PO-2026-M1', 10], ['PO-2026-M2', 20]]);
    expect(await poStatus('PO-2026-M1')).toBe('Dispatched');
    expect(await poStatus('PO-2026-M2')).toBe('Dispatched');
  });

  it('shows on each order it ships against', async () => {
    const a = await setup();
    const { body } = await ship(a.token, both);

    for (const poId of ['PO-2026-M1', 'PO-2026-M2']) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await request(app).get(`/api/pos/${poId}/asn`).set(auth(a.token));
      expect(listed.body.map((asn) => asn.id)).toEqual([body.asn.id]);
    }
  });

  it('counts its quantity against each line\'s own order', async () => {
    const a = await setup();
    await ship(a.token, both);

    const over = await ship(a.token, [{ poId: 'PO-2026-M2', line: 20, shippedQuantity: 21 }]);
    const fits = await ship(a.token, [{ poId: 'PO-2026-M2', line: 20, shippedQuantity: 20 }]);

    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/still open to ship \(20\) for line 20 of PO-2026-M2/);
    expect(fits.status).toBe(201);
  });

  it('allows the same line number on two different orders', async () => {
    const a = await setup();

    const res = await ship(a.token, [
      { poId: 'PO-2026-M1', line: 10, shippedQuantity: 1 },
      { poId: 'PO-2026-M2', line: 10, shippedQuantity: 1 },
    ]);

    expect(res.status).toBe(201);
  });

  it('is refused across plants, or across currencies', async () => {
    const a = await setup({ second: { plant: '1200' } });
    const plants = await ship(a.token, both);
    expect(plants.status).toBe(400);
    expect(plants.body.error).toMatch(/different plants \(1100, 1200\)/);
  });

  it('is refused across currencies', async () => {
    const a = await setup({ second: { currency: 'USD' } });
    const res = await ship(a.token, both);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different currencies/);
  });

  it('cannot take another supplier\'s order, and creates nothing when it tries', async () => {
    const a = await setup();
    await supplier('b');
    await order('PO-2026-MB', 'vendor_multi_b');

    const res = await ship(a.token, [both[0], { poId: 'PO-2026-MB', line: 10, shippedQuantity: 1 }]);

    expect(res.status).toBe(404);
    expect(await asTenant(() => prisma.aSN.count())).toBe(0);
  });

  it('needs every line to name its order', async () => {
    const a = await setup();

    expect((await ship(a.token, [{ line: 10, shippedQuantity: 1 }])).status).toBe(400);
  });
});

describe('receiving a shipment across several orders', () => {
  it('is Partially Received until every order is in, with one GRN per order', async () => {
    const a = await setup();
    const { body: { asn } } = await ship(a.token, both);

    expect(await receive(asn, { 'PO-2026-M1': 40 })).toEqual({ done: false });
    let row = await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id }, include: { items: true } }));
    expect(row.status).toBe('Partially Received');
    expect(row.sapSyncState).toBe('pending');

    // Still open: a cancel is refused once anything is received.
    const cancel = await request(app).post(`/api/asns/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'x' });
    expect(cancel.status).toBe(400);

    expect(await receive(asn, { 'PO-2026-M2': 30 })).toEqual({ done: true });
    row = await asTenant(() => prisma.aSN.findFirst({ where: { id: asn.id }, include: { items: true } }));
    expect(row.status).toBe('Received');
    expect(row.sapSyncState).toBe('synced');

    // One SAP material document across both orders: each order still gets
    // its own GRN, the second not colliding with the first.
    const grns = await asTenant(() => prisma.gRN.findMany({ where: { asnId: asn.id }, orderBy: { id: 'asc' } }));
    expect(grns.map((grn) => [grn.id, grn.poId])).toEqual([
      ['GRN-2026-5000000001-1', 'PO-2026-M1'],
      ['GRN-2026-5000000001-2', 'PO-2026-M2'],
    ]);
  });

  it('frees nothing twice: a received order\'s line is not still counted in transit', async () => {
    const a = await setup();
    const { body: { asn } } = await ship(a.token, both);
    await receive(asn, { 'PO-2026-M1': 40 });

    // 100 ordered, 40 received, nothing else in transit on PO-2026-M1/10.
    const res = await ship(a.token, [{ poId: 'PO-2026-M1', line: 10, shippedQuantity: 60 }]);

    expect(res.status).toBe(201);
  });
});

describe('cancelling a shipment across several orders', () => {
  it('frees every order\'s quantity and steps each order back', async () => {
    const a = await setup();
    const { body: { asn } } = await ship(a.token, both);

    const res = await request(app).post(`/api/asns/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'Wrong truck' });

    expect(res.status).toBe(200);
    expect(await poStatus('PO-2026-M1')).toBe('Acknowledged');
    expect(await poStatus('PO-2026-M2')).toBe('Acknowledged');
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.cancelled' } }));
    expect(audit.meta.poIds).toEqual(['PO-2026-M1', 'PO-2026-M2']);
  });

  it('can be cancelled from either order\'s page, but not from an order it is not on', async () => {
    const a = await setup();
    await order('PO-2026-M3', 'vendor_multi_a');
    await acknowledge(a.token, 'PO-2026-M3');
    const { body: { asn } } = await ship(a.token, both);

    const wrong = await request(app).post(`/api/pos/PO-2026-M3/asn/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'x' });
    const right = await request(app).post(`/api/pos/PO-2026-M2/asn/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'x' });

    expect(wrong.status).toBe(404);
    expect(right.status).toBe(200);
  });

  it('is not open to another supplier', async () => {
    const a = await setup();
    const b = await supplier('b');
    const { body: { asn } } = await ship(a.token, both);

    expect((await request(app).post(`/api/asns/${asn.id}/cancel`).set(auth(b.token)).send({ reason: 'x' })).status).toBe(404);
  });
});

describe('the inbound delivery for a shipment across several orders', () => {
  it('names each line\'s own SAP order', async () => {
    const a = await setup({ first: { sapPoNumber: '4500022828' }, second: { sapPoNumber: '4500022835' } });
    await asTenant(() => prisma.vendor.updateMany({ where: { vendorId: 'vendor_multi_a' }, data: { sapVendorCode: '1120250081' } }));
    const { body: { asn } } = await ship(a.token, both);
    let sent;
    const adapter = { inboundDeliveryCreate: jest.fn(async (args) => { sent = args; return { created: true, delivery: '0180000999' }; }) };

    await asTenant(() => createInboundDelivery({ job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() }, adapter }));

    expect(sent.pos.map((po) => po.sapPoNumber).sort()).toEqual(['4500022828', '4500022835']);
    expect(sent.asn.items.map((item) => item.poId)).toEqual(['PO-2026-M1', 'PO-2026-M2']);
  });

  it('waits until every order has its SAP number', async () => {
    const a = await setup({ first: { sapPoNumber: '4500022828' } });
    await asTenant(() => prisma.vendor.updateMany({ where: { vendorId: 'vendor_multi_a' }, data: { sapVendorCode: '1120250081' } }));
    const { body: { asn } } = await ship(a.token, both);
    const adapter = { inboundDeliveryCreate: jest.fn() };

    const result = await asTenant(() => createInboundDelivery({ job: { clientId: 'CLT-0001', args: { asnId: asn.id }, createdAt: new Date() }, adapter }));

    expect(result).toEqual({ done: false });
    expect(adapter.inboundDeliveryCreate).not.toHaveBeenCalled();
  });
});
