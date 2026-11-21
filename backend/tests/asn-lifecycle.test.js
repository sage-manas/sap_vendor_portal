const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createOperatorSession, asTenant, withoutAsnApproval } = require('./helpers');
const { markFailed } = require('../jobs/syncState');
const awaitGoodsReceiptHandler = require('../jobs/handlers/awaitGoodsReceipt');

// The shipment notice lifecycle: partial shipments, the open quantity a new
// ASN is checked against, cancellation, attachments, and what the goods
// receipt records back onto the ASN.
//
// Seeding note (AGENTS.md): the purchase orders are preconditions — a PO is
// produced by awarding an RFQ or by the SAP sweep, neither of which is under
// test here. Every ASN, and every state an ASN reaches, is produced through
// `POST /api/pos/:id/asn`, the cancel endpoint, or the goods-receipt job
// handler.

const app = buildTestApp();

// Shipments here go straight to SAP: the workspace's approval step
// (tests/asn-approval.test.js) is a precondition this suite does not test.
beforeEach(() => withoutAsnApproval());
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const seedPo = (vendorId, poId, items) => asTenant(() => prisma.purchaseOrder.create({
  data: {
    id: poId,
    vendorId,
    items: {
      create: items || [
        { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, unitPrice: 10, netValue: 1000 },
      ],
    },
  },
}));

let invoiceSeq = 0;
const shipment = (items, overrides = {}) => ({
  invoiceReference: `INV/26/${(invoiceSeq += 1)}`,
  invoiceDate: new Date().toISOString(),
  invoiceValue: 1180,
  shipDate: new Date().toISOString(),
  estimatedDeliveryDate: new Date(Date.now() + 5 * 86400000).toISOString(),
  carrierName: 'Blue Dart Express',
  trackingNumber: 'LR-0001',
  items,
  ...overrides,
});

const supplier = async (suffix = 'a') => registerVendor(app, {
  vendorId: `vendor_asn_${suffix}`,
  companyName: `Asn Supplier ${suffix.toUpperCase()} Pvt Ltd`,
  gstin: suffix === 'a' ? '27AAAAA5551A1Z1' : '27AAAAA5552A1Z1',
  pan: suffix === 'a' ? 'AAAAA5551A' : 'AAAAA5552A',
  email: `asn-${suffix}@example.com`,
}, { onboarded: true });

// A supplier with one acknowledged order — acknowledged through the API,
// since that is a state the API produces.
const acknowledgedOrder = async (poId = 'PO-2026-ASN1', items) => {
  const a = await supplier('a');
  await seedPo('vendor_asn_a', poId, items);
  expect((await request(app).put(`/api/pos/${poId}/acknowledge`).set(auth(a.token))).status).toBe(200);
  return a;
};

const submit = (token, poId, body) => request(app).post(`/api/pos/${poId}/asn`).set(auth(token)).send(body);
const cancel = (token, poId, asnId, reason = 'Truck did not leave') => request(app)
  .post(`/api/pos/${poId}/asn/${asnId}/cancel`).set(auth(token)).send({ reason });
const poStatus = async (poId) => (await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: poId } }))).status;

// Runs the goods-receipt job for one ASN against an adapter that answers with
// the given receipt — the same handler the job worker calls.
const receive = async (asn, receipt) => asTenant(() => awaitGoodsReceiptHandler({
  job: { clientId: 'CLT-0001', args: { asnId: asn.id, poId: asn.poId, vendorId: asn.vendorId }, createdAt: new Date() },
  adapter: {
    awaitGoodsReceipt: async (ctx, handler) => {
      await handler({
        sapMigoDoc: '5000000001',
        sapDocYear: 2026,
        postingDate: new Date(),
        receivedBy: 'SAP',
        ...receipt,
        items: receipt.items.map((item) => ({ materialCode: 'MAT-001', description: 'Hex bolts M8', ...item })),
      });
      return true;
    },
  },
}));

