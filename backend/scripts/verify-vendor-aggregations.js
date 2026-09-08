// Smoke test for vendor.controller.js's getVendorById / getPerformance —
// the two Phase 2 raw-SQL aggregation handlers, against the real dev Postgres.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const { getVendorById, getPerformance } = require('../controllers/vendor.controller');

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
const fakeReq = (overrides = {}) => ({ ip: '127.0.0.1', query: {}, body: {}, params: {}, ...overrides });
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.payment.deleteMany({});
  await rawPrisma.invoiceItem.deleteMany({});
  await rawPrisma.invoice.deleteMany({});
  await rawPrisma.gRN.deleteMany({});
  await rawPrisma.aSN.deleteMany({});
  await rawPrisma.rfqInvitedVendor.deleteMany({});
  await rawPrisma.rFQ.deleteMany({});
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
  // A second tenant with its own vendor/PO of the same shape — proves the
  // raw SQL's explicit clientId filter actually isolates tenants, since
  // $queryRaw bypasses the Prisma extension.
  await withoutTenantScope(() => rawPrisma.client.create({
    data: { clientId: 'CLT-0002', slug: 'other', companyName: 'Other', status: 'Active' },
  }));

  const vendor = await runWithTenant('CLT-0001', () => prisma.vendor.create({
    data: { vendorId: 'VND-AAAAA', companyName: 'Vendor A', gstin: '27AABCB1234F1Z5', pan: 'AABCB1234F', email: 'a@example.com' },
  }));
  await runWithTenant('CLT-0002', () => prisma.vendor.create({
    data: { vendorId: 'VND-AAAAA-OTHER', companyName: 'Same vendorId elsewhere', gstin: '27AABCB1234F1Z9', pan: 'AABCB1234H', email: 'other@example.com' },
  }));

  // PO #1: Open, 2 line items totalling 1500.
  await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-0001', vendorId: 'VND-AAAAA', vendorPk: vendor.pk, status: 'Open',
      items: { create: [
        { clientId: 'CLT-0001', line: 10, materialCode: 'M1', quantity: 10, unitPrice: 100, netValue: 1000 },
        { clientId: 'CLT-0001', line: 20, materialCode: 'M2', quantity: 5, unitPrice: 100, netValue: 500 },
      ] },
    },
  }));
  // PO #2: Delivered, 1 line item of 300 — a different status bucket.
  const po2 = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-0002', vendorId: 'VND-AAAAA', vendorPk: vendor.pk, status: 'Delivered',
      createdDate: new Date('2026-01-01'),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'M3', quantity: 3, unitPrice: 100, netValue: 300 }] },
    },
  }));

  // A polluting PO in the OTHER tenant, same vendorId string — must not leak
  // into CLT-0001's totals.
  await runWithTenant('CLT-0002', () => prisma.purchaseOrder.create({
    data: { id: 'PO-2026-9999', vendorId: 'VND-AAAAA', status: 'Open',
      items: { create: [{ clientId: 'CLT-0002', line: 10, materialCode: 'X', quantity: 1, unitPrice: 999999, netValue: 999999 }] } },
  }));

  // Invoice.grnId/invoicePlanRef are an XOR (a real DB CHECK constraint added
  // during the migration) — these are plan-style invoices for test simplicity,
  // since manufacturing a real GRN for each would be unnecessary ceremony here.
  const fakePlanRef = { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() };
  await runWithTenant('CLT-0001', () => prisma.invoice.create({
    data: {
      id: 'INV-1', poId: po2.id, vendorId: 'VND-AAAAA', invoiceNumber: 'V-1', invoiceDate: new Date(),
      status: 'Cleared', subTotal: 300, taxAmount: 54, totalAmount: 354, invoicePlanRef: fakePlanRef,
    },
  }));
  await runWithTenant('CLT-0001', () => prisma.invoice.create({
    data: {
      id: 'INV-2', poId: po2.id, vendorId: 'VND-AAAAA', invoiceNumber: 'V-2', invoiceDate: new Date(),
      status: 'Match Warning', matchWarning: 'price variance', subTotal: 100, taxAmount: 18, totalAmount: 118,
      invoicePlanRef: { ...fakePlanRef, planLineNumber: 2 },
    },
  }));

  await runWithTenant('CLT-0001', () => prisma.payment.create({
    data: {
      id: 'PMT-1', invoiceId: 'INV-1', poId: po2.id, vendorId: 'VND-AAAAA',
      grossAmount: 354, tdsDeducted: 3.54, netAmount: 350.46, paymentDate: new Date(), utrCode: 'UTR1',
    },
  }));

  await runWithTenant('CLT-0001', () => prisma.rFQ.create({
    data: {
      id: 'RFQ-2026-001', description: 'Test', deadlineDate: new Date(Date.now() + 86400000),
      invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: 'VND-AAAAA', name: 'Vendor A' }] },
    },
  }));

  await runWithTenant('CLT-0001', () => prisma.aSN.create({
    data: {
      id: 'ASN-1', poId: po2.id, vendorId: 'VND-AAAAA', status: 'Received',
      shipDate: new Date('2025-12-25'), estimatedDeliveryDate: new Date('2025-12-30'), // before po2.createdDate 2026-01-01 -> on time
    },
  }));
  await runWithTenant('CLT-0001', () => prisma.gRN.create({
    data: {
      id: 'GRN-1', poId: po2.id, asnId: 'ASN-1', vendorId: 'VND-AAAAA', postingDate: new Date(),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'M3', receivedQuantity: 10, acceptedQuantity: 9, rejectedQuantity: 1 }] },
    },
  }));

  await test('getVendorById aggregates PO status counts/values and stays tenant-isolated', async () => {
    const req = fakeReq({ params: { id: 'VND-AAAAA' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getVendorById(req, res, capturedNext()));

    assert.strictEqual(res.body.activity.purchaseOrders.total, 2);
    assert.strictEqual(res.body.activity.purchaseOrders.value, 1800, 'must not include the other tenant\'s 999999 PO');
    assert.strictEqual(res.body.activity.purchaseOrders.byStatus.Open.count, 1);
    assert.strictEqual(res.body.activity.purchaseOrders.byStatus.Open.value, 1500);
    assert.strictEqual(res.body.activity.purchaseOrders.byStatus.Delivered.value, 300);
  });

  await test('getVendorById aggregates invoice status counts/values', async () => {
    const req = fakeReq({ params: { id: 'VND-AAAAA' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getVendorById(req, res, capturedNext()));
    assert.strictEqual(res.body.activity.invoices.total, 2);
    assert.strictEqual(res.body.activity.invoices.value, 472);
    assert.strictEqual(res.body.activity.invoices.byStatus.Cleared.count, 1);
  });

  await test('getVendorById aggregates payment totals, RFQ invitations, GRN/ASN counts', async () => {
    const req = fakeReq({ params: { id: 'VND-AAAAA' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getVendorById(req, res, capturedNext()));
    assert.strictEqual(res.body.activity.payments.total, 1);
    assert.strictEqual(res.body.activity.payments.grossPaid, 354);
    assert.strictEqual(res.body.activity.rfqInvitations, 1);
    assert.strictEqual(res.body.activity.goodsReceipts, 1);
    assert.strictEqual(res.body.activity.shipments, 1);
    assert.strictEqual(res.body.recentOrders.length, 2);
  });

  await test('getVendorById by pk resolves the same vendor as by vendorId', async () => {
    const req = fakeReq({ params: { id: vendor.pk } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getVendorById(req, res, capturedNext()));
    assert.strictEqual(res.body.vendor.vendorId, 'VND-AAAAA');
  });

  await test('getPerformance computes quality/OTIF/invoice-accuracy and a grade', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getPerformance(req, res, capturedNext()));
    // 9/10 accepted -> 90% quality; 1/1 on-time ASN -> 100% OTIF; 1/2 invoices
    // warning-free -> 50% invoice accuracy.
    assert.strictEqual(res.body.qualityAcceptance, 90);
    assert.strictEqual(res.body.deliveryOTIF, 100);
    assert.strictEqual(res.body.invoiceAccuracy, 50);
    const expectedScore = Math.round(((90 * 0.4) + (100 * 0.4) + (50 * 0.2)) * 100) / 100;
    assert.strictEqual(res.body.weightedScore, expectedScore);
    assert.ok(['A', 'B', 'C', 'D'].includes(res.body.grade));
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
