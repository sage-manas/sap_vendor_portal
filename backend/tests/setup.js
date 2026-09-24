const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Independent of tests/env.js (Jest's setupFiles, which runs before this
// setupFilesAfterEnv file and normally redirects DATABASE_URL first) — this
// is a second, self-contained check rather than trust that env.js already
// ran. It has to be: on 2026-09-23, a suite ran against this repo's actual
// development database and wiped every table, including the Kaveri Forge
// vendor and its live SAP connection config — recovered afterwards only by
// hand, through raw pg_surgery on the dead tuples DELETE leaves behind. The
// working theory is a stale checkout predating env.js's own PR — but "the
// upstream setup file loaded correctly" is exactly the kind of assumption a
// stale checkout, a wrong working directory, or a hand-edited jest config
// can quietly break, and resetDatabase() below is the actual destructive
// operation — it should not have to trust that something else already made
// it safe. dotenv.config() above does not override an already-set
// DATABASE_URL, so on a correct run this just reconfirms what env.js set;
// on a broken one, it is the one thing standing between a test run and the
// same wipe happening again.
require('../config/testDatabase').assertSafeToWipe(process.env.DATABASE_URL, 'The Jest suite');

const { rawPrisma } = require('../db/prisma');
const logger = require('../utils/logger');

// Postgres replaces mongodb-memory-server: a real instance (this repo's
// docker-compose `postgres` service) rather than an ephemeral in-memory one,
// per the migration plan's Phase 5 decision (a fresh, real database per run
// is the closer analogue to how mongodb-memory-server was used than a
// transaction-rollback-per-test trick would be). `npx prisma migrate deploy`
// must have been run against DATABASE_URL before the suite starts.

// The table list is fixed for the life of a run — migrations have already been
// applied — so it is read once rather than per test. `_prisma_migrations` is
// excluded: it is the schema's own bookkeeping, not test data, and wiping it
// would strand the database mid-history for anything that reads it later.
let tableNames = null;

const loadTableNames = async () => {
  if (tableNames) return tableNames;
  const rows = await rawPrisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  tableNames = rows.map((t) => t.tablename);
  return tableNames;
};

// This used to be `TRUNCATE ... CASCADE` over every table. That was correct but
// pathologically slow and deadlock-prone, which mattered because it ran after
// every single test:
//
//   * TRUNCATE takes an ACCESS EXCLUSIVE lock on all ~29 tables and fsyncs each
//     relation it rewrites. Measured on the docker-compose instance: ~1.6s per
//     call, i.e. ~1.6s of pure overhead per test, putting the full suite at
//     roughly five hours.
//   * That lock also conflicts with everything, including the deferred SAP
//     timers described below. When one of those was still in flight the two
//     sides took their locks in opposite orders and Postgres killed the loser
//     with a 40P01 deadlock — surfacing as *false failures in unrelated tests*,
//     tenant-isolation cases among them, because a lost reset leaves the next
//     test reading the previous one's rows.
//
// DELETE takes only ROW EXCLUSIVE, needs no relation rewrite, and on tables
// holding a handful of test rows is ~75ms for the whole set — a 21x improvement
// that also removes the lock conflict outright. `session_replication_role =
// 'replica'` suspends FK triggers for the transaction so the deletes need no
// dependency ordering, exactly as CASCADE spared us that before. It is set
// LOCAL, so it lasts only until this transaction ends.
// Issue #120: names the blocker, not just the fact of blocking. This has to
// poll WHILE the write is waiting, not after — once Postgres cancels a
// statement on statement_timeout, the canceled backend's entry in pg_locks
// disappears with it, so checking from the `catch` block below is always too
// late (verified directly: it never once found a pair). Runs concurrently
// with resetDatabase()'s transaction and logs the first blocked/blocking pair
// it sees whose blocked query is one of ours — identified by query text
// rather than backend pid, so this needs no change to the transaction shape
// below (a connection-pooled client doesn't hand back which physical
// connection a batched $transaction([...]) call lands on until it's done).
const watchForBlocker = (context) => {
  let stopped = false;
  // A plain flag alone would leave every resetDatabase() call waiting out a
  // pending 500ms sleep in its `finally` before it could resolve — negligible
  // once, but it measurably tripled the full suite's time (measured: ~210s
  // to ~640s) run across ~830 tests. stop() has to wake the sleep, not just
  // flag it for next time.
  let wake = () => {};
  const stop = () => { stopped = true; wake(); };
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const poll = (async () => {
    while (!stopped) {
      await sleep(500);
      if (stopped) return;
      try {
        const rows = await rawPrisma.$queryRaw`
          SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query,
                 blocking.pid AS blocking_pid, blocking.query AS blocking_query,
                 blocking.state AS blocking_state,
                 (now() - blocking.query_start)::text AS blocking_for
          FROM pg_stat_activity blocked
          JOIN pg_locks blocked_locks ON blocked_locks.pid = blocked.pid AND NOT blocked_locks.granted
          JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
            AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
            AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
            AND blocking_locks.pid != blocked_locks.pid
          JOIN pg_stat_activity blocking ON blocking.pid = blocking_locks.pid
          WHERE blocked.datname = current_database() AND blocked.query LIKE 'DELETE FROM %'
        `;
        if (rows.length) {
          logger.error(`[tests/setup] ${context}: blocked on ${JSON.stringify(rows)}`);
          return;
        }
      } catch (diagErr) {
        logger.error(`[tests/setup] ${context}: could not read pg_locks for diagnostics: ${diagErr.message}`);
        return;
      }
    }
  })();
  return { stop, poll };
};

const resetDatabase = async () => {
  const tables = await loadTableNames();
  if (!tables.length) return;

  const statements = tables.map((name) =>
    rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}"`));

  const watcher = watchForBlocker('resetDatabase() DELETE transaction');

  try {
    await rawPrisma.$transaction([
      rawPrisma.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'"),
      ...statements,
    ]);
  } catch (err) {
    // 57014 is Postgres's "canceling statement due to statement timeout" —
    // config/testDatabase.js's withStatementTimeout gives every test
    // connection a 15s cap specifically so a genuine block surfaces here,
    // rather than as Jest's own bare 30s timeout further up the stack. Prisma
    // wraps the raw query error rather than exposing the Postgres code
    // directly on `.code` (that comes back as its own generic 'P2010'), so
    // the real signal is in the message text. A blocked DELETE would block
    // TRUNCATE the same way, so this does not fall through to the
    // privilege-fallback below — it rethrows once the watcher above has had
    // its say, since retrying blind teaches nothing new.
    if (/57014|statement timeout/.test(err.message || '')) {
      throw err;
    }
    // Suspending FK triggers needs elevated rights. Both the docker-compose
    // instance and the CI service container run as the database owner, so this
    // is a safety net for an unprivileged role rather than an expected path:
    // fall back to the old behaviour, which is slow but needs no privilege.
    const names = tables.map((name) => `"${name}"`).join(', ');
    await rawPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} CASCADE`);
  } finally {
    watcher.stop();
    await watcher.poll;
  }
};

beforeAll(async () => {
  await resetDatabase();
});

// Every request path now resolves a tenant, so a deployment — and therefore a
// test database — always has at least one. This is the same CLT-0001 "Legacy"
// client the migration script creates.
beforeEach(async () => {
  const { seedClient } = require('./helpers');
  await seedClient();
});

afterEach(async () => {
  // Issue #120's suggested fix: a test that starts jobs/worker.js's tick loop
  // (run()) and forgets stop() would keep polling and calling
  // materialiseSchedules() through every later test in the process, blind to
  // resetDatabase() truncating out from under it. No test does this today —
  // this is a tripwire against one starting to, not a fix for an observed
  // leak here.
  const worker = require('../jobs/worker');
  const leaked = worker.isRunning();
  if (leaked) worker.stop();

  // Runs regardless of the leak check above — failing this test must not
  // also leave the database dirty for whatever runs next.
  await resetDatabase();

  if (leaked) {
    throw new Error(
      `${expect.getState().currentTestName} left jobs/worker.js's tick loop running — call worker.stop() before the test ends.`,
    );
  }
});

afterAll(async () => {
  await rawPrisma.$disconnect();
});

// Exported for tests/statement-timeout.test.js (issue #120), which exercises
// the lock-timeout diagnostic path directly rather than trying to provoke it
// through the normal per-test lifecycle. This file still runs as
// setupFilesAfterEnv exactly as before — module.exports on a Jest setup file
// doesn't change how Jest loads it, only whether something else can require()
// it for its own use.
module.exports = { resetDatabase, watchForBlocker };
