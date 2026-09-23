const { prisma } = require('../../db/prisma');
const { nextSequentialId } = require('../../utils/nextSequentialId');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const logger = require('../../utils/logger');

const FEED = 'quotation';

// Prisma's RfqType enum (schema.prisma) — validated against here rather than
// trusted from SAP directly, since an enum mismatch would crash the create.
const RFQ_TYPES = ['AN', 'AB'];

// SAP's purchasing-document ledger (ME48/ME43 — see the notes on
// vendorQuotationDisplay/vendorRfqDisplay/vendorRfqDetail in contract.js) for
// this vendor.
//
// Every RFQ now originates in SAP (ME41), never in the portal (issue #117) —
// this is where one reaches the portal at all. ME43 is the authoritative
// "still open" list; ME48 is the fuller ledger, open and closed documents
// alike. A 6xxxxxxx document in ME48 that has fallen out of ME43 is closed —
// there is no other status signal SAP offers for an RFQ. A document neither
// read has ever shown before gets a local RFQ row, its line items filled in
// from vendorRfqDetail (zpo_grn/Detail), exactly as sweepPurchaseOrders.js
// gives a PO raised directly in ME21N a local row — from there it is an
// ordinary RFQ: biddable, evaluable, awardable, same as one this application
// created itself, because nothing downstream of the RFQ table distinguishes
// the two.
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
  // rfqs/pos are the caller's own correlation input for the mock/s4odata
  // driver (see vendorQuotationDisplay/vendorRfqDisplay in both) — the
  // portal's own RFQs and POs for this vendor, same as RfqView's live read
  // already sends.
  const [rfqs, pos] = await Promise.all([
    prisma.rFQ.findMany({ where: { invitedVendors: { some: { vendorExtId: vendor.vendorId } } } }),
    prisma.purchaseOrder.findMany({ where: { vendorId: vendor.vendorId }, include: { items: true } }),
  ]);

  const [{ documents: openDocs = [] }, { documents: ledger = [] }] = await Promise.all([
    adapter.vendorRfqDisplay({ vendor, rfqs }),
    adapter.vendorQuotationDisplay({ vendor, rfqs, pos }),
  ]);

  const openNumbers = new Set(openDocs.map((d) => d.sapRfqNumber).filter(Boolean));
  const rfqDocs = ledger.filter((d) => d.documentType === 'Quotation' && d.documentNumber);

  // Folds the open list into the fingerprint alongside the ledger: a
  // document falling out of ME43 while staying in ME48 (i.e. closing) is a
  // real change even when the ledger's own rows are byte-identical to last
  // tick, and must not be a silent no-op.
  const { changed } = await recordSweepTick({
    clientId, feed: FEED, vendorCode: vendor.sapVendorCode,
    data: { openNumbers: [...openNumbers].sort(), rfqDocs },
  });
  if (!changed) return;

  logger.info(`[jobs] sweepQuotations: the purchasing-document ledger changed for vendor ${vendor.vendorId}`);
  notifyVendor(clientId, vendor.vendorId, EVENTS.LOG_NEW, {
    type: 'SYS', name: 'SAP_DOCUMENT_LEDGER_CHANGED',
  });

  const localBySapNumber = new Map(
    rfqs.filter((r) => r.sapDocNumber).map((r) => [r.sapDocNumber, r]),
  );

  for (const doc of rfqDocs) {
    const isOpen = openNumbers.has(doc.documentNumber);
    const existing = localBySapNumber.get(doc.documentNumber);

    if (existing) {
      // eslint-disable-next-line no-await-in-loop
      await syncStatus({ rfq: existing, isOpen });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await discoverRfq({ clientId, vendor, doc, isOpen, adapter });
  }
}

// Never regresses past whatever the portal itself has done with this RFQ —
// same rule PurchaseOrder.status sync follows (services/poStatus.service.js).
// Awarded, Cancelled or anything else a buyer or the evaluation flow set is
// left alone; only the two states this sweep itself assigns (Bidding
// Open/Closed) are ever moved by it, in either direction, since SAP is the
// honest source for both — an RFQ SAP reopens is reopened here too.
async function syncStatus({ rfq, isOpen }) {
  const desired = isOpen ? 'Bidding Open' : 'Closed';
  if (rfq.status !== 'Bidding Open' && rfq.status !== 'Closed') return;
  if (rfq.status === desired) return;

  await prisma.rFQ.update({
    where: { pk: rfq.pk },
    data: { status: desired, sapSyncedAt: new Date() },
  });
  logger.info(`[jobs] sweepQuotations: SAP RFQ ${rfq.sapDocNumber} (${rfq.id}) is now ${desired}`);
}

