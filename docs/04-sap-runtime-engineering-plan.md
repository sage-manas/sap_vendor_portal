 # VendorConnect — SAP Runtime Engineering Plan

> **Scope.** Six architectural gaps between what the portal does today and what a
> production multi-tenant SAP integration has to do. Sequenced so that no phase
> has to be redone by a later one.
>
> **Constraint honoured throughout.** Phases 0–5 require **zero ABAP** and zero
> SAP-side change. Everything that would need someone else's SAP backlog is
> pushed to the Deferred section, and for each of those there is a portal-side
> alternative that is already good enough to ship on. Nothing in the deferred
> section blocks anything in the sequenced section.
>
> **Status:** Draft 1 · 8 September 2026 · targets the Postgres/Prisma codebase
> as of commit-time, not the Mongoose architecture described in
> `PROJECT_CONTEXT.md` (which is stale — see Phase 0).

---

## 0. How to use this document

This is written to be executed by Claude Code, one phase per session, and read
by a human between phases.

**Rules of engagement:**

1. **One phase per branch, one phase per PR.** Phases have hard dependencies;
   interleaving them produces merge conflicts in `sap/index.js` and
   `schema.prisma` specifically.
2. **Every phase ends green.** `cd backend && npm test` must pass before the
   phase is considered done. A phase that leaves a test red is not done, it is
   abandoned in place.
3. **Read before writing.** Each phase names the files it touches. Read all of
   them first. Several contain long comments explaining why the current code is
   the way it is — those comments are load-bearing and several of them predict
   the change you are about to make.
4. **Do not restate a registry.** This codebase's central discipline is that
   every fact lives in exactly one module (`config/roles.js`,
   `config/permissions.js`, `config/sapTransactions.js`, `sap/drivers/index.js`,
   `config/tenantModels.js`). If you find yourself typing a list that already
   exists somewhere, import it instead.
5. **`AGENTS.md` still applies.** This is a modified Next.js 16 — consult
   `node_modules/next/dist/docs/` before using a Next API, per the repo mandate.

**Non-negotiable invariants.** A change that violates any of these is wrong even
if the tests pass:

| # | Invariant | Enforced by |
|---|---|---|
| I1 | No controller imports a driver or writes a `SapLog` directly | `sap/index.js` is the only path |
| I2 | Every tenant-scoped query runs inside a bound tenant context or throws | `db/tenantExtension.js` |
| I3 | Cross-tenant reads answer 404, never 403 | API contract, `tenant-isolation.test.js` |
| I4 | Every route declares exactly one permission | `route-role-matrix.test.js` fails CI otherwise |
| I5 | A number shown to a supplier is either from SAP or clearly marked as not | `stamp()` in `sap/index.js`, and Phase 3 |
| I6 | Secrets are never returned, logged, or attached to an adapter's public surface | `db/prisma.js` `omit`, `secretBox.js` |

---

## 1. The sequence, and why it is this order

```
Phase 0  Pre-flight            ── delete the Mongoose corpse, prove the floor is solid
   │
Phase 1  Durable job runtime   ── everything after this needs somewhere to run work
   │
   ├── Phase 2  Field codec     ── cheap; Phase 4 would otherwise write bad data at volume
   │
   ├── Phase 3  Sync state      ── Phase 4 needs somewhere to record "found / not found"
   │        │
   │        └── Phase 4  Discovery sweeps  ── now safe to turn on
   │
   └── Phase 5  Sourcing boundary + export bridge  ── independent, do it whenever

Deferred A   On-prem connector agent   ── build when an ECC/on-prem customer signs
Deferred B   ABAP asks                 ── opportunistic optimisation, never a blocker
```

Phases 2 and 5 are independent of each other and of 3/4 — they can run in
parallel if you have the hands. **1 → 3 → 4 is a hard chain.**

---

# Phase 0 — Pre-flight gate

**Goal:** establish that the data layer is one thing, not one-and-a-half, before
building a job runtime on top of it.

**Effort:** half a day. **Blocks:** everything.

### What is actually true right now

The Postgres migration is **substantially complete** — further along than
`PROJECT_CONTEXT.md` claims:

- `config/db.js` connects `rawPrisma`, not Mongoose.
- `db/prisma.js` is the single client, extended with tenant scoping and
  append-only enforcement.
- `tests/setup.js` runs against a real Postgres instance and resets with
  `DELETE` + `session_replication_role = 'replica'`.
- `prisma/schema.prisma` covers all ~29 tables including the relational
  line-item children (`RfqItem`, `PurchaseOrderItem`, `InvoicePlanLine`, …).

What is left is dead weight, not half-migrated logic.

### Tasks

**0.1 — Prove the Mongoose path is dead.**

```bash
cd backend
grep -rn "require('mongoose')\|require(\"mongoose\")" --include=*.js . | grep -v node_modules
grep -rln "require.*['\"].*models/" --include=*.js \
  controllers services utils middleware routes config db sap scripts tests
```

Both should return nothing outside `models/` itself. **If either returns a live
call site, stop and migrate that call site first** — do not proceed to Phase 1
with a split data layer.

**0.2 — Remove the corpse.**

- Delete `backend/models/` entirely (git history keeps it; the Prisma schema
  header already documents which Mongoose model each table came from).
- Drop `mongoose` and `mongodb-memory-server` from `backend/package.json`.
- **Keep `express-mongo-sanitize`** — despite the name it is a generic
  `$`/`.`-key stripper on request bodies and is still doing real work in
  `server.js`. Removing it is a security regression, not a cleanup.
- `npm install` to regenerate the lockfile.

