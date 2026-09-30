import { NextResponse } from 'next/server';
import { buildCsp } from '@/lib/security-headers';

// Runs before every page render: mints a nonce, puts the Content-Security-Policy
// on the response and hands the nonce to the page, where Next attaches it to its
// own scripts and layout.jsx to the theme script. Pages become dynamically
// rendered as a result (a static page has no request to take a nonce from) —
// that is the cost of a CSP without 'unsafe-inline' (see Next's guide,
// docs/01-app/02-guides/content-security-policy.md).

// The API's origin when it is not this site's own. This must resolve exactly as
// the browser code does (lib/api-client.js, lib/socket.js: NEXT_PUBLIC_API_URL,
// else this default), or the policy blocks the app's own API calls. It may also
// be a relative path ('/api'), in which case 'self' already covers it.
const DEFAULT_API_URL = 'http://localhost:5000/api';

const apiOrigin = () => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL).origin;
  } catch {
    return null;
  }
};

export function proxy(request) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const host = request.headers.get('host');

  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    apiOrigin: apiOrigin(),
    // Only a plausible host reaches a header value.
    host: host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? host : null,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not static assets, image optimisation or prefetches.
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
