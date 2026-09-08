const { toNumber } = require('../utils/money');

// Shared between controllers/payment.controller.js and
// controllers/invoice.controller.js (the SAP reconciliation view in
// getSapInvoiceStatus hands a Payment row to the driver the same way payment
// endpoints do). grossAmount/tdsDeducted/netAmount/totalTds are Decimal-typed
// columns — converted to plain numbers here, the one place every consumer
// (API responses, the mock SAP driver, which just relays whatever it is
// handed) reads a payment back through. See utils/money.js for why a raw
// Decimal can't be left to reach either of those: it JSON-serializes as a
// string, not a number.
const formatPayment = (payment) => ({
  ...payment,
  grossAmount: toNumber(payment.grossAmount),
  tdsDeducted: toNumber(payment.tdsDeducted),
  netAmount: toNumber(payment.netAmount),
  totalTds: toNumber(payment.totalTds),
});

module.exports = { formatPayment };
