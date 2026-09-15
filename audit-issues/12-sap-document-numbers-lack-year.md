<!-- title: BUG: SAP document numbers are stored without fiscal or material-document year, so GRN ids will collide when SAP recycles a number range -->
<!-- labels: bug,severity:high,area:sap,area:data,backend -->

**Severity:** High — a latent data-integrity failure that fires on a calendar boundary.

## Summary

In SAP, a document number is not unique on its own:

- A material document is keyed on `MBLNR + MJAHR` (document number + year).
- An FI document is keyed on `BELNR + BUKRS + GJAHR` (number + company code + fiscal year).

The portal stores the number alone for goods receipts, and mints the business id directly
from it, against a per-tenant unique constraint. When SAP's number range recycles at a
fiscal-year boundary — standard behaviour for year-dependent ranges — the second year's
receipt collides with the first year's row.

The invoice path shows the team already knows this: it stores `miroDoc/fiscalYear`. The
goods-receipt path did not get the same treatment.

## Evidence

`backend/sap/drivers/s4odata.driver.js:1166-1167` — id minted from the bare number:
```js
grnId: `GRN-${firstGrn.grNumber}`,
sapMigoDoc: firstGrn.grNumber,
```

`backend/prisma/schema.prisma:674` — the constraint that will be violated:
```prisma
@@unique([clientId, id])
```

Contrast `s4odata.driver.js:1233`, which does it correctly:
```js
sapMiroDoc: `${found.miroDoc}/${found.fiscalYear}`,
```

The upstream payload is also missing the year: `vendorPoGrnDisplay` maps `GR_NUMBER`,
`GR_ITEM_NUMBER`, `GR_DATE` (`s4odata.driver.js:818-823`) but no `MJAHR` equivalent — so the
Z endpoint may need to return it.

## Steps to reproduce

Difficult to reproduce live before a year boundary; reproduce against the schema directly:

1. Insert a GRN with `id = 'GRN-5000001234'` for tenant CLT-0001.
2. Attempt to insert a second GRN with the same `id` for the same tenant, as a sweep would
   on a recycled number.
3. Unique-constraint violation. In the job runtime this surfaces through
   `jobs/worker.js` as a generic SAP error, so the job backs off and eventually abandons —
   and the receipt is never recorded.

## Expected

Every stored SAP document reference carries the full key. Company code belongs in this too
— see #13.

## Suggested fix

- Add `sapDocYear` (and `sapCompanyCode` for FI documents) alongside `sapDocNumber` on GRN,
  Invoice and Payment.
- Mint the GRN business id as `GRN-{year}-{number}`, or keep the id opaque and carry the SAP
  key in dedicated columns.
- Confirm with ABAP whether `zpo_grn_vendor/Detail` can return `MJAHR`; it is a one-field
  addition and removes the guesswork.
- Normalise the invoice's `miroDoc/fiscalYear` string into two columns while you are here.

## Acceptance criteria

- [ ] No SAP document is addressed by number alone.
- [ ] Two receipts with the same `MBLNR` in different years both persist.
- [ ] A unique-constraint violation in a job handler is recognised as "already handled"
      rather than reported as a SAP failure (see #19).
