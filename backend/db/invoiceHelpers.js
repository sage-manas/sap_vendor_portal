const { toNumber } = require('../utils/money');
const { toNumber: toQty } = require('../utils/quantity');

// Shared between controllers/invoice.controller.js and
// jobs/handlers/awaitPaymentRun.js (the job runtime rehydrates the same
// Invoice row the controller already had, and needs it in the same shape to
// hand to the SAP adapter). subTotal/taxAmount/totalAmount, each item's
// unitPrice/amount, and each item's quantity (issue #65) are Decimal-typed
// columns — converted to plain numbers here, the one place every consumer
// (API responses, the mock SAP driver's payment-run math) reads an invoice
// back through. See utils/money.js for why this can't be left to `+`'s
// implicit coercion.
const INVOICE_INCLUDE = { items: true };

// `paymentItems` (issue #63) is optional on the input, same convention as
// db/paymentHelpers.js's formatPayment — a caller that queried without
// `include: { paymentItems: true }` still gets a valid invoice, just with no
// amountPaid/outstandingAmount. When present, it's every PaymentItem
// referencing this invoice, across every Payment it's ever appeared in —
// summing them is what makes a partial settlement (or one settled across
// two separate F110 runs, the reverse case this redesign exists for)
// representable at all, since neither is a single stored column anywhere.
const formatInvoice = (invoice) => {
  const { items, paymentItems, subTotal, taxAmount, totalAmount, ...rest } = invoice;
  const total = toNumber(totalAmount);
  const amountPaid = paymentItems
    ? paymentItems.reduce((sum, item) => sum + (toNumber(item.grossAmount) || 0), 0)
    : undefined;
  return {
    ...rest,
    subTotal: toNumber(subTotal),
    taxAmount: toNumber(taxAmount),
    totalAmount: total,
    ...(amountPaid !== undefined && {
      amountPaid,
      // Never negative — a clearing that (somehow) overshoots the invoice
      // total is a reconciliation question for Finance, not a debt the
      // supplier owes back.
      outstandingAmount: Math.max(total - amountPaid, 0),
    }),
    items: (items || []).map(({ pk, clientId, invoicePk, unitPrice, amount, quantity, ...item }) => ({
      ...item,
      unitPrice: toNumber(unitPrice),
      amount: toNumber(amount),
      quantity: toQty(quantity),
    })),
  };
};

module.exports = { INVOICE_INCLUDE, formatInvoice };
