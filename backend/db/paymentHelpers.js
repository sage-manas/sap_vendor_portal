const { toNumber } = require('../utils/money');
const { fiscalPeriodOf } = require('../utils/fiscalPeriod');

// Shared between controllers/payment.controller.js and
// controllers/invoice.controller.js (the SAP reconciliation view in
// getSapInvoiceStatus hands a Payment row to the driver the same way payment
// endpoints do). grossAmount/tdsDeducted/netAmount/totalTds are Decimal-typed
// columns — converted to plain numbers here, the one place every consumer
// (API responses, the mock SAP driver, which just relays whatever it is
// handed) reads a payment back through. See utils/money.js for why a raw
// Decimal can't be left to reach either of those: it JSON-serializes as a
// string, not a number.
//
// `items` (issue #63) is optional on the input — a caller that queried
// without `include: { items: true }` still gets a valid formatted payment,
// just with no items array to show. When present, each item's own Decimal
// columns are converted the same way the header's are.
const formatPaymentItem = (item) => ({
  ...item,
  grossAmount: toNumber(item.grossAmount),
  tdsDeducted: toNumber(item.tdsDeducted),
  netAmount: toNumber(item.netAmount),
});

// Issue #282: #63 moved the invoice onto PaymentItem and removed the header's
// invoiceId/invoiceNumber, but every screen that names "the invoice this
// payment settled" was still reading the header — so the reference went
// permanently blank. `invoiceRefs` is that reference, derived here rather
// than re-derived in each consumer: the invoice numbers a remittance
// settled, in item order, preferring the human-readable invoiceNumber and
// falling back to the internal invoiceId when SAP gave us no number.
//
// Omitted, not empty, when `items` was not queried — a `[]` there would
// claim the remittance settled nothing, which is a different fact from "we
// didn't ask". src/lib/paymentInvoiceLabel.js handles both.
const invoiceRefsOf = (items) => items.map((item) => item.invoiceNumber || item.invoiceId).filter(Boolean);

const formatPayment = (payment) => ({
  ...payment,
  grossAmount: toNumber(payment.grossAmount),
  tdsDeducted: toNumber(payment.tdsDeducted),
  netAmount: toNumber(payment.netAmount),
  totalTds: toNumber(payment.totalTds),
  ...(payment.items && {
    items: payment.items.map(formatPaymentItem),
    invoiceRefs: invoiceRefsOf(payment.items),
  }),
});

// Every SAP driver's vendorPaymentDisplay (mock and s4_odata alike) was
// written when Payment carried its one invoice's miroDoc/poId/amounts
// directly — it still expects one flat object per settled invoice, not a
// header with a nested items array. This is that flattening, in the one
// place both callers (controllers/payment.controller.js's
// getSapPaymentStatus, jobs/handlers/sweepPayments.js) need it: one row per
// PaymentItem, carrying its own invoice/amount fields alongside the parent
// remittance's shared ones (date, UTR, method, clearing doc, fiscal period).
// Requires `items` to have been included on each payment.
const flattenPaymentItems = (payments) => payments.flatMap((payment) => {
  // `invoiceRefs` is dropped alongside `items`: each flattened row already
  // names its own invoice, and carrying its siblings' references onto it
  // would read as though this one row settled all of them.
  const { items, pk, invoiceRefs, ...header } = formatPayment(payment);
  return (items || []).map((item) => ({
    ...header,
    ...formatPaymentItem(item),
  }));
});

// Records one settled invoice against its Payment (issue #63) — shared by
// jobs/handlers/awaitPaymentRun.js (one watch job per invoice) and
// jobs/handlers/sweepPayments.js (the discovery backstop), the two places
// that ever learn of a SAP clearing. Must run inside the caller's own
// transaction (`tx`), alongside whatever else that one event (AP cleared
// this invoice) also has to change atomically.
//
// The SAP clearing document (`remittance.sapPaymentDoc`) is the real key for
// "this is the same remittance" — an F110 run pays several invoices under
// one clearing document, and each invoice's own watch job discovers it
// independently, in no particular order. Whichever discovers it first
// creates the Payment header; every one after finds it by that same
// document and just adds its own item. A remittance with no known clearing
// document (SAP hasn't told us one) never merges with anything — each such
// payment stands alone, honestly, rather than guessing it belongs with
// another.
//
// Idempotent against a retried/duplicate deferred answer for the *same*
// invoice: `@@unique([paymentPk, invoiceId])` is the actual guarantee, this
// check just avoids depending on that constraint's error path being handled
// everywhere it could fire.
const recordPaymentItem = async (tx, { clientId, paymentId, vendorId, remittance, invoiceId, poId, invoiceNumber, sapMiroDoc }) => {
  let payment = remittance.sapPaymentDoc
    ? await tx.payment.findFirst({ where: { sapPaymentDoc: remittance.sapPaymentDoc } })
    : null;

  if (!payment) {
    payment = await tx.payment.create({
      data: {
        id: paymentId,
        vendorId,
        paymentDate: remittance.paymentDate,
        utrCode: remittance.utrCode,
        paymentMethod: remittance.paymentMethod,
        sapPaymentDoc: remittance.sapPaymentDoc,
        bankName: remittance.bankName,
        runId: remittance.runId,
        ...fiscalPeriodOf(remittance.paymentDate),
        tdsSection: remittance.tdsSection,
        deducteePan: remittance.deducteePan,
        deductorTan: remittance.deductorTan,
        // Placeholder — recomputed from real items the moment the first one
        // is added below, a few lines down in this same transaction.
        grossAmount: 0,
        tdsDeducted: 0,
        netAmount: 0,
        totalTds: 0,
        // Dual identity / sync state (Phase 3): a Payment, like a GRN, is
        // only ever created *from* a found SAP clearing, so it starts life
        // already synced.
        sapDocNumber: remittance.sapPaymentDoc,
        sapSyncState: 'synced',
        sapSyncedAt: new Date(),
      },
    });
  }

  const existingItem = await tx.paymentItem.findFirst({ where: { paymentPk: payment.pk, invoiceId } });
  if (!existingItem) {
    await tx.paymentItem.create({
      data: {
        clientId,
        paymentPk: payment.pk,
        invoiceId,
        poId,
        invoiceNumber,
        sapMiroDoc,
        grossAmount: remittance.grossAmount,
        tdsDeducted: remittance.tdsDeducted,
        netAmount: remittance.netAmount,
      },
    });

    const items = await tx.paymentItem.findMany({ where: { paymentPk: payment.pk } });
    const sum = (key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    // A bare `{ pk }` update would make the tenant extension pre-check
    // ownership through the raw (unextended) client (db/tenantExtension.js) —
    // a separate connection that can't see this same transaction's own
    // uncommitted create just above. Naming clientId in the where (the
    // compound unique key every tenant-scoped model already carries) takes
    // the extension's other branch instead, which corrects it in place and
    // runs straight against `tx`, no side read required.
    payment = await tx.payment.update({
      where: { clientId_id: { clientId, id: payment.id } },
      data: {
        grossAmount: sum('grossAmount'),
        tdsDeducted: sum('tdsDeducted'),
        netAmount: sum('netAmount'),
        totalTds: sum('tdsDeducted'),
      },
    });
  }

  return tx.payment.findFirst({ where: { pk: payment.pk }, include: { items: true } });
};

module.exports = { formatPayment, formatPaymentItem, flattenPaymentItems, recordPaymentItem };
