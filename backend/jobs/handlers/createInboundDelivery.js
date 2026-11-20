const { prisma } = require('../../db/prisma');
const { PO_INCLUDE, formatPo } = require('../../db/poHelpers');
const { ASN_STATUS } = require('../../config/statuses');
const logger = require('../../utils/logger');

// Turns a submitted shipment notice into an inbound delivery in SAP —
// ADR-0049. Enqueued by submitASN, beside the goods-receipt watch.
//
// SAP creates the delivery and reports its number; this records it on the
// ASN. `ASN.sapInboundDelivery` means the delivery SAP holds *now*: it is
// cleared again when the delivery is deleted, and the SAP log keeps the
// history. A driver that cannot create one answers `{ created: false }` and
// the job is done — the shipment stays a portal record, which is all it ever
// was before this existed.
//
// The ASN's own sapSyncState is not touched. It tracks the goods receipt
// (jobs/syncState.js), and a delivery is a step on the way there, not the
// answer; a failure here shows on the jobs board, and the goods-receipt watch
// carries on matching by PO either way.

// The supplier withdrew the shipment while, or before, SAP created its
// delivery. A throw retries the job, which comes back here.
const removeDelivery = async (adapter, asn) => {
  const result = await adapter.inboundDeliveryCancel({ asn, vendorId: asn.vendorId });
  if (!result?.cancelled) {
    logger.warn(`[jobs] createInboundDelivery: ${asn.id} was cancelled, but this connection cannot delete delivery ${asn.sapInboundDelivery} — remove it in VL32N`);
    return;
  }
  await prisma.aSN.updateMany({
    where: { pk: asn.pk, sapInboundDelivery: asn.sapInboundDelivery },
    data: { sapInboundDelivery: null },
  });
};

module.exports = async ({ job, adapter }) => {
  const { asnId } = job.args;

  const asn = await prisma.aSN.findFirst({ where: { id: asnId }, include: { items: { orderBy: { line: 'asc' } } } });
  if (!asn) return { done: true };

  if (asn.status === ASN_STATUS.CANCELLED) {
    if (asn.sapInboundDelivery) await removeDelivery(adapter, asn);
    return { done: true };
  }
  // Already has one (a retry after the write landed), or SAP received the
  // goods before this ran — nothing left to announce.
  if (asn.sapInboundDelivery || asn.status !== ASN_STATUS.SUBMITTED) return { done: true };

  const po = await prisma.purchaseOrder.findFirst({ where: { id: asn.poId }, include: PO_INCLUDE });
  if (!po) return { done: true };
  // A delivery references the order SAP holds. A portal-awarded order has no
  // SAP number until the sweep correlates it — wait for that rather than fail.
  if (!po.sapPoNumber) return { done: false };

  const vendor = await prisma.vendor.findFirst({ where: { vendorId: asn.vendorId } });
  if (!vendor?.sapVendorCode) return { done: false };

  const result = await adapter.inboundDeliveryCreate({ asn, po: formatPo(po), vendor });
  if (!result?.created) return { done: true };

  // Recorded whatever happened to the ASN meanwhile: SAP holds this delivery
  // now, and the portal saying otherwise would hide it.
  await prisma.aSN.updateMany({
    where: { pk: asn.pk, sapInboundDelivery: null },
    data: { sapInboundDelivery: result.delivery },
  });

  // cancelASN found no delivery to remove while this was in flight, so it is
  // removed here. The create is idempotent on the ASN id, so a retry after a
  // failed delete finds this same delivery rather than making another.
  const latest = await prisma.aSN.findFirst({ where: { pk: asn.pk } });
  if (latest.status === ASN_STATUS.CANCELLED && latest.sapInboundDelivery) {
    await removeDelivery(adapter, latest);
  }

  return { done: true };
};
