import { describe, it, expect, afterEach, vi } from 'vitest';
import { documentIdOf, openDocument } from './open-document';

// A document used to be a plain <a href="/api/uploads/<id>">: a link the browser
// follows without the session token, so it landed on a 401. Documents are opened
// by asking the API for a short-lived signed link (GET /uploads/:id/link) and
// navigating to that.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('documentIdOf', () => {
  it('reads the id off what the uploads API returned', () => {
    expect(documentIdOf({ documentId: 'abc' })).toBe('abc');
    expect(documentIdOf({ url: '/api/uploads/def-123' })).toBe('def-123');
    expect(documentIdOf({ url: 'http://localhost:5000/api/uploads/def-123' })).toBe('def-123');
  });

  it('has none for an older record that kept only a name', () => {
    expect(documentIdOf('cheque.pdf')).toBeNull();
    expect(documentIdOf({ originalName: 'cheque.pdf' })).toBeNull();
    expect(documentIdOf(null)).toBeNull();
  });
});

describe('openDocument', () => {
  const stubApi = (link) => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => link }));
    vi.stubGlobal('fetch', fetchMock);
    const open = vi.fn();
    vi.stubGlobal('window', { open, localStorage: { getItem: () => 'tok' } });
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    return { fetchMock, open };
  };

  it('asks the API for a link with the session token and opens it in a new tab without an opener', async () => {
    const { fetchMock, open } = stubApi({ url: 'https://bucket.example/obj?X-Amz-Signature=s', expiresAt: '2030-01-01T00:00:00Z' });

    await openDocument({ documentId: 'abc' });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/uploads\/abc\/link$/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(open).toHaveBeenCalledWith('https://bucket.example/obj?X-Amz-Signature=s', '_blank', 'noopener,noreferrer');
  });

  it('resolves a link the API itself serves (local development) against the API origin', async () => {
    const { open } = stubApi({ url: '/api/uploads/signed/abc?c=CLT-0001&exp=1&sig=ff' });

    await openDocument({ documentId: 'abc' });

    expect(open.mock.calls[0][0]).toBe('http://localhost:5000/api/uploads/signed/abc?c=CLT-0001&exp=1&sig=ff');
  });

  it('says so when there is nothing to open, instead of opening a blank tab', async () => {
    const { open } = stubApi({});
    await expect(openDocument({ documentId: 'abc' })).rejects.toThrow(/link/i);
    await expect(openDocument('cheque.pdf')).rejects.toThrow(/not available/i);
    expect(open).not.toHaveBeenCalled();
  });
});