**0.3 — Update the stale docs.** `PROJECT_CONTEXT.md` §2, §6 and §13 describe
MongoDB/Mongoose as current. Correct them, and update the "Last synced with
code" date. This file is the onboarding contract for every future agent session;
leaving it wrong is a compounding cost.

**0.4 — Record a baseline.** Note the current test count and wall-clock runtime
in the PR description. Later phases add substantial test surface and you will
want the before number.

### Definition of done

- `npm test` green, with the same count as before the deletion.
- `grep -rn mongoose backend --include=*.js | grep -v node_modules` returns only
  `express-mongo-sanitize` imports.
- `PROJECT_CONTEXT.md` describes Postgres.

---

# Phase 1 — Durable SAP job runtime

**Goal:** move deferred SAP work from in-process closures into rows in the
database, without changing a single controller.

**Effort:** 3–4 days. **Blocks:** Phases 3, 4. **Depends on:** Phase 0.

### The problem, precisely

`sap/drivers/s4odata.driver.js` contains a `poll()` helper (~line 190) that
`awaitGoodsReceipt` and `awaitPaymentRun` use to re-check SAP on a
`setTimeout` loop. `sap/drivers/mock.driver.js` does the same with a single
timer. This is wrong in four ways:

1. **It dies on restart.** A supplier submits an ASN at 16:58, you deploy at
   17:00, and the goods-receipt watch is gone. Nothing retries it. Nothing
   records that it vanished. The supplier's order sits at "Dispatched" forever.
2. **The driver owns time.** `pollIntervalMs` is driver config, so cadence is a
   property of the transport rather than of the tenant. A tenant with 5 vendors
   and one with 5,000 poll identically.
3. **Failure is invisible.** `onTimeout` calls `logger.error` and the watch
   evaporates. There is no queryable record that PO 4500001234 was watched for
   two hours and never resolved.
4. **It cannot scale.** Two PM2 instances means two timers per ASN and two
   goods receipts persisted. This is why `ecosystem.config.js` is pinned to
   `exec_mode: 'fork'` with a comment — the process count is load-bearing, which
   is a design smell.

### The insight that makes this cheap

`sap/index.js` already has the right abstraction. `wrapDeferred(driverName,
method, fn, breaker, clientId)` takes `(args, handler)` and does four things the
drivers must not each reinvent: circuit breaker, SapLog write, `stamp()`, and
**re-binding the tenant context around an answer that arrives outside any
request**.

That last one is exactly what a job worker needs. The wrapper already assumes
the answer arrives late and from nowhere in particular. All that changes is
*what* schedules the retry — a durable row instead of a closure.

**Controllers do not change. `contract.js` does not change. The handler
signature does not change.**

### 1.1 — Schema

Add to `prisma/schema.prisma`:

```prisma
/// Durable scheduling for SAP work that resolves after the request that
/// started it. Replaces the in-process poll() timers in the drivers.
///
/// NOT tenant-scoped, deliberately — see the note in db/tenantExtension.js.
/// The worker must claim across all tenants before it knows whose job it is;
/// it binds the tenant with runWithTenant() immediately after claiming.
model SapJob {
  pk          String    @id @default(uuid())
  clientId    String
  kind        String    // SapJobKind value — see jobs/kinds.js
  dedupeKey   String    // stable identity, e.g. "awaitGoodsReceipt:CLT-0001:ASN-000412"
  args        Json      // ids only, never hydrated documents

  status      String    @default("pending") // pending|running|succeeded|failed|abandoned|cancelled
  runAt       DateTime  @default(now())
  attempts    Int       @default(0)
  maxAttempts Int       @default(240)

  lockedBy    String?
  lockedAt    DateTime?
  lastError   String?
  lastRunAt   DateTime?
  succeededAt DateTime?

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([dedupeKey])
  @@index([status, runAt])
  @@index([clientId, kind, status])
  @@index([status, lockedAt])
}

/// Recurring work. The worker materialises SapJob rows from these when
/// nextRunAt passes. One row per (tenant, feed).
model SapSchedule {
  pk         String    @id @default(uuid())
  clientId   String
  kind       String
  intervalMs Int
  enabled    Boolean   @default(true)
  lastRunAt  DateTime?
  nextRunAt  DateTime  @default(now())

  @@unique([clientId, kind])
  @@index([enabled, nextRunAt])
}
```

**Critical:** do **not** add `SapJob` or `SapSchedule` to `TENANT_SCOPED_MODELS`
in `db/tenantExtension.js`. They belong with `Client`, `AuditLog`,
`SapConnection` — infrastructure the platform plane owns. The worker reaches
them through `withoutTenantScope()`. Add a comment in `tenantExtension.js`
saying so, next to the existing note about which models are deliberately absent,
or someone will "fix" it in six months.

**On `dedupeKey`:** the unique constraint is the idempotency guarantee. Two
requests that both try to watch the same ASN produce one row, not two. Enqueue
with `upsert` on `dedupeKey`, not `create`.

Migration:

```bash
cd backend && npx prisma migrate dev --name sap_job_runtime
```

### 1.2 — The job registry

New file `backend/jobs/kinds.js`. Same discipline as `config/sapTransactions.js`
— one place, throws on anything unregistered:

```js
const SAP_JOB_KINDS = {
  awaitGoodsReceipt: {
    label: 'Await goods receipt',
    defaultIntervalMs: 30_000,
    defaultMaxAttempts: 240,      // 2h at 30s
    recurring: false,
  },
  awaitPaymentRun: {
    label: 'Await payment run',
    defaultIntervalMs: 60_000,
    defaultMaxAttempts: 1440,     // 24h at 60s
    recurring: false,
  },
  // Phase 4 adds the discovery sweeps here.
};
```

