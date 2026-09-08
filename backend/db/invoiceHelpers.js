const { toNumber } = require('../utils/money');

// Shared between controllers/invoice.controller.js and
// jobs/handlers/awaitPaymentRun.js (the job runtime rehydrates the same
// Invoice row the controller already had, and needs it in the same shape to
// hand to the SAP adapter). subTotal/taxAmount/totalAmount and each item's
// unitPrice/amount are Decimal-typed columns — converted to plain numbers
// here, the one place every consumer (API responses, the mock SAP driver's
// payment-run math) reads an invoice back through. See utils/money.js for
// why this can't be left to `+`'s implicit coercion.
const INVOICE_INCLUDE = { items: true };

const formatInvoice = (invoice) => {
  const { items, subTotal, taxAmount, totalAmount, ...rest } = invoice;
  return {
    ...rest,
    subTotal: toNumber(subTotal),
    taxAmount: toNumber(taxAmount),
    totalAmount: toNumber(totalAmount),
    items: (items || []).map(({ pk, clientId, invoicePk, unitPrice, amount, ...item }) => ({
      ...item,
      unitPrice: toNumber(unitPrice),
      amount: toNumber(amount),
    })),
  };
};

module.exports = { INVOICE_INCLUDE, formatInvoice };
