<!-- title: BUG: the first bid closes the RFQ — a competitive tender accepts exactly one bid -->
<!-- labels: bug,severity:high,area:rfq,backend -->

## Severity

**High** — the core competitive-sourcing workflow does not function.

## Summary

`submitBid` rejects any bid unless the RFQ status is `Bidding Open`, but it
also flips the status to `Submitted` as soon as the **first** bid is stored.
The second supplier to bid is told bidding is closed.

The ME48 weighted evaluation screen — price, technical score, delivery,
vendor rating — therefore has nothing to compare in practice.

## Evidence

`backend/controllers/rfq.controller.js:288` (the guard)

```js
if (rfq.status !== 'Bidding Open') {
  return next(ApiError.badRequest('Bidding is closed for this RFQ'));
}
```

`backend/controllers/rfq.controller.js:362` (the flip)

```js
// If first bid, set status to Submitted
if (rfq.status === 'Bidding Open') {
  await prisma.rFQ.update({ where: { pk: rfq.pk }, data: { status: 'Submitted' } });
}
```

## Steps to reproduce

1. As a `buyer`, create an RFQ inviting suppliers A and B, deadline well in
   the future.
2. As supplier **A**:

   ```bash
   curl -X POST "$API/api/rfqs/$RFQ_ID/bid" \
     -H "Authorization: Bearer $VENDOR_A_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"unitPrices":{"10":40},"gstRate":18,"deliveryLeadTimeDays":5}'
   ```

   → `200 OK`. RFQ status is now `Submitted`.

3. As supplier **B**, same request with a different price.

### Expected

`200 OK`. Both bids stored; `GET /rfqs/:id/evaluate` ranks two competitors.

### Actual

`400 Bad Request` — `{"error":"Bidding is closed for this RFQ"}`.
Only supplier A's bid exists. Evaluation ranks a field of one.

## Why this has survived

Three separate places record the behaviour without fixing it:

- `PROJECT_CONTEXT.md` §10 — *"Known product quirk … Flagged for a product decision."*
- `backend/tests/rfq.test.js:207` — the evaluation test seeds both bids via
  `prisma.rfqBid.create()` with the comment
  `// Seed two competing bids directly (API closes bidding after the first bid)`.
- No test exercises "second supplier bids after the first". The existing
  `'rejects a bid when bidding is not open'` case sets status to `Closed` by
  hand, so the defect is invisible to the suite by construction.

The scoring maths is correct and unreachable through the API.

## Suggested fix

Pick one:

**A. Drop the flip.** Bidding stays `Bidding Open` until the deadline passes,
the buyer cancels, or the RFQ is awarded. Simplest and matches how a tender
actually works.

**B. Add a distinct status.** Introduce `Bids Received` in
`config/statuses.js` and admit bids in both `Bidding Open` and
`Bids Received`:

```js
const BIDDABLE = ['Bidding Open', 'Bids Received'];
if (!BIDDABLE.includes(rfq.status)) { ... }
```

Preserves the "someone has responded" signal on the buyer's list view.

Either way the deadline check at line 292 remains the real gate.

## Acceptance criteria

- [ ] Two different suppliers can each bid on the same open RFQ via the API.
- [ ] New test: A bids, B bids, both succeed, `bidsCount === 2`.
- [ ] `rfq.test.js` evaluation test rewritten to create its bids **through the
      API**, and the `// Seed two competing bids directly` workaround removed.
- [ ] Re-bidding by the same supplier still replaces rather than duplicates
      (existing behaviour at line 337 — keep it and add a test).
- [ ] `PROJECT_CONTEXT.md` §10 "known product quirk" note removed.
