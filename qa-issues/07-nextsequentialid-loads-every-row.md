<!-- title: PERF: nextSequentialId loads every matching row into memory on each id mint, inside a transaction -->
<!-- labels: performance,severity:medium,area:data,backend -->

## Severity

**Medium** — degrades with tenant age; worsened by the new discovery sweeps.

## Summary

`nextSequentialId` selects **every** row whose business id starts with the
prefix, pulls them into Node, and scans in JavaScript — on every RFQ and
purchase-order creation.

## Evidence

`backend/utils/nextSequentialId.js`

```js
const nextSequentialId = async (model, prefix, padLength, client = prisma) => {
  const rows = await client[model].findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  let seq = 1;
  for (const row of rows) {
    const match = row.id.match(/-(\d+)$/);
    if (match) seq = Math.max(seq, parseInt(match[1], 10) + 1);
  }
  return `${prefix}${String(seq).padStart(padLength, '0')}`;
};
```

## Problems

1. **O(n) rows per mint.** A tenant with 20,000 POs in a year loads 20,000
   rows to allocate one id. Cost grows monotonically through the year and
   resets only in January.

2. **Inside a transaction.** `awardBid` passes its `tx`
   (`rfq.controller.js:580`), so the scan runs inside
   `prisma.$transaction`, extending the lock window on the award path.

3. **Documented race, now more likely.** The module's own comment calls the
   read-then-write race "deliberately kept". That was defensible when only a
   user action minted ids. `jobs/handlers/sweepPurchaseOrders.js:107` now
   calls it **without a transaction**, in a background sweep that can
   discover many POs in a burst — so a sweep and a concurrent award can
   compute the same next number.

Note the recent numeric-suffix fix (replacing `orderBy: { id: 'desc' }`) is
**correct** and should be preserved by whatever replaces this — the string
sort broke once a suffix outgrew its padding, and there is a regression test
(`sequential-id-overflow.test.js`) worth keeping green.

## Steps to reproduce

1. Seed 20,000 `PurchaseOrder` rows for one tenant with ids `PO-2026-00001` …
2. Time `POST /api/rfqs/:id/award`.
3. Compare against a tenant with 10 POs.

- Expected: constant time.
- Actual: latency scales linearly with existing PO count; memory spikes per call.

Concurrency variant: run a `sweepPurchaseOrders` job that discovers new POs
while awarding an RFQ in a different session. Both may compute the same id;
the loser fails with a unique-constraint 409 rather than a meaningful error.

## Suggested fix

**Preferred — a real Postgres sequence per (tenant, prefix).**

Add a counter table and allocate atomically:

```sql
CREATE TABLE document_counters (
  "clientId" text NOT NULL,
  prefix     text NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY ("clientId", prefix)
);
```

```js
const [row] = await client.$queryRaw`
  INSERT INTO document_counters ("clientId", prefix, next_value)
  VALUES (${clientId}, ${prefix}, 2)
  ON CONFLICT ("clientId", prefix)
  DO UPDATE SET next_value = document_counters.next_value + 1
  RETURNING next_value - 1 AS seq`;
```

One row touched, atomic, no scan, no race. Gaps on rollback are acceptable —
an unused document number is not a problem, and SAP's own number ranges
behave the same way.

**Interim, if the rewrite is deferred:** replace the scan with a single
aggregate so at least the row set stays in Postgres, and always pass a `tx`.

Requires a one-time backfill seeding `next_value` from existing max suffixes.

## Acceptance criteria

- [ ] Id allocation is O(1) regardless of existing row count.
- [ ] `sequential-id-overflow.test.js` still passes (>999 / >9999 suffixes).
- [ ] `id-collision-retry.test.js` still passes.
- [ ] New test: concurrent award + discovery sweep produce distinct ids.
- [ ] Backfill migration covered by a test, like `migrate-tenancy.test.js`.
