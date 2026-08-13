/**
 * Phase 1 migration — single-tenant data → multi-tenant.
 *
 *   node scripts/migrate-tenancy.js [--dry-run]
 *
 * Idempotent: creates the CLT-0001 "Legacy" client if absent, stamps every
 * pre-existing document with it, and drops the global unique indexes that the
 * per-tenant compound indexes replace. Running it twice is a no-op.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Client = require('../models/Client');
const { withoutTenantScope } = require('../utils/tenantContext');
const { LEGACY_CLIENT_ID, LEGACY_CLIENT_SLUG } = require('../utils/resolveClient');

// The ten tenant-scoped collections, and the now-obsolete global unique indexes
// on each. Business IDs are unique per tenant from here on.
const MODELS = [
  ['Vendor',        require('../models/Vendor'),        ['sapVendorCode_1']],
  ['RFQ',           require('../models/RFQ'),           ['id_1']],
  ['PurchaseOrder', require('../models/PurchaseOrder'), ['id_1']],
  ['ASN',           require('../models/ASN'),           ['id_1']],
  ['GRN',           require('../models/GRN'),           ['id_1']],
  ['Invoice',       require('../models/Invoice'),       ['id_1']],
  ['Payment',       require('../models/Payment'),       ['id_1']],
  ['ChatMessage',   require('../models/ChatMessage'),   []],
  ['SapLog',        require('../models/SapLog'),        []],
  ['Document',      require('../models/Document'),      []],
];

const log = (...args) => console.log('[migrate-tenancy]', ...args);

const ensureLegacyClient = async (dryRun) => {
  const existing = await Client.findOne({ clientId: LEGACY_CLIENT_ID });
  if (existing) {
    log(`client ${LEGACY_CLIENT_ID} already exists (${existing.companyName})`);
    return existing;
  }
  if (dryRun) {
    log(`would create client ${LEGACY_CLIENT_ID} "Legacy"`);
    return { clientId: LEGACY_CLIENT_ID };
  }
  const client = await Client.create({
    clientId: LEGACY_CLIENT_ID,
    companyName: 'Legacy',
    slug: LEGACY_CLIENT_SLUG,
    status: 'Active',
    plan: 'legacy',
    activatedAt: new Date(),
    createdBy: 'migrate-tenancy',
  });
  log(`created client ${client.clientId} "${client.companyName}" (slug: ${client.slug})`);
  return client;
};

// Drop indexes that assumed global uniqueness. Safe to call repeatedly.
const dropObsoleteIndexes = async (name, model, indexNames, dryRun) => {
  if (!indexNames.length) return;
  const existing = (await model.collection.indexes()).map((i) => i.name);
  for (const indexName of indexNames.filter((i) => existing.includes(i))) {
    if (dryRun) {
      log(`${name}: would drop obsolete global index ${indexName}`);
      continue;
    }
    await model.collection.dropIndex(indexName);
    log(`${name}: dropped obsolete global index ${indexName}`);
  }
};

const backfill = async (name, model, dryRun) => {
  const total = await model.collection.countDocuments({});
  const unstamped = await model.collection.countDocuments({
    $or: [{ clientId: { $exists: false } }, { clientId: null }],
  });

  if (unstamped === 0) {
    log(`${name}: ${total} docs, all already stamped`);
    return { name, total, migrated: 0 };
  }
  if (dryRun) {
    log(`${name}: would stamp ${unstamped}/${total} docs with ${LEGACY_CLIENT_ID}`);
    return { name, total, migrated: 0 };
  }

  const result = await model.collection.updateMany(
    { $or: [{ clientId: { $exists: false } }, { clientId: null }] },
    { $set: { clientId: LEGACY_CLIENT_ID } }
  );
  log(`${name}: stamped ${result.modifiedCount}/${total} docs with ${LEGACY_CLIENT_ID}`);
  return { name, total, migrated: result.modifiedCount };
};

const verify = async (name, model, before) => {
  const after = await model.collection.countDocuments({});
  const stamped = await model.collection.countDocuments({ clientId: LEGACY_CLIENT_ID });
  if (after !== before.total) {
    throw new Error(`${name}: document count changed (${before.total} → ${after}) — aborting`);
  }
  const orphans = after - (await model.collection.countDocuments({ clientId: { $type: 'string' } }));
  if (orphans !== 0) {
    throw new Error(`${name}: ${orphans} documents still have no clientId`);
  }
  log(`${name}: verified ${after} docs, ${stamped} in ${LEGACY_CLIENT_ID}`);
};

const run = async ({ dryRun = false } = {}) => {
  await ensureLegacyClient(dryRun);

  const results = [];
  for (const [name, model, obsolete] of MODELS) {
    await dropObsoleteIndexes(name, model, obsolete, dryRun);
    results.push(await backfill(name, model, dryRun));
  }

  if (!dryRun) {
    for (let i = 0; i < MODELS.length; i += 1) {
      await verify(MODELS[i][0], MODELS[i][1], results[i]);
    }
    // Build the new per-tenant compound indexes.
    for (const [name, model] of MODELS) {
      await model.syncIndexes();
      log(`${name}: indexes synced`);
    }
  }

  log(dryRun ? 'dry run complete — nothing written' : 'migration complete');
  return results;
};

// Migration is platform-plane work by definition: it operates across tenants.
const migrate = (opts) => withoutTenantScope(() => run(opts));

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  (async () => {
    if (!process.env.MONGO_URI) {
      console.error('[migrate-tenancy] MONGO_URI is not set');
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    try {
      await migrate({ dryRun });
      process.exit(0);
    } catch (err) {
      console.error('[migrate-tenancy] failed:', err);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
    }
  })();
}

module.exports = { migrate, MODELS };
