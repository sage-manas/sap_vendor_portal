const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser } = require('./helpers');
const { runWithTenant } = require('../utils/tenantContext');
const { INVOICE_STATUS } = require('../config/statuses');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Issue #283. "Outstanding" was overstated in two independent ways, and the
// fixture below is the smallest one that catches both:
//
//   1. A *Rejected* invoice counted as money the buyer still owed, because
//      every filter said `status !== 'Cleared'`. A rejection is a decision;
//      a rejected invoice is not a receivable.
//   2. A part-paid invoice counted for its full face value, because every
//      total summed `totalAmount`. An invoice can be settled across several
//      F110 runs (issue #63), so what is still owed is the total less every
//      PaymentItem referencing it.
//
// Three invoices, ₹1,00,000 each: one open and untouched, one open and half
// paid, one rejected, one cleared. The only honest answer to "how much is
// outstanding" is ₹1,50,000 across 2 invoices. Each of the old bugs lands on
// a different wrong number — ₹4,00,000 with both, ₹3,00,000 or ₹2,50,000 with
// one — so no assertion here can pass by accident.
//
// The documents are seeded through Prisma, which AGENTS.md permits as
// *precondition* seeding: what is exercised is the arithmetic in the overview
// and the supplier detail aggregates, not the pipeline that produces an
// invoice or a payment (lifecycle-e2e.test.js owns that), and every row below
// is one the API can and does produce.

const VENDOR = 'vendor_outstanding_1';
const CLIENT = 'CLT-0001';
const AMOUNT = 100000;
const PART_PAID = 50000;

// What each invoice is still owed, by design — the expected figures are
// stated here rather than recomputed, because the point of this test is that
// the endpoints agree with the *intended* definition of outstanding.
const EXPECTED_OPEN_COUNT = 2;
const EXPECTED_OUTSTANDING = AMOUNT + (AMOUNT - PART_PAID);
const EXPECTED_OPEN_FACE_VALUE = AMOUNT * 2;
const EXPECTED_RECEIVABLE = AMOUNT * 3; // all four less the rejected one
const EXPECTED_INVOICED = AMOUNT * 4;

const seed = () => runWithTenant(CLIENT, async () => {
  const po = await prisma.purchaseOrder.create({
    data: {
      id: 'PO-OUT-0001',
      vendorId: VENDOR,
      status: 'Invoiced',
      createdDate: new Date('2026-01-10'),
      items: {
        create: [{
          clientId: CLIENT, line: 10, materialCode: 'MAT-OUT',
          description: 'Outstanding fixture', quantity: 4, unitPrice: AMOUNT,
          netValue: AMOUNT * 4, plant: 'P100',
        }],
      },
    },
  });

  const invoice = async (suffix, status) => {
    const grn = await prisma.gRN.create({
      data: {
        id: `GRN-OUT-${suffix}`, poId: po.id, vendorId: VENDOR,
        postingDate: new Date('2026-02-01'), invoiceSubmitted: true,
        items: { create: [{ clientId: CLIENT, line: 1, materialCode: 'MAT-OUT', receivedQuantity: 1, acceptedQuantity: 1 }] },
      },
    });
    return prisma.invoice.create({
      data: {
        id: `INV-OUT-${suffix}`,
        // The schema's `invoice_grn_xor_plan_ref` CHECK wants exactly one of
        // a receipt and an invoicing-plan reference.
        grnId: grn.id,
        poId: po.id, vendorId: VENDOR,
        invoiceNumber: `OUT/${suffix}`,
        invoiceDate: new Date('2026-02-10'),
        status,
        subTotal: AMOUNT, taxAmount: 0, totalAmount: AMOUNT,
      },
    });
  };

  await invoice('OPEN', INVOICE_STATUS.SUBMITTED);
  const partPaid = await invoice('PART', INVOICE_STATUS.APPROVED);
  await invoice('REJ', INVOICE_STATUS.REJECTED);
  const cleared = await invoice('CLR', INVOICE_STATUS.CLEARED);

  // One remittance settling half of the open invoice and all of the cleared
  // one — the same shape F110 produces when a run clears several invoices
  // under one clearing document.
  await prisma.payment.create({
    data: {
      id: 'PMT-OUT-0001',
      vendorId: VENDOR, paymentDate: new Date('2026-03-01'),
      utrCode: 'UTROUT1', sapPaymentDoc: 'CLROUT1',
      grossAmount: PART_PAID + AMOUNT, tdsDeducted: 0,
      netAmount: PART_PAID + AMOUNT, totalTds: 0,
      items: {
        create: [
          {
            clientId: CLIENT, invoiceId: partPaid.id, poId: po.id,
            invoiceNumber: partPaid.invoiceNumber,
            grossAmount: PART_PAID, tdsDeducted: 0, netAmount: PART_PAID,
          },
          {
            clientId: CLIENT, invoiceId: cleared.id, poId: po.id,
            invoiceNumber: cleared.invoiceNumber,
            grossAmount: AMOUNT, tdsDeducted: 0, netAmount: AMOUNT,
          },
        ],
      },
    },
  });
});