`jobKind(key)` throws on an unknown key, mirroring `transaction()`.

### 1.3 — Enqueue and claim

New file `backend/jobs/queue.js`:

```js
const enqueue = async ({ clientId, kind, dedupeKey, args, runAt = new Date() }) => {
  const spec = jobKind(kind);
  return withoutTenantScope(() => rawPrisma.sapJob.upsert({
    where: { dedupeKey },
    create: {
      clientId, kind, dedupeKey, args, runAt,
      maxAttempts: spec.defaultMaxAttempts,
    },
    update: {},   // an existing watch is not restarted by a duplicate request
  }));
};
```

Claiming uses Postgres' own queue primitive. No Redis, no BullMQ:

```js
const claim = (workerId, limit = 20) => withoutTenantScope(() => rawPrisma.$queryRaw`
  UPDATE "SapJob" SET
    status = 'running',
    "lockedBy" = ${workerId},
    "lockedAt" = now(),
    attempts = attempts + 1,
    "lastRunAt" = now()
  WHERE pk IN (
    SELECT pk FROM "SapJob"
    WHERE status = 'pending' AND "runAt" <= now()
    ORDER BY "runAt" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *`);
```

`FOR UPDATE SKIP LOCKED` is what makes N workers safe. Two workers running this
concurrently get disjoint sets — no coordination, no lock service, no
double-execution. This is the single most important line in the phase.

Also needed:

- `release(job, { status, runAt, lastError })` — the completion path.
- `reapStale()` — jobs `running` with `lockedAt` older than a lease timeout
  (say 5× the interval) go back to `pending`. This is how a worker killed
  mid-job recovers. Run it at the top of every tick.

### 1.4 — Backoff

Put it in one function, `jobs/backoff.js`, because you will want to tune it:

```js
// Deferred SAP answers are "waiting for a human/batch elsewhere", not
// "the server is struggling" — so the base case is a flat poll interval,
// and exponential backoff applies only to *errors*.
const nextRunAt = ({ spec, attempts, errored }) => {
  if (!errored) return new Date(Date.now() + spec.defaultIntervalMs);
  const backoff = Math.min(spec.defaultIntervalMs * 2 ** Math.min(attempts, 6), 15 * 60_000);
  const jitter = backoff * (0.8 + Math.random() * 0.4);   // ±20%, avoid thundering herd
  return new Date(Date.now() + jitter);
};
```

The distinction matters. `awaitPaymentRun` polling every 60s for 24 hours is
normal and healthy — SAP genuinely has not paid yet. That must not be treated
as failure and backed off into uselessness. Only a thrown error backs off.

### 1.5 — The worker

New file `backend/jobs/worker.js`. The loop is deliberately boring:

```
reapStale()
materialiseSchedules()          // Phase 4 uses this; stub it now
jobs = claim(workerId)
for each job:
  runWithTenant(job.clientId, async () => {
    const adapter = await getSapAdapterForClient(job.clientId);
    const handler = handlerFor(job.kind);       // jobs/handlers/<kind>.js
    const outcome = await handler({ job, adapter });
    // outcome: { done: true } | { done: false } | throws
  })
sleep(tickMs)
```

**Design notes that matter:**

- **The worker is just another caller.** Tenant extension, circuit breaker,
  `SapLog`, `stamp()` — all work unchanged because the worker binds a tenant and
  calls the adapter exactly like a controller does. Do not add a bypass.
- **Handlers rehydrate from ids.** `job.args` holds `{ asnId, poId, vendorId }`,
  never a serialised ASN. The document may have changed since enqueue; a stale
  snapshot is how you persist a goods receipt against a cancelled shipment.
- **A handler returning `{ done: false }` means "not yet".** Reschedule at
  `nextRunAt`, do not increment error state. This is the normal path for a
  poll, and it maps onto the existing convention where a deferred handler
  returning `null` declines the answer and leaves the call open.
- **Exhausting `maxAttempts` sets `abandoned`, not `failed`.** They are
  different operator questions: `failed` means SAP errored, `abandoned` means
  SAP never answered. Phase 3's reconciliation queue shows them differently.

**Process model.** Run it as a second PM2 app (`vendorconnect-jobs`) in
`deploy/ecosystem.config.js`, `exec_mode: 'fork'`, pointing at
`backend/jobs/worker.js`. Do **not** run it in the API process — a slow SAP call
should never occupy the event loop that serves supplier requests. Gate it on an
env var (`JOBS_ENABLED`, default false in test) so the test suite drives handlers
directly instead of racing a live loop.

Once this is running, `vendorconnect-api` no longer needs its fork-mode pin for
correctness. Leave the pin (Socket.io still wants sticky sessions) but update the
comment — the reason has changed.

### 1.6 — Rewire the drivers

This is the payoff. In `sap/drivers/s4odata.driver.js`:

- Delete `poll()` (~line 190) and the `pollIntervalMs` / timeout config it reads.
- `awaitGoodsReceipt` and `awaitPaymentRun` become **one-shot probes**:
  `check()` once, call `handler(answer)` if found, return a "not found" signal if
  not. All the matching logic — the `vendorPoGrnDisplay` correlation, the
  `matchInvoiceDocument` call, the "every shipped line must have a GRN" rule —
  moves across **unchanged**. It is good logic; only the timer around it is wrong.
- Same treatment in `mock.driver.js`, where the timer becomes "answer on attempt
  N" so tests stay deterministic. Keep the `timings.*` config keys — they now
  mean "how many ticks before the simulator answers".
- `sap/index.js` `wrapDeferred` keeps its signature. The *caller* changes from
  a driver timer to `jobs/handlers/*`, but the wrapper cannot tell the
  difference, which is the proof the abstraction was right.

Update the block comment at the top of `contract.js` describing deferred
methods: "the mock driver uses a timer, a real driver would poll or take a
webhook" becomes a description of the job runtime.

### 1.7 — Operator surface

The platform console already has a health board (`GET /platform/health`). Extend
it — do not build a new screen:

- Per tenant: jobs pending / running / abandoned / failed, and oldest pending
  `runAt`.
- A `GET /platform/jobs` list behind `platform:health:read`, filterable by
  `clientId`, `kind`, `status`, with `lastError` visible.
- A `POST /platform/jobs/:pk/retry` behind `tenant:manage` that resets an
  abandoned job to `pending`. Audit it — add `job.retried` to
  `config/auditActions.js` (`recordAudit` rejects unregistered actions).

### Gotchas

- **`SapJob` outside the tenant extension** — stated above, restating because
  it is the one that will bite. If you add it to `TENANT_SCOPED_MODELS`, `claim()`
  throws `MissingTenantContextError` and nothing runs.
- **Nested writes bypass the extension.** Per the note in `tenantExtension.js`,
  a nested `create` does not re-enter it. Handlers that persist a GRN with its
  items must either pass `clientId` explicitly in the nested payload or issue
  child writes as top-level calls.
- **`prisma.$queryRaw` bypasses extensions entirely.** That is why `claim()` is
  correct *and* why every other query in the worker must go through the extended
  client inside `runWithTenant`.
- **Adapter cache TTL is 5 minutes** (`ADAPTER_TTL_MS`). A long-lived worker
  will hold adapters across config changes; call `getSapAdapterForClient` per
  job rather than caching one in the loop.

### Tests

New `backend/tests/job-runtime.test.js`:

- Enqueue twice with the same `dedupeKey` → one row.
- Two concurrent `claim()` calls → disjoint sets, no row claimed twice.
- Handler returns `{ done: false }` → status back to `pending`, `runAt` advanced,
  `lastError` still null.
- Handler throws → backoff applied, `attempts` incremented, `lastError` set.
- `attempts` reaching `maxAttempts` → `abandoned`, not `failed`.
- Stale `running` job past its lease → `reapStale()` returns it to `pending`.
- A job for tenant A cannot read tenant B's documents — bind A, assert 404 shape
  on B's ASN. Add to `tenant-isolation.test.js` rather than duplicating its
  harness.

Extend `sap-adapter.test.js` to assert `wrapDeferred` still re-binds the tenant
when driven by a handler rather than a timer.

### Definition of done

- `grep -rn "setTimeout\|setInterval" backend/sap/drivers/` returns only the
  `AbortController` timeouts in the HTTP plumbing.
- The `afterEach` 50ms sleep in `tests/setup.js` can be deleted — its comment
  explicitly blames the driver `setTimeout`s this phase removes. **Deleting that
  sleep and having the suite stay green is the proof this phase worked.**
- Restart the worker mid-watch; the watch resumes.
- Health board shows job counts per tenant.

---

# Phase 2 — The SAP field codec

**Goal:** one module that owns SAP's field rules, applied where no driver can
forget it.

**Effort:** 2 days. **Independent** of Phases 3–5. **Depends on:** Phase 0.

### The problem

Today: `LIFNR` is passed through unpadded (`vendor.sapVendorCode` straight into
a query string in four places in `s4odata.driver.js`); there is no `MATNR` length
enforcement; no 40-char text truncation; and — the dangerous one —
`uom: orderItem.uom || 'EA'` in `awaitGoodsReceipt`. That default will one day
turn cartons into pieces in a buyer's ledger, silently.

The B-tier fix is `maxLength` on React inputs. It drifts from the backend within
a month and does nothing for driver-side writes.

### 2.1 — The registry

New file `backend/sap/mappings/fields.js`:

```js
class SapFieldError extends Error {
  constructor(field, value, reason) {
    super(`SAP field ${field} rejected "${value}": ${reason}`);
    this.code = 'sap_field_invalid';
    this.statusCode = 422;
    this.field = field;
  }
}

const SAP_FIELDS = {
  LIFNR: { label: 'Vendor code',    max: 10, encode: v => pad(digits(v), 10) },
  MATNR: { label: 'Material',       max: 18, encode: v => upper(trim(v)) },
  EBELN: { label: 'Purchase order', max: 10, encode: v => pad(digits(v), 10) },
  TXZ01: { label: 'Short text',     max: 40, encode: v => trim(v).slice(0, 40) },
  MEINS: { label: 'Unit',           max: 3,  encode: v => uomToIso(v) },
  WAERS: { label: 'Currency',       max: 5,  encode: v => upper(trim(v)) },
};
```

`uomToIso` reads a `UOM_TO_ISO` map (`each|ea|pc|pcs → PCE`, `box → BOX`,
`litre|liter|l → L`, `kg → KGM`, …) and **throws `SapFieldError` on anything
unmapped**. It does not default. A rejected job with
`lastError: "SAP field MEINS rejected 'Cartons': unmapped unit"` is a
fifteen-minute fix; a wrong quantity in the buyer's ledger is a phone call and a
credit note.

Two directions, both needed:

- `encodeForSap(field, value)` — pad, upper, truncate, map, or throw.
- `decodeFromSap(field, value)` — strip leading zeros for display, map ISO unit
  back to a friendly label. Suppliers should see `10423`, not `0000010423`.

### 2.2 — Apply it in the wrapper, not the drivers

Add a `fields` declaration to entries in `contract.js`'s `SAP_METHODS`:

```js
vendorMiroDisplay: {
  transaction: null, logged: false,
  fields: { 'vendor.sapVendorCode': 'LIFNR' },
},
```

Then in `sap/index.js`, `wrapImmediate` runs the codec over `args` **before the
driver sees them**, exactly where `stamp()` and `recordSapCall` already sit. Now
no driver can forget it, and adding a fourth driver inherits the behaviour for
free. Do the same in `wrapDeferred` for its `args`.

A `SapFieldError` thrown here must **not** trip the circuit breaker — it is our
bug or bad data, not SAP being down. Check `error.code` in the catch block
alongside the existing `sap_circuit_open` / `not_implemented` passthrough.

### 2.3 — Generate validation, don't restate it

`backend/validators/*.js` should derive limits from the registry:

```js
const { SAP_FIELDS } = require('../sap/mappings/fields');
materialCode: z.string().max(SAP_FIELDS.MATNR.max),
```

### 2.4 — Serve limits to the frontend

Add `GET /api/meta/sap-fields` (public or behind `protect` — it is not
sensitive) returning `{ MATNR: { max: 18, label: 'Material' }, … }` plus the
UOM options. The RFQ and ASN forms read it and set their own `maxLength` and
unit dropdown from it.

This is the same pattern `/workspace/settings` already uses — the client renders
from a server registry and knows nothing about which fields exist. Follow that
precedent; there is a working example in `src/app/workspace/settings`.

Add `src/lib/sapFields.test.js` asserting the served map matches the backend
module via `createRequire`, exactly as `platformNav.test.js` and
`workspaceNav.test.js` already guard the permission maps. That test is what
stops the two languages drifting.

### Tests

- Every `SAP_FIELDS` entry round-trips: `decode(encode(x))` is display-stable.
- `LIFNR` `'10423'` → `'0000010423'`; `'0000010423'` → `'0000010423'`.
- Unknown UOM throws `SapFieldError`, not a default.
- A driver method declared with `fields` receives encoded args (assert in
  `sap-adapter.test.js` with a fake driver).
- `SapFieldError` does not increment the circuit breaker's failure count.

---

# Phase 3 — Dual identity and sync state

**Goal:** make "does SAP know about this document?" a queryable fact.

**Effort:** 2–3 days. **Blocks:** Phase 4. **Depends on:** Phase 1.

### Why not the spec's version

The original spec says *"every transaction must store its SAP document number as
its primary key; never generate portal-only sequences."* **Do not implement that
literally.** It makes your PK depend on an external system that may be down, may
reject the document, and — for portal-internal RFQs, which by design never reach
SAP — will never issue a number at all. It also breaks every URL already shipped.

The spec's *intent* is right: never show an invented number as if it were real.
You already honour that for `sapPoNumber` (null until matched, with a good
comment explaining why the old `'4500' + six random digits` was dangerous). This
phase generalises that instinct into a uniform, queryable mechanism.

### 3.1 — Schema

Add to `RFQ`, `PurchaseOrder`, `ASN`, `GRN`, `Invoice`, `Payment`:

```prisma
  sapDocNumber String?
  sapSyncState String    @default("local")
  sapSyncedAt  DateTime?
  sapSyncError String?

  @@index([clientId, sapSyncState])
```

States, in `config/statuses.js` alongside the existing lifecycle registries —
**not** as a Prisma enum, following the schema header's own convention that
registry-sourced values stay `String`:

| State | Meaning | Operator action |
|---|---|---|
| `local` | Portal-internal by design; SAP will never hold it | none — this is correct |
| `pending` | Waiting for SAP to produce or acknowledge | none, unless past SLA |
| `synced` | Correlated to a real SAP document number | none |
| `failed` | SAP rejected it | investigate, fix, retry |
| `orphaned` | Watched past `maxAttempts`; SAP never produced it | investigate |

`local` is the default and is a **success state**, not a deficiency. A
portal-internal RFQ is `local` forever and that is the honest answer.

Migration must backfill: existing rows with a non-null `sapPoNumber` /
`sapMiroDoc` become `synced` with that value copied into `sapDocNumber`;
everything else becomes `local`. Write it as a Prisma migration with SQL, and
cover it in a test the way `migrate-tenancy.test.js` covers its migration.

`sapPoNumber` and `sapMiroDoc` stay where they are — they are the *typed*
correlation keys that `awaitGoodsReceipt` and `awaitPaymentRun` already key on,
and renaming them is churn. `sapDocNumber` is the uniform one the reconciliation
queue reads.

### 3.2 — Wire it to the job runtime

The two are the same mechanism seen from different ends:

- Enqueue an `awaitGoodsReceipt` job → set the ASN to `pending`.
- Handler finds the GRN → `synced`, `sapDocNumber` = MIGO doc, `sapSyncedAt` now.
- Handler throws → `failed`, `sapSyncError` = the message.
- Job hits `abandoned` → document becomes `orphaned`.

Do this in **one place** — a `jobs/syncState.js` helper the handlers call — not
scattered through each handler.

### 3.3 — The reconciliation queue

A new screen in the platform console: everything `pending` past its SLA, plus
everything `failed` or `orphaned`, across tenants, with the last error and a
retry action. This is the spec's "hold for administrative review", and it is the
screen that converts a silent integration failure into a ticket someone closes.

Reuse `src/components/console/primitives.jsx` (`PageHeader`, `Table`,
`useResource`) — it is shared between the platform console and the tenant
workspace and already does this shape. Register the nav entry in
`src/lib/platformNav.js` with a permission from `config/permissions.js`;
`platformNav.test.js` will fail if you invent a permission string.

### 3.4 — Honest UI

Supplier-facing screens show state, not a fake number:

- `pending` → "Awaiting SAP confirmation" with the age.
- `synced` → the real document number.
- `orphaned` / `failed` → "Not yet recorded in SAP — your buyer has been
  notified." Never a number.

This is invariant **I5**, made uniform.

### Tests

- State machine: only legal transitions (`local` never becomes `synced` without
  a document number; `synced` never regresses).
- Backfill migration produces the expected states from a seeded pre-migration
  dataset.
- An abandoned job orphans its document.
- Supplier API responses never carry a `sapDocNumber` for a non-`synced` row.

---

# Phase 4 — Discovery sweeps without ABAP

**Goal:** find documents SAP created on its own, cheaply, with zero SAP-side
change.

**Effort:** 4–5 days. **Depends on:** Phases 1 and 3.

### The reframe that removes the ABAP dependency

The original spec asks for three cron workers doing broad periodic sync, and a
custom `Z_GET_TENANT_DELTAS` RFC to make that affordable. But there are actually
**two different kinds of sync here, and only one of them needs a delta**:

**Targeted watch** — the portal knows exactly which document it is waiting for,
because it started the transaction. A supplier submits an ASN; you know the PO,
the vendor and the lines. This needs no delta at all: it is one precise probe,
already implemented in Phase 1 as a job row.

**Discovery sweep** — finding what SAP created without portal involvement: a new
PO raised in ME21N, an unsolicited GRN, a payment against an older invoice. This
is the only place a delta filter would help.

Once you separate them, the sweep surface is far smaller than "sync everything",
and three portal-side techniques make it cheap enough that ABAP becomes an
optimisation rather than a requirement.

### 4.1 — Watermarks

```prisma
model SapSyncCursor {
  clientId    String
  feed        String    // 'po' | 'grn' | 'payment' | 'quotation'
  vendorCode  String
  watermark   DateTime?
  fingerprint String?    // sha256 of the last normalised response
  lastRunAt   DateTime?
  quietTicks  Int       @default(0)

  @@id([clientId, feed, vendorCode])
  @@index([clientId, feed])
}
```

Not tenant-scoped, same reasoning as `SapJob`.

Pull the full `LIFNR` set (unchanged), then diff against `watermark` and process
only what is newer. Kills write amplification and duplicate socket events
immediately, with no SAP dependency.

### 4.2 — Response fingerprinting — the real win

Before parsing, hash the **normalised** response body (sort keys, drop timestamp
/ correlation-id fields SAP varies per call) and compare to `fingerprint`.
Unchanged means: no parse, no diff, no writes, no events. A no-op sweep costs
exactly one HTTP call and one hash.

Get the normalisation right or this silently does nothing — write the test that
asserts two semantically identical responses with different key order produce
the same fingerprint.

### 4.3 — Adaptive polling — where the scale comes from

Not every vendor deserves the same cadence:

- **Fast lane (30–60s):** vendors with an open targeted watch, or activity in
  the last hour.
- **Normal (5–15 min):** vendors with an open PO or unpaid invoice.
- **Slow (hourly → daily):** everyone else, backing off as `quietTicks` grows,
  capped.

Any change resets `quietTicks` and promotes the vendor. Combined with 4.2, a
tenant with 5,000 vendors polls the ~40 that matter frequently and the rest
rarely — the same profile a real delta API would give you, achieved entirely on
your side of the wire.

Cadence lives on `SapConnection.config` per tenant, surfaced in the platform
console's SAP screen (which already renders driver config from a field
declaration — add the fields to `s4odata.driver.js`'s `configFields` and the form
draws itself).

