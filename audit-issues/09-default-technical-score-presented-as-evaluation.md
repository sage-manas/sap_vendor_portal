<!-- title: INTEGRITY: a constant 80 is fed into bid ranking as a technical evaluation score -->
<!-- labels: bug,severity:medium,area:rfq,backend -->

**Severity:** Medium — suppliers can lose tenders partly on a number nobody computed.

## Summary

`DEFAULT_TECHNICAL_SCORE = 80` is applied to every bid and carried into the weighted
evaluation matrix, where it is presented alongside genuinely computed figures as a technical
score. The config file's own comment admits no technical evaluation is captured anywhere in
the portal.

`DEFAULT_VENDOR_RATING = 80` has the same problem: it is applied when an invitation carries
no rating, with nothing distinguishing a default from a real rating in the output.

## Evidence

`backend/config/scoring.js:14` and `:19`:
```js
const DEFAULT_VENDOR_RATING = 80;
const DEFAULT_TECHNICAL_SCORE = 80;
```

`backend/prisma/schema.prisma:393` — the default is baked into the column too:
```prisma
technicalScore Float @default(80)
```

Applied at `backend/controllers/rfq.controller.js:330`:
```js
const rating = invitation.rating || DEFAULT_VENDOR_RATING;
```

Note for contrast: `getPerformance` (`controllers/vendor.controller.js:615-704`) computes
quality acceptance, delivery OTIF and invoice accuracy from real GRN/ASN/Invoice aggregates.
That one is trustworthy. This one is not, and they appear side by side in the UI.

## Expected

Either technical evaluation is captured (a buyer scores each bid against stated criteria), or
it is absent from the ranking. A constant must not be weighted as if it were data.

## Suggested fix

Two options, in order of preference:

1. Add a technical scoring step: buyer enters a score per bid before award; bids without one
   cannot be ranked on that dimension.
2. Until then, drop the technical dimension from the weighted score entirely and show it as
   "not evaluated" rather than 80.

Either way, surface provenance: a score that came from a default is labelled as such in the
evaluation matrix response.

## Acceptance criteria

- [ ] No constant contributes to a ranking as if it were measured.
- [ ] The evaluation response distinguishes measured from defaulted values.
- [ ] Test asserts two bids that differ only in price rank on price alone.
