<!-- title: PROCESS: two open defects are locked in by passing tests — add a review rule for API-bypassing test setup -->
<!-- labels: process,test,severity:medium -->

## Severity

**Medium** — process, not code. But it is why the two most serious defects in
this repo survived a suite of 30+ backend files.

## Summary

The two highest-severity open issues share a signature: **the test suite works
around the bug rather than failing on it.** In both cases the author could
evidently see the problem — the evidence is in their own comments.

### Case 1 — the defect is asserted as correct

`backend/tests/rfq.test.js:118`

```js
it('accepts a bid from a non-invited vendor by dynamically inviting them', async () => {
  ...
  expect(res.status).toBe(200);
  expect(stored.invitedVendors.map(v => v.id)).toContain('vendor_test_001');
});
```

An authorisation hole is written down as expected behaviour. CI now defends
it: fixing the controller turns this test red, and under deadline pressure
the test is as likely to be "fixed" as the code.

### Case 2 — the defect is routed around, with a note

`backend/tests/rfq.test.js:207`

```js
// Seed two competing bids directly (API closes bidding after the first bid)
await asTenant(async () => {
  await prisma.rfqBid.create({ ... });
  await prisma.rfqBid.create({ ... });
});
```

The ME48 evaluation test validates scoring arithmetic on data the API cannot
produce. The maths is correct and unreachable. The comment is an accurate bug
report that never became one.

## Why this pattern is worth a rule

An untested path is a known unknown — coverage tooling finds it. A *wrongly*
tested path is worse: it reads as covered, it goes green on every run, and it
actively resists the fix. Neither of these would appear in a coverage report
as a gap.

## Proposed rules

**1. API-bypassing setup is a defect report.**
If a test must write through the ORM to construct a state the API cannot
reach, that is a finding about the API, not a test helper. Either file the
issue and link it in the test, or fix the API.

Acceptable: seeding *preconditions* the test is not exercising (a tenant, an
approved vendor, historical rows). Not acceptable: seeding the exact state the
endpoint under test is supposed to produce.

**2. Test names must not describe a defect approvingly.**
`'accepts a bid from a non-invited vendor'` describes a security hole in the
language of a feature. A reviewer scanning names should be able to tell.

**3. Add to the PR template:**

```markdown
- [ ] No test in this PR constructs, via direct DB access, a state the API
      is supposed to be able to produce. (If one does, link the issue explaining why.)
- [ ] No test name asserts behaviour we would not want a customer to rely on.
```

**4. Grep guard in CI (optional, cheap).**
Flag `prisma.*.create(` inside `backend/tests/*.test.js` that is not inside an
`asTenant`/`seed*` helper, as a warning requiring a linked issue comment. A
blunt instrument, but it makes the pattern visible at review time.

## Related

A third, milder instance: `sequential-id-overflow.test.js` and
`id-collision-retry.test.js` exist because `nextSequentialId` has a documented,
deliberately-kept race. Tests that pin known-imperfect behaviour are fine —
but they should link the issue that tracks the underlying decision, so the
debt stays visible. *(See the nextSequentialId issue.)*

## Acceptance criteria

- [ ] PR template updated with the two checkboxes above.
- [ ] `rfq.test.js:118` rewritten as part of the uninvited-bid fix.
- [ ] `rfq.test.js` evaluation test rewritten to bid through the API as part of
      the first-bid fix.
- [ ] Rule documented in `AGENTS.md` so agent sessions follow it too.
