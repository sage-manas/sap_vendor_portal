<!-- title: INTEGRITY: the invoice PDF fabricates an 18% GST split and prints it on a document headed TAX INVOICE -->
<!-- labels: bug,severity:high,integrity,area:data,backend -->

**Severity:** High — a fabricated statutory figure on a document that presents itself as a
tax invoice.

## Summary

When an invoice has no stored `subTotal`, the PDF generator derives one by assuming an 18%
GST rate, then prints the resulting CGST/SGST split as fact on a document titled
"TAX INVOICE".

## Evidence

`backend/controllers/reports.controller.js:259-260`:
```js
const subTotal = toNumber(invoice.subTotal) || (totalAmount / 1.18);
```

The root cause is the data model: `Invoice` carries a single `taxCode` and a single
`taxAmount` (`prisma/schema.prisma:726-729`), with no CGST/SGST/IGST breakdown, no HSN/SAC
per line and no place of supply — see #17. Because the real breakdown cannot be stored, the
renderer invents one.

## Steps to reproduce

1. Create an invoice whose `subTotal` is null or zero (the plan-invoice path and any
   SAP-discovered invoice can produce this).
2. `GET /api/reports/invoice/:id/pdf`.
3. The PDF shows a subtotal and a CGST/SGST split derived from an assumed 18% rate, with
   nothing marking it as derived.

## Expected

A document labelled "TAX INVOICE" contains only figures the system actually holds. Where a
breakdown is unknown, the document either omits it or states that it is unavailable —
it never computes one from an assumed rate.

## Suggested fix

Short term: remove the fallback. If `subTotal` is missing, render the total only and label
the tax line "not available", or refuse to generate the document.

Proper fix: model tax per line (#17), then render from stored values.

## Acceptance criteria

- [ ] No arithmetic in the PDF path derives a tax figure from an assumed rate.
- [ ] An invoice with missing tax data renders without inventing one.
- [ ] Test asserts a null-`subTotal` invoice produces a PDF with no fabricated CGST/SGST.
