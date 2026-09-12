import { defineConfig, devices } from '@playwright/test';

// End-to-end coverage: a real browser against the real Next app, the real
// Express API and a real Postgres, with SAP on the mock driver.
//
// Deliberately separate from the Vitest suite. Those tests stub `fetch` and
// answer from a fixture table, which is the right trade for covering 35 routes
// quickly — but it means nothing there proves the frontend and backend agree.
// These two specs are what does.

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3100);
const API_PORT = Number(process.env.E2E_API_PORT || 5100);

const API_URL = `http://127.0.0.1:${API_PORT}/api`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

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
        // The mock driver is the whole point: a deterministic SAP that
        // confirms goods receipts and clears payments on a timer.
        SAP_MOCK_MODE: 'true',
        JWT_SECRET: 'e2e-secret',
        FRONTEND_URL: WEB_URL,
        ALLOWED_ORIGINS: WEB_URL,
        MAIL_TRANSPORT: 'log',
        // e2e/api-server.cjs starts the job worker in this same process.
        JOBS_ENABLED: 'true',
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
      env: { NEXT_PUBLIC_API_URL: API_URL },
    },
  ],
});
