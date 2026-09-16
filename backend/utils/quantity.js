// Quantity columns (RfqItem.quantity, PurchaseOrderItem.quantity/
// grnQuantity, AsnItem.shippedQuantity, GrnItem.receivedQuantity/
// acceptedQuantity/rejectedQuantity, InvoiceItem.quantity — see
// prisma/schema.prisma) are Decimal(13,3), matching SAP's own MENGE, for the
// same reason the money columns are Decimal (issue #65): a Float quantity
// that accumulates across partial receipts — a line's grnQuantity sums every
// GRN posted against it — drifts (0.1 + 0.2 + 0.7 as Float is
// 0.9999999999999999, not 1), and that residue is exactly what made a fully
// received line's `grnQuantity >= quantity` false, and pushed the invoice
// quantity-variance check above zero on an exact match.
//
// Same conversion discipline as utils/money.js's toNumber, and the same
// function — re-exported under this name so a quantity call site reads as
// one rather than reaching into "money" for it.
const { toNumber } = require('./money');

module.exports = { toNumber };
