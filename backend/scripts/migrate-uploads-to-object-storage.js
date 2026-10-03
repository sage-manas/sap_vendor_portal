#!/usr/bin/env node
/**
 * Moves uploads that still live on this server's disk into object storage.
 *
 *   node scripts/migrate-uploads-to-object-storage.js --dry-run
 *   node scripts/migrate-uploads-to-object-storage.js
 *   node scripts/migrate-uploads-to-object-storage.js --delete-local
 *
 * Needs STORAGE_DRIVER=s3 and the S3_* settings (docs/runbooks/object-storage.md).
 * Run against the production database deliberately, on the server that holds the
 * files, after the bucket is created and a test upload has worked.
 *
 * Safe to run again and to stop part-way:
 *   * each Document is handled on its own and repointed only after the object is
 *     in the bucket and its size read back matches the file;
 *   * rows already on object storage are skipped;
 *   * a row whose file is missing from disk is reported, never guessed at, and
 *     left as it was;
 *   * the local file is kept unless --delete-local is given, so the first run can
 *     be verified (download a few documents) before anything is removed.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const logger = require('../utils/logger');
const { storageFor } = require('../storage');
const { driverName } = require('../storage/config');

const BATCH = 200;

const migrateUploads = async ({ dryRun = false, deleteLocal = false } = {}) => {
  if (driverName() !== 's3') throw new Error('STORAGE_DRIVER must be s3 to migrate uploads into it');
  const target = storageFor('s3');

  const result = { moved: 0, wouldMove: 0, missing: 0, failed: 0, skipped: 0 };
  let cursor;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await withoutTenantScope(() => rawPrisma.document.findMany({
      where: { storageDriver: 'local' },
      orderBy: { pk: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { pk: cursor }, skip: 1 } : {}),
    }));
    if (!docs.length) break;
    cursor = docs[docs.length - 1].pk;

    for (const doc of docs) {
      if (!doc.filePath || !fs.existsSync(doc.filePath)) {
        result.missing += 1;
        logger.warn(`[migrate-uploads] ${doc.pk} (${doc.clientId}/${doc.vendorId}): file is not on disk, left as it was`);
        continue;
      }

      if (dryRun) {
        result.wouldMove += 1;
        continue;
      }

      try {
        const key = target.newKey({ clientId: doc.clientId, vendorId: doc.vendorId });
        const size = fs.statSync(doc.filePath).size;

        // eslint-disable-next-line no-await-in-loop
        await target.put({ filePath: doc.filePath, key, contentType: doc.mimeType, size });
        // eslint-disable-next-line no-await-in-loop
        const stored = await target.head(key);
        if (stored.size !== size) throw new Error(`stored ${stored.size} bytes, expected ${size}`);

        // eslint-disable-next-line no-await-in-loop
        await withoutTenantScope(() => rawPrisma.document.update({
          where: { pk: doc.pk },
          data: { storageDriver: 's3', storageKey: key, filePath: deleteLocal ? '' : doc.filePath },
        }));
        if (deleteLocal) fs.rmSync(doc.filePath, { force: true });
        result.moved += 1;
      } catch (error) {
        result.failed += 1;
        logger.error(`[migrate-uploads] ${doc.pk}: ${error.message}`);
      }
    }
  }

  return result;
};

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  migrateUploads({ dryRun: args.has('--dry-run'), deleteLocal: args.has('--delete-local') })
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await rawPrisma.$disconnect();
      process.exit(result.failed ? 1 : 0);
    })
    .catch(async (error) => {
      console.error(error.message);
      await rawPrisma.$disconnect();
      process.exit(1);
    });
}

module.exports = { migrateUploads };
