const { prisma } = require('../../db/prisma');
const { PO_INCLUDE, formatPo } = require('../../db/poHelpers');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');

// Persists SAP's goods receipt once the driver finds one — moved here,
// unchanged, from the closure controllers/po.controller.js's submitASN used
// to pass directly to `sap.awaitGoodsReceipt` (docs/04-sap-runtime-engineering-plan.md
// Phase 1.6). `job.args` holds only ids; everything else is rehydrated here,
// inside the tenant binding jobs/worker.js already applied before calling in.
module.exports = async ({ job, adapter }) => {
  const { asnId, poId, vendorId } = job.args;

  const [asn, po] = await Promise.all([
    prisma.aSN.findFirst({ where: { id: asnId }, include: { items: true } }),
    prisma.purchaseOrder.findFirst({ where: { id: poId }, include: PO_INCLUDE }),
  ]);

  // The watch is stale if either side vanished, or the shipment is no longer
  // awaiting one (a previous attempt already succeeded and this is a
  // duplicate/retry) — nothing left to wait for, so the job is done.
  if (!asn || !po || asn.status !== 'Submitted') return { done: true };

  const onCall = ({ code, type }) => notifyVendor(job.clientId, vendorId, EVENTS.LOG_NEW, { type, name: code });

  const found = await adapter.awaitGoodsReceipt(
    { asn, po: formatPo(po), vendorId, clientId: job.clientId, startedAt: job.createdAt, onCall },
    async (receipt) => {
      // The GRN creation, the ASN's status flip, the PO items' grnQuantity,
      // and the PO's own status all describe one physical event (goods
      // arrived) and must land together.
      const grn = await prisma.$transaction(async (tx) => {
        const latestPo = await tx.purchaseOrder.findFirst({ where: { id: po.id }, include: { items: true } });
        const latestAsn = await tx.aSN.findFirst({ where: { id: asn.id } });

        // Guards a retried/duplicate deferred answer, which atomicity alone
        // does not — a cancelled or already-received ASN must not gain a
        // second GRN.
        if (!latestPo || !latestAsn || latestAsn.status !== 'Submitted') return null;

        const createdGrn = await tx.gRN.create({
          data: {
            id: receipt.grnId,
            poId: latestPo.id,
            asnId: latestAsn.id,
            vendorId: latestAsn.vendorId,
            sapMigoDoc: receipt.sapMigoDoc,
            postingDate: receipt.postingDate,
            receivedBy: receipt.receivedBy,
            invoiceSubmitted: false,
            items: { create: receipt.items.map((item) => ({ clientId: job.clientId, ...item })) },
          },
          include: { items: true },
        });

        await tx.aSN.update({ where: { pk: latestAsn.pk }, data: { status: 'Received' } });

        for (const gItem of receipt.items) {
          const poItem = latestPo.items.find((pItem) => pItem.line === gItem.line);
          if (poItem) {
            await tx.purchaseOrderItem.update({
              where: { pk: poItem.pk },
              data: { grnQuantity: poItem.grnQuantity + gItem.acceptedQuantity },
            });
          }
        }
        await tx.purchaseOrder.update({ where: { pk: latestPo.pk }, data: { status: 'Delivered' } });

        return createdGrn;
      });

      if (!grn) return null;

      notifyVendor(job.clientId, asn.vendorId, EVENTS.GRN_RECEIVED, grn);

      return grn;
    },
  );

  return { done: found };
};
