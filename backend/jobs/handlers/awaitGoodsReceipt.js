const { Prisma } = require('@prisma/client');
const { prisma } = require('../../db/prisma');
const { PO_INCLUDE, formatPo, syncPoStatus } = require('../../db/poHelpers');
const { toNumber: toQty } = require('../../utils/quantity');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { markSynced } = require('../syncState');
const { ASN_STATUS, ASN_OPEN } = require('../../config/statuses');

const isUniqueViolation = (err) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Persists SAP's goods receipts for a shipment once the driver finds them —
// moved here from the closure controllers/po.controller.js's submitASN used
// to pass directly to `sap.awaitGoodsReceipt` (docs/04-sap-runtime-engineering-plan.md
// Phase 1.6). `job.args` holds only ids; everything else is rehydrated here,
// inside the tenant binding jobs/worker.js already applied before calling in.
//
// A shipment can carry lines from several orders (ASN design V2), and SAP
// receives goods per order: the drivers read receipts off one order's ledger.
// So each order still waiting is asked about separately, each receipt found
// becomes that order's GRN, and the shipment is Partially Received until
// every order on it is in.
module.exports = async ({ job, adapter }) => {
  const { asnId } = job.args;

  const asn = await prisma.aSN.findFirst({ where: { id: asnId }, include: { items: { orderBy: { line: 'asc' } } } });

  // The watch is stale if the shipment vanished, is fully received (a
  // duplicate or retried job), or the supplier cancelled it — nothing left to
  // wait for, so the job is done.
  if (!asn || !ASN_OPEN.includes(asn.status)) return { done: true };

  const vendorId = job.args.vendorId || asn.vendorId;
  const onCall = ({ code, type }) => notifyVendor(job.clientId, vendorId, EVENTS.LOG_NEW, { type, name: code });

  // Every order on the shipment, sorted so the GRN suffix below is stable.
  const allPoIds = [...new Set(asn.items.map((item) => item.poId))].sort();
  const waiting = allPoIds.filter((poId) => asn.items.some((item) => item.poId === poId && item.receivedQuantity == null));

  // Whether SAP answered for every order still waiting. An answer that was
  // already recorded — a race with another worker — counts as answered.
  let answeredAll = true;

  for (const poId of waiting) {
    const po = await prisma.purchaseOrder.findFirst({ where: { id: poId }, include: PO_INCLUDE });
    if (!po) continue;
    const lines = asn.items.filter((item) => item.poId === poId && item.receivedQuantity == null);

    const found = await adapter.awaitGoodsReceipt(
      // The drivers match a receipt against the lines they are given, so they
      // are given only this order's lines.
      { asn: { ...asn, items: lines }, po: formatPo(po), vendorId, clientId: job.clientId, startedAt: job.createdAt, onCall },
      // eslint-disable-next-line no-loop-func
      async (receipt) => {
        // One SAP material document can cover lines of several orders, but a
        // GRN here belongs to one order. On a shipment across several orders
        // the order's position is added to the id, so the second order's GRN
        // does not collide with the first's. A single-order shipment keeps the
        // id the driver minted, as it always had.
        const grnId = allPoIds.length > 1 ? `${receipt.grnId}-${allPoIds.indexOf(poId) + 1}` : receipt.grnId;

        // The GRN, the lines' received quantities, the PO items' grnQuantity
        // and the statuses all describe one physical event (goods arrived)
        // and must land together.
        let result;
        try {
          result = await prisma.$transaction(async (tx) => {
            const latestPo = await tx.purchaseOrder.findFirst({ where: { id: po.id }, include: { items: true } });
            const latestAsn = await tx.aSN.findFirst({ where: { id: asn.id }, include: { items: true } });

            // Guards a retried/duplicate deferred answer, which atomicity alone
            // does not — a cancelled shipment, or an order on it already
            // received, must not gain another GRN.
            if (!latestPo || !latestAsn || !ASN_OPEN.includes(latestAsn.status)) return null;
            const stillWaiting = latestAsn.items.filter((item) => item.poId === po.id && item.receivedQuantity == null);
            if (!stillWaiting.length) return null;

            const createdGrn = await tx.gRN.create({
              data: {
                id: grnId,
                poId: latestPo.id,
                asnId: latestAsn.id,
                vendorId: latestAsn.vendorId,
                sapMigoDoc: receipt.sapMigoDoc,
                sapDocYear: receipt.sapDocYear,
                postingDate: receipt.postingDate,
                receivedBy: receipt.receivedBy,
                invoiceSubmitted: false,
                // Dual identity / sync state (Phase 3): a GRN is only ever
                // created *from* a found SAP goods receipt, so it starts life
                // already synced — there is no "local" or "pending" GRN.
                sapDocNumber: receipt.sapMigoDoc,
                sapSyncState: 'synced',
                sapSyncedAt: new Date(),
                items: { create: receipt.items.map((item) => ({ clientId: job.clientId, ...item })) },
              },
              include: { items: true },
            });

            // What SAP actually received against each shipped line of this
            // order, so a short or excess delivery shows against the shipment
            // that caused it.
            for (const asnItem of stillWaiting) {
              const received = receipt.items.find((gItem) => gItem.line === asnItem.line);
              await tx.asnItem.update({
                where: { pk: asnItem.pk },
                data: { receivedQuantity: received ? toQty(received.receivedQuantity) : 0 },
              });
            }

            for (const gItem of receipt.items) {
              const poItem = latestPo.items.find((pItem) => pItem.line === gItem.line);
              if (poItem) {
                // poItem.grnQuantity is Decimal-typed (issue #65) — `+` on a
                // Decimal and a plain number is string concatenation, not
                // addition (utils/money.js's header comment).
                // A receipt nobody inspected (acceptedQuantity null — every
                // receipt read from SAP, issue #351) counts what was received.
                await tx.purchaseOrderItem.update({
                  where: { pk: poItem.pk },
                  data: { grnQuantity: toQty(poItem.grnQuantity) + toQty(gItem.acceptedQuantity ?? gItem.receivedQuantity) },
                });
              }
            }
            // Derived from every line's grnQuantity (issue #60) — a receipt on
            // one line of a multi-line order must not present the whole order as
            // Delivered while the others are untouched.
            await syncPoStatus(tx, latestPo.pk);

            // Received once every order on the shipment is in.
            const othersWaiting = latestAsn.items.some((item) => item.poId !== po.id && item.receivedQuantity == null);
            const status = othersWaiting ? ASN_STATUS.PARTIALLY_RECEIVED : ASN_STATUS.RECEIVED;
            await tx.aSN.update({ where: { pk: latestAsn.pk }, data: { status } });

            return { grn: createdGrn, status };
          });
        } catch (error) {
          // The GRN id is minted from SAP's own key (MBLNR + MJAHR), not a
          // random reference the caller can just draw again — see
          // sap/drivers/*.driver.js. A collision here means this exact receipt
          // was already recorded (most likely a race with another worker
          // between the check above and this create), not a once-in-900k
          // random clash, so the fix is to recognise it as already handled
          // rather than let it surface through jobs/worker.js as a generic SAP
          // failure that backs off and eventually abandons the watch, which
          // would leave a real receipt unrecorded.
          if (!isUniqueViolation(error)) throw error;
          const existing = await prisma.gRN.findFirst({ where: { id: grnId }, include: { items: true } });
          // Only *this* shipment's receipt counts as already handled. A receipt
          // recorded against another ASN on the same order (partial shipments)
          // or with none is not this one's — adopting it would mark this ASN
          // synced to someone else's goods. Thrown, so the job retries and the
          // driver picks a receipt not yet recorded.
          if (existing && existing.asnId !== asn.id) {
            throw new Error(`Goods receipt ${grnId} is already recorded against ${existing.asnId || 'no shipment'}, not ${asn.id}`);
          }
          // The adapter writes its SAP log from what this returns, so it is
          // still the GRN; the race's winner already did the rest.
          return existing;
        }

        if (!result) return null;

        // Dual identity / sync state (Phase 3): the ASN moves pending ->
        // synced once SAP has received all of it.
        if (result.status === ASN_STATUS.RECEIVED) {
          await markSynced('awaitGoodsReceipt', { asnId: asn.id }, receipt.sapMigoDoc);
        }

        notifyVendor(job.clientId, asn.vendorId, EVENTS.GRN_RECEIVED, result.grn);

        return result.grn;
      },
    );
    if (!found) answeredAll = false;
  }

  const latest = await prisma.aSN.findFirst({ where: { id: asn.id }, select: { status: true } });
  return { done: answeredAll || !latest || !ASN_OPEN.includes(latest.status) };
};
