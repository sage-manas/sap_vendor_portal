// Smoke test for controllers/po.controller.js's Prisma port — PO lifecycle
// (acknowledge -> ASN -> simulated goods receipt -> GRN) and the invoice-plan
// sub-resource (the 3-level-deep PurchaseOrderItem/InvoicePlan/
// InvoicePlanLine structure), against the real dev Postgres.
process.env.NODE_ENV = 'test'; // mock SAP driver runs goods-receipt instantly
process.env.SAP_MOCK_MODE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const {
  getPOs, getPOById, acknowledgePO, submitASN, getASNForPO,
  getInvoicePlan, configureInvoicePlan, removeInvoicePlan, setInvoicePlanLineBlock,
} = require('../controllers/po.controller');

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (likely inside the fire-and-forget awaitGoodsReceipt callback):', err);
});

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
  await rawPrisma.gRN.deleteMany({});
  await rawPrisma.aSN.deleteMany({});
  await rawPrisma.invoicePlanLine.deleteMany({});
  await rawPrisma.invoicePlan.deleteMany({});
  await rawPrisma.purchaseOrderItem.deleteMany({});
  await rawPrisma.purchaseOrder.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();
  await withoutTenantScope(() => rawPrisma.client.create({
    data: { clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy', status: 'Active' },
  }));
  const vendor = await runWithTenant('CLT-0001', () => prisma.vendor.create({
    data: { vendorId: 'VND-AAAAA', companyName: 'Vendor A', gstin: '27AABCB1234F1Z5', pan: 'AABCB1234F', email: 'a@example.com' },
  }));

  const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-0001', vendorId: 'VND-AAAAA', vendorPk: vendor.pk, status: 'Open',
      items: {
        create: [
          { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', quantity: 10, unitPrice: 100, netValue: 1000 },
          { clientId: 'CLT-0001', line: 20, materialCode: 'MAT-2', quantity: 5, unitPrice: 200, netValue: 1000 },
        ],
      },
    },
    include: { items: true },
  }));

  await test('getPOById returns items with a default (disabled) invoicePlan shape', async () => {
    const req = fakeReq({ params: { id: po.id } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getPOById(req, res, capturedNext()));
    assert.strictEqual(res.body.items.length, 2);
    assert.deepStrictEqual(res.body.items[0].invoicePlan, { enabled: false });
  });

  await test('acknowledgePO moves Open -> Acknowledged', async () => {
    const req = fakeReq({ params: { id: po.id }, clientId: 'CLT-0001' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => acknowledgePO(req, res, capturedNext()));
    assert.strictEqual(res.body.po.status, 'Acknowledged');
  });

  let asnId;
  await test('submitASN validates remaining quantity and moves PO to Dispatched', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA', clientId: 'CLT-0001', params: { id: po.id },
      body: { items: [{ line: 10, shippedQuantity: 10 }, { line: 20, shippedQuantity: 5 }] },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => submitASN(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    asnId = res.body.asn.id;

    const updatedPo = await runWithTenant('CLT-0001', () => rawPrisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    assert.strictEqual(updatedPo.status, 'Dispatched');
  });

  await test('submitASN rejects a shipped quantity exceeding what remains', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA', clientId: 'CLT-0001', params: { id: po.id },
      body: { items: [{ line: 10, shippedQuantity: 999 }] },
    });
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => submitASN(req, fakeRes(), next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('the simulated goods receipt lands: GRN created, ASN Received, PO Delivered, grnQuantity updated', async () => {
    // The mock driver's awaitGoodsReceipt fires on a 0ms timer under
    // NODE_ENV=test but is still async — give the event loop a tick.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const asn = await runWithTenant('CLT-0001', () => rawPrisma.aSN.findFirst({ where: { id: asnId } }));
    assert.strictEqual(asn.status, 'Received');

    const grn = await runWithTenant('CLT-0001', () => rawPrisma.gRN.findFirst({ where: { asnId }, include: { items: true } }));
    assert.ok(grn, 'a GRN must have been created');
    assert.strictEqual(grn.items.length, 2);

    const updatedPo = await runWithTenant('CLT-0001', () => rawPrisma.purchaseOrder.findFirst({
      where: { pk: po.pk }, include: { items: true },
    }));
    assert.strictEqual(updatedPo.status, 'Delivered');
    assert.ok(updatedPo.items.find((i) => i.line === 10).grnQuantity > 0);
  });

  await test('getASNForPO returns the ASN with its items', async () => {
    const req = fakeReq({ params: { id: po.id } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getASNForPO(req, res));
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].items.length, 2);
  });

  // --- Invoice plan sub-resource ---

  await test('configureInvoicePlan builds a Periodic plan and persists it relationally', async () => {
    const req = fakeReq({
      clientId: 'CLT-0001', params: { id: po.id, line: '10' },
      body: { type: 'Periodic', startDate: '2026-01-01', endDate: '2026-04-01', frequency: 'Monthly', periodicAmount: 100 },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => configureInvoicePlan(req, res, capturedNext()));
    assert.strictEqual(res.body.item.plan.enabled, true);
    assert.strictEqual(res.body.item.plan.lines.length, 3);
    assert.strictEqual(res.body.item.summary.totalLines, 3);

    const planRow = await rawPrisma.invoicePlan.findFirst({ where: { item: { line: 10, po: { pk: po.pk } } }, include: { lines: true } });
    assert.strictEqual(planRow.lines.length, 3);
  });

  await test('getInvoicePlan reports the configured line and its billable dates', async () => {
    const req = fakeReq({ params: { id: po.id } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getInvoicePlan(req, res, capturedNext()));
    assert.strictEqual(res.body.invoicePlanningEnabled, true);
    assert.strictEqual(res.body.items.length, 1);
    assert.strictEqual(res.body.items[0].line, 10);
    // All 3 settlement dates are in the past relative to "now" run against
    // 2026 fixture dates only if the test clock is after them — just assert
    // the shape rather than a specific due count, which depends on today's date.
    assert.ok(Array.isArray(res.body.billable));
  });

  await test('reconfiguring the plan replaces lines wholesale without leaving orphan rows', async () => {
    const req = fakeReq({
      clientId: 'CLT-0001', params: { id: po.id, line: '10' },
      body: { type: 'Periodic', startDate: '2026-01-01', endDate: '2026-07-01', frequency: 'Monthly', periodicAmount: 100 },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => configureInvoicePlan(req, res, capturedNext()));
    assert.strictEqual(res.body.item.plan.lines.length, 6);

    const planRow = await rawPrisma.invoicePlan.findFirst({ where: { item: { line: 10, po: { pk: po.pk } } }, include: { lines: true } });
    assert.strictEqual(planRow.lines.length, 6, 'old 3-line schedule must be fully replaced, not appended to');
  });

  await test('setInvoicePlanLineBlock blocks a due-date line', async () => {
    const planRow = await rawPrisma.invoicePlan.findFirst({ where: { item: { line: 10, po: { pk: po.pk } } }, include: { lines: true } });
    const firstLine = planRow.lines[0];

    const req = fakeReq({
      params: { id: po.id, line: '10', lineNumber: String(firstLine.lineNumber) },
      body: { blocked: true },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => setInvoicePlanLineBlock(req, res, capturedNext()));
    assert.strictEqual(res.body.item.plan.lines.find((l) => l.lineNumber === firstLine.lineNumber).blocked, true);
  });

  await test('removeInvoicePlan disables the plan (no invoiced lines yet, so it is allowed)', async () => {
    const req = fakeReq({ params: { id: po.id, line: '10' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => removeInvoicePlan(req, res, capturedNext()));

    const getReq = fakeReq({ params: { id: po.id } });
    const getRes = fakeRes();
    await runWithTenant('CLT-0001', () => getInvoicePlan(getReq, getRes, capturedNext()));
    assert.strictEqual(getRes.body.invoicePlanningEnabled, false);
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
