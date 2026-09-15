<!-- title: BUG: vendorVerifyKyc and vendorReject call no SAP service, and reference a dead Mongo field so every log entry records documentRef undefined -->
<!-- labels: bug,severity:medium,area:sap,backend -->

**Severity:** Medium — an integration that logs an outcome it never performed, plus a
migration leftover that the conformance suite actively protects.

## Summary

Two problems in the same handful of lines.

1. In the S/4 driver, `vendorVerifyKyc` and `vendorReject` perform no HTTP call. They return
   a log entry and nothing else. A tenant on the real driver sees "KYC verified in SAP" in
   the SAP log when SAP was never contacted.

2. Both reference `vendor._id`, a Mongoose field that no longer exists after the Prisma
   migration (the surrogate key is `pk`). `String(undefined)` is the literal string
   `"undefined"`, which is what gets written to `documentRef`.

The same `_id` reference appears six times across both drivers.

## Evidence

`backend/sap/drivers/s4odata.driver.js:1053-1061` — `vendorVerifyKyc`, no `odata.call`:
```js
vendorVerifyKyc: async ({ vendor, result }) => ({
  data: { gstinValid: result.gstinValid, panValid: result.panValid },
  log: { ..., documentRef: String(vendor._id) },
}),
```

Dead-field sites: `s4odata.driver.js:378`, `:1059`, `:1068`;
`mock.driver.js:158`, `:492`, `:501`.

**The conformance suite hides this.** `backend/sap/conformance/fixtures.js:12` still supplies
the Mongo-era field:
```js
_id: 'VENDORDOC-CONFORMANCE-1',
```
so the fixture makes the broken code pass. This is exactly the failure mode AGENTS.md warns
about — a wrongly tested path reads as covered and resists the fix.

## Steps to reproduce

1. Approve a supplier on a tenant configured with the `s4_odata` driver.
2. `GET /api/saplogs` — an entry of type `KYC` with status SUCCESS, `documentRef: "undefined"`.
3. Check the SAP gateway access log for the same window: no request was made.

## Expected

- `documentRef` carries the vendor's real identifier (`vendor.pk` or `vendor.vendorId`).
- A method that performs no SAP call either implements one or throws `not_implemented`
  (the contract already provides `notImplementedDriver` for exactly this), so a half-built
  driver is honest about which half is built.
- The conformance fixture mirrors the real Prisma shape.

## Suggested fix

Replace all six `vendor._id` with `vendor.pk`. Remove `_id` from
`sap/conformance/fixtures.js` and confirm the suite then fails before it passes. Decide per
method whether KYC/reject should write to SAP; if there is no endpoint, drop the overrides so
they fall through to `notImplementedDriver`.

## Acceptance criteria

- [ ] No `_id` reference remains outside git history.
- [ ] Conformance fixture built from the Prisma model, not a hand-written Mongo document.
- [ ] A log entry is only written for a call that was actually attempted.