describe('partial shipments', () => {
  it('accepts a second shipment against an order the first one already made Dispatched', async () => {
    const a = await acknowledgedOrder();

    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    expect(first.status).toBe(201);
    expect(await poStatus('PO-2026-ASN1')).toBe('Dispatched');

    const second = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 60 }]));
    expect(second.status).toBe(201);
  });

  it('counts quantity on an open shipment against what is left to ship', async () => {
    const a = await acknowledgedOrder();
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 60 }]))).status).toBe(201);

    const over = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 50 }]));

    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/still open to ship \(40\)/);
  });

  it('adds decimal quantities exactly — 33.3 and 66.7 ship the whole 100', async () => {
    const a = await acknowledgedOrder();
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 33.3 }]))).status).toBe(201);
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 66.7 }]))).status).toBe(201);
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 0.001 }]))).status).toBe(400);
  });

  it('refuses the same line listed twice on one shipment', async () => {
    const a = await acknowledgedOrder();

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([
      { line: 10, shippedQuantity: 60 },
      { line: 10, shippedQuantity: 60 },
    ]));

    expect(res.status).toBe(400);
    expect(await asTenant(() => prisma.aSN.count())).toBe(0);
  });

  it('lets only one of two simultaneous shipments take the same open quantity', async () => {
    const a = await acknowledgedOrder();

    const results = await Promise.all([
      submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 60 }])),
      submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 60 }])),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await asTenant(() => prisma.aSN.count({ where: { poId: 'PO-2026-ASN1' } }))).toBe(1);
  });

  it('tells the shipment form what each line has in transit and still open', async () => {
    const a = await acknowledgedOrder();
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 25 }]))).status).toBe(201);

    const list = await request(app).get('/api/pos').set(auth(a.token));
    const one = await request(app).get('/api/pos/PO-2026-ASN1').set(auth(a.token));

    for (const po of [list.body.pos[0], one.body]) {
      expect(po.items[0]).toMatchObject({ inTransitQuantity: 25, openToShipQuantity: 75 });
    }
  });

  it('refuses a shipment against a service line', async () => {
    const a = await acknowledgedOrder('PO-2026-ASN1', [
      { clientId: 'CLT-0001', line: 10, materialCode: '', description: 'Annual maintenance', quantity: 1, unitPrice: 5000, netValue: 5000, accountAssignmentCategory: 'D' },
    ]);

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 1 }]));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service line/);
  });
});

describe('e-way bill', () => {
  // 100 units at ₹600 — ₹60,000, over the ₹50,000 limit.
  const valuable = [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-002', description: 'Flanges', quantity: 100, unitPrice: 600, netValue: 60000 }];

  it('is required for an invoice worth more than ₹50,000', async () => {
    const a = await acknowledgedOrder('PO-2026-ASN1', valuable);

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }], { invoiceValue: 70800 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-way bill/);
  });

  it('is measured on the invoice\'s value with tax, not the order\'s net price', async () => {
    // 80 units at ₹600 is ₹48,000 net — under the limit — but ₹56,640 with
    // 18% GST, which is the value the rule is about (ASN design D5).
    const a = await acknowledgedOrder('PO-2026-ASN1', valuable);

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 80 }], { invoiceValue: 56640 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-way bill/);
  });

  it('is not required for an invoice worth less', async () => {
    const a = await acknowledgedOrder('PO-2026-ASN1', valuable);

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 50 }], { invoiceValue: 35400 }));

    expect(res.status).toBe(201);
  });

  it('accepts a 12-digit number, printed with spaces or not, and refuses anything else', async () => {
    const a = await acknowledgedOrder('PO-2026-ASN1', valuable);

    const bad = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }], { invoiceValue: 70800, ewayBillNo: '12345' }));
    expect(bad.status).toBe(400);

    const good = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }], { invoiceValue: 70800, ewayBillNo: '1234 5678 9012', ewayBillDate: new Date().toISOString() }));
    expect(good.status).toBe(201);
    expect(good.body.asn.ewayBillNo).toBe('123456789012');
  });
});

describe('the supplier\'s invoice', () => {
  it('is required: number, date and value', async () => {
    const a = await acknowledgedOrder();

    for (const missing of ['invoiceReference', 'invoiceDate', 'invoiceValue']) {
      const body = shipment([{ line: 10, shippedQuantity: 10 }]);
      delete body[missing];
      // eslint-disable-next-line no-await-in-loop
      expect((await submit(a.token, 'PO-2026-ASN1', body)).status).toBe(400);
    }
  });

  it('cannot reuse a number in the same financial year, on any order', async () => {
    const a = await acknowledgedOrder();
    await seedPo('vendor_asn_a', 'PO-2026-ASN2');
    expect((await request(app).put('/api/pos/PO-2026-ASN2/acknowledge').set(auth(a.token))).status).toBe(200);
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/26/0871', invoiceDate: '2026-11-02' }));
    expect(first.status).toBe(201);

    const reused = await submit(a.token, 'PO-2026-ASN2', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'inv/26/0871', invoiceDate: '2026-06-15' }));

    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatch(first.body.asn.id);
  });

  it('may reuse a number from the previous financial year, or from a cancelled shipment', async () => {
    const a = await acknowledgedOrder();
    const lastYear = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/0871', invoiceDate: '2026-03-31' }));
    expect(lastYear.status).toBe(201);
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/0871', invoiceDate: '2026-04-01' }))).status).toBe(201);

    const withdrawn = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/0999' }));
    expect((await cancel(a.token, 'PO-2026-ASN1', withdrawn.body.asn.id)).status).toBe(200);
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/0999' }))).status).toBe(201);
  });

  it('refuses a number that is not a GST invoice number', async () => {
    const a = await acknowledgedOrder();

    const tooLong = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV/2026/000000001' }));
    const badChars = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 10 }], { invoiceReference: 'INV 0871' }));

    expect(tooLong.status).toBe(400);
    expect(badChars.status).toBe(400);
  });
});