### 4.4 — The sweep handlers

Register in `jobs/kinds.js` as recurring, materialised from `SapSchedule`:

| Kind | Reads | Default | Produces |
|---|---|---|---|
| `sweepPurchaseOrders` | `vendorPoGrnDisplay` | 5 min | new POs; GRNs on watched ASNs |
| `sweepPayments` | `vendorPaymentDisplay` | 30 min | payments against open invoices |
| `sweepQuotations` | `vendorQuotationDisplay` | daily | SAP purchasing-doc ledger |

**This is where Phase 2 earns its place.** A sweep writes at volume and without a
human watching; unmapped units and over-length material codes must fail loudly
into `lastError`, not get defaulted into the database.

**And Phase 3:** a discovered PO arrives `synced` with a real `sapDocNumber`. A
portal-awarded PO that the sweep correlates moves `pending → synced`. A sweep
that finds nothing for a document past its SLA is what eventually orphans it.

### 4.5 — Idempotency

Sweeps re-see the same rows constantly. Every write must be an upsert on a
natural key — `(clientId, sapDocNumber)` for discovered documents. Emit socket
events only on actual state change, never on "seen again", or you will spam
every connected supplier every five minutes.

### Tests

- Fingerprint stability across key reordering and volatile-field changes.
- Watermark advance: second sweep over identical data writes nothing, emits
  nothing.
