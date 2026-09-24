const { PrismaClient } = require('@prisma/client');
const { rawPrisma } = require('../db/prisma');
const { seedClient } = require('./helpers');
const { resetDatabase, watchForBlocker } = require('./setup');
const logger = require('../utils/logger');

// Issue #120. `tests/job-runtime.test.js` timed out once in a full run,
// 77s into a test whose own suite completes in 1.7s in isolation — evidence
// of a blocked write, not a slow one, but the failure itself was a bare Jest
// "Exceeded timeout of 30000 ms" that named nothing. These tests verify the
// two pieces of infrastructure this issue asked for actually work end to end
// against a real Postgres lock, not just that the URL-building helper looks
// right in isolation (tests/test-database-guard.test.js covers that half).

describe('a genuinely blocked write, end to end', () => {
  it('fails with a named Postgres error, not a bare Jest timeout', async () => {
    // config/testDatabase.js's withStatementTimeout is what process.env.
    // DATABASE_URL already carries by the time any test runs (tests/env.js
    // resolved it before db/prisma.js was ever required) — this exercises
    // the live connection, not just the string.
    // Prisma wraps the raw Postgres error rather than exposing its code
    // directly on `.code` (that comes back as Prisma's own generic
    // 'P2010') — the real signal is the Postgres error text it carries.
    await expect(rawPrisma.$queryRaw`SELECT pg_sleep(20), 1 AS x`).rejects.toThrow(
      /57014|canceling statement due to statement timeout/,
    );
  });

  it('resetDatabase() surfaces the blocker instead of hanging past the statement timeout', async () => {
    await seedClient();
    const errorSpy = jest.spyOn(logger, 'error');
    const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

    let releaseHold;
    const held = new Promise((resolve) => { releaseHold = resolve; });

    // A second, independent connection holding an uncommitted write on a
    // table resetDatabase() deletes from — the same shape of problem
    // tests/setup.js's own comment attributes to "a deferred SAP timer still
    // in flight" (issue #120's leading hypothesis): whatever it is, from
    // resetDatabase()'s side it looks like exactly this.
    const blockingTx = holder.$transaction(async (tx) => {
      await tx.client.updateMany({ data: { companyName: 'Locked mid-transaction' } });
      await held;
      // Prisma's own interactive-transaction default (5s) would otherwise
      // abort this hold well before resetDatabase()'s 15s statement_timeout
      // gets a chance to fire on it.
    }, { timeout: 20000 });

    try {
      // Give the holder a moment to actually acquire the row lock before
      // resetDatabase() races it.
      await new Promise((r) => setTimeout(r, 200));

      const started = Date.now();
      await expect(resetDatabase()).rejects.toThrow(/57014|canceling statement due to statement timeout/);
      const elapsed = Date.now() - started;

      // Bounded by the statement timeout (15s), not Jest's own 30s ceiling —
      // the whole point of #120's fix.
      expect(elapsed).toBeLessThan(20000);

      // The watcher's whole reason to exist: it names the blocker, polling
      // WHILE the write waits rather than after (checking from the `catch`
      // block was verified directly to always find nothing — the canceled
      // backend's pg_locks entry is already gone by then).
      const blockerLog = errorSpy.mock.calls.find(([msg]) => /blocked on/.test(msg));
      expect(blockerLog).toBeDefined();
      expect(blockerLog[0]).toMatch(/blocking_query/);
    } finally {
      errorSpy.mockRestore();
      releaseHold();
      await blockingTx;
      await holder.$disconnect();
    }
  });

  it('the watcher does not itself throw when there is nothing blocked to report', async () => {
    // Best-effort diagnostics must never be the thing that turns a passing
    // test red — this covers the "nothing found" path directly. stop()
    // before the poll's first 500ms tick still lets that one tick run (it
    // only checks `stopped` after waking), so this settles in ~500ms.
    const watcher = watchForBlocker('test: nothing blocked');
    watcher.stop();
    await expect(watcher.poll).resolves.toBeUndefined();
  });
});
