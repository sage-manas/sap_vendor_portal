// The rules a shipment notice is checked against, in one place: the
// controller that accepts an ASN and the response that tells the supplier
// what they can still ship have to agree, or the form offers a quantity the
// API then refuses.

const { toNumber: toQty } = require('../utils/quantity');
const { toNumber: toMoney } = require('../utils/money');
const { ASN_OPEN } = require('../config/statuses');

// Quantities are Decimal(13,3) — SAP's MENGE (issue #65). Compared in
// thousandths so a line shipped as 33.3 + 66.7 is exactly the 100 it adds up
// to, not a float residue short of it.
const milli = (value) => Math.round((toQty(value) || 0) * 1000);
const fromMilli = (value) => value / 1000;

// The Central GST rule: a consignment worth more than ₹50,000 needs an
// e-way bill before it moves. Some states set a higher intra-state limit;
// this is the floor that applies everywhere, so it can only ask for a bill
// a state would also ask for, never waive one. Measured on the invoice's
// GST-inclusive value, the figure the rule itself names (ASN design D5) —
// it used to be the PO's net value, which let a consignment pushed over the
// limit by its tax through without a bill.
const EWAY_BILL_THRESHOLD_INR = 50000;

// A service line is confirmed by a service entry sheet in SAP, never by a
// goods receipt (issue #313), so there is nothing to ship against it.
// 'D' is how this codebase reads EKPO-KNTTP for a service line (see
// PurchaseOrderItem.accountAssignmentCategory in schema.prisma); an entry
// sheet already posted against the line says the same thing.
const isServiceLine = (item) => item.accountAssignmentCategory === 'D'
  || (Array.isArray(item.serviceEntries) && item.serviceEntries.length > 0);

/**
 * Per PO line: what was ordered, what SAP has received, what is on an open
 * shipment notice, and what is left to ship.
 *
 * @param {object} client - `prisma` or a transaction client
 * @param {object} po - a PurchaseOrder with its `items`
 * @param {object} [options]
 * @param {string} [options.excludeAsnId] - leave one ASN out of the in-transit sum
 * @returns {Promise<Map<number, {ordered:number, received:number, inTransit:number, open:number}>>}
 */
const shippableByLine = async (client, po, { excludeAsnId } = {}) => {
  const inTransit = await client.asnItem.findMany({
    where: {
      asn: {
        poId: po.id,
        status: { in: ASN_OPEN },
        ...(excludeAsnId ? { id: { not: excludeAsnId } } : {}),
      },
    },
    select: { line: true, shippedQuantity: true },
  });

  const inTransitByLine = new Map();
  for (const row of inTransit) {
    inTransitByLine.set(row.line, (inTransitByLine.get(row.line) || 0) + milli(row.shippedQuantity));
  }

  return new Map((po.items || []).map((item) => {
    const ordered = milli(item.quantity);
    const received = milli(item.grnQuantity);
    const shipped = inTransitByLine.get(item.line) || 0;
    return [item.line, {
      ordered: fromMilli(ordered),
      received: fromMilli(received),
      inTransit: fromMilli(shipped),
      open: isServiceLine(item) ? 0 : fromMilli(Math.max(0, ordered - received - shipped)),
    }];
  }));
};

/**
 * Adds `inTransitQuantity` and `openToShipQuantity` to every item of already-
 * formatted POs, so the supplier's form can offer exactly what the API will
 * accept. One query for the whole page, not one per order.
 *
 * @param {object} client - `prisma` or a transaction client
 * @param {object[]} pos - POs as db/poHelpers.js's formatPo returns them
 */
const withShippableQuantities = async (client, pos) => {
  if (!pos.length) return pos;

  const rows = await client.asnItem.findMany({
    where: { asn: { poId: { in: pos.map((po) => po.id) }, status: { in: ASN_OPEN } } },
    select: { line: true, shippedQuantity: true, asn: { select: { poId: true } } },
  });
  const inTransit = new Map();
  for (const row of rows) {
    const key = `${row.asn.poId}:${row.line}`;
    inTransit.set(key, (inTransit.get(key) || 0) + milli(row.shippedQuantity));
  }

  return pos.map((po) => ({
    ...po,
    items: (po.items || []).map((item) => {
      const shipped = inTransit.get(`${po.id}:${item.line}`) || 0;
      const open = Math.max(0, milli(item.quantity) - milli(item.grnQuantity) - shipped);
      return {
        ...item,
        inTransitQuantity: fromMilli(shipped),
        openToShipQuantity: isServiceLine(item) ? 0 : fromMilli(open),
      };
    }),
  }));
};

// What the API returns for an ASN. Quantities become plain numbers (they are
// Decimal columns), and each line says how far SAP's receipt was from what
// was shipped: negative is a short delivery, positive an excess, null not
// received yet.
const ASN_INCLUDE = {
  items: { orderBy: { line: 'asc' } },
  documents: { select: { pk: true, originalName: true, mimeType: true, size: true, createdAt: true } },
};

const formatAsn = (asn) => {
  const { items, documents, invoiceValue, ...rest } = asn;
  return {
    ...rest,
    invoiceValue: invoiceValue == null ? null : toMoney(invoiceValue),
    items: (items || []).map(({ pk, clientId, asnPk, shippedQuantity, receivedQuantity, ...item }) => {
      const received = receivedQuantity == null ? null : toQty(receivedQuantity);
      return {
        ...item,
        shippedQuantity: toQty(shippedQuantity),
        receivedQuantity: received,
        receiptVariance: received == null ? null : fromMilli(milli(received) - milli(shippedQuantity)),
      };
    }),
    documents: (documents || []).map(({ pk, ...doc }) => ({ documentId: pk, ...doc })),
  };
};

const ewayBillRequired = (po, invoiceValue) => (po.currency || 'INR') === 'INR'
  && Number(invoiceValue) > EWAY_BILL_THRESHOLD_INR;

// The Indian financial year (1 April to 31 March) a date falls in, as the
// half-open range [start, end). An invoice number is unique per supplier
// within one — the same number may legitimately recur the next year.
const financialYearOf = (value) => {
  const date = new Date(value);
  const startYear = date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return { start: new Date(Date.UTC(startYear, 3, 1)), end: new Date(Date.UTC(startYear + 1, 3, 1)) };
};

module.exports = {
  ASN_INCLUDE,
  formatAsn,
  EWAY_BILL_THRESHOLD_INR,
  isServiceLine,
  milli,
  shippableByLine,
  withShippableQuantities,
  ewayBillRequired,
  financialYearOf,
};