- Adaptive promotion/demotion arithmetic.
- Two tenants sweeping simultaneously see only their own vendors — extend
  `lifecycle-e2e.test.js`, which already runs two tenants through a full cycle.
- A discovered PO for an unknown vendor is ignored, not auto-created.

### What you give up without ABAP

Bandwidth on the SAP side: you fetch full vendor sets rather than deltas. With
4.2 and 4.3 that is bounded by *active* vendor count, not total. **No portal
capability is missing.** See Deferred B.

---

# Phase 5 — Sourcing boundary and export bridge

**Goal:** make the portal-internal sourcing boundary explicit, supported and
sellable — instead of building the fragile thing the spec asks for.

**Effort:** 2–3 days. **Independent.** **Depends on:** Phase 0.

### Why this is a "don't build it" phase

The spec wants `Z_PORTAL_MAINTAIN_RFQ` doing `CALL TRANSACTION 'ME47' USING
bdcdata_tab`. That is a screen-scrape. It breaks on any SAP patch, screen
variant, or user-parameter difference between tenants. It would be your most
fragile component and your most frequent support ticket — and it needs ABAP you
do not have.

`contract.js` already reached the right conclusion and documented it at length:
core S/4 exposes no public API for issuing an RFQ to, or capturing a bid from, an
external portal vendor. That is Ariba/Business Network territory. The five
sourcing writes that called a never-built Z-service threw 502 on every real
tenant.

