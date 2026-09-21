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
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;

  const development = env.DATABASE_URL;
  if (!development) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set — the test suite has no database to run against. '
      + 'Copy backend/.env.example to backend/.env, or set TEST_DATABASE_URL.',
    );
  }

  return withTestSuffix(development);
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

module.exports = { resolveTestDatabaseUrl, assertSafeToWipe, withTestSuffix, TEST_SUFFIX };
