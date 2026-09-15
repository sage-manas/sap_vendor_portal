<!-- title: SECURITY: every supplier can read competitors' sealed bid prices on an open tender -->
<!-- labels: security,severity:critical,area:rfq,backend -->

**Severity:** Critical — destroys the integrity of the sourcing process, which is the one
end-to-end process this portal owns (everything else is read from SAP).

## Summary

`RFQ_INCLUDE` pulls `bids` with `unitPrices` into every RFQ serialisation, and `formatRfq`
emits them verbatim. Both RFQ read endpoints return that shape to suppliers:

- `GET /api/rfqs/:id` applies **no invitation check at all** — any supplier can read any
  tender in the tenant, by id.
- `GET /api/rfqs` correctly restricts a supplier to tenders they were invited to, but then
  returns every rival's bid on those tenders.

A supplier therefore sees competitors' per-line unit prices, freight, delivery lead time,
technical score, MOQ and remarks — before the deadline, on a live tender.

## Evidence

`backend/controllers/rfq.controller.js:24`
```js
const RFQ_INCLUDE = { items: true, invitedVendors: true,
  bids: { include: { unitPrices: true, uploadedDocs: true } } };
```

`backend/controllers/rfq.controller.js:62` — bids go straight into the response:
```js
bids: (rfq.bids || []).map(formatBid),
```

`backend/controllers/rfq.controller.js:176` — no invitation check:
```js
const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: RFQ_INCLUDE });
```

`backend/config/permissions.js` — the `VENDOR` role holds `RFQ_READ`.

Note the asymmetry: `submitBid` (rfq.controller.js:295) *does* enforce participation and
deliberately returns 404 to a non-participant so as not to confirm the tender exists. The
read path never got the same treatment.

## Steps to reproduce

1. As buyer, create an RFQ and invite supplier A only.
2. As supplier A, submit a bid with a distinctive unit price.
3. As supplier B (any approved supplier in the same tenant), call:
   ```
   curl -H "Authorization: Bearer $SUPPLIER_B_TOKEN" \
        http://localhost:5000/api/rfqs/RFQ-2026-001
   ```
4. Supplier B receives the full RFQ including `bids[0].unitPrices` — supplier A's prices.
5. Repeat with supplier A calling `GET /api/rfqs` on a tender both were invited to: the
   response contains the other's bid without any id guessing.

RFQ ids are sequential (`RFQ-2026-001`, `-002`, …), so step 3 enumerates trivially.

## Expected

- A supplier may read only tenders they were invited to; anything else is 404.
- A supplier never sees another supplier's bid, in any response, at any time.
- Bid visibility for tenant staff is a separate decision (arguably gated until the
  deadline passes, to match sealed-tender practice).

## Suggested fix

Split the include by plane rather than filtering after the fact:

```js
const rfqIncludeFor = (req) => isSupplier(req)
  ? { items: true, invitedVendors: true, bids: { where: { vendorId: req.scopeVendorId },
      include: { unitPrices: true, uploadedDocs: true } } }
  : RFQ_INCLUDE;
```

and in `getRFQById`, resolve through an invitation-aware finder that 404s a
non-participant, mirroring `submitBid`'s existing behaviour.

## Acceptance criteria

- [ ] A supplier reading a tender they were invited to sees only their own bid.
- [ ] A supplier reading a tender they were not invited to gets 404, not 403.
- [ ] Test: two suppliers, one tender, each asserts it cannot see the other's `unitPrices`
      via both `GET /api/rfqs` and `GET /api/rfqs/:id`.
- [ ] Test asserts the 404 body is byte-identical to the cross-tenant 404.