The work here is making that boundary a *product decision* rather than a code
comment.

### 5.1 — Lean on the one real write

`quotationUpdatePrice` (ME47 net price, `ZQUOT_NETPR`) is **confirmed against
the live sandbox**. For buyers who raise RFQs in SAP, the portal can price their
existing quotation documents. Surface it as a first-class feature: a supplier
opens a SAP-originated quotation from `vendorQuotationDisplay`, prices the
lines, and the price lands in SAP. That is a real integration, not a simulation,
and it covers a genuine slice of the spec's steps 5–6.

Note the caveat already documented in `contract.js`: `ZCL_ME48/vendor` returns
the vendor's whole EKKO set, POs included, with no document-category filter.
Filter to the 6xxxxxxx range in the UI and label the screen as a purchasing
document ledger, not "quotations".

### 5.2 — The export bridge (zero SAP-side work)

Awarding a portal RFQ produces a downloadable artefact the buyer's team imports
on their own schedule:

- **CSV / XLSX** — the pragmatic default; every MM team can work with it. Use the
  `xlsx` skill's conventions if you want a formatted workbook.
- **Structured JSON** — for buyers with their own middleware.
- **A flat-file IDoc payload** (`ORDERS05` / `PORDCR` shaped) — optional, and the
  key point is that it is *a file*, not a connection. The buyer's team can feed
  it through WE19/WE16 if they choose. **No WE20 partner profile, no ABAP, no
  network path required from you.**