describe('cancelling a shipment', () => {
  it('frees its quantity and returns a once-shipped order to Acknowledged', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }]));
    expect(await poStatus('PO-2026-ASN1')).toBe('Dispatched');

    const res = await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id);

    expect(res.status).toBe(200);
    expect(res.body.asn).toMatchObject({ status: 'Cancelled', cancelReason: 'Truck did not leave' });
    expect(await poStatus('PO-2026-ASN1')).toBe('Acknowledged');
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }]))).status).toBe(201);
  });

  it('leaves the order Dispatched while another shipment is still on its way', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]))).status).toBe(201);

    expect((await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id)).status).toBe(200);

    expect(await poStatus('PO-2026-ASN1')).toBe('Dispatched');
  });

  it('stops the goods-receipt watch and records who cancelled it and why', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 100 }]));

    await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id, 'Wrong order');

    const job = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({
      where: { dedupeKey: `awaitGoodsReceipt:CLT-0001:${first.body.asn.id}` },
    }));
    expect(job.status).toBe('cancelled');

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.cancelled' } }));
    expect(audit.meta).toMatchObject({ poId: 'PO-2026-ASN1', reason: 'Wrong order' });
  });

  it('cannot be done twice, or to a shipment SAP has received', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    const second = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));

    expect((await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id)).status).toBe(200);
    expect((await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id)).status).toBe(400);

    await receive(second.body.asn, { grnId: 'GRN-2026-5000000001', items: [{ line: 10, receivedQuantity: 40, acceptedQuantity: 40, rejectedQuantity: 0, uom: 'EA' }] });
    const res = await cancel(a.token, 'PO-2026-ASN1', second.body.asn.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Received/);
  });

  it('needs a reason', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));

    expect((await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id, '  ')).status).toBe(400);
  });

  it('is not open to another supplier', async () => {
    const a = await acknowledgedOrder();
    const b = await supplier('b');
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));

    const res = await cancel(b.token, 'PO-2026-ASN1', first.body.asn.id);

    expect(res.status).toBe(404);
    expect((await asTenant(() => prisma.aSN.findFirst({ where: { id: first.body.asn.id } }))).status).toBe('Submitted');
  });

  it('takes the shipment out of the reconciliation queue even if its watch had failed', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    await asTenant(() => markFailed('awaitGoodsReceipt', { asnId: first.body.asn.id }, 'gateway down'));
    const { token } = await createOperatorSession();

    const before = await request(app).get('/api/platform/reconciliation?type=ASN').set(auth(token));
    expect(before.body.rows.map((r) => r.id)).toContain(first.body.asn.id);

    await cancel(a.token, 'PO-2026-ASN1', first.body.asn.id);

    const after = await request(app).get('/api/platform/reconciliation?type=ASN').set(auth(token));
    expect(after.body.rows.map((r) => r.id)).not.toContain(first.body.asn.id);
  });
});

describe('attachments', () => {
  const upload = (token, name) => request(app).post('/api/uploads').set(auth(token))
    .field('linkedTo', 'ASN').attach('file', Buffer.from('%PDF-1.4 packing list'), name);

  it('records which shipment a packing list belongs to, and returns it with the shipment', async () => {
    const a = await acknowledgedOrder();
    const doc = await upload(a.token, 'packing-list.pdf');
    expect(doc.status).toBe(201);

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }], { documentIds: [doc.body.documentId] }));

    expect(res.status).toBe(201);
    expect(res.body.asn.documents).toEqual([expect.objectContaining({ documentId: doc.body.documentId, originalName: 'packing-list.pdf' })]);
    const listed = await request(app).get('/api/asns').set(auth(a.token));
    expect(listed.body.asns[0].documents).toHaveLength(1);
  });

  it('refuses another supplier\'s document, and one already on another shipment', async () => {
    const a = await acknowledgedOrder();
    const b = await supplier('b');
    const theirs = await upload(b.token, 'theirs.pdf');
    const mine = await upload(a.token, 'mine.pdf');

    const stolen = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }], { documentIds: [theirs.body.documentId] }));
    expect(stolen.status).toBe(400);

    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }], { documentIds: [mine.body.documentId] }))).status).toBe(201);
    const reused = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }], { documentIds: [mine.body.documentId] }));
    expect(reused.status).toBe(400);
  });
});

