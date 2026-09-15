<!-- title: BUG: quantities are Float while money is Decimal, and those quantities drive invoice match variance -->
<!-- labels: bug,severity:medium,area:data,backend -->

**Severity:** Medium — floating-point quantities feeding a tolerance comparison.

## Summary

Money columns are correctly `Decimal(14,2)` throughout, and the `toNumber()` discipline
around them is good. Quantities are `Float` — double precision — everywhere:
`quantity`, `grnQuantity`, `receivedQuantity`, `acceptedQuantity`, `rejectedQuantity`,
`shippedQuantity`.

SAP's `MENGE` is a decimal (13,3) for a reason. These values feed the quantity-variance
comparison that decides whether an invoice is flagged, and they accumulate across partial
receipts.

## Evidence

`backend/prisma/schema.prisma:367` (RfqItem), `:512-513` (PurchaseOrderItem),
`:633` (AsnItem), `:693-695` (GrnItem), `:771` (InvoiceItem) — all `Float`.

Consumed in the variance check at `backend/controllers/invoice.controller.js:117`:
```js
const qtyVariance = Math.abs(acceptedQty - invQty) / acceptedQty;
```

And in the fully-received determination at
`backend/jobs/handlers/sweepPurchaseOrders.js:104`:
```js
const fullyReceived = items.length > 0 && items.every((item) => item.grnQuantity >= item.quantity);
```

## Steps to reproduce

Partial receipts of 0.1, 0.2 and 0.7 of a unit accumulate to 0.9999999999999999, so
`grnQuantity >= quantity` is false and the order never reaches `Delivered`. The same
residue pushes `qtyVariance` above zero on an exact match.

## Expected

Quantities are `Decimal(13,3)`, matching SAP, and read through the same `toNumber()` path as
money.

## Suggested fix

Change the column types and migrate. `utils/money.js` already provides the conversion
discipline; extend it (or add `utils/quantity.js`) so quantity reads go through one place.
The existing `tests/decimal-money-fields.test.js` is the pattern to copy for a quantity
equivalent.

## Acceptance criteria

- [ ] All quantity columns are `Decimal(13,3)`.
- [ ] No quantity is used in arithmetic without conversion.
- [ ] Test: three partial receipts summing exactly to the ordered quantity mark the line
      fully received.