// A short, honest description from whatever material text SAP gave the
// line items — never invented, and never left blank, since RFQ.description
// is required.
const describeFrom = (items) => {
  const names = items.map((item) => item.description).filter(Boolean);
  if (!names.length) return 'RFQ raised in SAP';
  return names.length > 2 ? `${names.slice(0, 2).join('; ')}; +${names.length - 2} more` : names.join('; ');
};

async function discoverRfq({ clientId, vendor, doc, isOpen, adapter }) {
  let detail;
  try {
    detail = await adapter.vendorRfqDetail({ rfqNumber: doc.documentNumber });
  } catch (error) {
    // A detail read failing (timeout, a transient 5xx) must not fail the
    // whole vendor's sweep — the ledger already changed, and every other
    // document on it still deserves processing. The next tick tries again;
    // recordSweepTick's fingerprint already moved on, so nothing here forces
    // a retry of just this one document, same trade-off sweepPurchaseOrders
    // accepts for its own per-order enrichment.
    logger.warn(`[jobs] sweepQuotations could not read detail for RFQ ${doc.documentNumber}: ${error.message}`);
    return;
  }

  // 404/gone, or a document with no line items to bid on — nothing to
  // discover yet. Left for a later tick rather than created empty.
  if (!detail || !detail.items?.length) return;

  const year = new Date().getFullYear();
  const id = await nextSequentialId('rFQ', `RFQ-${year}-`, 3);

  const created = await prisma.rFQ.create({
    data: {
      id,
      clientId,
      description: describeFrom(detail.items),
      // No SAP source for a bid-by date on either read this driver has —
      // null, honestly (see the RFQ.deadlineDate comment in schema.prisma),
      // rather than a cutoff nobody agreed to.
      deadlineDate: null,
      status: isOpen ? 'Bidding Open' : 'Closed',
      // Prisma's RfqType enum only knows AN/AB — SAP's TYPE has been AN on
      // every RFQ line seen live, but a code outside that pair must not crash
      // the whole discovery over an enum mismatch; AN is the observed default.
      rfqType: RFQ_TYPES.includes(detail.items.find((item) => item.type)?.type)
        ? detail.items.find((item) => item.type).type
        : 'AN',
      currency: doc.currency || detail.currency || 'INR',
      purchasingOrg: doc.purchasingOrg || '1000',
      companyCode: detail.companyCode || '1000',
      sapDocNumber: doc.documentNumber,
      sapSyncState: 'synced',
      sapSyncedAt: new Date(),
      items: {
        create: detail.items.map((item) => ({
          clientId,
          line: item.line,
          // A text-only RFQ line (no MATNR yet assigned) is not a case SAP
          // has shown this system, but materialCode is required — '' rather
          // than null keeps the same convention an asset PO line uses for
          // the same situation (createAssetPo).
          materialCode: item.materialCode || '',
          description: item.description || null,
          quantity: item.quantity || 0,
          uom: item.uom || 'EA',
          plant: item.plant || '1000',
        })),
      },
      // Exactly the vendor whose ME43 named this RFQ — that read is already
      // scoped to one vendor code, so there is no invitee list to reconstruct;
      // this is the whole list.
      invitedVendors: {
        create: [{ clientId, vendorExtId: vendor.vendorId, name: vendor.companyName, status: 'Pending' }],
      },
    },
  });

  logger.info(`[jobs] sweepQuotations discovered ${created.id} (SAP ${doc.documentNumber}, ${isOpen ? 'open' : 'closed'}) for vendor ${vendor.vendorId}`);
  notifyVendor(clientId, vendor.vendorId, EVENTS.LOG_NEW, {
    type: 'SYS', name: 'SAP_RFQ_DISCOVERED',
  });
}
