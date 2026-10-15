// Runs before anything else in a Jest worker — see `setupFiles` in
// jest.config.js, which is evaluated ahead of `setupFilesAfterEnv`.
//
// This has to happen here rather than in tests/setup.js because PrismaClient
// reads DATABASE_URL when it is constructed, and `db/prisma.js` constructs it
// at require time. By the time setup.js runs its first query the connection is
// already bound, so redirecting the suite has to precede that require.
//
// Issue #107: the suite used to inherit backend/.env's DATABASE_URL — the
// development database — and delete every row in it.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveTestDatabaseUrl, assertSafeToWipe } = require('../config/testDatabase');

process.env.DATABASE_URL = assertSafeToWipe(resolveTestDatabaseUrl(), 'The Jest suite');

// The per-account login backoff (middleware/accountGuard.js) is real seconds in
// production; a test that wants to observe it sets its own.
process.env.AUTH_DELAY_BASE_MS = '1';

// The suite's ambient tenancy mode is fixed here rather than inherited from
// backend/.env, which a developer sets for their own deployment. Most tests name
// their workspace with `x-client-slug`, which only `subdomain` reads; a case that
// wants the other model opts in per-case with withEnv (account-tenancy.test.js).
// Without this pin, flipping the local .env to `account` silently changes what
// ~35 unrelated test call sites are exercising.
process.env.PORTAL_TENANCY_MODE = 'subdomain';

// Same reasoning, and the same value CI's test job sets (.github/workflows/
// test.yml). Since #253 an unset DEFAULT_CLIENT_SLUG means "this request names
// no workspace" rather than "the legacy tenant", so the ~dozen call sites that
// reach the fallback need it named. A case that wants the unnamed realm opts
// out per-case with withEnv (tenant-realm.test.js).
process.env.DEFAULT_CLIENT_SLUG = 'legacy';
