const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

// The dashboards a client_admin, a buyer and a finance user rely on all trust
// one contract: "call this list endpoint with no vendorId and get every
// vendor's records." Nothing enforces that on purpose — it falls out of
// `withVendorScope`/`vendorScope` returning no filter when `req.scopeVendorId`
// is null (see utils/requestScope.js). That is correct today, but it is an
// absence, not a designed code path, so nothing previously asserted it stays
// true. These tests exist so a change that narrows staff visibility again
// (e.g. defaulting a missing vendorId to the caller's own) fails here first,
// rather than as a support ticket from a buyer who can suddenly see only one
// supplier's RFQs.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const soon = () => new Date(Date.now() + 86400000);

const seedTradeFor = (vendorId, suffix) => asTenant(async () => {
  await prisma.rFQ.create({ data: { id: `RFQ-2026-${suffix}`, description: `RFQ for ${vendorId}`, deadlineDate: soon() } });
  await prisma.purchaseOrder.create({ data: { id: `PO-2026-${suffix}`, vendorId } });
  await prisma.invoice.create({
    data: {
      id: `INV-${suffix}`, poId: `PO-2026-${suffix}`, vendorId,
      invoiceNumber: `INV/${suffix}`, invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
      // grnId and invoicePlanRef are mutually exclusive (a CHECK constraint,
      // not expressible in the Prisma schema itself) — this mirrors the
      // invoicing-plan-raised shape tests/tds-summary.test.js already uses,
      // rather than seeding a full PO→ASN→GRN chain this suite has no need for.
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
    },
  });
  await prisma.payment.create({
    data: {
      id: `PMT-${suffix}`, invoiceId: `INV-${suffix}`, poId: `PO-2026-${suffix}`, vendorId,
      netAmount: 118, grossAmount: 118, tdsDeducted: 0, paymentDate: new Date(), utrCode: `UTR-${suffix}`,
    },
  });
});

describe.each([
  ['client_admin', ROLES.CLIENT_ADMIN],
  ['buyer', ROLES.BUYER],
  ['finance', ROLES.FINANCE],
])('%s sees every vendor, not just one', (label, role) => {
  it(`GET /api/rfqs returns RFQs regardless of which vendor they were raised for (${label})`, async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_a1', gstin: '27AAAAA1111A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_b1', gstin: '27AAAAA1112A1Z1', email: 'b1@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'WA1');
    await seedTradeFor(b.vendorId, 'WB1');
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/rfqs').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.rfqs.map((r) => r.id)).toEqual(expect.arrayContaining(['RFQ-2026-WA1', 'RFQ-2026-WB1']));
  });

  it(`GET /api/pos returns purchase orders across vendors, unfiltered (${label})`, async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_a2', gstin: '27AAAAA1113A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_b2', gstin: '27AAAAA1114A1Z1', email: 'b2@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'WA2');
    await seedTradeFor(b.vendorId, 'WB2');
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/pos').set(auth(token));

    expect(res.status).toBe(200);
    const vendorIds = res.body.pos.map((po) => po.vendorId);
    expect(vendorIds).toEqual(expect.arrayContaining([a.vendorId, b.vendorId]));
  });

  it(`GET /api/invoices returns invoices across vendors, unfiltered (${label})`, async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_a3', gstin: '27AAAAA1115A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_b3', gstin: '27AAAAA1116A1Z1', email: 'b3@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'WA3');
    await seedTradeFor(b.vendorId, 'WB3');
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/invoices').set(auth(token));

    expect(res.status).toBe(200);
    const vendorIds = res.body.invoices.map((inv) => inv.vendorId);
    expect(vendorIds).toEqual(expect.arrayContaining([a.vendorId, b.vendorId]));
  });

  it(`GET /api/payments returns payments across vendors, unfiltered (${label})`, async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_a4', gstin: '27AAAAA1117A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_b4', gstin: '27AAAAA1118A1Z1', email: 'b4@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'WA4');
    await seedTradeFor(b.vendorId, 'WB4');
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/payments').set(auth(token));

    expect(res.status).toBe(200);
    const vendorIds = res.body.payments.map((p) => p.vendorId);
    expect(vendorIds).toEqual(expect.arrayContaining([a.vendorId, b.vendorId]));
  });

  it(`?vendorId= still narrows to one supplier when staff ask for it (${label})`, async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_a5', gstin: '27AAAAA1119A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_b5', gstin: '27AAAAA1120A1Z1', email: 'b5@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'WA5');
    await seedTradeFor(b.vendorId, 'WB5');
    const { token } = await createTenantUser({ role });

    const res = await request(app).get(`/api/pos?vendorId=${a.vendorId}`).set(auth(token));

    expect(res.body.pos.every((po) => po.vendorId === a.vendorId)).toBe(true);
    expect(res.body.pos.map((po) => po.vendorId)).not.toContain(b.vendorId);
  });
});

describe('a supplier sees only their own records, not any other vendor', () => {
  it('GET /api/pos and /api/invoices and /api/payments stay narrowed to the caller', async () => {
    const { token, vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_self1', gstin: '27AAAAA1121A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_self2', gstin: '27AAAAA1122A1Z1', email: 'self2@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'SA1');
    await seedTradeFor(b.vendorId, 'SB1');

    const pos = await request(app).get('/api/pos').set(auth(token));
    const invoices = await request(app).get('/api/invoices').set(auth(token));
    const payments = await request(app).get('/api/payments').set(auth(token));

    expect(pos.body.pos.every((po) => po.vendorId === a.vendorId)).toBe(true);
    expect(invoices.body.invoices.every((inv) => inv.vendorId === a.vendorId)).toBe(true);
    expect(payments.body.payments.every((p) => p.vendorId === a.vendorId)).toBe(true);
  });
});

describe('the workspace overview surfaces real finance figures, tenant-wide', () => {
  it('sums invoice value and payment/TDS totals across every vendor, not just counts', async () => {
    const { vendor: a } = await registerVendor(app, { vendorId: 'vendor_wide_fin1', gstin: '27AAAAA1123A1Z1' }, { onboarded: true });
    const { vendor: b } = await registerVendor(app, { vendorId: 'vendor_wide_fin2', gstin: '27AAAAA1124A1Z1', email: 'fin2@example.com' }, { onboarded: true });
    await seedTradeFor(a.vendorId, 'FA1');
    await seedTradeFor(b.vendorId, 'FB1');
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).get('/api/workspace/overview').set(auth(token));

    expect(res.status).toBe(200);
    // Two open invoices at 118 each.
    expect(res.body.finance.invoicesOpenValue).toBeGreaterThanOrEqual(236);
    expect(res.body.finance.invoicesTotal).toBeGreaterThanOrEqual(2);
    // Two payments at 118 gross each, no TDS.
    expect(res.body.finance.payments.count).toBeGreaterThanOrEqual(2);
    expect(res.body.finance.payments.grossPaid).toBeGreaterThanOrEqual(236);
    expect(res.body.sourcing.rfqsTotal).toBeGreaterThanOrEqual(2);
    expect(res.body.sourcing.posTotal).toBeGreaterThanOrEqual(2);
  });
});
