import { describe, it, expect, afterEach, vi } from 'vitest';
import { apiClient } from './api-client';

// Issue #119. A dropped connection on a GET is a harmless failed read — the
// portal has always swallowed it into `null`. On a POST/PUT/PATCH/DELETE the
// same drop does NOT mean the request failed: it may have reached the server
// and been acted on before the response was lost. Collapsing both into the
// same `null` made a write's outcome indistinguishable from "never sent",
// which is the one guarantee a caller creating a real SAP document — asset
// PO creation (ADR-0042) — cannot give up.

const networkFailure = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiClient.request, network failure', () => {
  it('still swallows a dropped GET into null', async () => {
    vi.stubGlobal('fetch', vi.fn(networkFailure));
    await expect(apiClient.get('/vendors')).resolves.toBeNull();
  });

  it('throws for a dropped POST, marked as an unknown outcome rather than a known failure', async () => {
    vi.stubGlobal('fetch', vi.fn(networkFailure));
    const promise = apiClient.post('/pos/asset', { vendorId: 'v1' });
    await expect(promise).rejects.toMatchObject({ offline: true });
  });

  it('throws for a dropped PUT and DELETE the same way as POST', async () => {
    vi.stubGlobal('fetch', vi.fn(networkFailure));
    await expect(apiClient.put('/pos/1/acknowledge', {})).rejects.toMatchObject({ offline: true });
    await expect(apiClient.delete('/pos/1/items/10/invoice-plan')).rejects.toMatchObject({ offline: true });
  });

  it('does not mark a real 4xx/5xx response as an unknown outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: 'Invalid asset number' }),
    })));
    const promise = apiClient.post('/pos/asset', { vendorId: 'v1' });
    await expect(promise).rejects.toMatchObject({ status: 422 });
    await expect(promise.catch((err) => err.offline)).resolves.toBeUndefined();
  });
});

// The server refuses every call but /auth/me and /auth/change-password to an
// account that must still change its temporary password (403,
// reason: 'password_change_required'). A request that raced the whoami gate
// must land the user on the change screen.
describe('apiClient.request, password change required', () => {
  const originalLocation = window.location;
  const refused = () => vi.fn(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'You must change your temporary password before continuing', reason: 'password_change_required' }),
  }));
  const at = (pathname) => Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { pathname, href: pathname } });

  afterEach(() => Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation }));

  it('sends the user to /change-password and still rejects the call', async () => {
    vi.stubGlobal('fetch', refused());
    at('/purchase-orders');
    await expect(apiClient.get('/pos')).rejects.toMatchObject({ status: 403, reason: 'password_change_required' });
    expect(window.location.href).toBe('/change-password');
  });

  it('does not redirect when already on /change-password', async () => {
    vi.stubGlobal('fetch', refused());
    at('/change-password');
    await expect(apiClient.get('/pos')).rejects.toMatchObject({ status: 403 });
    expect(window.location.href).toBe('/change-password');
    expect(window.location.pathname).toBe('/change-password');
  });

  it('leaves an unrelated 403 alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })));
    at('/purchase-orders');
    await expect(apiClient.get('/pos')).rejects.toMatchObject({ status: 403 });
    expect(window.location.href).toBe('/purchase-orders');
  });
});
