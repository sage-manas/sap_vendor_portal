<!-- title: SECURITY: invoice totals are taken from the request body and never recomputed, and three-way match only warns -->
<!-- labels: security,severity:high,area:data,backend -->

**Severity:** High — supplier-controlled financial figures with no server-side validation.

## Summary

Two related defects in `submitInvoice`:

1. `subTotal`, `taxAmount` and `totalAmount` are taken from the request body and written
   to the invoice without ever being recomputed from the submitted line items.
2. The three-way match produces a `matchWarning` string. The invoice is accepted either
   way — variance never blocks.

In SAP, a price or quantity variance beyond the configured tolerance blocks the invoice for
payment. Here it is a note on a record that continues through the flow, feeds the payables
figures on the dashboard and reports, and is shown to the buyer as a normal submission.

## Evidence

`backend/controllers/invoice.controller.js:165-167` — body values written verbatim:
```js
subTotal: Number(subTotal || (totalAmount - (taxAmount || 0))),
taxAmount: Number(taxAmount || 0),
totalAmount: Number(totalAmount),
```

`backend/controllers/invoice.controller.js:142` — variance is cosmetic:
```js
const status = matchWarning ? 'Match Warning' : 'Submitted';
```

`backend/controllers/invoice.controller.js:118` and `:127` — tolerances are hardcoded
constants, not tenant configuration and not SAP tolerance keys:
```js
if (qtyVariance > 0.02) { ... }
if (Math.abs(poPrice - invPrice) > 0.01) { ... }
```

Also missing:

- No check that cumulative invoiced quantity across invoices stays within received quantity.
  The only guard is the `GRN.invoiceSubmitted` boolean (`:93`).
- No duplicate-invoice check, despite `Vendor.doubleInvoiceCheck` existing in the schema
  (`prisma/schema.prisma:257`) and `Invoice.invoiceNumber` carrying no unique constraint.

## Steps to reproduce

```
curl -X POST -H "Authorization: Bearer $SUPPLIER_TOKEN" -H "Content-Type: application/json" \
  -d '{"grnId":"GRN-5000001234","invoiceNumber":"INV-1","invoiceDate":"2026-09-14",
       "subTotal":1000000,"taxAmount":180000,"totalAmount":1180000,
       "items":[{"line":10,"materialCode":"MAT-1","quantity":1,"unitPrice":100,"amount":100}]}' \
  http://localhost:5000/api/invoices
```

The invoice is created with `totalAmount = 1180000` against line items worth 100. It appears
in `GET /api/invoices`, in the dashboard payables figures, and in reports.

Submit the same `invoiceNumber` twice against two different GRNs: both succeed.

## Expected

- `subTotal` is recomputed as the sum of line amounts; a submitted value that disagrees is
  rejected, not silently overwritten.
- `totalAmount` must equal `subTotal + taxAmount` within rounding tolerance.
- A price or quantity variance beyond tolerance sets the invoice to a blocked state that
  requires tenant action before it proceeds.
- Tolerances come from tenant settings (`config/tenantSettings.js`), not literals.
- A duplicate `(vendorId, invoiceNumber)` is rejected when `Vendor.doubleInvoiceCheck` is on.

## Acceptance criteria

- [ ] Server recomputes and rejects mismatched totals with 400.
- [ ] A blocked invoice cannot reach `awaitPaymentRun` until released.
- [ ] Tolerances are tenant-configurable with the current values as defaults.
- [ ] `@@unique([clientId, vendorId, invoiceNumber])` added, with a migration that reports
      existing collisions rather than failing opaquely.
- [ ] Tests for each of the four rules above.
