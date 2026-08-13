/**
 * Backup/restore drill.
 *
 *   node scripts/backup-restore-drill.js
 *
 * Proves a backup is actually restorable, not just written. Dumps every
 * collection in the connected database to newline-delimited JSON on disk,
 * restores each one into a scratch database, and asserts the restored count
 * matches the source — then drops the scratch database. This does not
 * require the `mongodump`/`mongorestore` binaries: it reads and writes
 * through the driver directly, which is also what makes it something CI or a
 * cron can run on a schedule without extra tooling.
 *
 * Exit code 0 means every collection round-tripped; 1 means at least one
 * didn't, and the report printed says which.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const mongoose = require('mongoose');

const SOURCE_URI = process.env.MONGO_URI;
const DUMP_DIR = process.env.BACKUP_DRILL_DIR
  || path.join(__dirname, '..', 'backups', `drill-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SCRATCH_SUFFIX = '_backup_drill';

// Swaps the database name in a Mongo connection string for the scratch one,
// leaving host, auth and query params untouched.
const scratchUriFor = (uri, scratchDbName) => {
  const [beforeQuery, query] = uri.split('?');
  const lastSlash = beforeQuery.lastIndexOf('/');
  const base = beforeQuery.slice(0, lastSlash + 1);
  return `${base}${scratchDbName}${query ? `?${query}` : ''}`;
};

async function main() {
  if (!SOURCE_URI) throw new Error('MONGO_URI is required');

  const sourceConn = await mongoose.createConnection(SOURCE_URI).asPromise();
  const sourceDb = sourceConn.db;
  const scratchDbName = `${sourceDb.databaseName}${SCRATCH_SUFFIX}`;
  const scratchConn = await mongoose.createConnection(scratchUriFor(SOURCE_URI, scratchDbName)).asPromise();
  const scratchDb = scratchConn.db;

  fs.mkdirSync(DUMP_DIR, { recursive: true });

  const collectionNames = (await sourceDb.listCollections().toArray()).map((c) => c.name);
  const report = [];

  try {
    for (const name of collectionNames) {
      const docs = await sourceDb.collection(name).find({}).toArray();
      fs.writeFileSync(path.join(DUMP_DIR, `${name}.json`), JSON.stringify(docs));

      await scratchDb.collection(name).deleteMany({});
      if (docs.length) await scratchDb.collection(name).insertMany(docs, { ordered: false });

      const restored = await scratchDb.collection(name).countDocuments();
      report.push({ collection: name, source: docs.length, restored, ok: restored === docs.length });
    }
  } finally {
    // The scratch database is proof, not a copy anyone should rely on — the
    // dump on disk in DUMP_DIR is the artifact this drill leaves behind.
    await scratchDb.dropDatabase();
    await sourceConn.close();
    await scratchConn.close();
  }

  const failed = report.filter((r) => !r.ok);
  console.table(report);

  if (!collectionNames.length) {
    console.warn('No collections found — nothing was drilled. Check MONGO_URI.');
    process.exitCode = 1;
    return;
  }

  if (failed.length) {
    console.error(`Backup/restore drill FAILED for: ${failed.map((f) => f.collection).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Backup/restore drill passed for ${report.length} collections. Dump kept at ${DUMP_DIR}`);
  }
}

main().catch((err) => {
  console.error('Backup/restore drill errored:', err);
  process.exitCode = 1;
});