Unglamorous, and exactly what most mid-market SAP integrations actually do. It
never breaks on a patch.

### 5.3 — Say it in the product

- Label portal-internal documents in the UI: "This RFQ is managed in
  VendorConnect" with a tooltip explaining the boundary.
- Update `PROJECT_CONTEXT.md` and the process-flow diagram so steps 1–2 and 6
  read *"portal-internal, optionally reconciled against SAP"* rather than
  implying BDC round-trips.
- Add it to the sales collateral as a **positioning statement**, not an apology:
  sourcing that does not depend on the buyer's SAP configuration is faster to
  onboard and cannot break on an SAP upgrade.

If a design partner insists on true bidirectional sourcing, the honest answer is
Ariba/Business Network, priced as a separate integration. That is better business
than owning a BDC script.

---

# Deferred A — On-premise connector agent

**Trigger:** an ECC customer, or an S/4 customer whose gateway is not
internet-reachable, signs. **Not before.**

**Requires ABAP:** no. Requires SAP **Basis** configuration (service user + role),
which is the customer's standard onboarding work, not development.

### Why not `node-rfc` in the API

The spec says C++ NW RFC SDK bindings. Do not put those in this process:

- A native build in your container image.
- A licensed SDK you cannot redistribute.
- A segfault surface inside the API that serves suppliers.
- **The killer:** you would still need the customer to open RFC inbound through
  their firewall to your cloud. Most will refuse, and they are right to.

### The shape

A small Node service the customer runs **inside their network**, next to SAP:

- Holds `node-rfc` and the SDK — their host, their licence, their crash domain.
- **Dials out** over HTTPS/WSS to your platform. No inbound firewall rule.
- Authenticates with a per-tenant credential issued from the platform console
  and stored with the same envelope encryption as SAP credentials
  (`utils/secretBox.js`, `v2:` under a per-connection data key).
- Speaks **your existing contract** as its wire protocol.

`eccrfc.driver.js` then becomes ~200 lines shaped exactly like
`s4odata.driver.js` — an HTTP client, not an RFC client. Its current comment
predicted this:

> *"The likely shape is an on-prem agent speaking to us over HTTPS rather than a
> library in this process — which is exactly why the contract exists: that
> choice can be made in Phase 8 without any controller noticing."*

**Same artefact solves the S/4 on-premise case.** One build, two markets.

SAP-side asks are Basis, not development: a `System`-type service account
(SU01), and a PFCG role with `S_RFC` for the BAPIs you call plus `S_TABU_DIS`
read on `EKKO`/`EKPO`/`RBKP`/`RSEG`. Ship that as a documented role template —
it is the single biggest accelerator of a customer's security review.

---

# Deferred B — The ABAP asks

Everything here is an **optimisation**. Phases 0–5 ship a complete, correct
portal without any of it. Raise these opportunistically when you have ABAP
goodwill, never as a dependency.

### B1 — `CHANGED_SINCE` on the existing Z services

**Ask for:** an optional `CHANGED_SINCE` parameter on `zpo_grn_vendor`,
`zmiro_display/MIRO` and `ZCL_ME48/vendor`, filtering on `AEDAT`.

**Not** a new `Z_GET_TENANT_DELTAS`. Frame it as *"add an optional filter to
three endpoints you already have"* — backwards compatible, one signature change
each. You will get it in a sprint. A new tenant-wide RFC is a quarter, and it
cuts across the `LIFNR`-keyed shape everything else already uses.

