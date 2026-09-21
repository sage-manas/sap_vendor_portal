const {
  resolveTestDatabaseUrl,
  assertSafeToWipe,
  withTestSuffix,
} = require('../config/testDatabase');

// Issue #107. Both test runners delete every row and rewrite tenant SAP
// configuration, and both used to do it to whatever `backend/.env` named —
// the database a developer runs `npm run dev` against, which on this project
// held a live SAP connection (gateway URL, SAP client, every Z-endpoint path).
//
// These are pure-function tests on purpose: the guard has to hold before any
// database connection exists, so there is nothing here to seed and nothing to
// reset.

const DEV = 'postgresql://user:pw@localhost:5432/sap_vendor_portal?schema=public';

describe('resolveTestDatabaseUrl', () => {
  it('derives a _test database from the development URL', () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: DEV }))
      .toBe('postgresql://user:pw@localhost:5432/sap_vendor_portal_test?schema=public');
  });

  it('prefers an explicit TEST_DATABASE_URL over deriving one', () => {
    const explicit = 'postgresql://user:pw@db:5432/somewhere_else_test';
    expect(resolveTestDatabaseUrl({ DATABASE_URL: DEV, TEST_DATABASE_URL: explicit }))
      .toBe(explicit);
  });

  it('leaves a URL that already names a test database alone', () => {
    const already = 'postgresql://user:pw@localhost:5432/sap_vendor_portal_test?schema=public';
    expect(withTestSuffix(already)).toBe(already);
  });

  it('refuses to guess when neither variable is set', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(/no database to run against/i);
  });

  it('refuses a connection string that names no database', () => {
    expect(() => withTestSuffix('postgresql://user:pw@localhost:5432')).toThrow(/names no database/i);
  });

  it('keeps credentials, host, port and query parameters intact', () => {
    const derived = new URL(resolveTestDatabaseUrl({ DATABASE_URL: DEV }));
    expect(derived.username).toBe('user');
    expect(derived.host).toBe('localhost:5432');
    expect(derived.searchParams.get('schema')).toBe('public');
  });
});

describe('assertSafeToWipe', () => {
  it('refuses the development database', () => {
    expect(() => assertSafeToWipe(DEV, 'The Jest suite'))
      .toThrow(/refuses to run against the database "sap_vendor_portal"/);
  });

  it('refuses a production-looking database even when handed over deliberately', () => {
    expect(() => assertSafeToWipe('postgresql://u:p@prod.internal:5432/vendorconnect'))
      .toThrow(/does not end in "_test"/);
  });

  it('names the runner in the refusal, so the message says what was stopped', () => {
    expect(() => assertSafeToWipe(DEV, 'The Playwright suite'))
      .toThrow(/^The Playwright suite refuses/);
  });

  it('allows a _test database and returns it unchanged', () => {
    const safe = 'postgresql://u:p@localhost:5432/sap_vendor_portal_test?schema=public';
    expect(assertSafeToWipe(safe)).toBe(safe);
  });

  it('guards the URL this suite is actually running against', () => {
    // The one integration-ish assertion: whatever tests/env.js resolved at
    // boot must itself pass the guard. If this fails, the suite is pointed
    // somewhere it must not be.
    expect(() => assertSafeToWipe(process.env.DATABASE_URL, 'This suite')).not.toThrow();
  });
});
