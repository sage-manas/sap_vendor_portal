/**
 * First-run setup of a NEW production database. Seeds exactly one thing: the
 * platform super admin. No demo tenant, no legacy client, no sample suppliers —
 * everything else is created through the console by that admin.
 *
 *   node scripts/bootstrap-production.js --email ops@example.com [--name "Ada L"]
 *
 * Run it once, after `prisma migrate deploy`, with the production environment
 * loaded. It refuses when:
 *   - NODE_ENV is not production (so it cannot be pointed at a dev database by
 *     accident and leave a real-looking admin in it),
 *   - a variable production needs is missing (checked here so a half-configured
 *     server does not get as far as an admin account),
 *   - the database already holds tenants, suppliers, tenant staff or an operator
 *     (this is not a fresh database; use seed-platform-admin.js to add operators),
 *   - the migrations have not been applied.
 *
 * The admin gets a generated password, printed once, and must change it (and
 * enrol MFA) at first sign-in.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const { rawPrisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
const { ROLES } = require('../config/roles');

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'MASTER_KEY', 'PORTAL_BASE_DOMAIN', 'FRONTEND_URL', 'SMTP_HOST', 'MAIL_FROM'];

class BootstrapRefused extends Error {}

const bootstrap = async ({ email, name = 'Platform Administrator', env = process.env, allowNonProduction = false } = {}) => {
  const address = String(email || '').toLowerCase().trim();
  if (!address || !address.includes('@')) throw new BootstrapRefused('--email <address> is required');

  if (env.NODE_ENV !== 'production' && !allowNonProduction) {
    throw new BootstrapRefused('NODE_ENV is not "production". Refusing to seed a production admin into an unknown database.');
  }

  const missing = REQUIRED_ENV.filter((key) => !(key === 'MASTER_KEY' ? env.MASTER_KEY || env.SECRET_MASTER_KEY : env[key]));
  if (missing.length) throw new BootstrapRefused(`Missing environment for production: ${missing.join(', ')}`);

  const migrated = await rawPrisma.$queryRaw`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`;
  if (!migrated[0]?.present) throw new BootstrapRefused('No migration history found. Run `npx prisma migrate deploy` first.');

  const counts = {
    clients: await rawPrisma.client.count(),
    vendors: await rawPrisma.vendor.count(),
    users: await rawPrisma.user.count(),
    operators: await rawPrisma.platformUser.count(),
  };
  const used = Object.entries(counts).filter(([, count]) => count > 0);
  if (used.length) {
    throw new BootstrapRefused(`This is not a fresh database (${used.map(([k, n]) => `${n} ${k}`).join(', ')}). To add an operator to a live system use scripts/seed-platform-admin.js.`);
  }

  const temporaryPassword = crypto.randomBytes(18).toString('base64url');
  const { password, passwordChangedAt } = await hashPassword(temporaryPassword);
  const operator = await rawPrisma.platformUser.create({
    data: {
      email: address, name, role: ROLES.SUPER_ADMIN, status: 'Active',
      password, passwordChangedAt, mustChangePassword: true, createdBy: 'bootstrap-production',
    },
  });

  return { operator, temporaryPassword };
};

module.exports = { bootstrap, BootstrapRefused, REQUIRED_ENV };

if (require.main === module) {
  const arg = (flag) => {
    const index = process.argv.indexOf(`--${flag}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };

  bootstrap({ email: arg('email'), name: arg('name') })
    .then(({ operator, temporaryPassword }) => {
      console.log(`[bootstrap-production] created super admin ${operator.email}`);
      console.log('');
      console.log(`  temporary password: ${temporaryPassword}`);
      console.log('  Shown once. Sign in at https://platform.<PORTAL_BASE_DOMAIN>/platform, change it and enrol MFA.');
      console.log('  Then create the first client from the console.');
    })
    .catch((error) => {
      console.error(`[bootstrap-production] ${error instanceof BootstrapRefused ? 'refused' : 'failed'}: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => rawPrisma.$disconnect());
}
