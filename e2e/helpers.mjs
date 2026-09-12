import { expect } from '@playwright/test';

// The accounts backend/scripts/seed-demo.js creates. Its own output prints
// these; they are repeated here so a spec reads as a story about people
// rather than about credentials.
export const ACCOUNTS = {
  supplierA: { email: 'supplier@meridiancastings.in', password: 'Demo@12345', vendorId: 'VND-77104' },
  supplierB: { email: 'contact@bharatprecision.in', password: 'Demo@12345', vendorId: 'VND-83217' },
  buyer: { email: 'buyer@nucleusmfg.in', password: 'Demo@12345' },
  finance: { email: 'finance@nucleusmfg.in', password: 'Demo@12345' },
  admin: { email: 'admin@nucleusmfg.in', password: 'Demo@12345' },
};

export const API_URL = process.env.E2E_API_URL
  || `http://127.0.0.1:${process.env.E2E_API_PORT || 5100}/api`;

export const futureDate = (days = 30) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/**
 * A token for one account, taken from the real login endpoint.
 *
 * Used for the setup and the cross-checks a spec makes as a role whose screen
 * it is not driving — creating the tender as the buyer, say, while the browser
 * is signed in as a supplier.
 */
export const tokenFor = async (request, account) => {
  const response = await request.post(`${API_URL}/auth/login`, {
    data: { vendorIdOrEmail: account.email, password: account.password },
  });
  expect(response.ok(), `login failed for ${account.email}: ${await response.text()}`).toBe(true);
  return (await response.json()).token;
};

/** A thin authed client, so a spec's setup reads as one line per step. */
export const api = (request, token) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const unwrap = async (response, label) => {
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok(), status: response.status(), body, label };
  };

  return {
    get: async (path) => unwrap(await request.get(`${API_URL}${path}`, { headers }), `GET ${path}`),
    post: async (path, data) => unwrap(await request.post(`${API_URL}${path}`, { headers, data }), `POST ${path}`),
    put: async (path, data) => unwrap(await request.put(`${API_URL}${path}`, { headers, data }), `PUT ${path}`),
  };
};

/** Asserts a call succeeded and hands back its body, naming it on failure. */
export const ok = (result) => {
  expect(result.ok, `${result.label} → ${result.status} ${JSON.stringify(result.body)}`).toBe(true);
  return result.body;
};

/**
 * Signs in through the real sign-in form and waits for the landing page the
 * account's plane belongs to. Suppliers land on the portal home, tenant staff
 * on the workspace — the same split the form itself makes.
 */
export const signIn = async (page, account, { expectPath = '/' } = {}) => {
  await page.goto('/sign-in');

  await page.getByPlaceholder(/VND-|partner@domain/i).fill(account.email);
  await page.getByPlaceholder('••••••••').fill(account.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL((url) => new URL(url).pathname === expectPath, { timeout: 30_000 });
};

/** Drops the session without going through the sign-out menu. */
export const signOut = async (page) => {
  await page.evaluate(() => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('clerk_user_id');
    localStorage.removeItem('sap_vendor_profile_data');
  });
};

/**
 * An RFQ, created as the buyer, inviting whichever suppliers the spec names.
 * Created through the API rather than the buyer's own screen: the tender is
 * the fixture here, not the subject.
 */
export const createTender = async (buyer, { description, vendorIds, quantity = 100 }) => {
  const rfq = ok(await buyer.post('/rfqs', {
    description,
    deadlineDate: futureDate(30),
    items: [
      { line: 10, materialCode: 'MAT-E2E-1', description: 'Hex bolts M8', quantity, targetPrice: 15 },
    ],
    invitedVendors: vendorIds.map((id) => ({ id })),
  }));
  return rfq;
};
