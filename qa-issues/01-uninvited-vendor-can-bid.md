<!-- title: SECURITY: any supplier can submit a bid on an RFQ they were not invited to -->
<!-- labels: security,severity:critical,area:rfq,backend -->

## Severity

**Critical** — unauthorised participation in a sealed competitive tender.

## Summary

`submitBid` does not reject a supplier who is absent from the RFQ's invitee
list. Instead it **silently creates the invitation** and lets the bid through.

The inline comment says this is for "dev/unauth mode", but there is no
environment gate — `grep -rn NODE_ENV backend --include=*.js` returns four
matches across the whole business layer and none of them is in this file.
This code path is live in production.

## Evidence

`backend/controllers/rfq.controller.js:299`

```js
// Verify vendor is invited or dynamically invite them in dev/unauth mode
let invitation = rfq.invitedVendors.find((v) => v.vendorExtId === vendorId);
if (!invitation) {
  invitation = await prisma.rfqInvitedVendor.create({
    data: {
      rfqPk: rfq.pk,
      vendorExtId: vendorId,
      name: vendor ? vendor.companyName : 'Test Vendor',
      status: 'Pending',
      rating: 95,
    },
  });
}
```

## Steps to reproduce

1. Sign in as a `buyer` in tenant `CLT-0001`.
2. Create an RFQ inviting **only** supplier A:

   ```bash
   curl -X POST "$API/api/rfqs" \
     -H "Authorization: Bearer $BUYER_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"description":"Sealed tender","deadlineDate":"2027-01-01",
          "items":[{"line":10,"materialCode":"MAT-1","description":"Widget","quantity":100}],
          "invitedVendors":[{"id":"VND-AAAAA"}]}'
   ```

   Note the returned `id`, e.g. `RFQ-2026-014`.

3. Sign in as supplier **B** (`VND-BBBBB`) — a different, approved supplier in
   the same tenant, who was **not** invited.
4. Submit a bid against A's tender:

   ```bash
   curl -X POST "$API/api/rfqs/RFQ-2026-014/bid" \
     -H "Authorization: Bearer $VENDOR_B_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"unitPrices":{"10":42},"gstRate":18,"deliveryLeadTimeDays":7}'
   ```

### Expected

`403 Forbidden` — supplier B is not a participant in this tender.

### Actual

`200 OK`, `{"message":"Bid submitted successfully","bidsCount":1}`.
Supplier B now appears in `invitedVendors` with `rating: 95`, and their bid is
included in `GET /api/rfqs/RFQ-2026-014/evaluate`.

## Additional exposure

- RFQ ids are sequential and guessable (`RFQ-<year>-001`, `-002`, …), so an
  attacker does not need the tender to be listed to find it. `GET /rfqs`
  correctly hides uninvited RFQs, which gives a false sense of containment.
- The 400 response `Missing unit price for line 20` leaks the tender's line
  structure to a non-participant, enabling reconnaissance before bidding.

## Blocking problem: a passing test enforces this behaviour

`backend/tests/rfq.test.js:118`

```js
it('accepts a bid from a non-invited vendor by dynamically inviting them', async () => {
  const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(
    rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
  )).body;

  const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
  expect(res.status).toBe(200);

  const stored = await asTenant(() => readRfq(rfq.id));
  expect(stored.invitedVendors.map(v => v.id)).toContain('vendor_test_001');
});
```

**CI currently defends the vulnerability.** Fixing the controller will turn
this test red. It must be rewritten, not deleted or relaxed.

## Suggested fix

```js
const invitation = rfq.invitedVendors.find((v) => v.vendorExtId === vendorId);
if (!invitation) {
  return next(ApiError.forbidden('You are not invited to bid on this RFQ'));
}
```

Consider answering `404` instead of `403` for consistency with the
cross-tenant rule (the API should not confirm a tender the caller may not
participate in exists) — worth a deliberate decision either way.

Remove the `'Test Vendor'` and `rating: 95` literals; they are test
scaffolding in a production write path (see the linked rating issue).

## Acceptance criteria

- [ ] An uninvited supplier receives 403 (or 404) and no `RfqInvitedVendor`
      row is created.
- [ ] `rfq.test.js:118` rewritten to assert rejection, renamed accordingly.
- [ ] New test: an uninvited supplier's bid does not appear in
      `GET /rfqs/:id/evaluate`.
- [ ] New test in `rbac-hardening.test.js` covering cross-RFQ bid attempts.
- [ ] If a dev-only bypass is genuinely wanted, it is gated on
      `NODE_ENV !== 'production'` and the test name says so.
