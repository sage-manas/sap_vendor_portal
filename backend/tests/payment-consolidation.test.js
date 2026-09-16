// Issue #63: Payment was 1:1 with Invoice, so an F110 run settling several
// invoices under one clearing document could not be represented. Each
// invoice's watch job (jobs/handlers/awaitPaymentRun.js) discovers its own
// clearing independently — this exercises three such discoveries that all
// report the same SAP clearing document and asserts they converge on one
// Payment row with three items, not three fabricated payments.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { formatInvoice } = require('../db/invoiceHelpers');
const awaitPaymentRun = require('../jobs/handlers/awaitPaymentRun');

const seedVendor = (clientId, vendorId) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode: 'VENCONSOL', companyName: `${vendorId} Pvt Ltd`,
    gstin: '27AAAAA9000A1Z9', pan: 'AAAAA9000A', email: `${vendorId}@example.com`,
  },
}));

const seedPoAndInvoice = (clientId, { poId, invoiceId, vendorId, totalAmount }) => runWithTenant(clientId, async () => {
  const po = await prisma.purchaseOrder.upsert({
    where: { clientId_id: { clientId, id: poId } },
    create: { id: poId, vendorId, status: 'Invoiced', sapPoNumber: `4500${poId.slice(-6)}` },
    update: {},
  });
  const invoice = await prisma.invoice.create({
    data: {
      id: invoiceId, poId: po.id, vendorId, invoiceNumber: `V-${invoiceId}`, invoiceDate: new Date(),
      status: 'Submitted', subTotal: totalAmount, taxAmount: 0, totalAmount,
      // 'pending' — same as a real invoice submission enqueuing its
      // payment-run watch (jobs/syncState.js) would leave it, so
      // awaitPaymentRun.js's own markSynced call has a legal transition.
      sapSyncState: 'pending',
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
    },
  });
  return { po, invoice };
});

// A fake *adapter* (the sap/index.js-wrapped object jobs/handlers code
// actually receives), not a fake driver — jobs/handlers/awaitPaymentRun.js's
// own callback expects to be called with the plain remittance object
// directly, since in production it's sap/index.js's wrapDeferred that
// unwraps a driver's `{data, logs}` shape before this handler ever sees it.
const fakeAdapter = (remittanceFor) => ({
  awaitPaymentRun: async (ctx, handler) => {
    const remittance = remittanceFor(ctx.invoice.id);
    if (!remittance) return false;
    await handler(remittance);
    return true;
  },
});

const runWatch = (clientId, { invoiceId, poId, vendorId }, adapter) => runWithTenant(clientId, () => awaitPaymentRun({
  job: { clientId, args: { invoiceId, poId, vendorId }, createdAt: new Date() },
  adapter,
}));

describe('awaitPaymentRun — one clearing document, several invoices (issue #63)', () => {
  it('produces one Payment with three items, not three payments', async () => {
    const clientId = 'CLT-0001';
    const vendorId = 'vendor_consol_1';
    await seedVendor(clientId, vendorId);

    const invoices = await Promise.all([
      seedPoAndInvoice(clientId, { poId: 'PO-CONSOL-1', invoiceId: 'INV-CONSOL-1', vendorId, totalAmount: 100 }),
      seedPoAndInvoice(clientId, { poId: 'PO-CONSOL-2', invoiceId: 'INV-CONSOL-2', vendorId, totalAmount: 200 }),
      seedPoAndInvoice(clientId, { poId: 'PO-CONSOL-3', invoiceId: 'INV-CONSOL-3', vendorId, totalAmount: 300 }),
    ]);

    const sharedClearingDoc = 'PAY-CONSOL-RUN-1';
    const remittanceFor = (invoiceId) => {
      const match = invoices.find(({ invoice }) => invoice.id === invoiceId);
      if (!match) return null;
      const gross = Number(match.invoice.totalAmount);
      return {
        paymentId: `PMT-${invoiceId}`, // only used if this invoice's job is the one that creates the header
        sapPaymentDoc: sharedClearingDoc,
        sapMiroDoc: `MIRO-${invoiceId}`,
        runId: 'F110-CONSOL-1',
        utrCode: 'UTR-CONSOL-1',
        paymentDate: new Date('2026-06-15'),
        paymentMethod: 'NEFT',
        bankName: 'HDFC Bank Ltd',
        grossAmount: gross,
        tdsDeducted: gross * 0.01,
        netAmount: gross * 0.99,
        tdsSection: '194C',
        deducteePan: 'PANCONSOL1',
        deductorTan: 'TANCONSOL1',
      };
    };

    // Three independent watch jobs, run in sequence (as three separate job
    // attempts would be) — none of them know about each other.
    for (const { po, invoice } of invoices) {
      // eslint-disable-next-line no-await-in-loop
      await runWatch(clientId, { invoiceId: invoice.id, poId: po.id, vendorId }, fakeAdapter(remittanceFor));
    }

    const payments = await runWithTenant(clientId, () => prisma.payment.findMany({
      where: { vendorId }, include: { items: true },
    }));

    expect(payments).toHaveLength(1);
    const [payment] = payments;
    expect(payment.sapPaymentDoc).toBe(sharedClearingDoc);
    expect(payment.items).toHaveLength(3);
    expect(payment.items.map((item) => item.invoiceId).sort()).toEqual(
      ['INV-CONSOL-1', 'INV-CONSOL-2', 'INV-CONSOL-3'],
    );

    // The header's totals are the sum of every item — 100 + 200 + 300 gross.
    expect(Number(payment.grossAmount)).toBeCloseTo(600, 2);
    expect(Number(payment.netAmount)).toBeCloseTo(594, 2);

    // Every invoice was actually marked cleared, not just three-quarters of
    // them lost the way a fabricated-payments workaround would.
    const clearedInvoices = await runWithTenant(clientId, () => prisma.invoice.findMany({
      where: { id: { in: invoices.map(({ invoice }) => invoice.id) } },
    }));
    expect(clearedInvoices.every((inv) => inv.status === 'Cleared')).toBe(true);
  });
});

