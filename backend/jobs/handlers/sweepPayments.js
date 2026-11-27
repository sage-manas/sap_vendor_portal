const { prisma } = require('../../db/prisma');
const { PO_INCLUDE, syncPoStatus } = require('../../db/poHelpers');
const { flattenPaymentItems, recordPaymentItem } = require('../../db/paymentHelpers');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const { AMOUNT_TOLERANCE } = require('../../sap/mappings/invoice-match');
const { parseSapDate } = require('../../sap/mappings/dates');
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
  // row with no local match below is something to act on. Flattened to one
  // row per settled item (issue #63): vendorPaymentDisplay was written when
  // Payment carried one invoice's miroDoc/poId/amounts directly, and still
  // expects that shape — see flattenPaymentItems's own header comment.
  const existingPayments = await prisma.payment.findMany({ where: { vendorId: vendor.vendorId }, include: { items: true } });
  const result = await adapter.vendorPaymentDisplay({ vendor, payments: flattenPaymentItems(existingPayments) });
  const rows = (result?.payments || []).filter((row) => row.status === 'CLEARED');

  const { changed } = await recordSweepTick({ clientId, feed: FEED, vendorCode: vendor.sapVendorCode, data: rows });
  if (!changed) return;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await settleIfOpen({ clientId, vendor, row });
  }
}

// Which portal invoice this clearing pays (issue #349). It used to be "the
// first open invoice on the PO", whatever SAP document the row named — so on
// a PO with two open invoices, a payment for one could clear the other, and
// then stamp the other with this row's MIRO number.
//
//   1. The invoice already carrying this row's MIRO document. This is the
//      ordinary case: sweepInvoices records every invoice with its sapMiroDoc.
//   2. Failing that, an invoice not yet tied to any MIRO document, on the
//      row's PO, for the same gross amount — the same PO + amount rule as
//      sap/mappings/invoice-match.js, and only when exactly one fits.
//
// Nothing else. A row that fits no invoice, or more than one, is left alone.
async function invoiceForRow({ vendor, row }) {
  if (row.miroDoc) {
    const byDocument = await prisma.invoice.findFirst({ where: { vendorId: vendor.vendorId, sapMiroDoc: row.miroDoc } });
    if (byDocument) return byDocument;
  }

  // Correlate to a PO SAP has already confirmed — an unmatched poNumber (a
  // PO the portal has no record of) has no invoice to settle here; that is
  // sweepPurchaseOrders' job to discover first, not this sweep's to guess.
  if (!row.poNumber) return null;
  const po = await prisma.purchaseOrder.findFirst({
    where: { OR: [{ sapPoNumber: row.poNumber }, { sapDocNumber: row.poNumber }] },
  });
  if (!po) return null;

  const candidates = (await prisma.invoice.findMany({
    where: { poId: po.id, status: { not: 'Cleared' }, sapMiroDoc: null },
  })).filter((candidate) => Math.abs(Number(candidate.totalAmount) - Number(row.grossAmount)) <= AMOUNT_TOLERANCE);

  if (candidates.length > 1) {
    logger.warn(`[jobs] sweepPayments: ${candidates.length} unmatched invoices on PO ${po.id} fit SAP ${row.miroDoc || 'payment'} — leaving it for the targeted watch`);
    return null;
  }
  return candidates[0] || null;
}

async function settleIfOpen({ clientId, vendor, row }) {
  if (row.grossAmount == null) return;

  const invoice = await invoiceForRow({ vendor, row });
  // Prisma's Json-field filters don't accept a plain `null` for "column IS
  // NULL" the way a scalar field does, so the invoicePlanRef exclusion is
  // applied in JS after the fetch rather than in the query itself.
  if (!invoice || invoice.status === 'Cleared' || invoice.invoicePlanRef) return;

  // Cleared on a day this cannot read: not recorded rather than recorded as
  // paid today (issue #349). The next tick tries again.
  const paymentDate = parseSapDate(row.clearingDate);
  if (!paymentDate) {
    logger.warn(`[jobs] sweepPayments: SAP ${row.miroDoc || row.clearingDocument} is cleared but its clearing date ${JSON.stringify(row.clearingDate)} is unreadable — not recorded yet`);
    return;
  }

  const po = await prisma.purchaseOrder.findFirst({ where: { id: invoice.poId }, include: PO_INCLUDE });
  if (!po) return;

  // Same idempotency guard as awaitPaymentRun.js's transaction — a retried
  // sweep tick over the same already-cleared invoice must not pay it twice.
  const result = await prisma.$transaction(async (tx) => {
    const latestInvoice = await tx.invoice.findFirst({ where: { pk: invoice.pk } });
    if (!latestInvoice || latestInvoice.status === 'Cleared') return null;

    const sapMiroDoc = row.miroDoc || latestInvoice.sapMiroDoc;

    // One Payment per SAP clearing document, not per invoice (issue #63) —
    // see recordPaymentItem's own header comment. A second invoice this same
    // sweep tick settles under the same clearing document (settleIfOpen runs
    // once per row, sequentially — see sweepOneVendor above) converges on
    // the same Payment row this call either found or just created.
    const payment = await recordPaymentItem(tx, {
      clientId,
      // Keyed on SAP's own numbers, never the clock: a timestamp id could
      // not converge with a later sighting of the same clearing.
      paymentId: `PMT-SWEEP-${(row.clearingDocument || sapMiroDoc || `${Date.now()}`).replace(/[^A-Za-z0-9]/g, '')}`,
      vendorId: latestInvoice.vendorId,
      remittance: {
        paymentDate,
        // As SAP reported them, or null (issue #351): a cheque has no UTR,
        // and SAP reporting no method is not NEFT.
        utrCode: row.utrReference || null,
        paymentMethod: row.paymentMethod || null,
        sapPaymentDoc: row.clearingDocument || null,
        bankName: row.bankName || null,
        runId: row.runId || null,
        tdsSection: row.tdsSection || null,
        deducteePan: row.deducteePan || null,
        deductorTan: row.deductorTan || null,
        grossAmount: row.grossAmount,
        tdsDeducted: row.tdsDeducted || 0,
        netAmount: row.netDisbursed ?? row.grossAmount,
      },
      invoiceId: latestInvoice.id,
      poId: po.id,
      invoiceNumber: latestInvoice.invoiceNumber,
      sapMiroDoc,
    });

    await tx.invoice.update({
      where: { pk: latestInvoice.pk },
      data: {
        sapMiroDoc, status: 'Cleared', clearedAt: new Date(),
        sapDocNumber: sapMiroDoc, sapSyncState: 'synced', sapSyncedAt: new Date(),
      },
    });
    // Derived, not declared (issue #60) — same helper every other status
    // change goes through.
    await syncPoStatus(tx, po.pk);

    return payment;
  });

  if (!result) return;

  logger.info(`[jobs] sweepPayments discovered a clearing for invoice ${invoice.id} (PO ${po.id})`);
  notifyVendor(clientId, vendor.vendorId, EVENTS.PAYMENT_CLEARED, result);
}
