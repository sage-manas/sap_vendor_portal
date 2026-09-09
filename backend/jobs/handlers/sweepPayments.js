const { prisma } = require('../../db/prisma');
const { PO_INCLUDE } = require('../../db/poHelpers');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const { fiscalPeriodOf } = require('../../utils/fiscalPeriod');
const logger = require('../../utils/logger');

const FEED = 'payment';

// A payment SAP cleared against an older invoice without the portal's own
// targeted watch (jobs/handlers/awaitPaymentRun.js) ever finding it — a
// backstop, not the primary path: the watch job is enqueued on every invoice
// submission and normally finds its own clearing first. This exists for the
// cases it doesn't (the watch was never enqueued for an invoice raised
// outside the portal's own flow, or it was abandoned before SAP answered).
// Scope, deliberately: only GRN-matched invoices (no invoicePlanRef) — a
// periodic/partial invoicing plan's payment settling is the watch job's
// business alone, since only it knows which plan *line* a clearing answers.
module.exports = async ({ job, adapter }) => {
  const { clientId } = job;
  const due = await dueVendors(clientId, FEED);

  for (const { vendor } of due) {
    // eslint-disable-next-line no-await-in-loop
    await sweepOneVendor({ clientId, vendor, adapter });
  }

  return { done: true };
};

async function sweepOneVendor({ clientId, vendor, adapter }) {
  // The mock/s4odata driver need the caller's own Payment rows to describe
  // (see mock.driver.js's file header) — passing what already exists keeps
  // an unchanged payment's fingerprint stable across sweeps; only a CLEARED
  // row with no local match below is something to act on.
  const existingPayments = await prisma.payment.findMany({ where: { vendorId: vendor.vendorId } });
  const result = await adapter.vendorPaymentDisplay({ vendor, payments: existingPayments });
  const rows = (result?.payments || []).filter((row) => row.status === 'CLEARED');

  const { changed } = await recordSweepTick({ clientId, feed: FEED, vendorCode: vendor.sapVendorCode, data: rows });
  if (!changed) return;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await settleIfOpen({ clientId, vendor, row });
  }
}

async function settleIfOpen({ clientId, vendor, row }) {
  if (!row.poNumber || row.grossAmount == null) return;

  // Correlate to a PO SAP has already confirmed — an unmatched poNumber (a
  // PO the portal has no record of) has no invoice to settle here; that is
  // sweepPurchaseOrders' job to discover first, not this sweep's to guess.
  const po = await prisma.purchaseOrder.findFirst({
    where: { OR: [{ sapPoNumber: row.poNumber }, { sapDocNumber: row.poNumber }] },
    include: PO_INCLUDE,
  });
  if (!po) return;

  // Prisma's Json-field filters don't accept a plain `null` for "column IS
  // NULL" the way a scalar field does, so the invoicePlanRef exclusion is
  // applied in JS after the fetch rather than in the query itself.
  const openInvoices = await prisma.invoice.findMany({
    where: { poId: po.id, status: { not: 'Cleared' } },
  });
  const invoice = openInvoices.find((candidate) => !candidate.invoicePlanRef);
  if (!invoice) return;

  // Same idempotency guard as awaitPaymentRun.js's transaction — a retried
  // sweep tick over the same already-cleared invoice must not pay it twice.
  const result = await prisma.$transaction(async (tx) => {
    const latestInvoice = await tx.invoice.findFirst({ where: { pk: invoice.pk } });
    if (!latestInvoice || latestInvoice.status === 'Cleared') return null;

    const sapMiroDoc = row.miroDoc || latestInvoice.sapMiroDoc;
    const paymentDate = row.clearingDate ? new Date(row.clearingDate) : new Date();

    const payment = await tx.payment.create({
      data: {
        id: `PMT-SWEEP-${(row.clearingDocument || `${Date.now()}`).replace(/[^A-Za-z0-9]/g, '')}`,
        invoiceId: latestInvoice.id,
        poId: po.id,
        vendorId: latestInvoice.vendorId,
        invoiceRef: latestInvoice.id,
        invoiceNumber: latestInvoice.invoiceNumber,
        sapMiroDoc,
        grossAmount: row.grossAmount,
        tdsDeducted: row.tdsDeducted || 0,
        netAmount: row.netDisbursed ?? row.grossAmount,
        paymentDate,
        utrCode: row.utrReference || `SWEEP-${Date.now()}`,
        paymentMethod: row.paymentMethod || 'NEFT',
        sapPaymentDoc: row.clearingDocument || null,
        ...fiscalPeriodOf(paymentDate),
        sapDocNumber: row.clearingDocument || sapMiroDoc,
        sapSyncState: 'synced',
        sapSyncedAt: new Date(),
      },
    });

    await tx.invoice.update({
      where: { pk: latestInvoice.pk },
      data: {
        sapMiroDoc, status: 'Cleared', clearedAt: new Date(),
        sapDocNumber: sapMiroDoc, sapSyncState: 'synced', sapSyncedAt: new Date(),
      },
    });
    await tx.purchaseOrder.update({ where: { pk: po.pk }, data: { status: 'Paid' } });

    return payment;
  });

  if (!result) return;

  logger.info(`[jobs] sweepPayments discovered a clearing for invoice ${invoice.id} (PO ${po.id})`);
  notifyVendor(clientId, vendor.vendorId, EVENTS.PAYMENT_CLEARED, result);
}
