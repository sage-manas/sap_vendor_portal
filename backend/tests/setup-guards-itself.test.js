const { execFileSync } = require('child_process');
const path = require('path');

// On 2026-09-23, running the backend suite wiped this repo's real
// development database — every table, including the Kaveri Forge vendor and
// its live SAP connection config — because tests/setup.js loaded without
// tests/env.js having redirected DATABASE_URL first (the working theory: a
// checkout predating the PR that added env.js, per Jest's setupFiles). It
// was recoverable only by hand, through raw pg_surgery on the dead tuples a
// DELETE leaves behind — no backup existed.
//
// tests/setup.js now carries its own independent check rather than trusting
// that env.js already ran — see the comment there. These tests spawn a real
// child Node process, in a controlled environment, to prove exactly the two
// paths that matter: env.js ran first (the normal case, must proceed), and
// it did not (the incident's actual shape, must refuse before any query).
// Both processes are handed the real development DATABASE_URL from .env, so
// a regression here would show up as this test itself reaching for it — the
// assertion is that the child process refuses before that connection is
// ever opened, not merely that it exits non-zero for some other reason.
//
// Not a unit test of a plain function (that's test-database-guard.test.js,
// for config/testDatabase.js): this is the one place that specific defence
// actually matters, so it is exercised the way Jest itself loads it —
// requiring the real setupFilesAfterEnv file, not calling its logic
// directly.

const backendRoot = path.join(__dirname, '..');
const devDatabaseUrl = require('dotenv').parse(
  require('fs').readFileSync(path.join(backendRoot, '.env')),
).DATABASE_URL;

const run = (script) => {
  try {
    execFileSync(process.execPath, ['-e', script], {
      cwd: backendRoot,
      env: { ...process.env, DATABASE_URL: devDatabaseUrl },
      stdio: 'pipe',
    });
    return { threw: false };
  } catch (error) {
    return { threw: true, message: error.stderr.toString() };
  }
};

describe('tests/setup.js refuses to run without a verified target, on its own', () => {
  it('proceeds when env.js already redirected DATABASE_URL (the normal Jest order)', () => {
    const result = run(`
      require('./tests/env.js');
      try { require('./tests/setup.js'); } catch (e) {
        // beforeAll/beforeEach/etc. are Jest globals — undefined outside a
        // real Jest run, so setup.js throws reaching them. That is this
        // script succeeding: it proves nothing upstream of that line threw,
        // in particular not the DATABASE_URL check.
        if (!/is not defined/.test(e.message)) throw e;
      }
    `);
    expect(result.threw).toBe(false);
  });

  it("refuses immediately when env.js did not run — the incident's exact shape", () => {
    const result = run(`require('./tests/setup.js');`);
    expect(result.threw).toBe(true);
    expect(result.message).toMatch(/refuses to run against the database/);
    expect(result.message).toMatch(/does not end in "_test"/);
  });
});
