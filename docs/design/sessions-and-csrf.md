# Sessions: cookie-borne short-lived tokens, rotating refresh, CSRF (findings 1.1 + 1.2)

**Status: proposal. Nothing here is implemented. Waiting for the decisions in §9.**

## 1. The problem, as the code has it today

- `signToken` (`backend/utils/authToken.js`) mints a **30-day** JWT (`JWT_EXPIRES_IN`, default `30d`). `verifyToken` does not pin the algorithm (the library accepts HS256/384/512 for a string secret); the secret falls back to the literal `'secret'` outside production, and only production boot insists on `JWT_SECRET`.
- The browser keeps it in `localStorage` (`jwt_token` for supplier and tenant staff, `vc_platform_token` for operators) and sends it as `Authorization: Bearer`. Any script that runs on the page — an XSS, a compromised dependency — can read it and use it for up to 30 days, from anywhere.
- There is no session record and no logout on the server. "Sign out" deletes the browser's copy; a stolen copy stays valid. The only server-side kill switches are indirect and already good: `resolveAccountFromToken` (`middleware/auth.js`) reloads the account on every request and refuses on role change, password change (`iat < passwordChangedAt`), or a non-active account, and the socket handshake and its recheck interval go through the same function.
- Socket.io authenticates with `auth: { token }` in the handshake (`src/lib/socket.js`, `backend/sockets/socketAuth.js`).
- The browser also keeps business data in `localStorage`: `sap_vendor_profile_data` (**holds PAN and bank details**), `clerk_user_id`, and nine `sap_vendor_portal_*` list caches (POs, RFQs, invoices, payments, GRNs, ASNs, logs, performance, and a leftover `chats` key). `jwt_token` is referenced in 32 places (set, read, removed), most of them as the "am I signed in" test. Several hooks fall back to these caches when the API call fails.
- Topology (`deploy/nginx.conf`): web and API are served from **one host**; nginx sends `/api/` and `/socket.io/` to Express and everything else to Next. Per-client subdomains (#191) make each tenant its own host. In development they are `localhost:3000` and `localhost:5000`, which are the same *site* (cookies ignore ports).

## 2. Goals and non-goals

Goals: a stolen page script cannot exfiltrate a usable credential; a session can be ended from the server (password change, suspension, "sign out everywhere", operator MFA reset); a cross-site page cannot make the browser perform an action; no business data at rest in browser storage; one sign-out path.

Non-goals: SSO/OIDC, changing the permission model, buyer-facing flows, per-device session management UI (offered in §9, not assumed).

## 3. Design

### 3.1 Two cookies per plane

(Names are shown without their plane prefix; see the last bullet below.)

| Cookie | Content | Lifetime | Flags |
|---|---|---|---|
| `vc_at` | the existing JWT shape plus `sid`, signed `HS256` (algorithm pinned) | **15 min** | `HttpOnly; Secure; SameSite=Strict; Path=/` |
| `vc_rt` | 32 random bytes, opaque | idle 7 d / absolute 30 d (operators: idle 30 min / absolute 12 h) | `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` (operators: `/api/platform/auth`) |
| `vc_csrf` | CSRF token, see 3.4 | session | `Secure; SameSite=Strict; Path=/` — **not** HttpOnly, the page must read it |

- **No `Domain` attribute**: cookies are host-only, so each tenant subdomain has its own session and a cookie set at `acme.<base>` is never sent to `globex.<base>`.
- Production uses the `__Host-` prefix on `vc_at` and `vc_csrf` (browser-enforced: Secure, Path=/, no Domain). `vc_rt` uses `__Secure-` because it needs a path. In development (plain http) the prefixes and `Secure` are dropped; `Secure` follows `req.secure` behind the trusted proxy.
- Tenant/supplier and operator planes get **separate** cookie sets (`vc_t_*`, `vc_p_*`): a browser can legitimately hold both, and the platform session has the MFA claim and shorter limits.

### 3.2 Session table

New table `sessions`: `id` (uuid, goes in the JWT as `sid`), `accountType`, `accountPk`, `clientId` (null for operators), `refreshHash` (SHA-256 of the current refresh token), `familyId`, `createdAt`, `lastUsedAt`, `idleExpiresAt`, `absoluteExpiresAt`, `revokedAt`, `revokedReason`, `mfaVerifiedAt` (operators), `userAgent`, `ipPrefix` (truncated /24 or /48, see §9 question 6).

- **Refresh rotates.** `POST /api/auth/refresh` swaps the refresh token for a new one and mints a new access token. The superseded hash is kept for its family.
- **Reuse detection.** Presenting a refresh token that was already rotated means someone has a copy: the **whole family is revoked** and the caller gets 401.
- **Every request checks the session.** `protect`/`protectPlatform` already do one account lookup; they add one primary-key lookup of the session (`sid`, not revoked, not expired). That is what makes revocation immediate instead of "within 15 minutes". A 5-second in-process cache is available if the extra query shows up in the load test (Sprint 4).
- **Revocation events**, each a single `revokeSessions(account, { except, reason })` call: password change (all other sessions, and the caller is issued a fresh one — replacing today's "mint a new token so I don't log myself out"); password reset (all); account suspension/rejection (all); tenant suspension (every session in the tenant); role change; operator MFA reset (all of that operator's); `POST /api/auth/logout-all`.
- `passwordChangedAt` stays as a belt-and-braces check, and `mustChangePassword` (#0.7) is unchanged.

### 3.3 Endpoints

| | |
|---|---|
| `POST /api/auth/login` | sets the three cookies; the body carries the principal summary (as `GET /auth/me`) and **no token** |
| `POST /api/auth/refresh` | rotates; 401 + clears cookies on failure or reuse |
| `POST /api/auth/logout` | revokes this session, clears cookies |
| `POST /api/auth/logout-all` | revokes every session of the caller |
| `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` | only if §9 question 7 says yes |
| `/api/platform/auth/*` | the same set; MFA verification re-mints the access token with `mfa: true` and records `mfaVerifiedAt` on the session |

`refresh` and `login` get their own per-IP limiter on top of the per-account guards from #189.

### 3.4 CSRF

`SameSite=Strict` is the main defence and covers every current browser. It is not relied on alone:

1. **Origin check.** For `POST/PUT/PATCH/DELETE` authenticated by cookie, the `Origin` header (falling back to `Referer`) must be in `config/corsOrigins.js`'s allow-list, else 403.
2. **Double-submit token.** `vc_csrf` is a random value stored (hashed) on the session; the page copies it into `X-CSRF-Token`; the server compares in constant time. A mismatch or absence is 403 with reason `csrf`.
3. The design relies on no `GET` changing state. That is believed true today (the export/report GETs only read) but is not yet proven; the route-table test in §5 will pin it.

Bearer-authenticated requests carry no ambient credential and are exempt (see §9 question 1).

### 3.5 Socket.io

- The browser connects with `withCredentials: true`; the server reads `vc_t_at` from the handshake `cookie` header. The `auth.token` path stays only for bearer mode.
- **Origin check at the handshake** (`allowRequest`): the browser does not enforce CORS on a WebSocket handshake, so a page on another site could otherwise open one carrying the user's cookies. Rather than rely on `SameSite` behaving identically for every browser's upgrade requests, the server checks `Origin` against the same allow-list.
- The existing periodic recheck (`sockets/socketAuth.js`) validates the session as well as the account, so logout, revocation and expiry disconnect the socket within one interval. The client treats `connect_error`/`disconnect` for auth as "try refresh once, then reconnect, else `clearSession()`".

### 3.6 Frontend

- `src/lib/api-client.js` and `platform-client.js` send `credentials: 'include'` and `X-CSRF-Token`; on a 401 they run **one** single-flight `POST /auth/refresh` and retry the request once; if that fails they call `clearSession()`.
- **"Signed in" comes from the server**, via `GET /auth/me` (already what `PortalProvider` does), not from the presence of a stored token. The 32 `jwt_token` references go away.
- **`clearSession()`** is the single sign-out path: `POST /auth/logout`, disconnect the socket, reset provider state, remove any legacy storage keys, navigate to sign-in. Every sign-out button, the 401 handler and the forced-expiry path call it; a test greps that nothing else removes session state.
- **Business data leaves `localStorage`.** `sap_vendor_profile_data`, `clerk_user_id` and all `sap_vendor_portal_*` caches are deleted; state lives in React memory and is refetched. On load, the app removes those legacy keys once. Only `vc-theme` remains. Consequence: the hooks' "fall back to the cache when the API is down" paths are removed; an outage shows an error state instead of stale data (§9 question 4).

### 3.7 Cutover

The old 30-day JWTs stop working when this ships; every user signs in once. Because the web UI no longer holds a token, there is nothing to migrate. The migration is additive (one new table). Deploy order: backend (accepts cookie and bearer) → frontend. `JWT_SECRET` must be ≥ 32 characters and the algorithm is pinned to `HS256` in the same change (this is finding 1.11, which this work makes cheap to include).

## 4. What this does and does not defend against

Defends: token theft by script (XSS cannot read `HttpOnly` cookies); a leaked token living 30 days (now 15 minutes, and revocable); cross-site request forgery; cross-site WebSocket hijacking; a refresh-token copy (reuse detection); a stale browser holding PAN/bank data after sign-out.

Does **not** defend: an XSS can still *act as* the user while the page is open (it can call the API with the cookie attached). That is why finding 0.6 (CSP with nonces) is the other half of this; the two should be read together. It also does not defend a compromised user machine.

## 5. Testing plan (failing test first, as always)

Backend: cookie flags per environment and per plane; login returns no token in the body; refresh rotates and the old token is refused; **reuse revokes the family**; each revocation event ends the next request (password change, reset, user/vendor/tenant suspension, MFA reset, `logout-all`); `protect` refuses a revoked/expired `sid`; CSRF refuses missing, wrong and cross-origin writes and accepts the right one; the route table asserts every non-GET route is behind the CSRF check and that no GET route writes; socket handshake accepts the cookie, refuses a foreign `Origin`, and disconnects on revocation.

Frontend (Vitest, fetch seam): requests carry credentials and the CSRF header; 401 → one refresh → retry; refresh failure → `clearSession()`; **no business data written to `localStorage`** (a test fails if any key outside `vc-theme` is set during a full signed-in render of the main screens); `clearSession()` is the only code path that ends a session. The browser suite (e2e) needs its sign-in helper updated; it will run in CI, not locally.

## 6. Proposed split (the whole thing is too large for one reviewable PR)

1. **Backend sessions.** `sessions` table + migration, cookie auth alongside bearer, refresh/logout/logout-all, revocation events, session check in `protect`, algorithm pinned, secret length enforced.
2. **CSRF** (Origin check + double-submit) and the route-table test.
3. **Sockets** on cookie auth with the Origin check.
4. **Frontend**: clients, `clearSession()`, signed-in-from-server, cache removal, e2e helper.
5. **Cleanup**: bearer mode behind its flag (or removed), docs, runbook entry for revoking sessions in an incident.

PRs 1–3 are backend-only and independently reviewable; 4 is where users see change.

## 7. Risks

- One extra indexed lookup per request. Measured in the Sprint 4 load test; cacheable for seconds if needed.
- Cookie auth across environments is where this usually breaks: cross-port dev, the Playwright run (`127.0.0.1` ports 3100/5100), and any deployment where web and API end up on different registrable domains. Today's nginx config keeps them on one host; a split-domain deployment would need `SameSite=None` and is **not supported** by this design.
- Removing the cache fallbacks makes API outages more visible.
- Any script or runbook that logs in and uses the returned token (`tokenFor` in e2e, ad-hoc `curl`) needs bearer mode (§9 question 1).

## 8. Not in this change

Active-sessions screen (unless §9 q7 is yes), device naming, geo/IP anomaly alerts, "remember me", and SSO.

## 9. Decisions needed from you

1. **Bearer mode.** Keep `Authorization: Bearer` accepted for non-browser callers (tests, e2e helpers, scripts), obtained by sending `X-Auth-Mode: bearer` to login, with the same 15-minute token and a body-borne refresh? *Recommended: yes.* The alternative is removing it, which means rewriting the ~980 backend tests' auth helper and the e2e helper to carry cookies.
2. **Lifetimes.** Access 15 min; supplier/staff refresh idle 7 d / absolute 30 d; operators idle 30 min / absolute 12 h. OK, or different numbers?
3. **Hard cutover.** Everyone signs in again once at deploy. OK?
4. **No offline fallback.** Removing the localStorage caches removes "show last-known data when the API is unreachable". OK?
5. **Platform operators** as a separate cookie set with their own limits (3.1) — OK?
6. **Session metadata.** Store a truncated IP prefix and the user-agent on each session (useful in an incident, personal data under privacy law)? *Recommended: store the user-agent and a truncated prefix, 90-day retention.*
7. **Active-sessions screen** ("sign out other devices") in scope for this work, or only the `logout-all` endpoint?
