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
const { rawPrisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
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

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const existing = await rawPrisma.platformUser.findFirst({ where: { email } });
  if (existing) {
    log(`operator ${email} already exists (role: ${existing.role}) — nothing to do`);
    await rawPrisma.$disconnect();
    return;
  }

  const plainPassword = suppliedPassword || generatePassword();
  const { password, passwordChangedAt } = await hashPassword(plainPassword);

  const operator = await rawPrisma.platformUser.create({
    data: {
      email,
      name,
      role: ROLES.SUPER_ADMIN,
      status: 'Active',
      password,
      passwordChangedAt,
      mustChangePassword: !suppliedPassword,
      createdBy: 'seed-platform-admin',
    },
  });

  log(`created super admin ${operator.email} (${operator.pk})`);
  if (!suppliedPassword) {
    log('');
    log(`  temporary password: ${plainPassword}`);
    log('  This is shown once. Sign in at /platform and change it immediately.');
    log('');
  }

  await rawPrisma.$disconnect();
};

run().catch(async (error) => {
  console.error('[seed-platform-admin] failed:', error.message);
  await rawPrisma.$disconnect().catch(() => {});
  process.exit(1);
});
