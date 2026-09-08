const logger = require('../utils/logger');

const validateEnv = () => {
  const strictlyRequired = ['PORT', 'DATABASE_URL', 'FRONTEND_URL'];
  const clerkKeys = ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SIGNING_SECRET'];

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

  // Removed in Phase 2 (ADR-0009): it granted an admin role from a public
  // endpoint. Fail loudly rather than silently ignoring a stale deployment
  // config that an operator still believes is doing something.
  if (process.env.ADMIN_BOOTSTRAP_EMAILS) {
    const msg = '❌ ADMIN_BOOTSTRAP_EMAILS is no longer supported — provision staff with scripts/seed-platform-admin.js and the invitation flow. Remove it from the environment.';
    logger.error(msg);
    console.error(`\n${msg}\n`);
    process.exit(1);
  }

  const missingClerk = [];
  clerkKeys.forEach(key => {
    if (!process.env[key]) {
      missingClerk.push(key);
    }
  });

  if (missingClerk.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      const prodErrorMsg = `❌ Server crash in Production: Missing Clerk credentials: ${missingClerk.join(', ')}`;
      logger.error(prodErrorMsg);
      console.error(`\n${prodErrorMsg}\n`);
      process.exit(1);
    } else {
      logger.warn(`⚠️ Development Warning: Missing Clerk environment credentials: ${missingClerk.join(', ')}. (Authentication features will be connected in Phase 7)`);
    }
  } else {
    logger.info('✅ Clerk Authentication environment keys detected');
  }

  logger.info('✅ Environment variables validated successfully');
};

module.exports = validateEnv;
