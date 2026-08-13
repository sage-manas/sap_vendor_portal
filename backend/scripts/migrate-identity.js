/**
 * Phase 2 migration — tenant administrators move out of the Vendor collection.
 *
 *   node scripts/migrate-identity.js [--dry-run]
 *
 * Before Phase 2 a tenant administrator was a Vendor document with
 * role: 'admin'. Vendor is now the supplier plane only (ADR-0007), so each such
 * document becomes a User with role 'client_admin'.
 *
 * Idempotent, and refuses to guess: an admin Vendor that also carries supplier
 * business data (RFQ bids, POs, invoices…) is reported and skipped rather than
 * deleted, because it is doing two jobs and only a human can say which one it
 * should keep.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const RFQ = require('../models/RFQ');
const PurchaseOrder = require('../models/PurchaseOrder');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const { withoutTenantScope } = require('../utils/tenantContext');
const { ROLES } = require('../config/roles');

const log = (...args) => console.log('[migrate-identity]', ...args);

// Business documents that would be orphaned if we removed the Vendor record.
const businessDataCount = async (vendorId) => {
  const counts = await withoutTenantScope(async () => Promise.all([
    PurchaseOrder.countDocuments({ vendorId }),
    Invoice.countDocuments({ vendorId }),
    Payment.countDocuments({ vendorId }),
    RFQ.countDocuments({ 'invitedVendors.id': vendorId }),
  ]));
  return counts.reduce((sum, n) => sum + n, 0);
};

const run = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  log(`connected to ${mongoose.connection.name}${dryRun ? ' (dry run)' : ''}`);

  // The enum no longer contains 'admin', so this reads the raw collection.
  const admins = await mongoose.connection.db
    .collection('vendors')
    .find({ role: 'admin' })
    .toArray();

  log(`${admins.length} admin vendor document(s) found`);

  let migrated = 0;
  let skipped = 0;

  for (const admin of admins) {
    const email = (admin.email || '').toLowerCase();
    if (!email || !admin.clientId) {
      log(`skip ${admin.vendorId}: missing email or clientId`);
      skipped += 1;
      continue;
    }

    const existing = await withoutTenantScope(() => User.findOne({ email }));
    if (existing) {
      log(`skip ${email}: a User already exists (${existing.role})`);
      skipped += 1;
      continue;
    }

    const linked = await businessDataCount(admin.vendorId);
    if (linked > 0) {
      log(`SKIP ${email}: admin vendor ${admin.vendorId} has ${linked} linked business document(s). ` +
        `Decide manually whether it is a supplier or an administrator.`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      log(`would migrate ${email} → User(client_admin) in ${admin.clientId}, and delete vendor ${admin.vendorId}`);
      migrated += 1;
      continue;
    }

    // The password hash moves across unchanged, so the administrator's existing
    // credentials keep working. Bypass the pre-save hash hook by inserting the
    // already-hashed value directly.
    await mongoose.connection.db.collection('users').insertOne({
      clientId: admin.clientId,
      email,
      name: admin.companyName || email,
      role: ROLES.CLIENT_ADMIN,
      status: 'Active',
      password: admin.password,
      mustChangePassword: false,
      activatedAt: new Date(),
      createdAt: admin.createdAt || new Date(),
      updatedAt: new Date(),
      __v: 0,
    });

    await mongoose.connection.db.collection('vendors').deleteOne({ _id: admin._id });
    log(`migrated ${email} → client_admin in ${admin.clientId} (vendor ${admin.vendorId} removed)`);
    migrated += 1;
  }

  log(`done: ${migrated} migrated, ${skipped} skipped`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('[migrate-identity] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
