const { toNumber } = require('./money');

// The net value of a purchase order line.
//
// SAP's `NETPR` is the price for `PEINH` units, not the price for one — a line
// priced at 5,000 with a price unit of 100 costs 50 per unit. So the value of
// a line is `quantity / priceUnit * unitPrice`, and dropping the divisor
// overstates it by exactly `priceUnit`.
//
// This lives in one place because it was previously written out twice — in
// controllers/po.controller.js's createAssetPo and again in the New asset PO
// form — and both copies omitted the divisor (issue #108). Two copies of an
// arithmetic rule is one copy too many when one of them is the figure an
// operator checks before creating a document in SAP that the portal cannot
// reverse.
//
// Rounding matches the money columns: two decimal places, the same as
// `Decimal(13,2)` stores. Quantity carries three (SAP's MENGE), so the
// division is done before rounding rather than after.

const DEFAULT_PRICE_UNIT = 1;

/**
 * @param {object} line
 * @param {number|string|object} line.quantity   - MENGE. Decimal-typed columns are converted.
 * @param {number|string|object} line.unitPrice  - NETPR, the price for `priceUnit` units.
 * @param {number|string|null}  [line.priceUnit] - PEINH. Null/undefined/0 means 1.
 * @returns {number} the line's net value, rounded to 2 decimal places.
 */
const lineNetValue = ({ quantity, unitPrice, priceUnit } = {}) => {
  const qty = toNumber(quantity) || 0;
  const price = toNumber(unitPrice) || 0;

  // A zero price unit is not a legitimate SAP value and dividing by it would
  // yield Infinity, so it is read as "not stated" — same as null. The
  // validator refuses a non-positive priceUnit on the way in; this is the
  // belt-and-braces for a row written before the column existed.
  const per = toNumber(priceUnit) || DEFAULT_PRICE_UNIT;

  return Number(((qty / per) * price).toFixed(2));
};

module.exports = { lineNetValue, DEFAULT_PRICE_UNIT };
