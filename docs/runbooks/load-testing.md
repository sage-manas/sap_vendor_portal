# Load testing

`scripts/load-test.js` is a [k6](https://k6.io) script that drives the portal's
own hot path — authentication, the dashboards, and the paginated document
lists every navigation fetches.

It exists to answer one question before go-live: **does this application fall
over at the concurrency the first customers will actually produce?** It is not
a benchmark, and it does not produce a number anyone should quote.

## Run it

```bash
BASE_URL=https://staging.example.com \
SUPPLIER_LOGIN=supplier@example.com SUPPLIER_PASSWORD=... \
STAFF_LOGIN=buyer@example.com       STAFF_PASSWORD=... \
k6 run scripts/load-test.js
```

k6 is a single static binary and is not an npm dependency here, deliberately —
it is a tool an operator runs against a deployed environment, not something
the application needs installed to work. Install it from
<https://k6.io/docs/get-started/installation/>.

The run takes about four and a half minutes: suppliers ramp 0 → 25 virtual
users and back, with three staff users pulling tenant-wide lists alongside
them. It writes `load-test-summary.json` beside wherever you ran it.

## Read the result in this order

1. **`rate_limited`.** If this is not approximately zero, stop — the numbers
   describe `express-rate-limit`, not the application. See below.
2. **`http_req_failed`.** Anything above ~0 is the actual finding. Check the
   target's logs for what failed before looking at any timing.
3. **`login_duration`** and **`list_duration`**, p(95). Login is bcrypt-bound
   and will be the slowest thing here by design; a list that is slower than
   login is worth investigating.
4. The per-endpoint breakdown. Requests are tagged by route
   (`GET /pos`, not `GET /pos?limit=20`), so the summary groups usefully.

The thresholds in the script are **provisional starting numbers**, written so
a run fails loudly rather than silently. This application has no measured
baseline yet, and inventing a performance budget would be the same mistake as
inventing a SAP latency. Record what staging actually does on a known-good
build, replace the thresholds with that, and from then on treat a regression
against your own baseline as the signal.

## Three things to get right before you trust a run

### Raise the rate limits on the target

A load generator is one IP address and one tenant. `middleware/rateLimiter.js`
caps an IP at 5000 requests per 15 minutes (`apiLimiter`) and a tenant at 300
per minute (`tenantLimiter`). Both will refuse you long before the application
struggles, and a 429 is fast — so a rate-limited run looks *better* than an
honest one.

Set `API_RATE_LIMIT_MAX` and `TENANT_RATE_LIMIT_MAX` high on the target for
the duration of the test, and put them back afterwards. The script tracks a
`rate_limited` rate and prints a warning in its summary when it is non-zero,
precisely because this is the easiest way to get a meaningless green run.

### Do not point it at a tenant wired to a real SAP

The script is read-only — every request but the login is a `GET` — and that is
not incidental. A write against a tenant whose driver is `s4_odata` reaches
that customer's SAP: `createAssetPo` creates a real purchase order there, and
nothing cleans that up afterwards. CLT-0001 is connected to a live sandbox.

Several *reads* are also SAP calls (`/pos/sap-status`,
`/invoices/sap-status`, the catalogue endpoints). Those are excluded unless you
pass `INCLUDE_SAP=true`, and you should only do that against a tenant whose
driver is `mock`. Hammering a customer's SAP gateway will trip their circuit
breaker and take the portal down for everyone on that tenant — see
[sap-outage.md](sap-outage.md) for what that looks like from the other side.

This also means the script does **not** measure SAP, and cannot. One endpoint
has been observed at 22–84 seconds (`sap/timeouts.js`); including it would
swamp every other number in the run.

### Not production, and not a dev machine

Staging. A dev machine running `npm run dev` points at the development
database, which is not something to fill with load-test session rows — and the
numbers from a laptop sharing a CPU with a bundler are not information.

## What it does not cover

- **Writes.** Submitting a bid, raising an invoice, uploading a document. All
  of these are write paths with real SAP consequences or real storage cost, and
  none is load-tested. If write throughput becomes a question, it needs a
  tenant on the `mock` driver and a separate script, kept separate so nobody
  runs it against the wrong `BASE_URL` by habit.
- **The job worker.** `jobs/worker.js` polls on its own schedule, independent
  of HTTP load. A backlog there is an alerting concern, not a k6 one.
- **Socket.io.** k6 can drive websockets, but the realtime rooms carry
  notifications rather than load, and nothing here measures them.
- **The frontend.** This is an API test. Next.js rendering and bundle size are
  a different measurement with different tools.
