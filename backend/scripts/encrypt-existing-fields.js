#!/usr/bin/env node
/**
 * Encrypts the bank account numbers and PANs that were stored in plain text
 * before field-level encryption existed (db/fieldEncryptionExtension.js), and
 * re-encrypts them when MASTER_KEY is rotated:
 *
 *   vendors.pan, vendors."accountNumber", vendors."pendingBankChange"->accountNumber,
 *   payments."deducteePan"
 *
 *   node scripts/encrypt-existing-fields.js --dry-run
 *   node scripts/encrypt-existing-fields.js
 *   MASTER_KEY_OLD=<previous key> node scripts/encrypt-existing-fields.js --rotate-from-env MASTER_KEY_OLD
 *
 * Needs the production MASTER_KEY in the environment. Run it deliberately,
 * against the production database: it rewrites supplier bank data. Take a backup
 * first (docs/runbooks/backup-restore.md).
 *
 * Safe to run again and to stop part-way. A value already readable under the
 * CURRENT key is skipped; a plain value is encrypted; with --rotate-from-env a
 * value readable only under the old key is re-encrypted under the current one; a
 * value readable under neither is reported as `failed` and left untouched. Each
 * row is updated on its own. Reads need no migration: the data layer returns a
 * plain value as it is, so the application keeps working throughout.
 *
 * It uses raw SQL deliberately, so it sees exactly what is in the table.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { seal } = require('../db/fieldEncryptionExtension');
const { isEncrypted, decrypt, decryptUnder } = require('../utils/secretBox');
const logger = require('../utils/logger');

const BATCH = 500;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const readableNow = (value) => {
  try { decrypt(value); return true; } catch { return false; }
};

const encryptExistingFields = async ({ dryRun = false, rotateFrom } = {}) => {
  const result = { encrypted: 0, rotated: 0, wouldEncrypt: 0, failed: 0 };

  // What to store for one value, or `undefined` for "leave it alone".
  const convert = (value) => {
    if (typeof value !== 'string' || value === '') return undefined;
    if (!isEncrypted(value)) return { stored: seal(value), kind: 'encrypted' };
    if (readableNow(value)) return undefined;
    if (!rotateFrom) throw new Error('value is encrypted under a key that is not the current MASTER_KEY (use --rotate-from-env)');
    return { stored: seal(decryptUnder(rotateFrom, value)), kind: 'rotated' };
  };

  const tally = (kind) => {
    if (dryRun) result.wouldEncrypt += 1; else result[kind] += 1;
  };

  await withoutTenantScope(async () => {
    // --- vendors ----------------------------------------------------------
    let cursor = ZERO_UUID;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await rawPrisma.$queryRaw`
        SELECT pk::text AS pk, pan, "accountNumber", "pendingBankChange"
        FROM vendors WHERE pk > ${cursor}::uuid ORDER BY pk LIMIT ${BATCH}`;
      if (!rows.length) break;
      cursor = rows[rows.length - 1].pk;

      for (const row of rows) {
        try {
          const pan = convert(row.pan);
          const account = convert(row.accountNumber);
          const pendingAccount = row.pendingBankChange ? convert(row.pendingBankChange.accountNumber) : undefined;
          if (!pan && !account && !pendingAccount) continue;

          if (!dryRun) {
            const pending = pendingAccount
              ? { ...row.pendingBankChange, accountNumber: pendingAccount.stored }
              : row.pendingBankChange;
            // eslint-disable-next-line no-await-in-loop
            await rawPrisma.$executeRaw`
              UPDATE vendors SET pan = ${pan ? pan.stored : row.pan},
                "accountNumber" = ${account ? account.stored : row.accountNumber},
                "pendingBankChange" = ${pending === null || pending === undefined ? null : JSON.stringify(pending)}::jsonb
              WHERE pk = ${row.pk}::uuid`;
          }
          [pan, account, pendingAccount].filter(Boolean).forEach((change) => tally(change.kind));
        } catch (error) {
          result.failed += 1;
          logger.error(`[encrypt-existing-fields] vendor ${row.pk}: ${error.message}`);
        }
      }
    }

    // --- payments ---------------------------------------------------------
    cursor = ZERO_UUID;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await rawPrisma.$queryRaw`
        SELECT pk::text AS pk, "deducteePan" FROM payments
        WHERE pk > ${cursor}::uuid AND "deducteePan" IS NOT NULL AND "deducteePan" <> ''
        ORDER BY pk LIMIT ${BATCH}`;
      if (!rows.length) break;
      cursor = rows[rows.length - 1].pk;

      for (const row of rows) {
        try {
          const change = convert(row.deducteePan);
          if (!change) continue;
          if (!dryRun) {
            // eslint-disable-next-line no-await-in-loop
            await rawPrisma.$executeRaw`UPDATE payments SET "deducteePan" = ${change.stored} WHERE pk = ${row.pk}::uuid`;
          }
          tally(change.kind);
        } catch (error) {
          result.failed += 1;
          logger.error(`[encrypt-existing-fields] payment ${row.pk}: ${error.message}`);
        }
      }
    }
  });

  return result;
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const flag = args.indexOf('--rotate-from-env');
  const rotateFrom = flag === -1 ? undefined : process.env[args[flag + 1]];

  if (flag !== -1 && !rotateFrom) {
    console.error(`--rotate-from-env ${args[flag + 1] || '<NAME>'}: that environment variable is not set`);
    process.exit(1);
  }

  encryptExistingFields({ dryRun, rotateFrom })
    .then(async (result) => {
      console.log(JSON.stringify({ dryRun, ...result }, null, 2));
      await rawPrisma.$disconnect();
      process.exit(result.failed ? 1 : 0);
    })
    .catch(async (error) => {
      console.error(error.message);
      await rawPrisma.$disconnect();
      process.exit(1);
    });
}

module.exports = { encryptExistingFields };
