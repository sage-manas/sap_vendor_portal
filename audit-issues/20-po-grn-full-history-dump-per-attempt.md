<!-- title: PERF: every goods-receipt check re-downloads the supplier's entire purchase order history from SAP -->
<!-- labels: performance,severity:high,area:sap,backend -->

**Severity:** High — will not survive a production tenant.

## Summary

`vendorPoGrnDisplay` fetches a supplier's complete purchase order history — every order, with
line items and goods receipts nested — with no date filter, no document filter, no `$top`
and no paging. The driver's own config documents 22–84 seconds and roughly half a megabyte
for 173 orders.

`awaitGoodsReceipt` calls it **once per ASN, per job attempt**. `awaitPaymentRun` similarly
re-reads the full MIRO ledger on every attempt, which its own comment acknowledges is more
traffic than the design it replaced.

The discovery sweeps mitigate this with response fingerprinting (`jobs/fingerprint.js`), and
that part is well done — but the targeted watches bypass the cursor entirely and call the
driver directly.

Twenty open shipments across fifty suppliers on a one-minute cadence is roughly 1,000 calls
an hour against an endpoint that can take a minute and a half to answer.

## Evidence

`backend/sap/drivers/s4odata.driver.js:778-782` — the unfiltered request:
```js
const response = await getWithBody(url, { headers: baseHeaders(config, secrets),
  body: { vendor: vendor.sapVendorCode },
  timeoutMs: Number(config.poGrnTimeoutMs) || 120000 });
```
The body carries only the vendor code — the Z endpoint accepts nothing else.

`backend/sap/drivers/s4odata.driver.js:1135` — called from the per-ASN watch:
```js
const { orders } = (await driver.vendorPoGrnDisplay({ vendor: vendorDoc })).data;
```

`backend/jobs/kinds.js` — `awaitGoodsReceipt` cadence and a `maxAttempts` in the hundreds.

Compounding: `sap/index.js` builds the circuit breaker per adapter instance, per process. The
API process and the jobs process each hold their own, so neither sees the other's failures
and SAP receives roughly double the pressure before anything trips.

## Expected

A goods-receipt check asks SAP about one purchase order, not about every order the supplier
has ever had.

## Suggested fix

Two tracks, and the first does not need ABAP:

**Portal side.** Route the targeted watches through the same cursor and fingerprint machinery
the sweeps use, so one fetch per vendor per cadence serves every open ASN for that vendor
rather than one fetch per ASN. Share the adapter's response through a short-lived per-tenant
cache keyed on vendor code.

**ABAP side.** Ask for a purchase-order parameter and a changed-since date on
`zpo_grn_vendor/Detail`. This is a filter on an existing report, not new functionality, and
it pairs with the company-code filter in #13 — worth raising as one request.

Also: move the circuit breaker state somewhere both processes can see, or accept and document
that the effective failure threshold is double the configured one.

## Acceptance criteria

- [ ] N open ASNs for one supplier produce one SAP call per cadence, not N.
- [ ] A goods-receipt check for a known PO number does not download unrelated orders.
- [ ] The ABAP request is written up and sent, with the company-code ask from #13.
- [ ] Load test: 50 suppliers, 20 open ASNs each, measured calls per hour.
