// Smoke test for controllers/invoice.controller.js + payment.controller.js's
// Prisma port — GRN-matched invoice submission through simulated payment
// clearing, and the plan-based invoice path, against the real dev Postgres.
process.env.NODE_ENV = 'test'; // mock SAP driver runs payment-run instantly
process.env.SAP_MOCK_MODE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const { submitInvoice, submitPlanInvoice, getInvoices } = require('../controllers/invoice.controller');
const { getPayments, getTdsSummary, createPayment, updatePaymentStatus } = require('../controllers/payment.controller');
const { configureInvoicePlan } = require('../controllers/po.controller');

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION (likely inside a fire-and-forget SAP callback):', err);
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
  ip: '127.0.0.1', query: {}, body: {}, params: {}, app: { get: () => null }, clientId: 'CLT-0001', ...overrides,
});
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.payment.deleteMany({});
  await rawPrisma.invoiceItem.deleteMany({});
  await rawPrisma.invoice.deleteMany({});
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
      id: 'PO-2026-0001', vendorId: 'VND-AAAAA', vendorPk: vendor.pk, status: 'Delivered',
      items: {
        create: [
          { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', quantity: 10, grnQuantity: 10, unitPrice: 100, netValue: 1000 },
        ],
      },
    },
  }));

  await runWithTenant('CLT-0001', () => prisma.aSN.create({
    data: {
      id: 'ASN-1', poId: po.id, vendorId: 'VND-AAAAA', status: 'Received',
      shipDate: new Date(), estimatedDeliveryDate: new Date(),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', shippedQuantity: 10 }] },
    },
  }));

  const grn = await runWithTenant('CLT-0001', () => prisma.gRN.create({
    data: {
      id: 'GRN-1', poId: po.id, asnId: 'ASN-1', vendorId: 'VND-AAAAA', postingDate: new Date(),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', receivedQuantity: 10, acceptedQuantity: 10 }] },
    },
  }));

  let invoiceId;
  await test('submitInvoice records a 3-way-matched invoice with no warnings', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA',
      body: {
        grnId: grn.id, invoiceNumber: 'INV-VENDOR-1', invoiceDate: '2026-01-15',
        subTotal: 1000, taxAmount: 180, totalAmount: 1180,
        items: [{ line: 10, materialCode: 'MAT-1', quantity: 10, unitPrice: 100, amount: 1000 }],
      },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => submitInvoice(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.invoice.status, 'Submitted');
    invoiceId = res.body.invoice.id;

    const updatedGrn = await runWithTenant('CLT-0001', () => rawPrisma.gRN.findFirst({ where: { pk: grn.pk } }));
    assert.strictEqual(updatedGrn.invoiceSubmitted, true);
    const updatedPo = await runWithTenant('CLT-0001', () => rawPrisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    assert.strictEqual(updatedPo.status, 'Invoiced');
  });

  await test('submitInvoice refuses a second invoice against the same GRN', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA',
      body: {
        grnId: grn.id, invoiceNumber: 'INV-VENDOR-2', invoiceDate: '2026-01-16',
        subTotal: 1000, taxAmount: 180, totalAmount: 1180,
        items: [{ line: 10, materialCode: 'MAT-1', quantity: 10, unitPrice: 100, amount: 1000 }],
      },
    });
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => submitInvoice(req, fakeRes(), next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('the simulated payment run clears the invoice and creates a Payment', async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The mock driver's awaitPaymentRun answer carries no sapMiroDoc (only the
    // real getSapInvoiceStatus reconciliation path ever discovers and writes
    // one) — clearing alone must not invent one.
    const invoice = await runWithTenant('CLT-0001', () => rawPrisma.invoice.findFirst({ where: { id: invoiceId } }));
    assert.strictEqual(invoice.status, 'Cleared');

    const payment = await runWithTenant('CLT-0001', () => rawPrisma.payment.findFirst({ where: { invoiceId } }));
    assert.ok(payment, 'a Payment row must have been created');
    assert.strictEqual(payment.grossAmount, 1180);
    assert.ok(payment.netAmount < payment.grossAmount, 'TDS should have been deducted');

    const updatedPo = await runWithTenant('CLT-0001', () => rawPrisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    assert.strictEqual(updatedPo.status, 'Paid', 'a GRN-matched invoice clearing should move the PO to Paid');
  });

  await test('getPayments and getTdsSummary reflect the cleared payment', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getPayments(req, res));
    assert.strictEqual(res.body.payments.length, 1);

    const tdsRes = fakeRes();
    await runWithTenant('CLT-0001', () => getTdsSummary(fakeReq({ scopeVendorId: 'VND-AAAAA' }), tdsRes));
    assert.strictEqual(tdsRes.body.quarters.length, 1);
    assert.ok(tdsRes.body.quarters[0].taxWithheld > 0);
  });

  // --- Plan-based invoice path ---

  let planPo;
  await test('a Periodic invoicing plan produces a billable line, and submitPlanInvoice bills it', async () => {
    planPo = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-2026-0002', vendorId: 'VND-AAAAA', vendorPk: vendor.pk, status: 'Acknowledged',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-SVC', quantity: 1, unitPrice: 500, netValue: 500 }] },
      },
    }));

    const past = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const configReq = fakeReq({
      params: { id: planPo.id, line: '10' },
      body: { type: 'Periodic', startDate: past, endDate: soon, frequency: 'Monthly', periodicAmount: 500 },
    });
    await runWithTenant('CLT-0001', () => configureInvoicePlan(configReq, fakeRes(), capturedNext()));

    const planRow = await rawPrisma.invoicePlan.findFirst({ where: { item: { line: 10, po: { pk: planPo.pk } } }, include: { lines: true } });
    const dueLine = planRow.lines.find((l) => l.status === 'Open');
    assert.ok(dueLine, 'the plan must have at least one due line to bill');

    const billReq = fakeReq({
      scopeVendorId: 'VND-AAAAA',
      body: { poId: planPo.id, line: 10, planLineNumber: dueLine.lineNumber, invoiceNumber: 'INV-PLAN-1', invoiceDate: new Date().toISOString() },
    });
    const billRes = fakeRes();
    await runWithTenant('CLT-0001', () => submitPlanInvoice(billReq, billRes, capturedNext()));
    assert.strictEqual(billRes.statusCode, 201);
    assert.strictEqual(billRes.body.invoice.subTotal, 500);

    const updatedLine = await rawPrisma.invoicePlanLine.findFirst({ where: { planPk: planRow.pk, lineNumber: dueLine.lineNumber } });
    assert.strictEqual(updatedLine.status, 'Invoiced');
    assert.strictEqual(updatedLine.invoiceId, billRes.body.invoice.id);
  });

  await test('the plan invoice clears via payment run without moving the PO to Paid', async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const invoice = await runWithTenant('CLT-0001', () => rawPrisma.invoice.findFirst({ where: { poId: planPo.id } }));
    assert.strictEqual(invoice.status, 'Cleared');

    const stillOpenPo = await runWithTenant('CLT-0001', () => rawPrisma.purchaseOrder.findFirst({ where: { pk: planPo.pk } }));
    assert.strictEqual(stillOpenPo.status, 'Acknowledged', 'a plan invoice must not overwrite the PO\'s own status');

    const planLine = await rawPrisma.invoicePlanLine.findFirst({ where: { invoiceId: invoice.id } });
    assert.strictEqual(planLine.status, 'Invoiced');
  });

  await test('createPayment and updatePaymentStatus (a pre-existing no-op) behave as before', async () => {
    // invoiceId/poId are real FKs now (an improvement over Mongoose, which
    // enforced neither) — this ad hoc creation endpoint needs a real invoice
    // to point at, so it references the one submitInvoice created earlier.
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA', body: { invoiceId, poId: po.id, netAmount: 100, paymentDate: new Date().toISOString(), utrCode: 'UTR1' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => createPayment(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.match(res.body.id, /^PMT-/);

    const statusReq = fakeReq({ params: { id: res.body.id }, body: { status: 'Whatever' } });
    const statusRes = fakeRes();
    await runWithTenant('CLT-0001', () => updatePaymentStatus(statusReq, statusRes, capturedNext()));
    assert.strictEqual(statusRes.body.payment.status, 'Whatever', 'returned in the response, per the pre-existing (non-persisting) behavior');

    const stored = await runWithTenant('CLT-0001', () => rawPrisma.payment.findFirst({ where: { id: res.body.id } }));
    assert.strictEqual('status' in stored, false, 'Payment has no status column — nothing should have persisted');
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