describe('the goods receipt', () => {
  it('records what SAP received on each shipped line, and the shortfall', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));

    await receive(first.body.asn, { grnId: 'GRN-2026-5000000001', items: [{ line: 10, receivedQuantity: 38, acceptedQuantity: 38, rejectedQuantity: 0, uom: 'EA' }] });

    const [asn] = (await request(app).get('/api/pos/PO-2026-ASN1/asn').set(auth(a.token))).body;
    expect(asn.status).toBe('Received');
    expect(asn.items[0]).toMatchObject({ shippedQuantity: 40, receivedQuantity: 38, receiptVariance: -2 });
  });

  it('does not adopt a receipt already recorded against a different shipment on the same order', async () => {
    const a = await acknowledgedOrder();
    const first = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    const second = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 40 }]));
    const items = [{ line: 10, receivedQuantity: 40, acceptedQuantity: 40, rejectedQuantity: 0, uom: 'EA' }];
    await receive(first.body.asn, { grnId: 'GRN-2026-5000000001', items });

    // The driver offers the second shipment the first one's receipt.
    await expect(receive(second.body.asn, { grnId: 'GRN-2026-5000000001', items })).rejects.toThrow(/already recorded against/);

    const stillWaiting = await asTenant(() => prisma.aSN.findFirst({ where: { id: second.body.asn.id } }));
    expect(stillWaiting.status).toBe('Submitted');
    expect(stillWaiting.sapSyncState).toBe('pending');
  });
});

describe('shipment details (screen V4 rules)', () => {
  it('needs the transporter, and an LR / docket number or a vehicle number', async () => {
    const a = await acknowledgedOrder();
    const base = shipment([{ line: 10, shippedQuantity: 1 }]);

    const noTransporter = await submit(a.token, 'PO-2026-ASN1', { ...base, carrierName: undefined });
    const noReference = await submit(a.token, 'PO-2026-ASN1', { ...base, trackingNumber: undefined });
    const vehicleOnly = await submit(a.token, 'PO-2026-ASN1', { ...base, trackingNumber: undefined, vehicleNumber: 'hr 55 ab 1234' });

    expect(noTransporter.status).toBe(400);
    expect(noReference.status).toBe(400);
    expect(vehicleOnly.status).toBe(201);
    expect(vehicleOnly.body.asn.vehicleNumber).toBe('HR55AB1234');
  });

  it('accepts a Bharat-series vehicle and refuses one that is not a registration', async () => {
    const a = await acknowledgedOrder();

    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 1 }], { vehicleNumber: '22BH1234AB' }))).status).toBe(201);
    expect((await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 1 }], { vehicleNumber: 'TRUCK1' }))).status).toBe(400);
  });

  it('checks dates against dispatch, and taxable value against the total', async () => {
    const a = await acknowledgedOrder();
    const line = [{ line: 10, shippedQuantity: 1 }];
    const ship = '2026-11-20T00:00:00.000Z';

    const late = await submit(a.token, 'PO-2026-ASN1', shipment(line, { shipDate: ship, invoiceDate: '2026-11-21T00:00:00.000Z' }));
    const arrivesFirst = await submit(a.token, 'PO-2026-ASN1', shipment(line, { shipDate: ship, invoiceDate: ship, estimatedDeliveryDate: '2026-11-19T00:00:00.000Z' }));
    const taxable = await submit(a.token, 'PO-2026-ASN1', shipment(line, { invoiceValue: 100, taxableValue: 120 }));

    expect(late.body.errors).toHaveProperty('invoiceDate');
    expect(arrivesFirst.body.errors).toHaveProperty('estimatedDeliveryDate');
    expect(taxable.body.errors).toHaveProperty('taxableValue');
  });

  it('keeps the rest of the details screen', async () => {
    const a = await acknowledgedOrder();

    const res = await submit(a.token, 'PO-2026-ASN1', shipment([{ line: 10, shippedQuantity: 1 }], {
      invoiceValue: 1180, taxableValue: 1000, arrivalTime: '10:30', vehicleType: 'Truck - closed body',
      driverMobile: '+91 98765 43210', transporterGstin: '27abcde1234f1z5', packages: 4, grossWeightKg: 120.5,
    }));

    expect(res.status).toBe(201);
    expect(res.body.asn).toMatchObject({
      taxableValue: 1000, arrivalTime: '10:30', vehicleType: 'Truck - closed body',
      driverMobile: '+919876543210', transporterGstin: '27ABCDE1234F1Z5', packages: 4, grossWeightKg: 120.5,
    });
  });
});
