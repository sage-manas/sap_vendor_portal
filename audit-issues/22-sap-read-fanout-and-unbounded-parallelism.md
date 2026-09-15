<!-- title: PERF: the invoice SAP-status endpoint fans out one uncapped SAP call per matched invoice -->
<!-- labels: performance,severity:medium,area:sap,backend -->

**Severity:** Medium — one user action can saturate the customer's SAP gateway.

## Summary

`getSapInvoiceStatus` first pulls the supplier's entire MIRO ledger, then issues a
`invoicePaymentDetail` call for every matched invoice in a single unbounded `Promise.all`.
A supplier with 80 matched invoices produces 80 simultaneous requests to the customer's
gateway from one page load.

Because the circuit breaker counts every failure, a burst that overwhelms the gateway trips
the breaker and takes out SAP access for that tenant entirely.

## Evidence

`backend/controllers/invoice.controller.js:366-374`:
```js
await Promise.all(matchedInvoices.map(async (inv) => {
  const detail = await sap.invoicePaymentDetail({ ... });
```

No `take` on the invoice query at `:324` either, so the fan-out grows without bound as a
supplier's history grows.

## Steps to reproduce

1. A supplier with 80+ invoices that match SAP documents.
2. `GET /api/invoices/sap-status`.
3. Observe 80 concurrent requests to the gateway; measure response time and gateway load.

## Expected

SAP reads are bounded and paginated, and a single user action cannot issue an unbounded
number of them.

## Suggested fix

- Paginate the invoice query and only resolve detail for the page being displayed.
- Replace `Promise.all` with a small concurrency pool (4–8).
- Cache `invoicePaymentDetail` per `(miroDoc, fiscalYear)` for a short TTL — the answer for a
  cleared document does not change.
- Persist the resolved detail so a cleared invoice never needs re-reading, which the code
  already does for `sapMiroDoc` but not for the payment detail.

## Acceptance criteria

- [ ] Concurrent SAP calls from one request are capped.
- [ ] The endpoint is paginated.
- [ ] A cleared invoice's payment detail is read once, not on every page load.
