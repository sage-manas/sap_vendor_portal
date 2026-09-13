<!-- title: BUG: a self-invited bidder is scored with rating 95 while a properly invited bidder defaults to 80 -->
<!-- labels: bug,severity:medium,area:rfq,backend -->

## Severity

**Medium** — evaluation integrity. Depends on the uninvited-bid issue.

## Summary

The auto-created invitation hardcodes `rating: 95`, while a genuinely invited
vendor without an explicit rating falls back to `80`. Vendor rating carries
10% of the ME48 weighted score, so a supplier who was never invited is
scored **more favourably** than one who was.

## Evidence

`backend/controllers/rfq.controller.js:307` — auto-created invitation:

```js
invitation = await prisma.rfqInvitedVendor.create({
  data: {
    rfqPk: rfq.pk,
    vendorExtId: vendorId,
    name: vendor ? vendor.companyName : 'Test Vendor',
    status: 'Pending',
    rating: 95,          // <-- hardcoded, higher than the invited default
  },
});
```

`backend/controllers/rfq.controller.js:320` — the fallback for everyone else:

```js
const rating = invitation.rating || 80;
```

Evaluation formula (`PROJECT_CONTEXT.md` §7.1):
`weighted = price*0.40 + technical*0.30 + delivery*0.20 + rating*0.10`

## Steps to reproduce

Requires the uninvited-bid path to be reachable (see linked issue).

1. Create an RFQ inviting supplier A with no explicit rating.
2. A bids. B (uninvited) bids with identical prices, freight and lead time.
3. `GET /api/rfqs/:id/evaluate`.

- Expected: identical bids score identically.
- Actual: B outranks A by `(95 - 80) * 0.10 = 1.5` weighted points.

## Related problems in the same block

- `name: vendor ? vendor.companyName : 'Test Vendor'` and the same literal at
  line 326 write the string `Test Vendor` into production business records
  whenever the vendor lookup misses.
- The vendor lookup uses `findFirst({ where: { OR: [{ vendorId }, { clerkId: vendorId }] } })`
  and its result is allowed to be `null` without comment — worth deciding
  whether a bid from an unresolvable vendor should be an error rather than a
  row labelled `Test Vendor`.

## Suggested fix

Primary fix is the linked issue — reject uninvited bidders and this code path
disappears. If any auto-invite path is retained for development:

- Use the same default as everyone else (`80`), sourced from one constant.
- Remove the `'Test Vendor'` literals; fail the request if the vendor cannot
  be resolved.
- Move the default rating into `config/` rather than inlining `80` and `95`
  in two places.

## Acceptance criteria

- [ ] No hardcoded rating differs between invitation paths.
- [ ] Default vendor rating defined once, in a config module.
- [ ] `'Test Vendor'` does not appear in any non-test file.
- [ ] Test: two identical bids from differently-invited suppliers score equally.
