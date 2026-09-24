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
