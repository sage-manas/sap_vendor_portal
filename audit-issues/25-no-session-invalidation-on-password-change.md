<!-- title: SECURITY: changing a password does not invalidate existing tokens, and sockets never re-check account status -->
<!-- labels: security,severity:high,area:infra,backend -->

**Severity:** High — "change your password" does not end an attacker's access.

## Summary

Two instances of the same root cause: there is no token revocation mechanism beyond role-change
detection and natural expiry.

1. `resolveAccount` re-validates only that the token's role still matches the account's role.
   It never compares `account.passwordChangedAt` against the token's issue time, and the
   token carries no password or session version. Tokens default to a 30-day life.

2. The Socket.io handshake verifies the JWT signature and reads `clientId`/`role` from the
   claims, but never reloads the account — unlike the HTTP `protect` path, which reloads and
   calls `canAuthenticate`. A supplier suspended or demoted mid-session keeps a live socket,
   and its room membership, until the token expires.

`passwordChangedAt` is written by `hashPassword` and `consumeResetToken`
(`db/credentials.js:44-53`), so the data needed for the check already exists and is simply
never read.

## Evidence

`backend/middleware/auth.js:69-73` — the only re-validation performed.

`backend/utils/authToken.js:39-54` — no password or session version in the claims; 30-day
default expiry at `:53`.

`backend/server.js:54-74` — socket auth, signature check only.

Tokens live in `localStorage` (`src/lib/portal-context.js:71`), so an XSS or a shared device
yields a bearer token, and the victim's natural response — changing their password — does
nothing.

## Steps to reproduce

1. Sign in as a supplier and capture the token.
2. Change that supplier's password through the UI.
3. Replay the captured token against `GET /api/pos`. It still works.
4. Open a socket with the captured token, then suspend the account. The socket stays
   connected and keeps receiving that supplier's room events.

## Expected

- A password change invalidates every token issued before it.
- A suspended or demoted account's sockets are disconnected.

## Suggested fix

Add the check in `resolveAccount`:
```js
if (account.passwordChangedAt && claims.iat * 1000 < account.passwordChangedAt.getTime()) return null;
```
Reload the account in the socket handshake and run it through `canAuthenticate`, and
re-check on `join_*_room`. For immediate revocation of an active socket, emit a disconnect
on suspension from the same place that writes `suspendedAt`.

Consider shortening the default token life and adding refresh, but the `passwordChangedAt`
check is the high-value half and is a few lines.

## Acceptance criteria

- [ ] A token issued before a password change is rejected.
- [ ] A suspended account's socket is disconnected within one heartbeat.
- [ ] Tests for both.
