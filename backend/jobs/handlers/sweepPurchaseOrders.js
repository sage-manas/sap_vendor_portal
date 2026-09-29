const { prisma } = require('../../db/prisma');
const { formatPo, syncPoStatus } = require('../../db/poHelpers');
const { nextSequentialId } = require('../../utils/nextSequentialId');
const { EVENTS } = require('../../utils/socketEmitter');
const { Prisma } = require('@prisma/client');
const { notifyProcurement, notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const { toNumber: toMoney } = require('../../utils/money');
const { toNumber: toQty } = require('../../utils/quantity');
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

    // A vendor read is the vendor's *entire* order history (issue #69's own
    // note on this same endpoint), not a page or a delta — so a previously
    // correlated order missing from it isn't a gap in this read, it is SAP
    // saying that order is gone (issue #73). This feed carries no deletion
    // flag to read instead; absence is the only signal available.
    await markDeletedOrders({ clientId, vendor, localPos, orders });
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

// A synced order this vendor's ledger no longer lists is marked, not
// silently kept (issue #73's own acceptance criterion) — but only once:
// re-checking an order already marked would just restamp the same
// sapDeletedAt over and over on every future tick it stays gone. A row
// that was never correlated (`local`/`pending`, no sapPoNumber yet) was
// never in SAP to begin with, so its absence here means nothing.
async function markDeletedOrders({ clientId, vendor, localPos, orders }) {
  const seen = new Set(orders.map((o) => o.poNumber).filter(Boolean));
  const missing = localPos.filter(
    (po) => po.sapSyncState === 'synced' && po.sapPoNumber && !po.sapDeletedAt && !seen.has(po.sapPoNumber),
  );

  for (const po of missing) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { sapDeletedAt: new Date() } });
    logger.info(`[jobs] sweepPurchaseOrders marked ${po.id} (SAP ${po.sapPoNumber}) deleted — no longer in SAP's vendor ledger`);
    notifyVendor(clientId, vendor.vendorId, EVENTS.PO_DELETED, { id: po.id, sapPoNumber: po.sapPoNumber });
  }
}

// Which of these already-correlated lines the supplier has not yet shipped
// against — an ASN line with no shipped quantity recorded. A change on a
// line already in transit or received is still written (SAP is still the
// system of record), it just doesn't interrupt the supplier with a toast
// about a shipment already on its way.
async function unshippedLines(poId, lines) {
  if (!lines.length) return new Set();
  const shipped = await prisma.asnItem.findMany({
    where: { line: { in: lines }, asn: { poId } },
    select: { line: true, shippedQuantity: true },
  });
  const hasShipped = new Set(shipped.filter((item) => toQty(item.shippedQuantity) > 0).map((item) => item.line));
  return new Set(lines.filter((line) => !hasShipped.has(line)));
}

// Field-level reconcile for an order already correlated (issue #73) —
// replaces the old unconditional early return, which meant nothing written
// in SAP after the first sight of an order (a re-priced line, a partial
// goods receipt, a changed buyer) ever reached the portal again.
//
// Scoped, deliberately: this refreshes the fields this same feed already
// carries per line (ordered quantity, received quantity, unit price, net
// value, plant) and per header (buyer, company code, currency). It does not
// add a line SAP added, or remove one SAP removed — either needs a schema
// answer for what "this line no longer exists" means on a row invoices and
// GRNs may already reference, which is the harder, still-open half of #73
// this fix deliberately leaves for a follow-up rather than guessing at.
async function reconcileOrder({ clientId, vendor, existing, order }) {
  const headerChanges = {};
  if (order.buyerName && order.buyerName !== existing.buyerName) headerChanges.buyerName = order.buyerName;
  if (order.companyCode && order.companyCode !== existing.companyCode) headerChanges.companyCode = order.companyCode;
  if (order.currency && order.currency !== existing.currency) headerChanges.currency = order.currency;

  const itemsByLine = new Map(existing.items.map((item) => [item.line, item]));
  const lineChanges = [];
  for (const orderItem of order.items || []) {
    const line = Number(orderItem.itemNumber);
    const item = itemsByLine.get(line);
    if (!item) continue; // a line added since correlation — out of scope, see above

    const data = {};
    const quantity = Number(orderItem.orderedQuantity) || 0;
    const grnQuantity = Number(orderItem.receivedQuantity) || 0;
    const unitPrice = Number(orderItem.unitPrice) || 0;
    const netValue = Number(orderItem.netAmount) || 0;
    const plant = orderItem.plant || null;

    if (quantity !== toQty(item.quantity)) data.quantity = quantity;
    if (grnQuantity !== toQty(item.grnQuantity)) data.grnQuantity = grnQuantity;
    if (unitPrice !== toMoney(item.unitPrice)) data.unitPrice = unitPrice;
    if (netValue !== toMoney(item.netValue)) data.netValue = netValue;
    if (plant !== item.plant) data.plant = plant;

    if (Object.keys(data).length) lineChanges.push({ pk: item.pk, line, data });
  }

  if (!Object.keys(headerChanges).length && !lineChanges.length) {
    // Nothing differs, but the check itself happened — sapSyncedAt describes
    // freshness of correlation, not of content (schema note on the field),
    // so it still moves forward here to make a stale order's last-checked
    // time visible.
    await prisma.purchaseOrder.update({ where: { pk: existing.pk }, data: { sapSyncedAt: new Date() } });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({ where: { pk: existing.pk }, data: { ...headerChanges, sapSyncedAt: new Date() } });
    for (const change of lineChanges) {
      // eslint-disable-next-line no-await-in-loop
      await tx.purchaseOrderItem.update({ where: { pk: change.pk }, data: change.data });
    }
  });

  // A received-quantity refresh can move status forward (issue #60) the same
  // way a portal-side goods receipt does; syncPoStatus never regresses, so a
  // stale/late tick can't undo a status a faster path already reached.
  await syncPoStatus(prisma, existing.pk);

  const unshipped = await unshippedLines(existing.id, lineChanges.map((c) => c.line));
  const supplierVisible = lineChanges.filter((c) => unshipped.has(c.line));

  logger.info(`[jobs] sweepPurchaseOrders refreshed ${existing.id} (SAP ${order.poNumber}) — ${
    [...Object.keys(headerChanges), ...lineChanges.map((c) => `line ${c.line}`)].join(', ')
  }`);

  if (Object.keys(headerChanges).length || supplierVisible.length) {
    notifyVendor(clientId, vendor.vendorId, EVENTS.PO_UPDATED, {
      id: existing.id,
      sapPoNumber: order.poNumber,
      header: headerChanges,
      lines: supplierVisible.map((c) => ({ line: c.line, ...c.data })),
    });
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
    // Already ours. A row already `synced` is re-read rather than skipped
    // (issue #73) — reconcileOrder is the field-level refresh, this branch
    // below stays for the portal-awarded path: correlating a row that
    // wasn't synced yet, same effect as getSapPoStatus's on-demand backfill,
    // just run proactively. setSyncState isn't used here (this isn't a
    // job-watched document — see jobs/syncState.js's DOCUMENT_FOR_KIND,
    // which PurchaseOrder is deliberately not in), so the terminal check is
    // inline.
    if (existing.sapSyncState === 'synced') {
      await reconcileOrder({ clientId, vendor, existing, order });
      return;
    }

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
