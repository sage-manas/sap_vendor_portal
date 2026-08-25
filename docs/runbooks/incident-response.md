# Incident response

## 1. Confirm the scope

`GET /api/status` (browser: same URL, or append no `Accept` header for JSON)
answers three questions with no login required:

- Is the database reachable at all (`database: "connected"`)?
- How many tenants are currently operational?
- What does aggregate SAP traffic look like in the last hour (`sap.calls`,
  `sap.failures`, `sap.errorRate`)?

A `503` with `status: "outage"` means the database connection is down — that
is almost certainly the whole platform, not one tenant. Anything else and the
incident is scoped to fewer tenants; go to §2.

## 2. Find which tenant(s)

Sign in to `/platform` (mandatory MFA) and open **Platform health**
(`GET /api/platform/health`, permission `platform:health:read`). Per tenant,
it shows:

- `sap.status` — `healthy` / `degraded` / `failing` / `unknown`, and whether
  the circuit breaker is open (`sap.connection.circuit`).
- `usage` — is a limit breached (`usage.<metric>.breached`)? A tenant hitting
  its plan limit on RFQs or suppliers is not an incident, but it produces the
  same symptom ("things stopped working") from that tenant's side.

## 3. Check the logs

Every request log line and every error carries `requestId` and, once the
tenant is known, `clientId` (see `middleware/requestLogger.js`,
`middleware/errorHandler.js`). `backend/logs/error-*.log` and
`combined-*.log` (winston-daily-rotate-file, 14-day retention) can be
filtered on either. A 500 always logs at `error` with the stack; 4xx logs at
`warn`.

## 4. Common causes and their fix

| Symptom | Likely cause | Fix |
|---|---|---|
| One tenant's `sap.status: failing`, circuit `open` | SAP driver misconfigured or a downstream failure spike | `/platform` → tenant → SAP → **Test connection**; if it fails, check `SapConnection` credentials (they're never returned — re-enter and re-test) |
| `429` responses from one tenant's own users | `tenantLimiter` (per-tenant rate limit, `middleware/rateLimiter.js`) — expected under a load spike or a runaway integration, not a bug | Raise `TENANT_RATE_LIMIT_MAX` if legitimate, or find the runaway caller |
| `402` on vendor/RFQ creation | Plan limit reached (`utils/usage.js` `assertCanCreate`) | Confirm with the tenant, raise `Client.limits` via `PUT /api/platform/tenants/:clientId` if warranted |
| Mass `401 session is stale` | A role was changed or an account suspended (ADR-0013 — token role is re-checked every request) | Expected behaviour; tell the affected user to sign in again |
| Database unreachable | Network/Atlas issue, or `MONGO_URI` misconfigured | Check the deployment's connectivity to the configured `MONGO_URI` first, application code second |

## 5. After

If tenant data was at risk, follow [backup-restore.md](backup-restore.md) to
confirm the last backup is restorable before doing anything destructive.
Record what happened — this codebase has no incident log yet; a plain dated
entry in whatever tracker the team uses is enough. There is no "post-mortem"
tooling here, on purpose: `AuditLog` and the winston logs are the record.
