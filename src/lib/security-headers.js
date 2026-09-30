// The security headers the Next app sends with every page.
//
// The nonce-based Content-Security-Policy is built per request in src/proxy.js;
// the headers that do not vary per request are set in next.config.ts. Both come
// from here so there is one place that says what the pages may do.

// The registration form looks up IFSC and PIN codes straight from these two
// public services (features/profile/components/RegistrationView.jsx).
const LOOKUP_ORIGINS = ['https://ifsc.razorpay.com', 'https://api.postalpincode.in'];

const asWebsocketOrigin = (origin) => origin.replace(/^http/, 'ws');

/**
 * @param nonce      fresh per request
 * @param isDev      next dev needs unsafe-eval (React debugging) and inline styles
 * @param apiOrigin  origin of the API when it is not the page's own (NEXT_PUBLIC_API_URL)
 * @param host       the host the page was requested on, for the same-host socket
 */
export const buildCsp = ({ nonce, isDev = false, apiOrigin = null, host = null }) => {
  const connect = [
    "'self'",
    apiOrigin,
    apiOrigin && asWebsocketOrigin(apiOrigin),
    host && `wss://${host}`,
    isDev && host && `ws://${host}`,
    ...LOOKUP_ORIGINS,
  ].filter(Boolean);

  const directives = [
    "default-src 'self'",
    // Scripts run only if they carry the request's nonce (or were loaded by one
    // that did). No 'unsafe-inline'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // <style> elements need the nonce too. Inline style *attributes* (React's
    // style props render as attributes in server HTML) cannot carry one, so they
    // are allowed separately; they cannot run script.
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    // https: because a workspace's own logo is an admin-supplied URL.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  return directives.join('; ');
};

// Same for every response. HSTS is ignored by browsers over plain http, so it is
// safe to send from `next start` behind or without TLS.
export const STATIC_SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // frame-ancestors in the CSP is the modern control; this covers older browsers.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];
