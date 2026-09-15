<!-- title: BUG: the job runtime releases a job without checking it still holds the lease, so a slow handler can clobber another worker's result -->
<!-- labels: bug,severity:high,area:infra,backend -->

**Severity:** High — the runtime exists to deliver side effects exactly once, and its release
step breaks its own lease contract.

## Summary

`claim()` is correct — `FOR UPDATE SKIP LOCKED`, status and `runAt` filtered, `lockedBy` and
`lockedAt` set. `release()` then writes by primary key alone, with no check that this worker
still owns the lease.

`reapStale()` reclaims any `running` job whose `lockedAt` is older than five minutes. SAP
calls here routinely exceed that: the driver's own config documents `zpo_grn_vendor/Detail`
at 22–84 seconds and defaults its timeout to 120000 ms, and `awaitPaymentRun` makes several
calls per attempt. So leases will expire mid-flight.

Sequence: worker 1 claims, calls SAP, exceeds the lease. The reaper returns the job to
`pending`. Worker 2 claims it, completes it, marks it `succeeded`. Worker 1's call finally
returns and calls `release()` with its stale job object, overwriting worker 2's terminal
state — reverting `succeeded` to `pending`, or pushing an already-synced document into
`abandoned`.

Duplicate `GRN`/`Payment` rows are prevented only incidentally, by deterministic ids hitting
a unique constraint — which `processJob` then reports as a generic SAP failure rather than
recognising as "already handled".

## Evidence

`backend/jobs/queue.js:43-51` — no `lockedBy` guard on the update.

`backend/jobs/queue.js:57` — the reaper window:
```js
const LEASE_MS = 5 * 60_000;
```

`backend/sap/drivers/s4odata.driver.js:1294` — the documented call duration:
> "this endpoint is very slow (22–84s observed for 173 orders)", default 120000 ms.

`backend/jobs/handlers/awaitGoodsReceipt.js:40` and `awaitPaymentRun.js:47` — the
transaction-time status re-check that is currently the only thing standing between this race
and duplicate rows.

## Steps to reproduce

1. Set `LEASE_MS` to 2000 ms in a test build.
2. Enqueue an `awaitGoodsReceipt` job whose driver call sleeps 5 seconds.
3. Run two workers.
4. Worker 2 completes the job and writes the GRN. Worker 1 then releases, and the
   `sap_jobs` row returns to `pending` despite the work being done — or, on the error path,
   the already-synced ASN is marked `orphaned`.

## Expected

A worker that has lost its lease cannot write.

## Suggested fix

```sql
UPDATE sap_jobs SET status = $2, run_at = $3, last_error = $4, locked_by = NULL, locked_at = NULL
WHERE pk = $1 AND locked_by = $5
```
and treat a zero-row result as "lease lost" — log it, do nothing else. Apply the same guard
to the sync-state writes in `worker.js:58,72,84`.

Separately, recognise a unique-constraint violation in a handler as an idempotent no-op
rather than a SAP error, so a benign loser does not abandon a succeeded job.

Consider raising `LEASE_MS` above the slowest configured SAP timeout, or heart-beating
`lockedAt` during long calls.

## Acceptance criteria

- [ ] `release()` is a compare-and-swap on `lockedBy`.
- [ ] A stale worker's release changes nothing.
- [ ] A duplicate-key error in a handler resolves the job as succeeded, not failed.
- [ ] Test simulating a lease expiring mid-handler with two workers.