**What it buys:** SAP-side bandwidth on the discovery sweep.
**What you lose without it:** nothing functional. Phase 4.2 + 4.3 already make a
quiet sweep cost one HTTP call.

**Design so it is a config flag, not a rewrite:** the sweep passes
`changedSince` when `config.supportsChangedSince` is true, and ignores the
response's completeness either way. Same code path, both worlds.

### B2 — Verify the two unverified write paths

`s4odata.driver.js` flags two endpoints as guesses in its own `configFields`
labels:

- `vendorCrPath` → `/zvendor_create/VENDOR_CR` (the payload body **is**
  confirmed via `vendor-create.map.js`; the path is not)
- `invoicePlanUpdatePath` → `/zpo_invplan/PLAN_UPD` (`poInvoicePlanUpdate` has
  never run against a live system)

**These need sandbox access, not necessarily ABAP** — the endpoints may already
exist under different paths. Run `npm run sap:conformance -- --client <id>`
against the sandbox and let it tell you which methods answer. That tool exists
precisely for this and is the cheapest possible way to find out.

Until verified, `sapSyncState` from Phase 3 keeps you honest: a vendor-create
that fails lands in `failed` with the error visible, not silently pretending.

### B3 — Things to refuse

Requests that will arrive and should be declined, with the reason:

- **`Z_PORTAL_MAINTAIN_RFQ` / BDC ME47** — screen-scrape, breaks on patches.
  Phase 5's export bridge covers the need.
- **Inbound `INVOIC02` via WE20/MRM1 posting the supplier's invoice** — MIRO is
  AP's transaction against the buyer's own books. Posting it on the supplier's
  behalf puts the supplier inside the buyer's ledger and skips the AP review the
  `finance` role exists for. This is already documented in `contract.js` and the
  reasoning is sound.
- **Portal-side PO creation in SAP** — you removed `POST /pos/simulate` for good
  reason. Do not reintroduce it.

---

# Appendix A — Verification commands

```bash
# Backend suite (serial; parallel is unreliable — see PROJECT_CONTEXT §10)
cd backend && npx jest --runInBand

# Frontend
npm test

# Schema changes
cd backend && npx prisma migrate dev --name <name> && npx prisma generate

# SAP conformance against a configured tenant
cd backend && npm run sap:conformance -- --client CLT-0001

# Against a sandbox with no tenant yet
cd backend && npm run sap:conformance -- --driver s4_odata --config f.json --secrets f.json

# Backup drill (read-only against source; read the runbook first)
cd backend && npm run backup:drill
```

# Appendix B — Conventions this codebase enforces

Violating these fails CI or review, not just taste:

1. **Two packages, two suites.** Backend work → `cd backend`. Frontend at root.
2. **SAP goes through the adapter, always.** Adding a call means: a transaction
   in `config/sapTransactions.js`, a method in `sap/contract.js`, an
   implementation in every driver. Skeletons inherit `not_implemented`
   automatically via `notImplementedDriver()`.
3. **Registries are singular.** `config/roles.js`, `config/permissions.js`,
   `config/statuses.js`, `config/tenantSettings.js`, `config/auditActions.js`,
   `config/sapTransactions.js`, `config/tenantModels.js`,
   `sap/drivers/index.js`. Never inline a list one of these owns.
4. **Every route declares one permission.** `route-role-matrix.test.js` walks the
   real router and fails on any route that declares none.
5. **New tenant-scoped model?** Register it in `db/tenantExtension.js`'s
   `TENANT_SCOPED_MODELS` **and** add a case to `tenant-isolation.test.js` in the
   same commit. Infrastructure tables (`SapJob`, `SapSchedule`, `SapSyncCursor`)
   deliberately stay out — document why, inline.
6. **Design system is strict.** Zero border-radius, no drop shadows, JetBrains
   Mono for all tabular data, IDs, amounts and compliance codes. See `DESIGN.md`.
7. **`apiClient` returns `null` on network failure** — it does not throw.
   Callers must handle null.
8. **Errors surface, never swallowed.** Hooks return `{ success, error }`;
   surface via `addToast`.
9. **Decimal columns are `Decimal`.** Read them through `utils/money.js`
   `toNumber()`, never implicit coercion — see the comment in `db/poHelpers.js`.
10. **Postgres returns rows in heap order without `ORDER BY`.** An `UPDATE`
    rewrites a row to the end of the heap. Every query whose result is indexed
    into needs an explicit `orderBy` — this already caused a real bug with
    invoicing-plan lines.

# Appendix C — Files this plan touches

| Phase | Primary files |
|---|---|
| 0 | `backend/models/` (delete), `backend/package.json`, `PROJECT_CONTEXT.md` |
| 1 | `prisma/schema.prisma`, `backend/jobs/*` (new), `sap/index.js`, `sap/drivers/*.driver.js`, `sap/contract.js`, `deploy/ecosystem.config.js`, `tests/setup.js` |
| 2 | `sap/mappings/fields.js` (new), `sap/contract.js`, `sap/index.js`, `backend/validators/*`, `src/lib/sapFields.js` (new) |
| 3 | `prisma/schema.prisma`, `config/statuses.js`, `jobs/syncState.js` (new), `src/app/platform/*`, `src/lib/platformNav.js` |
| 4 | `prisma/schema.prisma`, `backend/jobs/handlers/sweep*.js` (new), `sap/drivers/s4odata.driver.js` (`configFields`) |
| 5 | `src/features/rfq/*`, `backend/controllers/rfq.controller.js`, `backend/services/export.service.js` (new), `PROJECT_CONTEXT.md` |

---

*Plan version 1.0 · 8 September 2026. When this document and the code disagree,
the code wins — then update this document.*
