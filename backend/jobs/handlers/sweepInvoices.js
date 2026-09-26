const { prisma } = require('../../db/prisma');
const { formatInvoice } = require('../../db/invoiceHelpers');
const { matchInvoiceDocument, AmbiguousInvoiceMatchError } = require('../../sap/mappings/invoice-match');
const { nextSequentialId } = require('../../utils/nextSequentialId');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyProcurement } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const logger = require('../../utils/logger');

const FEED = 'invoice';

// Invoice creation was removed from the portal (a9fe9ac): MIRO is invoice
// verification, AP's own transaction against their books, and the portal
// never posts to SAP on a supplier's behalf, so a local "submit" was only
// ever a record waiting to be matched against what AP posts. This sweep is
// what an Invoice row's existence now depends on entirely — the same
// "SAP originated it, not the portal" shape as sweepPurchaseOrders.js, one
// document type later in the P2P chain (issue #72's follow-up).
//
// Scope, deliberately: this only discovers a MIRO document AP has already
// posted; it does not simulate AP posting one, and it does not chase a
// document down to a specific goods receipt SAP never told it about (see
// claimGrnFor below). jobs/handlers/awaitPaymentRun.js's targeted watch and
// sweepPayments.js's backstop both pick up from here unchanged — a
// discovered invoice is, from that point on, indistinguishable from one the
// old portal-side submission would have produced.
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
  const existingInvoices = await prisma.invoice.findMany({ where: { vendorId: vendor.vendorId }, include: { items: true } });
  const result = await adapter.vendorMiroDisplay({ vendor, invoices: existingInvoices.map(formatInvoice) });
  const documents = result?.documents || [];

  // An unchanged SAP answer normally means there is nothing to do — but not
  // while a document it lists is still unrecorded here. upsertInvoice defers
  // a document whose PO or goods receipt the portal hasn't synced yet, and
  // SAP's answer won't change when that receipt later arrives, so without
  // this the deferred invoice would never be retried.
  const { changed } = await recordSweepTick({ clientId, feed: FEED, vendorCode: vendor.sapVendorCode, data: documents });
  const unrecorded = documents.some(
    (document) => document.miroDoc && !existingInvoices.some((inv) => inv.sapMiroDoc === document.miroDoc),
  );
  if (!changed && !unrecorded) return;

  for (const document of documents) {
    // eslint-disable-next-line no-await-in-loop
    await upsertInvoice({ clientId, vendor, document, existingInvoices });
  }
}

// SAP's own report has no field naming the portal's PurchaseOrder — the PO
// is read from the line items first (sap/mappings/invoice-match.js's own
// header comment explains why: the header REFERENCE field's meaning is a
// per-configuration choice in SAP and unconfirmed against a live system;
// PO_NO on each item is unambiguous), falling back to the header only when
// no item carries one.
const poNumberOf = (document) => {
  const fromItems = (document.items || []).map((item) => item.poNumber).filter(Boolean);
  return fromItems[0] || document.poNumber || null;
};

async function upsertInvoice({ clientId, vendor, document, existingInvoices }) {
  if (!document.miroDoc) return;

  // Already known by its SAP document number — nothing to do.
  if (existingInvoices.some((inv) => inv.sapMiroDoc === document.miroDoc)) return;

  // Correlate to a PO SAP has already confirmed — an unmatched poNumber (a
  // PO the portal has no record of) has no invoice to raise here; that is
  // sweepPurchaseOrders' job to discover first, not this sweep's to guess.
  const poNumber = poNumberOf(document);
  if (!poNumber) return;
  const po = await prisma.purchaseOrder.findFirst({
    where: { OR: [{ sapPoNumber: poNumber }, { sapDocNumber: poNumber }] },
  });
  if (!po) return;

  // An existing invoice with no sapMiroDoc yet might already *be* this
  // document, just not matched — the same rule
  // controllers/invoice.controller.js's getSapInvoiceStatus uses to
  // recognise one. Correlate rather than duplicate: creating a second local
  // row for a MIRO document a supplier-facing screen already resolved would
  // silently double the vendor's invoice count.
  const unmatched = existingInvoices.filter((inv) => !inv.sapMiroDoc && inv.poId === po.id);
  for (const inv of unmatched) {
    let found;
    try {
      found = matchInvoiceDocument({ sapPoNumber: poNumber, totalAmount: inv.totalAmount, invoiceDate: inv.invoiceDate }, [document]);
    } catch (error) {
      // Ambiguous against a single candidate document can't actually
      // happen (the ambiguity is between multiple documents) — but the
      // function's contract allows it, so this stays defensive rather than
      // assuming.
      if (error instanceof AmbiguousInvoiceMatchError) continue;
      throw error;
    }
    if (found) {
      await prisma.invoice.update({
        where: { pk: inv.pk },
        data: {
          sapMiroDoc: document.miroDoc, sapDocNumber: document.miroDoc,
          sapSyncState: 'synced', sapSyncedAt: new Date(), sapSyncError: null,
        },
      });
      return;
    }
  }

  await createDiscoveredInvoice({ clientId, vendor, po, document });
}

