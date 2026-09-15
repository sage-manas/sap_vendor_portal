<!-- title: CHORE: dead Mongoose model and Mongo dependencies remain, and a debug script that dumps tenant data is committed -->
<!-- labels: chore,severity:low,tech-debt,backend -->

**Severity:** Low individually, but this is Phase 0 of the engineering plan, which is listed
as a prerequisite for everything after it and was never completed.

## Summary

The Postgres migration is otherwise complete, but its cleanup step was skipped:

- `backend/models/PurchaseOrder.js` still exists and still `require`s mongoose.
- `mongoose` and `mongodb-memory-server` remain in `backend/package.json` dependencies.
- `backend/probe.tmp.js` is committed: a debug script that dumps every client and vendor —
  emails, SAP codes, company names — to stdout.
- `backend/.gitignore` covers only `/node_modules`, `.env`, `/logs`, `/uploads`, so a
  `*.tmp.js` is committed by default.
- `backend/.env.bak-before-clerk-removal` is present in the working tree.

`docs/04-sap-runtime-engineering-plan.md` Appendix C lists Phase 0 as
"`backend/models/` (delete), `backend/package.json`, `PROJECT_CONTEXT.md`".

## Evidence

`backend/package.json:37` and `:50`:
```json
"mongoose": "^9.6.3",
"mongodb-memory-server": "^11.2.0",
```

`backend/models/PurchaseOrder.js` — the only remaining file under `models/`.

`backend/probe.tmp.js` — `prisma.client.findMany()` / `prisma.vendor.findMany()` to stdout.

## Suggested fix

- Delete `backend/models/`, `backend/probe.tmp.js`, `backend/.env.bak-before-clerk-removal`.
- Remove both Mongo packages and reinstall to prune the lockfile.
- Add `*.tmp.js`, `*.bak*` and `.env.*` to `backend/.gitignore`.
- Confirm the full suite passes with mongoose absent — if anything still imports it, that is
  a finding in its own right.

## Acceptance criteria

- [ ] No mongoose import anywhere outside git history.
- [ ] Neither Mongo package appears in `package-lock.json`.
- [ ] No `*.tmp.js` in the tree, and the pattern is ignored.
- [ ] Backend suite green.
