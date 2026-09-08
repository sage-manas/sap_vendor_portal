/**
 * Backup/restore drill.
 *
 *   node scripts/backup-restore-drill.js
 *
 * Proves a backup is actually restorable, not just written. Dumps every table
 * in the connected database to JSON on disk, restores each one into a scratch
 * schema on the same database, and asserts the restored count matches the
 * source — then drops the scratch schema. This goes through the Prisma
 * driver directly (raw SQL, no `pg_dump`/`pg_restore`), which is what makes it
 * something CI or a cron can run on a schedule without extra tooling.
 *
 * A schema, not a separate database, is the scratch area: `CREATE DATABASE`
 * cannot run inside the connection pool's transactions and would need a
 * second connection string, while a schema round-trips through the exact
 * same connection this script already has.
 *
 * Exit code 0 means every table round-tripped; 1 means at least one didn't,
 * and the report printed says which.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Prisma } = require('@prisma/client');
const { rawPrisma } = require('../db/prisma');

const DUMP_DIR = process.env.BACKUP_DRILL_DIR
  || path.join(__dirname, '..', 'backups', `drill-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SCRATCH_SCHEMA = 'backup_drill';

// Prisma's raw-query layer hands back Decimal and Buffer instances that
// JSON.stringify cannot round-trip on its own — tag them so the restore step
// can tell a wrapped value from a plain jsonb column apart from a real object.
const toJsonSafe = (value) => {
  if (value instanceof Prisma.Decimal) return { $decimal: value.toString() };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  return value;
};

const fromJsonSafe = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.$decimal === 'string') return new Prisma.Decimal(value.$decimal);
    if (typeof value.$bytes === 'string') return Buffer.from(value.$bytes, 'base64');
  }
  return value;
};

const mapRow = (row, fn) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fn(v)]));

async function listTables() {
  const rows = await rawPrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  return rows.map((r) => r.tablename);
}

async function main() {
  const tables = await listTables();
  if (!tables.length) {
    console.warn('No tables found — nothing was drilled. Check DATABASE_URL.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(DUMP_DIR, { recursive: true });

  await rawPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
  await rawPrisma.$executeRawUnsafe(`CREATE SCHEMA "${SCRATCH_SCHEMA}"`);

  const report = [];

  try {
    for (const table of tables) {
      const rows = await rawPrisma.$queryRawUnsafe(`SELECT * FROM "public"."${table}"`);
      const dumped = rows.map((row) => mapRow(row, toJsonSafe));
      fs.writeFileSync(path.join(DUMP_DIR, `${table}.json`), JSON.stringify(dumped));

      // LIKE ... INCLUDING ALL copies columns, defaults, indexes and CHECK
      // constraints but never foreign keys — exactly what a scratch table
      // needs, since it has no siblings in "backup_drill" to reference.
      await rawPrisma.$executeRawUnsafe(
        `CREATE TABLE "${SCRATCH_SCHEMA}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`,
      );

      for (const row of dumped) {
        const restored = mapRow(row, fromJsonSafe);
        const columns = Object.keys(restored);
        if (!columns.length) continue;
        const columnList = columns.map((c) => `"${c}"`).join(', ');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        await rawPrisma.$executeRawUnsafe(
          `INSERT INTO "${SCRATCH_SCHEMA}"."${table}" (${columnList}) VALUES (${placeholders})`,
          ...columns.map((c) => restored[c]),
        );
      }

      const [{ count }] = await rawPrisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "${SCRATCH_SCHEMA}"."${table}"`,
      );
      report.push({ table, source: dumped.length, restored: count, ok: count === dumped.length });
    }
  } finally {
    // The scratch schema is proof, not a copy anyone should rely on — the
    // dump on disk in DUMP_DIR is the artifact this drill leaves behind.
    await rawPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
  }

  const failed = report.filter((r) => !r.ok);
  console.table(report);

  if (failed.length) {
    console.error(`Backup/restore drill FAILED for: ${failed.map((f) => f.table).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Backup/restore drill passed for ${report.length} tables. Dump kept at ${DUMP_DIR}`);
  }

  await rawPrisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Backup/restore drill errored:', err);
  process.exitCode = 1;
  await rawPrisma.$disconnect();
});