const buildItems = (document, clientId) => (document.items || []).map((item, index) => {
  const quantity = Number(item.quantity) || 0;
  const amount = Number(item.amount ?? item.totalValue) || 0;
  return {
    clientId,
    line: Number(item.poItem) || (index + 1) * 10,
    materialCode: item.materialCode || 'UNKNOWN',
    quantity,
    unitPrice: quantity ? amount / quantity : amount,
    amount,
  };
});

// Genuinely unsolicited: SAP has an invoice for this vendor's PO the portal
// has never seen. `Invoice.grnId`/`invoicePlanRef` are mutually exclusive
// and exactly one must be set (a database CHECK constraint — see the
// initial migration) — a portal-side submission always named the specific
// receipt or plan date it billed, but a MIRO document carries no GRN
// reference of its own (invoice verification here is PO/line-level, not
// GRN-level). The best correlation available without one is the oldest
// receipt against this PO still awaiting an invoice; claiming it is
// expressed as the conditional `updateMany` issue #72 itself suggested, so
// a concurrent sweep tick racing for the same receipt loses cleanly instead
// of both creating an invoice for it. A PO with every receipt already
// invoiced (or none at all) has nothing this sweep can claim, so the
// document is left for the next tick — by then either a new receipt has
// arrived or a human needs to look at why AP invoiced a PO the portal shows
// nothing outstanding on.
async function createDiscoveredInvoice({ clientId, vendor, po, document }) {
  const created = await prisma.$transaction(async (tx) => {
    const candidate = await tx.gRN.findFirst({
      where: { poId: po.id, invoiceSubmitted: false },
      orderBy: { postingDate: 'asc' },
    });
    if (!candidate) return null;

    const claim = await tx.gRN.updateMany({
      where: { pk: candidate.pk, invoiceSubmitted: false },
      data: { invoiceSubmitted: true },
    });
    if (claim.count === 0) return null; // lost the race to another sweep tick

    const subTotal = Number(document.taxableAmount) || 0;
    const totalAmount = Number(document.grossAmount) || 0;
    const taxAmount = Math.max(totalAmount - subTotal, 0);
    const year = new Date(document.docDate || Date.now()).getFullYear();
    const id = await nextSequentialId('invoice', `INV-${year}-`, 4, tx);

    return tx.invoice.create({
      data: {
        id,
        grnId: candidate.id,
        poId: po.id,
        vendorId: vendor.vendorId,
        invoiceNumber: document.miroDoc,
        invoiceDate: document.docDate ? new Date(document.docDate) : new Date(),
        subTotal, taxAmount, totalAmount,
        ...(document.taxCode ? { taxCode: document.taxCode } : {}),
        currency: document.currency || 'INR',
        sapMiroDoc: document.miroDoc,
        sapDocNumber: document.miroDoc,
        sapSyncState: 'synced',
        sapSyncedAt: new Date(),
        items: { create: buildItems(document, clientId) },
      },
    });
  });

  if (!created) return;

  logger.info(`[jobs] sweepInvoices discovered ${created.id} (SAP ${document.miroDoc}) for vendor ${vendor.vendorId}`);
  notifyProcurement(clientId, EVENTS.INVOICE_NEW, { id: created.id, sapMiroDoc: document.miroDoc, vendorId: vendor.vendorId });
}
