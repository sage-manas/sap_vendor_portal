<!-- title: BUG: production boot requires three dead Clerk variables, and SERVER_SETUP_QUICK_READ.md names a database variable that no longer exists -->
<!-- labels: bug,severity:high,area:deployment,documentation -->

## Severity

**High** — following the official handover document produces a server that
exits before it listens. Twice over.

## Summary

Two independent contradictions between `config/validateEnv.js` and
`SERVER_SETUP_QUICK_READ.md`, the document handed to whoever hosts this.

### 1. Dead Clerk variables hard-crash production

`backend/config/validateEnv.js:43`

```js
const clerkKeys = ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SIGNING_SECRET'];
...
if (missingClerk.length > 0) {
  if (process.env.NODE_ENV === 'production') {
    const prodErrorMsg = `Server crash in Production: Missing Clerk credentials: ${missingClerk.join(', ')}`;
    process.exit(1);
  }
}
```

Clerk was abandoned for local JWT. `PROJECT_CONTEXT.md` §4 states plainly:
*"**Deprecated/unused** — Clerk was the original auth plan; replaced by local
JWT."* The application crashes in production over three variables that
nothing reads.

`SERVER_SETUP_QUICK_READ.md` does not mention them, so an operator following
it has no way to know.

### 2. The documented database variable is wrong

`validateEnv.js:4` requires `DATABASE_URL` (Postgres/Prisma).
`SERVER_SETUP_QUICK_READ.md` "Required Backend Environment" lists
`MONGO_URI=<mongodb connection string>`, a leftover from before the Postgres
migration.

### 3. `MASTER_KEY` is validated too late

`validateEnv` does not check it. The production guard lives in
`utils/secretBox.js:29` and only fires when something first touches an
encrypted secret — so the server starts healthy and fails later, on an
operator action, rather than at boot.

## Steps to reproduce

1. On a clean host, create `backend/.env` containing **exactly** the variables
   listed under "Required Backend Environment" in `SERVER_SETUP_QUICK_READ.md`:

   ```
   PORT=5000
   MONGO_URI=<...>
   FRONTEND_URL=https://example.com
   ALLOWED_ORIGINS=https://example.com
   NODE_ENV=production
   JWT_SECRET=<...>
   MASTER_KEY=<...>
   MAIL_TRANSPORT=smtp
   SMTP_HOST=... SMTP_PORT=... SMTP_USER=... SMTP_PASSWORD=... MAIL_FROM=...
   SAP_MOCK_MODE=true
   ```

2. `cd backend && npm start`

### Expected

Server connects to the database and listens on :5000.

### Actual

```
Server crash: Missing strictly required env variables: DATABASE_URL
```

Add `DATABASE_URL` and retry:

```
Server crash in Production: Missing Clerk credentials: CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_WEBHOOK_SIGNING_SECRET
```

## Suggested fix

- Delete the entire `clerkKeys` block from `validateEnv.js`.
- Add `MASTER_KEY` to the production-required checks so it fails at boot
  alongside `JWT_SECRET`, matching what `secretBox.js` already enforces later.
- Consider failing loudly on a **present** `CLERK_*` or `MONGO_URI`, the way
  `ADMIN_BOOTSTRAP_EMAILS` already does — a stale variable an operator
  believes is doing something is worse than a missing one.
- Regenerate `SERVER_SETUP_QUICK_READ.md`: `DATABASE_URL` not `MONGO_URI`,
  and add a Postgres section replacing the MongoDB one.
- Update `deploy/setup-server.sh`, which still installs MongoDB 7.x.
- Update `backend/.env.example` if it still carries the `CLERK_*` block.

## Acceptance criteria

- [ ] A `.env` containing only the variables documented in
      `SERVER_SETUP_QUICK_READ.md` boots successfully with `NODE_ENV=production`.
- [ ] Smoke test in CI that boots the app with exactly the documented set.
- [ ] `MASTER_KEY` missing in production fails at boot, not on first use.
- [ ] No `CLERK_*` reference remains in `validateEnv.js`, `.env.example`, or
      the deployment docs.
- [ ] `deploy/setup-server.sh` provisions PostgreSQL, not MongoDB.
