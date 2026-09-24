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
const resetDatabase = async () => {
  const tables = await loadTableNames();
  if (!tables.length) return;

  const statements = tables.map((name) =>
    rawPrisma.$executeRawUnsafe(`DELETE FROM "${name}"`));

  try {
    await rawPrisma.$transaction([
      rawPrisma.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'"),
      ...statements,
    ]);
  } catch (err) {
    // Suspending FK triggers needs elevated rights. Both the docker-compose
    // instance and the CI service container run as the database owner, so this
    // is a safety net for an unprivileged role rather than an expected path:
    // fall back to the old behaviour, which is slow but needs no privilege.
    const names = tables.map((name) => `"${name}"`).join(', ');
    await rawPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} CASCADE`);
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
  await resetDatabase();
});

afterAll(async () => {
  await rawPrisma.$disconnect();
});
