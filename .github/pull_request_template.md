<!--
Keep the summary short and say WHY. The diff already says what.
-->

## Summary

## Test plan

---

### Tests

<!--
These two exist because the repo's two most serious defects — an uninvited
supplier bidding on a sealed tender, and the first bid closing that tender —
both survived a suite of 30+ backend files. Neither was untested. Both were
*wrongly* tested: one asserted the hole as expected behaviour, the other
seeded around it through the ORM with a comment explaining why. A wrongly
tested path reads as covered, goes green every run, and resists the fix.
See ADR-0037.
-->

- [ ] No test here builds, through direct database access, a state the API is
      supposed to be able to produce. Seeding *preconditions* the test is not
      exercising is fine — a tenant, an approved supplier, historical rows.
      Seeding the exact thing the endpoint under test should produce is a
      finding about the API. If it is deliberate, link the issue saying why.
- [ ] No test name describes behaviour we would not want a customer to rely
      on. `'accepts a bid from a non-invited vendor'` is a security hole
      written in the language of a feature.

<!--
This one exists because five `:id` read endpoints resolved a document by id
alone — the tenant boundary was enforced, the ownership boundary wasn't, so
any supplier could read any other supplier's PO, invoice, payment or GRN in
the same tenant. See ADR-0038 and `utils/requestScope.js`'s `scopedWhere`.
-->

- [ ] Every new or edited `GET .../:id` (or `:id/child`) route reachable by a
      supplier scopes its lookup to the caller's own document — via
      `scopedWhere(req, { id: ... })`, or, for a parent/child route, by
      checking the parent. A supplier resolving someone else's document gets
      404, not the document.
