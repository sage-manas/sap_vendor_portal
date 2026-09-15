<!-- title: DESIGN: GST is modelled as one header tax code and one tax amount, with no CGST/SGST/IGST, HSN or place of supply -->
<!-- labels: bug,severity:high,area:data,backend -->

**Severity:** High — an India-focused portal that cannot represent an Indian tax invoice.

## Summary

`Invoice` carries `taxCode` (defaulting to `"G1"`) and a single `taxAmount`. There is no
CGST/SGST/IGST split, no HSN/SAC per line, no place of supply, and no reverse-charge flag.

That matters here specifically, because the rest of the model is unmistakably built for
India: GSTIN, PAN, CIN, MSME number, TDS section, TAN, fiscal quarters. The tax model is the
one part that is not.

Direct consequences already in the code:

- The invoice PDF invents an 18% split to fill the gap (#08).
- `submitPlanInvoice` hardcodes 18% when no tax is stated.
- Intra-state versus inter-state supply cannot be determined, so the correct split cannot be
  computed even if the columns existed.
- Reconciliation against SAP's tax line items is not possible.

## Evidence

`backend/prisma/schema.prisma:727-729`:
```prisma
taxAmount     Decimal  @db.Decimal(14, 2)
taxCode       String   @default("G1")
```

`backend/controllers/invoice.controller.js:237` — the hardcoded rate:
```js
const taxAmount = statedTax !== undefined ? Number(statedTax) : Number((subTotal * 0.18).toFixed(2));
```

`backend/controllers/rfq.controller.js:66-73` — the whole tax model is a four-branch rate
to code mapping:
```js
const gstToTaxCode = (gstRate) => { ... if (cleanRate === '18') return 'G1'; ... };
```

`InvoiceItem` (`schema.prisma:762-776`) has no tax fields at all.

## Expected

- Tax is per line: HSN/SAC, rate, taxable value, CGST, SGST, IGST, cess.
- Place of supply on the invoice header, derived from the supplier's and the buyer's state,
  determining intra- versus inter-state treatment.
- Reverse-charge flag.
- The header `taxAmount` becomes a derived sum, not an input.

## Suggested fix

Add tax fields to `InvoiceItem`, add `placeOfSupply` and `reverseCharge` to `Invoice`, and
make the tax code registry tenant configuration rather than a four-branch function. Recompute
header totals from lines (which #05 requires anyway).

Sequence this with #05 and #08 — all three touch the same submission path, and #08 cannot be
properly fixed without this.

## Acceptance criteria

- [ ] An invoice stores per-line HSN and the CGST/SGST/IGST split.
- [ ] Intra-state supply produces CGST+SGST; inter-state produces IGST.
- [ ] No hardcoded 18% remains anywhere in the codebase.
- [ ] The PDF renders only stored values.
