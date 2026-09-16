const { prisma } = require('../../db/prisma');
const { PO_INCLUDE, formatPo, syncPoStatus } = require('../../db/poHelpers');
const { INVOICE_INCLUDE, formatInvoice } = require('../../db/invoiceHelpers');
const { recordPaymentItem } = require('../../db/paymentHelpers');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { markSynced } = require('../syncState');

// Persists SAP's payment clearing once the driver finds one — moved here,
// unchanged, from controllers/invoice.controller.js's `schedulePaymentRun`
// closure (docs/04-sap-runtime-engineering-plan.md Phase 1.6). `job.args`
// holds only ids; everything else is rehydrated here, inside the tenant
// binding jobs/worker.js already applied before calling in.
module.exports = async ({ job, adapter }) => {
  const { invoiceId, poId, vendorId } = job.args;

  const [invoice, po, vendor] = await Promise.all([
    prisma.invoice.findFirst({ where: { id: invoiceId }, include: INVOICE_INCLUDE }),
    prisma.purchaseOrder.findFirst({ where: { id: poId }, include: PO_INCLUDE }),
    prisma.vendor.findFirst({ where: { vendorId } }),
  ]);

  // Already cleared (a previous attempt succeeded and this is a
  // duplicate/retry), or one side vanished — nothing left to wait for.
  if (!invoice || !po || invoice.status === 'Cleared') return { done: true };

  const onCall = ({ code, type }) => notifyVendor(job.clientId, vendorId, EVENTS.LOG_NEW, { type, name: code });

  const found = await adapter.awaitPaymentRun(
    {
      invoice: { ...formatInvoice(invoice), sapPoNumber: po.sapPoNumber },
      vendor,
      vendorId,
      startedAt: job.createdAt,
      onCall,
    },
    async (remittance) => {
      // The Payment row, the invoice's Cleared status, and the PO/plan-line
      // side effect all describe one event (AP cleared this invoice) and
      // must land together.
      const result = await prisma.$transaction(async (tx) => {
        const latestInvoice = await tx.invoice.findFirst({ where: { id: invoice.id } });
        const latestPo = await tx.purchaseOrder.findFirst({ where: { id: po.id }, include: PO_INCLUDE });

        // Guards a retried/duplicate deferred answer, which atomicity alone
        // does not — an invoice already cleared must not be paid twice.
        if (!latestInvoice || !latestPo || latestInvoice.status === 'Cleared') return null;

        // SAP's own MIRO number, learned by discovery rather than minted
        // here. Storing it means the reconciliation view stops having to
        // re-match.
        const sapMiroDoc = (remittance.sapMiroDoc && !latestInvoice.sapMiroDoc)
          ? remittance.sapMiroDoc
          : latestInvoice.sapMiroDoc;

        // One Payment per SAP clearing document, not per invoice (issue
        // #63) — see recordPaymentItem's own header comment for why this is
        // safe to call once per invoice's independent watch job.
        const payment = await recordPaymentItem(tx, {
          clientId: job.clientId,
          paymentId: remittance.paymentId,
          vendorId: latestInvoice.vendorId,
          remittance,
          invoiceId: latestInvoice.id,
          poId: latestPo.id,
          invoiceNumber: latestInvoice.invoiceNumber,
          sapMiroDoc,
        });

        await tx.invoice.update({
          where: { pk: latestInvoice.pk },
          data: { sapMiroDoc, status: 'Cleared', clearedAt: new Date() },
        });

        // A plan-based invoice doesn't own the PO's overall status by itself
        // — other lines may still be mid-delivery, and a periodic plan has
        // more instalments to come — but it does own its own plan entry,
        // which gains SAP's MIRO number so the plan and the invoice list
        // agree about the document without re-matching.
        if (latestInvoice.invoicePlanRef?.planLineNumber) {
          const formattedPo = formatPo(latestPo);
          const planItem = formattedPo.items.find((item) => item.line === latestInvoice.invoicePlanRef.line);
          const planLine = (planItem?.invoicePlan?.lines || []).find(
            (line) => line.lineNumber === latestInvoice.invoicePlanRef.planLineNumber,
          );
          if (planLine && sapMiroDoc) {
            const rawItem = latestPo.items.find((item) => item.line === latestInvoice.invoicePlanRef.line);
            await tx.invoicePlanLine.update({
              where: { planPk_lineNumber: { planPk: rawItem.invoicePlan.pk, lineNumber: planLine.lineNumber } },
              data: { sapMiroDoc },
            });
          }
        }

        // Derived from every line's delivered/invoiced state plus every
        // invoice's own clearing (issue #60) — a plan invoice clearing no
        // longer leaves the header stuck wherever it was; it now reaches
        // Invoiced/Paid exactly when the plan (and every other line) is
        // actually done, the same helper GRN-matched invoices go through.
        await syncPoStatus(tx, latestPo.pk);

        return { payment, sapMiroDoc, vendorId: latestInvoice.vendorId };
      });

      if (!result) return null;

      // Dual identity / sync state (Phase 3): the invoice itself moves
      // pending -> synced the moment its payment clears.
      await markSynced('awaitPaymentRun', { invoiceId: invoice.id }, result.sapMiroDoc);

      notifyVendor(job.clientId, result.vendorId, EVENTS.PAYMENT_CLEARED, result.payment);

      return result.payment;
    },
  );

  return { done: found };
};
