const logger = require('../utils/logger');

const validateEnv = () => {
  const strictlyRequired = ['PORT', 'DATABASE_URL', 'FRONTEND_URL'];

  const missingStrict = [];
  strictlyRequired.forEach(key => {
    if (!process.env[key]) {
      missingStrict.push(key);
    }
  });

  if (missingStrict.length > 0) {
    const errorMsg = `❌ Server crash: Missing strictly required env variables: ${missingStrict.join(', ')}`;
    logger.error(errorMsg);
    console.error(`\n${errorMsg}\n`);
    process.exit(1);
  }

  // Sessions are signed with this; the 'secret' fallback in code is a
  // development convenience and must never reach production.
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    const msg = '❌ Server crash in Production: JWT_SECRET is required';
    logger.error(msg);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }

  // utils/secretBox.js throws on a missing MASTER_KEY in production, but only
  // when something first touches an encrypted secret — an operator action,
  // long after boot. Checked here so it fails on the same startup that
  // JWT_SECRET does.
  if (process.env.NODE_ENV === 'production'
      && !process.env.MASTER_KEY && !process.env.SECRET_MASTER_KEY) {
    const msg = '❌ Server crash in Production: MASTER_KEY is required — it encrypts MFA and SAP secrets at rest';
    logger.error(msg);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }

  // Removed in Phase 2 (ADR-0009): it granted an admin role from a public
  // endpoint. Fail loudly rather than silently ignoring a stale deployment
  // config that an operator still believes is doing something.
  if (process.env.ADMIN_BOOTSTRAP_EMAILS) {
    const msg = '❌ ADMIN_BOOTSTRAP_EMAILS is no longer supported — provision staff with scripts/seed-platform-admin.js and the invitation flow. Remove it from the environment.';
    logger.error(msg);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }

  // Clerk was the original auth plan, replaced by local JWT; MONGO_URI
  // predates the Postgres migration. Nothing reads either any more. Same
  // reasoning as ADMIN_BOOTSTRAP_EMAILS above: a stale variable an operator
  // believes is doing something is worse than a missing one.
  const retired = [
    'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SIGNING_SECRET', 'MONGO_URI',
  ].filter((key) => process.env[key]);

  if (retired.length > 0) {
    const msg = `❌ Retired env variables are set and do nothing: ${retired.join(', ')}. Clerk was replaced by local JWT auth, and MONGO_URI by DATABASE_URL (Postgres/Prisma). Remove them from the environment.`;
    logger.error(msg);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }

  logger.info('✅ Environment variables validated successfully');
};

module.exports = validateEnv;
