import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '../../next.config';
import { buildCsp } from './security-headers';
import { proxy } from '../proxy';

// The pages shipped no security headers at all: nothing stopped them being
// framed, a script injected into one would run, and a browser that once saw the
// site over http would happily do so again. The CSP is nonce-based, so it is
// only useful if a fresh nonce is minted per request and reaches both the
// header and the theme script in layout.jsx.

const directive = (csp, name) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) || '';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('buildCsp', () => {
  const csp = buildCsp({ nonce: 'abc123', apiOrigin: 'https://api.example.com', host: 'portal.example.com' });

  it('allows scripts only by nonce, never inline', () => {
    const scripts = directive(csp, 'script-src');
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it('refuses framing, plugins and foreign form posts or base URLs', () => {
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('lets the app reach only its own API, its socket and the two lookups the registration form uses', () => {
    const connect = directive(csp, 'connect-src');
    expect(connect).toContain("'self'");
    expect(connect).toContain('https://api.example.com');
    expect(connect).toContain('wss://api.example.com');
    expect(connect).toContain('wss://portal.example.com');
    expect(connect).toContain('https://ifsc.razorpay.com');
    expect(connect).toContain('https://api.postalpincode.in');
    expect(connect).not.toMatch(/\s\*(\s|$)/);
  });

  it('allows unsafe-eval in development only', () => {
    expect(directive(buildCsp({ nonce: 'n', isDev: true }), 'script-src')).toContain("'unsafe-eval'");
    expect(directive(buildCsp({ nonce: 'n', isDev: false }), 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('is one line with no stray whitespace', () => {
    expect(csp).not.toMatch(/\n/);
    expect(csp).not.toMatch(/\s{2,}/);
  });
});

describe('proxy', () => {
  const run = (url = 'https://portal.example.com/pos') => proxy(new NextRequest(url));
  const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp)?.[1];

  it('mints a different nonce for every request', () => {
    const a = nonceOf(run().headers.get('content-security-policy'));
    const b = nonceOf(run().headers.get('content-security-policy'));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').length).toBeGreaterThanOrEqual(16);
  });

  // A policy that blocks the app's own API is worse than none: the browser code
  // falls back to this same origin when NEXT_PUBLIC_API_URL is not set.
  it('allows the API origin the browser code will use, set or defaulted', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    expect(directive(run().headers.get('content-security-policy'), 'connect-src')).toContain('https://api.example.com');

    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    const connect = directive(run().headers.get('content-security-policy'), 'connect-src');
    expect(connect).toContain('http://localhost:5000');
    expect(connect).toContain('ws://localhost:5000');
  });

  it('adds nothing for a relative API path, which the same origin already covers', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api');
    expect(directive(run().headers.get('content-security-policy'), 'connect-src')).not.toContain('localhost');
  });

  it('sends the nonce to the page in the request header Next reads, and the CSP to the browser', () => {
    const response = run();
    const csp = response.headers.get('content-security-policy');
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(csp));
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });
});

describe('next.config security headers', () => {
  it('sets HSTS, nosniff, referrer policy and framing protection on every route', async () => {
    const rules = await nextConfig.headers();
    const everything = rules.find((rule) => rule.source === '/(.*)');
    const headers = Object.fromEntries(everything.headers.map(({ key, value }) => [key.toLowerCase(), value]));

    expect(headers['strict-transport-security']).toMatch(/max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(headers['strict-transport-security'])[1])).toBeGreaterThanOrEqual(31536000);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toMatch(/camera=\(\)/);
  });

  it('does not announce the framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe('the theme script in the root layout', () => {
  it('carries the request nonce, so a strict CSP does not block it', async () => {
    vi.doMock('next/headers', () => ({ headers: async () => new Headers({ 'x-nonce': 'nonce-from-proxy' }) }));
    // next/font is a build-time transform; there is nothing to load it from here.
    vi.doMock('next/font/local', () => ({ default: () => ({ variable: 'font' }) }));
    vi.doMock('@/components/portal/PortalLayout', () => ({ default: ({ children }) => children }));
    const { default: RootLayout } = await import('../app/layout.jsx');

    const tree = await RootLayout({ children: null });

    const find = (node, predicate) => {
      if (!node || typeof node !== 'object') return null;
      if (predicate(node)) return node;
      const children = node.props?.children;
      for (const child of [].concat(children ?? [])) {
        const hit = find(child, predicate);
        if (hit) return hit;
      }
      return null;
    };
    const script = find(tree, (node) => node.props?.id === 'theme-script');

    expect(script).toBeTruthy();
    expect(script.props.nonce).toBe('nonce-from-proxy');
  });
});
