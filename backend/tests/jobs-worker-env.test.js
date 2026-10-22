const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// `npm run jobs` (and the vendorconnect-jobs PM2 app) runs jobs/worker.js as
// its own entry point. server.js loads backend/.env on line 1; the worker did
// not, so Prisma failed on every single tick with "Environment variable not
// found: DATABASE_URL" and the queue never drained — a worker that logs
// "starting", ticks forever and accomplishes nothing.
//
// Nothing caught it, because every other way the module is reached (jest,
// e2e/api-server.mjs) brings its own environment. So this spawns it the way
// an operator does: a bare child with DATABASE_URL stripped.

const BACKEND = path.join(__dirname, '..');
const ENV_FILE = path.join(BACKEND, '.env');
const SENTINEL = 'postgresql://sentinel:sentinel@localhost:5432/sentinel';

// A developer machine has backend/.env; CI does not. Rather than skip there —
// which would leave the defect unguarded exactly where it would be caught —
// write a throwaway one for the duration, and never touch a real file.
//
// 'wx' rather than exists-then-write: the two-step version is a race (CodeQL
// flags it, and rightly — a .env appearing in the gap would be overwritten,
// then deleted in afterAll). This way the create either wins or reports
// EEXIST, and only a file we know we created is cleaned up.
let wroteEnvFile = false;

beforeAll(() => {
  try {
    fs.writeFileSync(ENV_FILE, `DATABASE_URL=${SENTINEL}\n`, { flag: 'wx' });
    wroteEnvFile = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // a real .env is already there
  }
});

afterAll(() => {
  if (wroteEnvFile) fs.unlinkSync(ENV_FILE);
});

// Requiring the module is enough: the tick loop is gated on JOBS_ENABLED,
// which is left unset here, so nothing starts and nothing reaches SAP.
const loadWorkerWithout = (...unset) => {
  const env = { ...process.env };
  for (const key of unset) delete env[key];
  delete env.JOBS_ENABLED;

  return execFileSync(
    process.execPath,
    ['-e', 'require("./jobs/worker"); process.stdout.write(process.env.DATABASE_URL || "")'],
    { cwd: BACKEND, env, encoding: 'utf8' }
  );
};

describe('jobs/worker.js as a standalone entry point', () => {
  it('loads backend/.env, so DATABASE_URL is set even when the environment is bare', () => {
    expect(loadWorkerWithout('DATABASE_URL')).not.toBe('');
  });

  it('does not overwrite a DATABASE_URL the host already supplied', () => {
    const env = { ...process.env, DATABASE_URL: SENTINEL };
    delete env.JOBS_ENABLED;

    const loaded = execFileSync(
      process.execPath,
      ['-e', 'require("./jobs/worker"); process.stdout.write(process.env.DATABASE_URL || "")'],
      { cwd: BACKEND, env, encoding: 'utf8' }
    );

    expect(loaded).toBe(SENTINEL);
  });
});
