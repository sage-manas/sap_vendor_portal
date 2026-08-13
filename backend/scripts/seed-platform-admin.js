/**
 * Creates the platform's first super admin.
 *
 *   node scripts/seed-platform-admin.js --email you@example.com --name "Ada L"
 *   node scripts/seed-platform-admin.js --email you@example.com --password '...'
 *
 * Idempotent: if the email already exists the script reports it and exits
 * without touching the account. When no password is supplied one is generated,
 * printed once (this is the only channel a bootstrap has) and flagged
 * mustChangePassword.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const mongoose = require('mongoose');
const PlatformUser = require('../models/PlatformUser');
const { ROLES } = require('../config/roles');

const log = (...args) => console.log('[seed-platform-admin]', ...args);

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

// 24 bytes of base64url: comfortably above anything a person would choose.
const generatePassword = () => crypto.randomBytes(18).toString('base64url');

const run = async () => {
  const email = (arg('email') || process.env.PLATFORM_ADMIN_EMAIL || '').toLowerCase().trim();
  const name = arg('name') || process.env.PLATFORM_ADMIN_NAME || 'Platform Administrator';
  const suppliedPassword = arg('password') || process.env.PLATFORM_ADMIN_PASSWORD;

  if (!email) {
    console.error('Usage: node scripts/seed-platform-admin.js --email <address> [--name "Full Name"] [--password <password>]');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  log(`connected to ${mongoose.connection.name}`);

  const existing = await PlatformUser.findOne({ email });
  if (existing) {
    log(`operator ${email} already exists (role: ${existing.role}) — nothing to do`);
    await mongoose.disconnect();
    return;
  }

  const password = suppliedPassword || generatePassword();

  const operator = await PlatformUser.create({
    email,
    name,
    role: ROLES.SUPER_ADMIN,
    status: 'Active',
    password,
    mustChangePassword: !suppliedPassword,
    createdBy: 'seed-platform-admin',
  });

  log(`created super admin ${operator.email} (${operator._id})`);
  if (!suppliedPassword) {
    log('');
    log(`  temporary password: ${password}`);
    log('  This is shown once. Sign in at /platform and change it immediately.');
    log('');
  }

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('[seed-platform-admin] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
