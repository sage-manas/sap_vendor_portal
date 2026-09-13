<!-- title: SECURITY: CORS and Socket.io accept any localhost origin in production, with credentials enabled -->
<!-- labels: security,severity:medium,area:infra,backend -->

## Severity

**Medium** — a dev convenience shipped to production. Impact is limited by
token storage, but the rule is wrong and should not be relied on.

## Summary

Both the Express CORS handler and the Socket.io CORS handler accept **any**
origin beginning `http://localhost:`, `http://127.0.0.1:` or `http://[::1]:`,
unconditionally, alongside `credentials: true` and a permissive `!origin`.

## Evidence

`backend/server.js` — the same block appears twice, once for Socket.io and
once for Express:

```js
const isLocalhost = origin && (
  origin.startsWith('http://localhost:') ||
  origin.startsWith('http://127.0.0.1:') ||
  origin.startsWith('http://[::1]:')
);
if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/') || isLocalhost) {
  callback(null, true);
}
```

`allowedOrigins` additionally hardcodes eight localhost entries
(`:3000`, `:3001`, `:3002`, `:5173`) with no environment gate.

The helmet CSP has the same issue:

```js
connectSrc: ["'self'", 'http://localhost:3000', 'http://127.0.0.1:3000', process.env.FRONTEND_URL]
```

## Impact

Sessions live in `localStorage` rather than cookies, so this is not a
classic credentialed-CORS session-theft path. What it does mean:

- Any page served from a local dev server on the victim's machine can make
  credentialed cross-origin calls to production.
- `credentials: true` combined with a wildcard-ish origin predicate is a
  pattern that will be flagged in any security review, and it will become
  genuinely exploitable the moment auth moves to cookies.
- The `!origin` branch admits requests with no `Origin` header at all.

## Steps to reproduce

1. Deploy with `NODE_ENV=production` and `FRONTEND_URL=https://portal.example.com`.
2. Serve any page from `http://localhost:8080` and run:

   ```js
   fetch('https://api.example.com/api/health', { credentials: 'include' })
     .then(r => r.text()).then(console.log);
   ```

- Expected: blocked by CORS.
- Actual: succeeds; response headers carry
  `Access-Control-Allow-Origin: http://localhost:8080` and
  `Access-Control-Allow-Credentials: true`.

## Suggested fix

Gate the entire localhost allowance on environment, and build the origin list
in one place shared by both handlers:

```js
const DEV_ORIGINS = process.env.NODE_ENV === 'production' ? [] : [
  'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://localhost:3001', 'http://127.0.0.1:3001',
  'http://localhost:3002', 'http://127.0.0.1:3002',
  'http://localhost:5173', 'http://127.0.0.1:5173',
];

const allowLocalhost = process.env.NODE_ENV !== 'production';

const isAllowedOrigin = (origin) => {
  if (!origin) return process.env.NODE_ENV !== 'production';
  if (allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/')) return true;
  return allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin);
};
```

Apply the same treatment to `connectSrc` in the helmet CSP.

Deduplicate: the identical predicate is currently written twice and will
drift.

## Acceptance criteria

- [ ] One shared origin predicate used by both Express CORS and Socket.io CORS.
- [ ] With `NODE_ENV=production`, a `http://localhost:8080` origin is rejected.
- [ ] With `NODE_ENV=development`, localhost origins still work on any port.
- [ ] CSP `connectSrc` contains no localhost entry in production.
- [ ] Tests covering both environments.
