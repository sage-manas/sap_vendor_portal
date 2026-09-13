<!-- title: CHORE: always-true branch in the tenant extension, committed debug script, and stale comments/docs -->
<!-- labels: chore,severity:low,tech-debt -->

## Severity

**Low** individually. Grouped because they are all one-line fixes, and the
first one sits in the most security-sensitive file in the repo.

---

### 1. Always-true branch in the tenant extension

`backend/db/tenantExtension.js:172`

```js
} else if (operation !== 'upsert' || true) {
```

`|| true` makes the condition unconditionally true — this is a plain `else`.
Leftover from a refactor. Behaviour is correct today, but it reads as
uncertainty in the file that enforces tenant isolation, and any linter with
`no-constant-binary-expression` will flag it.

**Fix:** make it `} else {`, or restore the intended condition if one was
meant. Add a comment either way, since the branch handles four operations
with different safety characteristics.

---

### 2. Committed debug script that dumps customer data

`backend/probe.tmp.js` is checked in and prints every client and vendor —
emails, SAP vendor codes, company names — to stdout.

```js
const vendors = await prisma.vendor.findMany();
console.log('vendors', vendors.map(v => ({ clientId: v.clientId, vendorId: v.vendorId, email: v.email, ... })));
```

**Fix:** delete it. Same treatment for the other ad-hoc scripts in
`backend/`: `check_all_data.js`, `seed_payments.js`, `test_endpoints.js`,
`test_remaining_endpoints.js`, `test_week2_endpoints.js`, and root
`test_sockets.js`. Add `*.tmp.js` to `.gitignore`.

Keep `scripts/` — those are real tooling.

---

### 3. `express-mongo-sanitize` comment is now misleading

`backend/server.js:139`

```js
// Prevent NoSQL query injection
app.use(mongoSanitize());
```

The database is PostgreSQL. The middleware still does useful generic work
(stripping `$`- and `.`-prefixed keys from request bodies) so **keep it** —
but the comment will convince the next reader there is injection protection
where the actual raw-SQL surface is elsewhere. (`jobs/queue.js`'s
`$queryRaw` is correctly parameterised — worth noting in the new comment.)

**Fix:** retitle to something like
`// Strip $-prefixed and dotted keys from request bodies (generic; not NoSQL-specific)`.
Same for the Express 5 `req.query` redefinition shim above it.

---

### 4. Deprecated `req.connection`

`backend/middleware/requestLogger.js:24` and `:45` use `req.connection`,
deprecated since Node 13. Use `req.socket`. (See the `trust proxy` issue —
these two lines are being touched anyway.)

---

### 5. `PROJECT_CONTEXT.md` documents the wrong database

§2, §6 and §13 describe MongoDB/Mongoose throughout; the backend runs
PostgreSQL via Prisma (`config/db.js`, `db/prisma.js`,
`prisma/schema.prisma`). §10 describes `mongodb-memory-server` for tests;
`tests/setup.js` uses a real Postgres instance.

This file is the onboarding contract for every developer and agent session.
Stale, it compounds.

**Fix:** update §2 (tech stack), §6 (schemas), §10 (testing) and §13
(conventions); refresh the "Last synced with code" date. Remove the "known
product quirk" note in §10 once the first-bid issue is fixed.

---

### 6. Dead Mongoose dependencies

`mongoose` and `mongodb-memory-server` remain in `backend/package.json` and
`backend/models/` still exists, though nothing outside it imports either.
Confirm with:

```bash
cd backend
grep -rn "require('mongoose')" --include=*.js . | grep -v node_modules
grep -rln "require.*['\"].*models/" --include=*.js controllers services utils middleware routes config db sap scripts tests
```

Both should be empty. If so, delete `backend/models/` and drop both deps.
**Keep `express-mongo-sanitize`** (see item 3).

## Acceptance criteria

- [ ] No `|| true` in `tenantExtension.js`; tenant-isolation suite still green.
- [ ] `probe.tmp.js` and the ad-hoc `test_*.js` / `check_all_data.js` /
      `seed_payments.js` scripts removed; `*.tmp.js` gitignored.
- [ ] `mongoSanitize` comment describes what it actually does.
- [ ] `req.connection` → `req.socket`.
- [ ] `PROJECT_CONTEXT.md` describes PostgreSQL/Prisma and real-Postgres tests.
- [ ] `mongoose` / `mongodb-memory-server` removed; suite still green.
