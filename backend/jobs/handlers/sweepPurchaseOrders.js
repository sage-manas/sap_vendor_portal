const { prisma } = require('../../db/prisma');
const { formatPo, syncPoStatus } = require('../../db/poHelpers');
const { nextSequentialId } = require('../../utils/nextSequentialId');
const { EVENTS } = require('../../utils/socketEmitter');
const { Prisma } = require('@prisma/client');
const { notifyProcurement, notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const logger = require('../../utils/logger');

const FEED = 'po';

// A purchasing document raised directly in SAP (ME21N), never through the
// portal — the discovery half of Phase 4 of
// docs/04-sap-runtime-engineering-plan.md. Scope, deliberately: this creates
// the missing PurchaseOrder and correlates one the portal already has but
// hadn't matched yet (the same job getSapPoStatus already does on demand —
// po.controller.js — this is that same correlation running proactively). It
// does *not* also create GRNs for a portal-awarded PO's watched ASN — that
// is jobs/handlers/awaitGoodsReceipt.js's job, a targeted watch that already
// exists for exactly that document. What this does add is the receipt SAP
// posted with *no* portal ASN behind it (reconcileReceipts below) — nothing
// else would ever record one, so the PO read Delivered with no receipt to show.
//
// Natural key for idempotency (4.5): `(clientId, sapDocNumber)` — a sweep
// re-seeing the same order writes nothing new for it (find-or-create, not
// blind insert), and events fire only for a real state change.
module.exports = async ({ job, adapter }) => {
  const { clientId } = job;
  const due = await dueVendors(clientId, FEED);

  for (const { vendor } of due) {
    // eslint-disable-next-line no-await-in-loop
    await sweepOneVendor({ clientId, vendor, adapter });
  }

  return { done: true };
};

// Split out so the per-vendor unit is easy to read and to test in isolation.
async function sweepOneVendor({ clientId, vendor, adapter }) {
  // Passed in the same shape getSapPoStatus already sends (po.controller.js)
  // — the mock driver's only way to echo back which of *our* records an
  // order is (`poId`, see vendorPoGrnDisplay in mock.driver.js); the real
  // driver ignores this entirely and always answers `poId: null` (no
  // correlation key exists on a live system either — see its own note).
  const localPos = await prisma.purchaseOrder.findMany({ where: { vendorId: vendor.vendorId }, include: { items: true } });
  const result = await adapter.vendorPoGrnDisplay({ vendor, pos: localPos.map(formatPo) });
  const orders = result?.orders || [];

  const { changed } = await recordSweepTick({ clientId, feed: FEED, vendorCode: vendor.sapVendorCode, data: orders });
  if (changed) {
    for (const order of orders) {
      if (!order.poNumber) continue;
      // eslint-disable-next-line no-await-in-loop
      await upsertOrder({ clientId, vendor, order, localPos });
    }
  }

  // Outside the `changed` gate on purpose: it reads only rows we already hold
  // plus the orders just fetched (no SAP call), and it must also catch a
  // receipt that was already in SAP the last time the fingerprint moved.
  await reconcileReceipts({ clientId, vendor, orders });
}

const isUniqueViolation = (err) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Records each SAP goods receipt the portal holds no GRN for, as a GRN with no
// ASN. A PO whose shipment is still being watched (a Submitted ASN) is left to
// awaitGoodsReceipt, which links the receipt to that ASN — recording it here
// first would leave the shipment unmatched. grnQuantity is not touched: the PO
// already carries SAP's received quantity per line from the order read.
async function reconcileReceipts({ clientId, vendor, orders }) {
  const withReceipts = orders.filter((o) => o.poNumber && (o.items || []).some((i) => (i.grns || []).length));
  if (!withReceipts.length) return;

  const pos = await prisma.purchaseOrder.findMany({
    where: { vendorId: vendor.vendorId, sapPoNumber: { in: withReceipts.map((o) => o.poNumber) } },
    select: { id: true, sapPoNumber: true, vendorId: true },
  });
  if (!pos.length) return;
  const poByNumber = new Map(pos.map((po) => [po.sapPoNumber, po]));

  const [grns, openAsns] = await Promise.all([
    prisma.gRN.findMany({ where: { poId: { in: pos.map((p) => p.id) } }, select: { id: true, sapMigoDoc: true } }),
    prisma.aSN.findMany({ where: { poId: { in: pos.map((p) => p.id) }, status: 'Submitted' }, select: { poId: true } }),
  ]);
  const haveDoc = new Set(grns.flatMap((g) => [g.id, g.sapMigoDoc]));
  const watched = new Set(openAsns.map((a) => a.poId));

  for (const order of withReceipts) {
    const po = poByNumber.get(order.poNumber);
    if (!po || watched.has(po.id)) continue;

    // One GR document spans several PO lines (its number repeats per line), so
    // a receipt is the document, not the row.
    const docs = new Map();
    for (const item of order.items) {
      for (const gr of item.grns || []) {
        if (!gr.grNumber) continue;
        const year = gr.grYear || (gr.grDate ? new Date(gr.grDate).getFullYear() : null);
        if (!year) continue;
        const key = `${year}-${gr.grNumber}`;
        const doc = docs.get(key) || { id: `GRN-${key}`, grNumber: gr.grNumber, year, date: gr.grDate, lines: new Map() };
        const line = doc.lines.get(item.itemNumber) || { item, quantity: 0 };
        line.quantity += Number(gr.quantity) || 0;
        doc.lines.set(item.itemNumber, line);
        docs.set(key, doc);
      }
    }

    for (const doc of docs.values()) {
      if (haveDoc.has(doc.id) || haveDoc.has(doc.grNumber)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const grn = await prisma.gRN.create({
          data: {
            id: doc.id,
            poId: po.id,
            asnId: null,
            vendorId: po.vendorId,
            sapMigoDoc: doc.grNumber,
            sapDocYear: doc.year,
            postingDate: doc.date ? new Date(doc.date) : new Date(),
            receivedBy: 'SAP',
            invoiceSubmitted: false,
            sapDocNumber: doc.grNumber,
            sapSyncState: 'synced',
            sapSyncedAt: new Date(),
            items: {
              create: [...doc.lines.values()].map(({ item, quantity }) => ({
                clientId,
                line: Number(item.itemNumber) || null,
                materialCode: item.materialCode,
                description: item.description,
                receivedQuantity: quantity,
                // The endpoint reports received quantity only — no rejection
                // field exists in it (see the s4odata driver's awaitGoodsReceipt).
                acceptedQuantity: quantity,
                rejectedQuantity: 0,
                uom: item.uom,
              })),
            },
          },
          include: { items: true },
        });
        haveDoc.add(doc.id);
        logger.info(`[jobs] sweepPurchaseOrders recorded ${grn.id} (SAP ${doc.grNumber}) on ${po.id} — no portal ASN`);
        notifyVendor(clientId, po.vendorId, EVENTS.GRN_RECEIVED, grn);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }
}

async function upsertOrder({ clientId, vendor, order, localPos }) {
  // Correlate: prefer the mock's own poId echo (a portal-awarded PO the
  // simulator can identify by our own id); the real driver never sets this,
  // so fall back to an already-synced local row that carries this same SAP
  // number from a previous sweep or on-demand correlation — a re-sweep of
  // something already matched, not a fresh discovery.
  const existing = order.poId
    ? localPos.find((po) => po.id === order.poId)
    : localPos.find((po) => po.sapPoNumber === order.poNumber || po.sapDocNumber === order.poNumber);

  if (existing) {
    // Already ours — correlate it if it wasn't already (the portal-awarded
    // path: same effect as getSapPoStatus's on-demand backfill, just run
    // proactively). Never touch a row that's already `synced`; setSyncState
    // isn't used here (this isn't a job-watched document — see
    // jobs/syncState.js's DOCUMENT_FOR_KIND, which PurchaseOrder is
    // deliberately not in), so the terminal check is inline.
    if (existing.sapSyncState === 'synced') return;

    await prisma.purchaseOrder.update({
      where: { pk: existing.pk },
      data: {
        sapPoNumber: order.poNumber,
        sapDocNumber: order.poNumber,
        sapSyncState: 'synced',
        sapSyncedAt: new Date(),
        sapSyncError: null,
      },
    });
    return;
  }

  // Genuinely unsolicited: SAP has an order for this vendor the portal has
  // never seen.
  const items = (order.items || []).map((item) => ({
    line: Number(item.itemNumber) || 0,
    materialCode: item.materialCode,
    description: item.description,
    quantity: item.orderedQuantity || 0,
    grnQuantity: item.receivedQuantity || 0,
    unitPrice: item.unitPrice || 0,
    netValue: item.netAmount || 0,
    uom: item.uom || 'EA',
    // Per line, not guessed from the order as a whole (issue #62) — a real
    // PO can ship from more than one plant. `null`, honestly, when SAP
    // didn't say — never a demo-value guess.
    plant: item.plant || null,
    // EKPO-KNTTP: 'A' asset, 'D' service, 'K' cost centre, null an ordinary
    // material line. Recorded so an asset or service order SAP raised itself
    // is recognisable as one — the asset fields are only ever set by the
    // portal's own createAssetPo, so without this a discovered asset PO would
    // be indistinguishable from a stock order.
    accountAssignmentCategory: item.accountAssignmentCategory || null,
    // FPLA-FPLNR. A number here means SAP bills this line on an invoicing
    // plan's dates rather than against a goods receipt, which changes what the
    // supplier should expect to invoice — so the line is recorded as planned
    // rather than reading as an ordinary one until someone presses Sync.
    //
    // Deliberately just the number, `source: sap`, and no lines: the plan's
    // dates and amounts live in zinv_milestone/plan and are a separate read
    // (po.controller.js's syncInvoicePlan). Inventing dates here to fill the
    // shape would be inventing a billing schedule. `syncedAt` stays null,
    // which is the honest "we know this exists, we have not read it yet".
    ...(item.invoicePlanNumber
      ? { invoicePlan: { create: { clientId, enabled: true, planNumber: item.invoicePlanNumber, source: 'sap' } } }
      : {}),
  }));
  const year = new Date().getFullYear();
  const id = await nextSequentialId('purchaseOrder', `PO-${year}-`, 4);

  const created = await prisma.purchaseOrder.create({
    data: {
      id,
      sapPoNumber: order.poNumber,
      sapDocNumber: order.poNumber,
      sapSyncState: 'synced',
      sapSyncedAt: new Date(),
      vendorId: vendor.vendorId,
      vendorPk: vendor.pk,
      buyerName: order.buyerName || 'SAP System Procurement',
      // The driver has already scoped `order` to a company code this tenant
      // declared (issue #62 — see declaredCompanyCodes in
      // sap/drivers/s4odata.driver.js), so this is always real when set.
      // purchasingOrg/purchasingGroup/docType stay null: nothing in
      // zpo_grn_vendor/Detail's response names them yet.
      companyCode: order.companyCode || null,
      currency: order.currency || 'INR',
      // status starts at the schema default (Open) and is corrected below by
      // syncPoStatus, from whatever SAP already shows received on each line
      // (issue #60) — this order never goes through the portal's own
      // acknowledge/ASN steps, so its status has to be inferred from receipts
      // alone, same as a partially received order discovered mid-flight.
      items: { create: items.map((item) => ({ clientId, ...item })) },
    },
  });
  await syncPoStatus(prisma, created.pk);

  logger.info(`[jobs] sweepPurchaseOrders discovered ${created.id} (SAP ${order.poNumber}) for vendor ${vendor.vendorId}`);
  notifyProcurement(clientId, EVENTS.PO_NEW, { id: created.id, sapPoNumber: order.poNumber, vendorId: vendor.vendorId });
}
