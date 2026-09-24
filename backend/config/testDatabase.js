// Where the test suites are allowed to write.
//
// Both test runners — Jest (backend/tests/setup.js) and Playwright
// (playwright.config.mjs, e2e/global-setup.mjs) — used to run against whatever
// `backend/.env` named, which is the database a developer runs `npm run dev`
// against. Jest deletes every row in it before and after each test; the
// Playwright global setup rewrote the tenant's SapConnection. Neither is
// survivable on a database holding real configuration (issue #107).
//
// So the rule is: a test run never touches the development database, and it
// does not need the developer to remember to set anything. `TEST_DATABASE_URL`
// is honoured when set; otherwise the development URL's database name gets a
// `_test` suffix, which is the convention the repo documents in
// backend/.env.example.

const TEST_SUFFIX = '_test';

// Issue #120. `resetDatabase()`'s DELETE, or any other write in a test, can in
// principle block behind a lock held by a connection another test left open —
// the same family of problem #107's setup-file comment already documents for
// the old TRUNCATE. Without a cap, that shows up as Jest's own bare "Exceeded
// timeout of 30000 ms", which says nothing about what it was waiting on. A
// per-session statement_timeout well under Jest's testTimeout turns a genuine
// block into a real Postgres error (57014, "canceling statement due to
// statement timeout") instead — still a failure, but a diagnosable one. 15s
// comfortably clears every query this app actually issues (the slowest suites
// — lifecycle-e2e, production-boot — raise jest.setTimeout for a whole test
// spawning a child process or working through a multi-step flow, not because
// any single statement is slow).
const STATEMENT_TIMEOUT_MS = 15000;

/**
 * Adds a bounded `statement_timeout` to a Postgres connection string, unless
 * the URL already sets one via `options=` — an explicit TEST_DATABASE_URL
 * that sets its own is left alone rather than overridden.
 *
 * Prisma's Postgres connector does not honour a bare `?statement_timeout=`
 * query parameter (verified directly: a query with it set to 1ms still ran to
 * completion) — only the libpq `options=-c statement_timeout=…` startup
 * option actually reaches the server's per-session GUC.
 */
const withStatementTimeout = (url, ms = STATEMENT_TIMEOUT_MS) => {
  const parsed = new URL(url);
  const existingOptions = parsed.searchParams.get('options') || '';
  if (/\bstatement_timeout\b/.test(existingOptions)) return url;
  const options = `${existingOptions} -c statement_timeout=${ms}`.trim();
  parsed.searchParams.set('options', options);
  return parsed.toString();
};

/**
 * Derive the test database URL from a development one by suffixing the
 * database name. Returns the input unchanged if it already names a test
 * database, so setting TEST_DATABASE_URL explicitly is always respected.
 */
const withTestSuffix = (url) => {
  const parsed = new URL(url);
  // pathname is "/<database>"; a URL with no database name is not something we
  // can derive from, and silently inventing one would defeat the point.
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(
      `Cannot derive a test database from "${parsed.protocol}//…" — the connection string names no database.`,
    );
  }
  if (name.endsWith(TEST_SUFFIX)) return url;
  parsed.pathname = `/${name}${TEST_SUFFIX}`;
  return parsed.toString();
};

/**
 * The URL the test suites must use.
 *
 * @param {object} [env] - defaults to process.env; injectable for testing.
 * @returns {string}
 */
const resolveTestDatabaseUrl = (env = process.env) => {
  if (env.TEST_DATABASE_URL) return withStatementTimeout(env.TEST_DATABASE_URL);

  const development = env.DATABASE_URL;
  if (!development) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set — the test suite has no database to run against. '
      + 'Copy backend/.env.example to backend/.env, or set TEST_DATABASE_URL.',
    );
  }

  return withStatementTimeout(withTestSuffix(development));
};

/**
 * Throw unless `url` names a database that is safe to destroy.
 *
 * The guard is deliberately about the *name*, not about how the URL was
 * obtained: the failure mode this exists for is a test run silently pointed at
 * production or development data, and in that case every other signal
 * (NODE_ENV, which file set it) has already been wrong.
 */
const assertSafeToWipe = (url, runner = 'This test run') => {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `${runner} refuses to run against the database "${name}", which does not end in "${TEST_SUFFIX}". `
      + 'Test runs delete every row and rewrite tenant SAP configuration. '
      + `Set TEST_DATABASE_URL to a throwaway database (see backend/config/testDatabase.js).`,
    );
  }
  return url;
};

module.exports = {
  resolveTestDatabaseUrl,
  assertSafeToWipe,
  withTestSuffix,
  withStatementTimeout,
  TEST_SUFFIX,
  STATEMENT_TIMEOUT_MS,
};
