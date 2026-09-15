<!-- title: BUG: matching invoices to SAP on purchase order plus gross amount can never resolve a periodic invoicing plan -->
<!-- labels: bug,severity:high,area:sap,backend -->

**Severity:** High — the matching rule structurally fails on the feature invoicing plans
exist to support.

## Summary

The portal posts nothing to SAP, so it recognises its own invoice in SAP's ledger by matching
on purchase order number plus gross amount. `matchInvoiceDocument` correctly refuses to guess
when more than one document fits.

A monthly periodic invoicing plan produces twelve invoices against the same purchase order
for the same amount. From the second month onwards there are always at least two candidates,
so the match is permanently ambiguous:

- `awaitPaymentRun` returns "not yet" forever.
- The job burns its full attempt budget (`defaultMaxAttempts: 1440` in `jobs/kinds.js`).
- The invoice is marked `orphaned` by `jobs/syncState.js` and the supplier is never shown a
  payment, even though SAP paid it.

The refusal to guess is right. The match key is wrong.

## Evidence

`backend/sap/mappings/invoice-match.js:40-50`:
```js
return candidates.length === 1 ? candidates[0] : null;
```
with candidacy defined at `:44-47` on PO membership and gross amount within `AMOUNT_TOLERANCE`.

The file's header explains why the supplier's invoice number was deliberately excluded:
`REFERENCE`/`XBLNR` mapping is a per-configuration choice in SAP and was unconfirmed on this
sandbox. That reasoning is sound but leaves no disambiguator.

Same rule used in two places — `s4odata.driver.js:1216` and
`controllers/invoice.controller.js:350` — so a fix lands in one file.

## Steps to reproduce

1. Configure a monthly periodic invoicing plan on a PO line, twelve periods, same amount.
2. Submit the month-one invoice; let it match and clear.
3. Submit the month-two invoice for the same amount.
4. `matchInvoiceDocument` now sees two candidate MIRO documents and returns null on every
   attempt. Watch `sap_jobs` for the `awaitPaymentRun` row: attempts climb to `maxAttempts`
   and status becomes `abandoned`; the invoice's `sapSyncState` becomes `orphaned`.

## Expected

A periodic plan invoice matches the SAP document that corresponds to its own plan period.

## Suggested fix

Establish a disambiguator, in preference order:

1. **Confirm `XBLNR` with the customer's FI team.** If the supplier's invoice number lands in
   `XBLNR`, add it to the match key and the problem disappears for every invoice, not just
   plan ones. This is a question, not an ABAP build.
2. Add invoice date to the key, with a tolerance window — two periods of the same plan are
   rarely posted on the same day.
3. Where several candidates remain, do not abandon: park the invoice in a
   `needs_manual_match` state and surface it in the reconciliation console
   (`controllers/platformReconciliation.controller.js` already exists for this class of
   problem), so a human resolves it rather than the supplier silently never being paid.

Regardless of which lands, (3) should be implemented — an ambiguous match must not degrade
into an abandoned job.

## Acceptance criteria

- [ ] Twelve identical monthly invoices against one PO each match their own SAP document,
      or are parked for manual resolution.
- [ ] No invoice reaches `orphaned` purely because of ambiguity.
- [ ] Ambiguous matches appear in the reconciliation queue with both candidates shown.
- [ ] Test with two identical-amount invoices on one PO.