describe('outstanding invoice totals', () => {
  let admin;
  let supplier;

  beforeEach(async () => {
    supplier = await registerVendor(app, { vendorId: VENDOR, gstin: '27AAAAA9283A1Z1' }, { onboarded: true });
    admin = await createAdminUser();
    await seed();
  });

  it('counts only open invoices on the workspace overview, net of part payments', async () => {
    const res = await request(app).get('/api/workspace/overview').set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.finance.invoicesTotal).toBe(4);
    // Not 3 (which would count the rejected one as still owed).
    expect(res.body.finance.invoicesOpen).toBe(EXPECTED_OPEN_COUNT);
    // Not ₹2,00,000 (which would ignore the part payment) and not ₹3,00,000
    // or ₹4,00,000 (which would also count the rejected invoice).
    expect(res.body.finance.invoicesOpenValue).toBeCloseTo(EXPECTED_OUTSTANDING, 2);
    // The face value of the same invoices is still served, separately and by
    // name, because the overview says both.
    expect(res.body.finance.invoicesOpenFaceValue).toBeCloseTo(EXPECTED_OPEN_FACE_VALUE, 2);
  });

  it('leaves a rejected invoice out of the review-amount queue too', async () => {
    // Every invoice in the fixture is ₹1,00,000, below CLT-0001's ₹5,00,000
    // default — so the threshold is lowered first, through the settings API,
    // to put all four above it. Then the only thing separating 2 from 3 is
    // whether the rejected one is counted as awaiting review.
    const settings = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(admin.token))
      .send({ settings: { 'thresholds.invoiceReviewAmount': 50000 } });
    expect(settings.status).toBe(200);

    const res = await request(app).get('/api/workspace/overview').set(auth(admin.token));

    expect(res.body.thresholds.invoiceReviewAmount).toBe(50000);
    // Counted on face value, deliberately: what a human is asked to approve
    // is the invoice as raised, not its balance after a part payment — so
    // the half-paid ₹1,00,000 invoice is still here.
    expect(res.body.finance.invoicesOverThreshold).toBe(EXPECTED_OPEN_COUNT);
  });

  it('separates billed, receivable and still-owed on the supplier detail', async () => {
    const res = await request(app)
      .get(`/api/vendors/${supplier.vendor.pk}`)
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    const { invoices } = res.body.activity;
    expect(invoices.total).toBe(4);
    // Everything ever billed, rejections included: this is the history of
    // what was raised, and it is the one figure a rejection belongs in.
    expect(invoices.value).toBeCloseTo(EXPECTED_INVOICED, 2);
    // A rejected invoice was never a receivable.
    expect(invoices.receivableValue).toBeCloseTo(EXPECTED_RECEIVABLE, 2);
    expect(invoices.openCount).toBe(EXPECTED_OPEN_COUNT);
    expect(invoices.outstandingValue).toBeCloseTo(EXPECTED_OUTSTANDING, 2);
  });

  it('agrees with the supplier\'s own dashboard summary, to the rupee', async () => {
    // The tenant's overview and the supplier's summary answer the same
    // question from two code paths; #283 was partly these drifting apart.
    const [overview, summary] = await Promise.all([
      request(app).get('/api/workspace/overview').set(auth(admin.token)),
      request(app).get('/api/dashboard/summary').set(auth(supplier.token)),
    ]);

    expect(summary.body.invoices.openCount).toBe(overview.body.finance.invoicesOpen);
    expect(summary.body.invoices.openValue).toBeCloseTo(overview.body.finance.invoicesOpenValue, 2);
    expect(summary.body.invoices.openInvoicedValue)
      .toBeCloseTo(overview.body.finance.invoicesOpenFaceValue, 2);
  });

  it('never reports a negative balance when a clearing overshoots one invoice', async () => {
    // An overshooting clearing is a reconciliation question for Finance, not
    // a debt the supplier owes back — and crucially it must not pay down a
    // *different* invoice's balance, which a plain SUM − SUM would let it do.
    await runWithTenant(CLIENT, () => prisma.paymentItem.updateMany({
      where: { invoiceId: 'INV-OUT-PART' },
      data: { grossAmount: AMOUNT * 3, netAmount: AMOUNT * 3 },
    }));

    const res = await request(app).get('/api/workspace/overview').set(auth(admin.token));

    // The part-paid invoice is settled to zero and no further; the untouched
    // open invoice still owes its full ₹1,00,000.
    expect(res.body.finance.invoicesOpenValue).toBeCloseTo(AMOUNT, 2);

    const detail = await request(app)
      .get(`/api/vendors/${supplier.vendor.pk}`)
      .set(auth(admin.token));
    expect(detail.body.activity.invoices.outstandingValue).toBeCloseTo(AMOUNT, 2);
  });
});
