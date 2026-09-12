// Smoke test for controllers/rfq.controller.js's Prisma port — the most
// structurally-changed model (embedded items/bids/invitedVendors became
// child tables). Exercises the full lifecycle: create -> bid -> evaluate ->
// award -> PO creation, against the real dev Postgres.
const assert = require('assert');
const { rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const {
  getRFQs, getRFQById, createRFQ, submitBid, getEvaluationMatrix, awardBid, cancelRFQ, reissueRFQ,
} = require('../controllers/rfq.controller');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
};

const fakeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const fakeReq = (overrides = {}) => ({
  ip: '127.0.0.1', query: {}, body: {}, params: {}, app: { get: () => null }, ...overrides,
});
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.purchaseOrderItem.deleteMany({});
  await rawPrisma.purchaseOrder.deleteMany({});
  await rawPrisma.rfqBidUnitPrice.deleteMany({});
  await rawPrisma.rfqBidDocument.deleteMany({});
  await rawPrisma.rfqBid.deleteMany({});
  await rawPrisma.rfqInvitedVendor.deleteMany({});
  await rawPrisma.rfqItem.deleteMany({});
  await rawPrisma.rFQ.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();
  const client = await withoutTenantScope(() => rawPrisma.client.create({
    data: {
      clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy', status: 'Active',
      limitRfqsPerMonth: 100,
    },
  }));

  const vendorA = await runWithTenant('CLT-0001', () => rawPrisma.vendor.create({
    data: { clientId: 'CLT-0001', vendorId: 'VND-AAAAA', companyName: 'Vendor A', gstin: '27AABCB1234F1Z5', pan: 'AABCB1234F', email: 'a@example.com' },
  }));
  const vendorB = await runWithTenant('CLT-0001', () => rawPrisma.vendor.create({
    data: { clientId: 'CLT-0001', vendorId: 'VND-BBBBB', companyName: 'Vendor B', gstin: '27AABCB1234F1Z6', pan: 'AABCB1234G', email: 'b@example.com' },
  }));

  let rfqId;
  await test('createRFQ creates an RFQ with items and invited vendors', async () => {
    const req = fakeReq({
      client,
      body: {
        description: 'Bearings', deadlineDate: new Date(Date.now() + 86400000).toISOString(),
        items: [{ line: 10, materialCode: 'MAT-1', quantity: 5 }, { line: 20, materialCode: 'MAT-2', quantity: 10 }],
        invitedVendors: [{ id: 'VND-AAAAA', name: 'Vendor A' }, { id: 'VND-BBBBB', name: 'Vendor B' }],
      },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => createRFQ(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.match(res.body.id, /^RFQ-\d{4}-001$/);
    assert.strictEqual(res.body.items.length, 2);
    assert.strictEqual(res.body.invitedVendors.length, 2);
    assert.strictEqual(res.body.status, 'Bidding Open');
    rfqId = res.body.id;
  });

  await test('a second createRFQ increments the sequential id', async () => {
    const req = fakeReq({
      client,
      body: { description: 'Second', deadlineDate: new Date(Date.now() + 86400000).toISOString(), items: [{ line: 10, materialCode: 'MAT-3', quantity: 1 }] },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => createRFQ(req, res, capturedNext()));
    assert.match(res.body.id, /^RFQ-\d{4}-002$/);
  });

  await test('getRFQById returns the reconstructed nested shape', async () => {
    const req = fakeReq({ params: { id: rfqId } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getRFQById(req, res, capturedNext()));
    assert.strictEqual(res.body.items[0].materialCode, 'MAT-1');
    assert.strictEqual(res.body.invitedVendors[0].id, 'VND-AAAAA');
  });

  await test('submitBid from an invited vendor prices all lines and keeps status Bidding Open', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA', params: { id: rfqId },
      body: { unitPrices: { 10: 100, 20: 50 }, gstRate: 18, freight: 20, deliveryLeadTimeDays: 5 },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => submitBid(req, res, capturedNext()));
    assert.strictEqual(res.body.bidsCount, 1);

    const rfq = await runWithTenant('CLT-0001', () => rawPrisma.rFQ.findFirst({ where: { id: rfqId } }));
    assert.strictEqual(rfq.status, 'Bidding Open');
  });

  await test('submitBid rejects a bid missing a line price', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-BBBBB', params: { id: rfqId },
      body: { unitPrices: { 10: 90 }, gstRate: 18 }, // missing line 20
    });
    const res = fakeRes();
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => submitBid(req, res, next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('a second invited vendor can also bid once the RFQ stays Bidding Open', async () => {
    const reqB = fakeReq({
      scopeVendorId: 'VND-BBBBB', params: { id: rfqId },
      body: { unitPrices: { 10: 80, 20: 40 }, gstRate: 18, freight: 0, deliveryLeadTimeDays: 3 },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => submitBid(reqB, res, capturedNext()));
    assert.strictEqual(res.body.bidsCount, 2);
  });

  await test('getEvaluationMatrix scores both bids that were actually accepted', async () => {
    const req = fakeReq({ params: { id: rfqId } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getEvaluationMatrix(req, res, capturedNext()));
    assert.strictEqual(res.body.evaluation.length, 2);
    assert.deepStrictEqual(
      res.body.evaluation.map((e) => e.vendorId).sort(),
      ['VND-AAAAA', 'VND-BBBBB'],
    );
  });

  await test('awardBid creates a PO with the winning bid\'s prices and marks the RFQ Awarded', async () => {
    const req = fakeReq({ params: { id: rfqId }, body: { vendorId: 'VND-AAAAA' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => awardBid(req, res, capturedNext()));
    assert.match(res.body.po.id, /^PO-\d{4}-0001$/);
    assert.strictEqual(res.body.po.items.length, 2);
    assert.strictEqual(res.body.po.items.find((i) => i.line === 10).unitPrice, 100);
    assert.strictEqual(res.body.po.vendorPk, vendorA.pk);

    const rfq = await runWithTenant('CLT-0001', () => rawPrisma.rFQ.findFirst({ where: { id: rfqId } }));
    assert.strictEqual(rfq.status, 'Awarded');
    assert.strictEqual(rfq.convertedPoId, res.body.po.id);
  });

  await test('awardBid on an already-awarded RFQ is rejected', async () => {
    const req = fakeReq({ params: { id: rfqId }, body: { vendorId: 'VND-AAAAA' } });
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => awardBid(req, fakeRes(), next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('cancelRFQ and reissueRFQ transition status on a fresh RFQ', async () => {
    const listReq = fakeReq({ query: { all: 'true' } });
    const listRes = fakeRes();
    await runWithTenant('CLT-0001', () => getRFQs(listReq, listRes));
    const secondRfq = listRes.body.rfqs.find((r) => r.description === 'Second');

    const cancelRes = fakeRes();
    await runWithTenant('CLT-0001', () => cancelRFQ(fakeReq({ params: { id: secondRfq.id } }), cancelRes, capturedNext()));
    assert.strictEqual(cancelRes.body.rfq.status, 'Closed');

    const reissueRes = fakeRes();
    await runWithTenant('CLT-0001', () => reissueRFQ(
      fakeReq({ params: { id: secondRfq.id }, body: { deadlineDate: new Date(Date.now() + 172800000).toISOString() } }),
      reissueRes, capturedNext(),
    ));
    assert.strictEqual(reissueRes.body.rfq.status, 'Bidding Open');
  });

  await test('getRFQs scoped to a vendor only returns RFQs they were invited to', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getRFQs(req, res));
    assert.ok(res.body.rfqs.every((r) => r.invitedVendors.some((v) => v.id === 'VND-AAAAA')));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await resetDb();
  await rawPrisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await rawPrisma.$disconnect();
  process.exit(1);
});
