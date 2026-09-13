import { test, expect } from '@playwright/test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ACCOUNTS, API_URL, signIn } from './helpers.mjs';

// Every screen, as every account that is meant to reach it.
//
// The two flow specs prove the procure-to-pay chain holds together; this one
// proves nothing on the way is broken to look at. Each route is loaded in a
// real browser against the seeded demo tenant and fails on any of:
//   - an uncaught exception or a console error
//   - an API call answering 4xx/5xx (other than the ones a screen expects)
//   - an error boundary, or text a template leaked ("undefined", "NaN", …)
//   - no top-level heading
// A full-page screenshot of each lands in test-results/demo-sweep/ for review.

const root = path.resolve(import.meta.dirname, '..');
const shots = path.join(root, 'test-results', 'demo-sweep');

const SUPPLIER_ROUTES = ['/', '/registration', '/rfqs', '/pos', '/invoices', '/payments', '/performance', '/analytics'];

const WORKSPACE_ROUTES = [
  '/workspace', '/workspace/suppliers', '/workspace/suppliers/VND-77104', '/workspace/rfqs',
  '/workspace/purchase-orders', '/workspace/purchase-orders/PO-2026-0007', '/workspace/invoices',
  '/workspace/payments', '/workspace/users', '/workspace/settings', '/workspace/audit',
];

const PLATFORM_ROUTES = [
  '/platform', '/platform/tenants', '/platform/tenants/CLT-0001', '/platform/tenants/CLT-0001/sap',
  '/platform/operators', '/platform/audit', '/platform/sap', '/platform/reconciliation',
];

const PUBLIC_ROUTES = ['/sign-in', '/sign-up', '/forgot-password'];

// Text that only ever reaches a screen through a bug.
const LEAKS = [/\bundefined\b/, /\bNaN\b/, /Invalid Date/, /\[object Object\]/, /Something went wrong/i, /Application error/i];

/** Wires listeners that collect everything wrong with one page load. */
const watch = (page) => {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.url().startsWith(API_URL) && res.status() >= 400) {
      problems.push(`api ${res.status()}: ${res.request().method()} ${res.url().slice(API_URL.length)}`);
    }
  });
  return problems;
};

const inspect = async (page, route, problems, label) => {
  const start = problems.length;
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  // Skeletons on several screens hold for a deliberate beat before content.
  await page.waitForTimeout(1200);

  expect.soft(new URL(page.url()).pathname, `${label} ${route} redirected away`).toBe(route);
  await expect.soft(page.getByRole('heading', { level: 1 }).first(), `${label} ${route} has no h1`).toBeVisible({ timeout: 5_000 });

  const text = await page.locator('main, body').first().innerText();
  const leaks = LEAKS.filter((pattern) => pattern.test(text)).map((pattern) => `leaked text ${pattern}`);

  const file = `${label}${route.replaceAll('/', '_') || '_root'}.png`;
  await page.screenshot({ path: path.join(shots, file), fullPage: true });

  const found = [...problems.slice(start), ...leaks];
  expect.soft(found, `${label} ${route}`).toEqual([]);
};

test.describe('demo sweep: every screen renders cleanly', () => {
  test('signed-out screens', async ({ page }) => {
    const problems = watch(page);
    for (const route of PUBLIC_ROUTES) await inspect(page, route, problems, 'public');
  });

  test('supplier portal (approved supplier)', async ({ page }) => {
    const problems = watch(page);
    await signIn(page, ACCOUNTS.supplierA);
    for (const route of SUPPLIER_ROUTES) await inspect(page, route, problems, 'supplier');
  });

  for (const role of ['admin', 'buyer', 'finance']) {
    test(`tenant workspace as ${role}`, async ({ page }) => {
      const problems = watch(page);
      await signIn(page, ACCOUNTS[role], { expectPath: '/workspace' });

      // Only what this role's own navigation offers: a buyer is not shown
      // Settings, and a 403 there would be correct rather than a defect.
      const nav = await page.locator('a[href^="/workspace"]').evaluateAll(
        (links) => [...new Set(links.map((a) => a.getAttribute('href')))],
      );
      const routes = WORKSPACE_ROUTES.filter((route) =>
        nav.some((href) => route === href || (href !== '/workspace' && route.startsWith(`${href}/`))) || route === '/workspace');

      for (const route of routes) await inspect(page, route, problems, role);
    });
  }

  test('platform console (super admin, through MFA)', async ({ page, request }) => {
    const operator = await provisionOperator(request);
    const problems = watch(page);

    await page.goto('/platform');
    await page.getByLabel('Email').fill(operator.email);
    await page.getByLabel('Password').fill(operator.password);
    await page.getByRole('button', { name: /sign in|continue/i }).click();

    await page.getByLabel('Six-digit code').fill(operator.code());
    await page.getByRole('button', { name: 'Enter console' }).click();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    for (const route of PLATFORM_ROUTES) await inspect(page, route, problems, 'platform');
  });
});

/**
 * A super admin with a known password and an enrolled authenticator.
 *
 * The account itself is a precondition, seeded the way
 * backend/scripts/seed-platform-admin.js seeds one; enrolment then goes
 * through the real API so the code the browser types is one the server issued
 * the secret for.
 */
async function provisionOperator(request) {
  const require = createRequire(path.join(root, 'backend', 'package.json'));
  const { rawPrisma } = require('./db/prisma');
  const { hashPassword } = require('./db/credentials');
  const totp = require('./utils/totp');

  const email = 'e2e-operator@vendorconnect.test';
  const password = 'E2e-Operator@12345';
  const { password: hash, passwordChangedAt } = await hashPassword(password);
  const reset = { password: hash, passwordChangedAt, mustChangePassword: false, mfaEnabled: false, mfaSecret: null, status: 'Active' };

  await rawPrisma.platformUser.upsert({
    where: { email },
    create: { email, name: 'E2E Operator', role: 'super_admin', ...reset },
    update: reset,
  });
  await rawPrisma.$disconnect();

  const login = await (await request.post(`${API_URL}/platform/auth/login`, { data: { email, password } })).json();
  const headers = { Authorization: `Bearer ${login.token}` };
  const { secret } = await (await request.post(`${API_URL}/platform/auth/mfa/enrol`, { headers })).json();
  const verified = await request.post(`${API_URL}/platform/auth/mfa/verify`, { headers, data: { code: totp.generateToken(secret) } });
  expect(verified.ok(), `mfa enrolment: ${await verified.text()}`).toBe(true);

  // The enrolment above consumed this window's code; wait for a fresh one so
  // the browser's sign-in is not refused as a replay.
  const msIntoStep = Date.now() % (totp.STEP_SECONDS * 1000);
  await new Promise((resolve) => setTimeout(resolve, totp.STEP_SECONDS * 1000 - msIntoStep + 500));

  return { email, password, code: () => totp.generateToken(secret) };
}
