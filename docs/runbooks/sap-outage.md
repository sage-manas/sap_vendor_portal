# A tenant's SAP connection is failing

Applies today only to `mock` (the simulator) misbehaving, or — once Phase 8
lands — a real `s4_odata`/`ecc_rfc` driver. The mechanism is the same either
way: everything goes through `getSapAdapterForClient(clientId)`
(`backend/sap/index.js`), so there is exactly one place this can be
diagnosed.

## 1. Is it one tenant or all of them?

`GET /api/platform/health` (`platform:health:read`) lists every tenant's
`sap.status` and `sap.connection`. If only one tenant is `failing`, it's a
configuration problem on that tenant's `SapConnection`. If every tenant on
the same driver is failing, it's the driver itself.

## 2. Read the two signals separately

The board deliberately carries two things that answer different questions:

- **`sap.connection.circuit`** — is the circuit breaker open? An open circuit
  means the adapter *stopped calling* SAP because recent calls kept failing
  (`sap/circuitBreaker.js`). Traffic counts will look quiet — that quiet is
  the symptom, not evidence of a fixed problem.
- **`sap.status` from traffic** (`calls`/`failures`/`errorRate` over the last
  24h) — is SAP itself failing when called. `unknown` means no traffic in the
  window, which is not the same as healthy; don't read it as healthy.

## 3. Fix

- **Circuit open, connection misconfigured:** `/platform` → tenant → SAP →
  edit the connection, then **Test connection**. Editing clears `lastTest`
  (ADR-0020) on purpose — a green tick against settings that have since
  changed is worse than no tick. A passing test does not itself close the
  breaker; it will close on the next successful real call, or check
  `sap/circuitBreaker.js` for its reset behaviour if it seems stuck.
- **Circuit open, connection looks fine:** the downstream system (SAP itself,
  or `mock.driver.js`'s configured latency/failure behaviour) is the problem.
  For the mock driver, check `SapConnection.config` — timings and any
  injected failure mode are per-tenant config, not code.
- **High error rate, circuit still closed:** below the breaker's trip
  threshold but degraded. Same fix path — check the connection's `lastTest`
  and the tenant's `sapEnvironment` (sandbox vs production, ADR-0020).

## 4. What this does *not* affect

Every SAP result carries `{ source, syncedAt }` (ADR-0021) — the UI can
always say where a number came from and how stale it is, even mid-outage.
Deferred answers (goods receipt, payment run — ADR-0022) that were already
in flight when the outage started are not lost: the handler re-runs when the
answer eventually arrives, or stays pending and visible as such. Nothing
about an outage on one tenant's SAP connection touches another tenant's — the
adapter cache and circuit breaker are keyed per `clientId`.
