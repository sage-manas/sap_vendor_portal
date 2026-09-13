<!-- title: BUG: Express `trust proxy` is never set — rate limiting, audit IPs and the internal loopback guard are all wrong in production -->
<!-- labels: bug,severity:high,security,area:infra,backend -->

## Severity

**High** — one root cause, four production defects. Invisible in dev and CI.

## Summary

`deploy/nginx.conf` terminates TLS and proxies to `127.0.0.1:5000`, setting
`X-Real-IP` and `X-Forwarded-For`. Express is never told to trust them:

```bash
$ grep -rn "trust proxy\|trustProxy" backend --include=*.js | grep -v node_modules
# (no output)
```

So in production `req.ip` is `::ffff:127.0.0.1` for **every request from every
client on earth**.

## Downstream defects

### 1. `apiLimiter` becomes a global throttle — most severe

`backend/middleware/rateLimiter.js:3` — `windowMs: 15 * 60 * 1000, max: 100`,
keyed on IP. With one effective IP, the whole deployment shares a single
bucket of **100 requests per 15 minutes**.

It is mounted only under `if (process.env.NODE_ENV === 'production')`
(`server.js`), which is exactly why dev and CI never see it. The first busy
morning in production presents as a total outage.

### 2. The audit trail's IP column is worthless

`backend/utils/audit.js:64`

```js
ip: req?.ip || req?.headers?.['x-forwarded-for'] || undefined,
```

`req.ip` is always truthy, so the `x-forwarded-for` fallback is **dead code**.
Every append-only `AuditLog` row records the proxy address. An audit trail
that cannot attribute an action to an origin will be raised in any DPDP or
SOC 2 assessment.

### 3. Structured request logs are equally unattributable

`backend/middleware/requestLogger.js:24` and `:45` —
`ip: req.ip || req.connection.remoteAddress`. Same problem.
(`req.connection` is also deprecated since Node 13; use `req.socket`.)

### 4. `restrictToLoopback` inverts

`backend/routes/internal.routes.js:19`

```js
const ip = req.ip || req.socket?.remoteAddress || '';
const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
```

Behind nginx, `req.ip` **is** loopback — so this gate passes for external
callers. Today `/internal` is unreachable only because nginx's catch-all
`location /` routes it to Next.js on :3000. That is safety by routing
accident: adding one `location /internal` block to nginx would expose the
Socket.io emit relay, leaving only the `x-internal-key` HMAC between an
attacker and cross-tenant realtime event injection.

Note this means **setting `trust proxy` tightens the guard rather than
loosening it.**

## Steps to reproduce

Requires a deployment behind the shipped nginx config (or any reverse proxy).

**Rate limiter:**

1. Deploy with `NODE_ENV=production`.
2. From machine X, issue 100 requests to any `/api/*` endpoint.
3. From machine Y (entirely different public IP), issue one request.

- Expected: machine Y is unaffected — it has its own bucket.
- Actual: machine Y receives `429 Too many requests from this IP`.

**Audit IP:**

1. From an external client, perform any audited action (e.g. approve a vendor).
2. `SELECT ip FROM audit_logs ORDER BY at DESC LIMIT 1;`

- Expected: the client's public IP.
- Actual: `::ffff:127.0.0.1`.

## Suggested fix

In `backend/server.js`, before any middleware:

```js
// Behind nginx (see deploy/nginx.conf) the socket peer is always the proxy.
// Without this, req.ip is 127.0.0.1 for every client: the per-IP rate
// limiter degrades to one global bucket, audit rows record the proxy rather
// than the actor, and restrictToLoopback in routes/internal.routes.js passes
// for proxied external callers.
app.set('trust proxy', process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : 'loopback');
```

Use `'loopback'` (or a hop count), **never `true`** — trusting all proxies
lets a client spoof `X-Forwarded-For` and defeat the rate limiter from the
other direction.

Then simplify `audit.js` to just `req?.ip`, since the fallback was never
reachable.

## Acceptance criteria

- [ ] `app.set('trust proxy', ...)` set, with a hop count or `'loopback'`, not `true`.
- [ ] Test: a request carrying `X-Forwarded-For: 203.0.113.9` yields
      `req.ip === '203.0.113.9'`.
- [ ] Test: `restrictToLoopback` rejects a request whose `X-Forwarded-For`
      names a non-loopback address.
- [ ] Test: an audited action records the forwarded client IP.
- [ ] `req.connection` replaced with `req.socket` in `requestLogger.js`.
- [ ] Manual: two clients on different IPs have independent rate-limit budgets.
