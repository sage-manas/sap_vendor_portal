import { createRequire } from 'node:module';
import { defineConfig, devices } from '@playwright/test';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: './backend/.env' });
const { resolveTestDatabaseUrl, assertSafeToWipe } = require('./backend/config/testDatabase');

// Never the database `npm run dev` uses. globalSetup seeds a tenant and
// rewrites its SapConnection, and the specs write documents throughout — on a
// development database that destroys real SAP configuration (issue #107).
// Set TEST_DATABASE_URL to override; otherwise this is DATABASE_URL's database
// name with a `_test` suffix.
const DATABASE_URL = assertSafeToWipe(resolveTestDatabaseUrl(), 'The Playwright suite');

// globalSetup runs inside this process and reaches Prisma through
// backend/db/prisma.js, which reads process.env at require time — so the
// redirect has to be in place before it loads, not only in the webServer envs.
process.env.DATABASE_URL = DATABASE_URL;

// End-to-end coverage: a real browser against the real Next app, the real
// Express API and a real Postgres, with SAP on the mock driver.
//
// Deliberately separate from the Vitest suite. Those tests stub `fetch` and
// answer from a fixture table, which is the right trade for covering 35 routes
// quickly — but it means nothing there proves the frontend and backend agree.
// These two specs are what does.

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3100);
const API_PORT = Number(process.env.E2E_API_PORT || 5100);

// E2E_HOST=localhost lets the specs run against an already-running
// `npm run dev` (E2E_WEB_PORT=3000 E2E_API_PORT=5000): Next's dev server
// refuses its client bundles to a 127.0.0.1 origin it was not started on.
const HOST = process.env.E2E_HOST || '127.0.0.1';
const API_URL = `http://${HOST}:${API_PORT}/api`;
const WEB_URL = `http://${HOST}:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Seeds the demo tenant and zeroes the mock SAP's delays.
  globalSetup: './e2e/global-setup.mjs',
  // The purchase-order flow waits on the backend's own 10s goods-receipt
  // simulator (see submitASN in backend/controllers/po.controller.js), so the
  // per-test budget has to clear that with room to spare.
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // One worker: both specs drive the same seeded tenant, and a second worker
  // would be awarding tenders out from under the first.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // Ports of their own, so a running `npm run dev` is neither disturbed nor
  // mistaken for the server under test.
  webServer: [
    {
      command: 'npm run e2e:api',
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL,
        // The mock driver is the whole point: a deterministic SAP that
        // confirms goods receipts and clears payments on a timer. It is
        // selected by the tenant's SapConnection row, which globalSetup
        // writes — there is no environment variable that chooses a driver.
        JWT_SECRET: 'e2e-secret',
        FRONTEND_URL: WEB_URL,
        ALLOWED_ORIGINS: WEB_URL,
        MAIL_TRANSPORT: 'log',
        // e2e/api-server.cjs starts the job worker in this same process.
        JOBS_ENABLED: 'true',
        // The whole suite signs in to one tenant, and the sweep alone loads
        // ~40 screens at ~20 API calls each — well past the production
        // per-tenant default of 300/minute (middleware/rateLimiter.js).
        TENANT_RATE_LIMIT_MAX: '10000',
      },
    },
    {
      command: `npm run build && npm run start -- --port ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      // A cold Next build is the slow part of a first run.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      // The web server never talks to Postgres directly, but it runs Next's
      // build, which loads this repo's env — keep it on the test database so
      // nothing it does at build time can reach development data.
      env: { NEXT_PUBLIC_API_URL: API_URL, DATABASE_URL },
    },
  ],
});
