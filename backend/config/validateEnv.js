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

  // Workspaces are `<slug>.PORTAL_BASE_DOMAIN`. Without it the resolver has to
  // guess a tenant from the first label of whatever host arrived, which is how
  // a shared name like vendorportal.example.com broke every login.
  if (process.env.NODE_ENV === 'production' && !process.env.PORTAL_BASE_DOMAIN) {
    const msg = '❌ Server crash in Production: PORTAL_BASE_DOMAIN is required — workspaces are <slug>.<PORTAL_BASE_DOMAIN> (e.g. portal.example.com)';
    logger.error(msg);
    console.error(`
${msg}
`);
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

  // A short secret is guessable offline from any one token. 32 characters is
  // the floor for an HS256 key; `openssl rand -hex 32` gives 64.
  const MIN_SECRET_LENGTH = 32;
  if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < MIN_SECRET_LENGTH) {
    const msg = `❌ Server crash in Production: JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (generate one with: openssl rand -hex 32)`;
    logger.error(msg);
    console.error(`
${msg}
`);
    process.exit(1);
  }

  // The loopback relay between the API and the job worker has its own key
  // (utils/internalAuth.js), so that leaking one secret does not open both.
  if (process.env.NODE_ENV === 'production') {
    const key = process.env.INTERNAL_KEY || '';
    const problem = !key ? 'is required'
      : key.length < MIN_SECRET_LENGTH ? `must be at least ${MIN_SECRET_LENGTH} characters`
        : key === process.env.JWT_SECRET ? 'must differ from JWT_SECRET'
          : null;
    if (problem) {
      const msg = `❌ Server crash in Production: INTERNAL_KEY ${problem} — it authenticates the API/worker relay (generate one with: openssl rand -hex 32)`;
      logger.error(msg);
      console.error(`
${msg}
`);
      process.exit(1);
    }
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

  // CLAMAV_REQUIRED=true means "no scan, no upload". With no scanner named it
  // would refuse every upload, which is a misconfiguration to fail on at boot
  // rather than discover as a 503 on the first supplier document.
  if (String(process.env.CLAMAV_REQUIRED).toLowerCase() === 'true' && !process.env.CLAMAV_HOST) {
    const msg = '❌ CLAMAV_REQUIRED=true but CLAMAV_HOST is not set — every upload would be refused';
    logger.error(msg);
    console.error(`
${msg}
`);
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
