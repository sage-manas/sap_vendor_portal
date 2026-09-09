const { prisma } = require('../../db/prisma');
const { formatPo } = require('../../db/poHelpers');
const { nextSequentialId } = require('../../utils/nextSequentialId');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyProcurement } = require('../notify');
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
// exists for exactly that document; duplicating its create logic here would
// be a second place to keep in sync for no new capability.
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
  if (!changed) return;

  for (const order of orders) {
    if (!order.poNumber) continue;
    // eslint-disable-next-line no-await-in-loop
    await upsertOrder({ clientId, vendor, order, localPos });
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
  // never seen. Status is inferred from what SAP already shows received,
  // since there was no ASN/acknowledgement event here to derive it from —
  // Open unless every line is already fully received.
  const items = (order.items || []).map((item) => ({
    line: Number(item.itemNumber) || 0,
    materialCode: item.materialCode,
    description: item.description,
    quantity: item.orderedQuantity || 0,
    grnQuantity: item.receivedQuantity || 0,
    unitPrice: item.unitPrice || 0,
    netValue: item.netAmount || 0,
    uom: item.uom || 'EA',
  }));
  const fullyReceived = items.length > 0 && items.every((item) => item.grnQuantity >= item.quantity);

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
      plant: order.items?.[0]?.plant || '1000',
      currency: order.currency || 'INR',
      status: fullyReceived ? 'Delivered' : 'Open',
      items: { create: items.map((item) => ({ clientId, ...item })) },
    },
  });

  logger.info(`[jobs] sweepPurchaseOrders discovered ${created.id} (SAP ${order.poNumber}) for vendor ${vendor.vendorId}`);
  notifyProcurement(clientId, EVENTS.PO_NEW, { id: created.id, sapPoNumber: order.poNumber, vendorId: vendor.vendorId });
}
