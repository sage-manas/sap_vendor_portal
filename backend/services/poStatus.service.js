// Derives PurchaseOrder.status from line-item and document facts, rather than
// letting each event handler declare it directly (issue #60).
//
// PoStatus (prisma/schema.prisma) is a single header enum — Open ->
// Acknowledged -> Dispatched -> Delivered -> Invoiced -> Paid — kept for
// display/filtering compatibility, but real orders spend most of their life
// partially delivered or partially invoiced, which a header-only status
// cannot represent on its own. So the enum stays; what changes is that
// nothing writes it by decree any more; it is always computed from the
// per-line facts that are already modelled (PurchaseOrderItem.grnQuantity,
// InvoiceItem quantities, InvoicePlanLine.status) and applied through
// applyDerivedPoStatus (db/poHelpers.js), which also enforces that the
// header can only advance, never regress.
//
// No new "invoicedQuantity" column was added to PurchaseOrderItem for this:
// a GRN-matched line's invoiced quantity is the sum of InvoiceItem.quantity
// across that PO's invoices for the same line (the only place that number is
// ever recorded), and a plan-enabled line's completion already has a fact of
// its own (services/invoicePlan.service.js's summarizePlan().complete) — a
// stored duplicate of either would just be one more place to keep in sync.

const { summarizePlan } = require('./invoicePlan.service');
const { toNumber } = require('../utils/quantity');

const STATUS_ORDER = ['Open', 'Acknowledged', 'Dispatched', 'Delivered', 'Invoiced', 'Paid'];
const STATUS_RANK = Object.fromEntries(STATUS_ORDER.map((status, index) => [status, index]));

const statusRank = (status) => STATUS_RANK[status] ?? 0;

// quantity/grnQuantity are Decimal-typed columns (issue #65) — converted
// here rather than left to `>`/`>=`'s implicit coercion, which for two
// Decimal instances compares decimal.js's own valueOf() strings
// *lexicographically* ("10" < "9"), not numerically. See utils/money.js's
// header comment for the same trap on `+`.
const itemFullyDelivered = (item) => toNumber(item.quantity) > 0 && toNumber(item.grnQuantity) >= toNumber(item.quantity);

// A plan-enabled line is billed by percentage/amount against its own
// schedule, not by quantity — "fully invoiced" for it means the plan itself
// is complete (every instalment invoiced), not a quantity comparison. A
// twelve-month periodic plan is therefore not "invoiced" until month twelve,
// not month one.
const itemFullyInvoiced = (item, invoicedQtyByLine) => {
  if (item.invoicePlan?.enabled) {
    return summarizePlan(item.invoicePlan)?.complete === true;
  }
  const invoiced = invoicedQtyByLine.get(item.line) || 0;
  return toNumber(item.quantity) > 0 && invoiced >= toNumber(item.quantity);
};

/**
 * Computes what PurchaseOrder.status should be right now.
 *
 * @param {object} po - carries `acknowledgedAt` and `items` (each item's
 *   `invoicePlan` included the way db/poHelpers.js's PO_INCLUDE shapes it).
 * @param {object} facts
 * @param {number} facts.asnCount - shipments the supplier has submitted through the portal.
 * @param {Map<number, number>} facts.invoicedQtyByLine - summed InvoiceItem quantity per PO line.
 * @param {number} facts.invoiceCount - invoices raised against this PO, of any kind.
 * @param {boolean} facts.allInvoicesCleared - true only when every one of those invoices has cleared.
 */
const derivePoStatus = (po, facts) => {
  const items = po.items || [];
  if (!items.length) return po.acknowledgedAt ? 'Acknowledged' : 'Open';

  const allDelivered = items.every(itemFullyDelivered);
  const allInvoiced = items.every((item) => itemFullyInvoiced(item, facts.invoicedQtyByLine));

  if (allInvoiced && facts.invoiceCount > 0 && facts.allInvoicesCleared) return 'Paid';
  if (allInvoiced) return 'Invoiced';
  if (allDelivered) return 'Delivered';

  // "Dispatched" covers a shipment in flight either because the supplier
  // filed one through the portal, or — for a PO SAP raised directly, which
  // never goes through the portal's acknowledge/ASN steps at all (see
  // jobs/handlers/sweepPurchaseOrders.js) — because SAP already shows some
  // quantity received on at least one line. Either way, "nothing is moving
  // yet" would misrepresent a partially received order as untouched.
  const shipmentInFlight = facts.asnCount > 0 || items.some((item) => toNumber(item.grnQuantity) > 0);
  if (shipmentInFlight) return 'Dispatched';

  return po.acknowledgedAt ? 'Acknowledged' : 'Open';
};

module.exports = { STATUS_ORDER, statusRank, derivePoStatus };