describe('an invoice settled across two separate runs reports its outstanding balance (issue #63)', () => {
  it('sums PaymentItems across both Payments rather than storing one amount', async () => {
    const clientId = 'CLT-0001';
    const vendorId = 'vendor_consol_2';
    await seedVendor(clientId, vendorId);
    const { po, invoice } = await seedPoAndInvoice(clientId, {
      poId: 'PO-CONSOL-PARTIAL', invoiceId: 'INV-CONSOL-PARTIAL', vendorId, totalAmount: 1000,
    });

    // Two Payment headers, two different clearing documents, each settling
    // only part of the same invoice — the reverse case this redesign exists
    // for (one invoice, two runs), not one clearing document with two items.
    await runWithTenant(clientId, () => prisma.payment.create({
      data: {
        id: 'PMT-PARTIAL-1', vendorId, netAmount: 594, grossAmount: 600, tdsDeducted: 6,
        paymentDate: new Date('2026-06-01'), utrCode: 'UTR-PARTIAL-1', sapPaymentDoc: 'PAY-PARTIAL-1',
        items: { create: [{ clientId, invoiceId: invoice.id, poId: po.id, grossAmount: 600, tdsDeducted: 6, netAmount: 594 }] },
      },
    }));
    await runWithTenant(clientId, () => prisma.payment.create({
      data: {
        id: 'PMT-PARTIAL-2', vendorId, netAmount: 396, grossAmount: 400, tdsDeducted: 4,
        paymentDate: new Date('2026-06-20'), utrCode: 'UTR-PARTIAL-2', sapPaymentDoc: 'PAY-PARTIAL-2',
        items: { create: [{ clientId, invoiceId: invoice.id, poId: po.id, grossAmount: 400, tdsDeducted: 4, netAmount: 396 }] },
      },
    }));

    const reloaded = await runWithTenant(clientId, () => prisma.invoice.findFirst({
      where: { pk: invoice.pk },
      include: { items: true, paymentItems: true },
    }));
    const formatted = formatInvoice(reloaded);

    expect(formatted.amountPaid).toBeCloseTo(1000, 2); // 600 + 400 across the two runs
    expect(formatted.outstandingAmount).toBeCloseTo(0, 2);

    // A payment covering only part of the total leaves a real balance.
    await runWithTenant(clientId, async () => {
      const item = await prisma.paymentItem.findFirst({ where: { invoiceId: invoice.id, payment: { id: 'PMT-PARTIAL-2' } } });
      await prisma.paymentItem.update({ where: { pk: item.pk }, data: { grossAmount: 150 } });
    });
    const stillOpen = await runWithTenant(clientId, () => prisma.invoice.findFirst({
      where: { pk: invoice.pk },
      include: { items: true, paymentItems: true },
    }));
    expect(formatInvoice(stillOpen).outstandingAmount).toBeCloseTo(250, 2); // 1000 - (600 + 150)
  });
});
