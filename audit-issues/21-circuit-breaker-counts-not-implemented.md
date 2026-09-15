<!-- title: BUG: the circuit breaker counts not_implemented errors, so calling an unbuilt driver method trips SAP for every other method -->
<!-- labels: bug,severity:medium,area:sap,backend -->

**Severity:** Medium — a self-inflicted outage on any tenant using a partially built driver.

## Summary

`breaker.run()` counts every thrown error as a failure. `NotImplementedError` is thrown
*inside* the wrapped function, so it is counted before `wrapImmediate` gets the chance to
re-throw it unwrapped. Five calls to an unimplemented method open the circuit for **all**
SAP methods on that tenant for the cooldown period.

The `ecc_rfc` driver is a 61-line skeleton that implements almost nothing, so any tenant
configured against it is one screen refresh away from a self-inflicted SAP outage.

The same applies to ordinary business-level failures: if a driver throws on a legitimate
"document not found", normal operation counts toward tripping the breaker.

## Evidence

`backend/sap/circuitBreaker.js:71-82`:
```js
try { const result = await fn(); close(); return result; }
catch (error) { failures += 1; if (wasHalfOpen || failures >= limit) trip(error); throw error; }
```

`backend/sap/index.js:65` — the call is already inside the breaker when the driver throws:
```js
result = await breaker.run(() => fn(encodedArgs));
```

`backend/sap/index.js:79` — the exemption exists, but only after the count has happened:
```js
if (error.code === 'sap_circuit_open' || error.code === 'not_implemented') throw error;
```

Compare the field-encoding path, which gets this exactly right — `applyFieldEncoding` runs at
`sap/index.js:61`, before the breaker, with a comment explaining that our own bad data must
not count against it. `not_implemented` deserves the same treatment and did not get it.

## Steps to reproduce

1. Configure a tenant with the `ecc_rfc` driver.
2. Call an unimplemented method five times (e.g. load a screen that fetches PO status).
3. Call `testConnection` — it now fails with `sap_circuit_open` for 30 seconds, despite the
   gateway being healthy.

## Expected

The breaker counts transport and gateway failures only. A method that does not exist, and a
SAP business response of "not found", are not outages.

## Suggested fix

Classify before counting:

```js
const countsAsFailure = (error) =>
  error.code !== 'not_implemented' && error.code !== 'sap_not_found';
```
and in `run()`, re-throw without incrementing when `countsAsFailure` is false. Add a
`sap_not_found` code in the drivers for legitimate empty results.

## Acceptance criteria

- [ ] Ten `not_implemented` calls leave the breaker closed.
- [ ] A 404-equivalent from SAP does not count toward the threshold.
- [ ] Test asserting both.
