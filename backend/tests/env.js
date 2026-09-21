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
