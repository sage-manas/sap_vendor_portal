# Documentation cleanup — 14 September 2026

Every markdown file in the repository was read and checked against the code before anything
was put on this list. Nothing here is deleted on a guess, and nothing is deleted for being
merely old — only for describing a system that no longer exists.

Run `bash audit-issues/docs-cleanup.sh` for a dry run, then `--delete` to stage the removals.
All of these are tracked files, so `git show HEAD~1:<path>` recovers any of them.

## Removed

### `workflow/` — the entire directory, 9 files, ~211 KB

The original planning corpus. Every file still carries its first-commit timestamp; none has
been touched since the project began.

| File | Why |
|---|---|
| `sprint_roadmap.md` (82 KB) | 143 references to Clerk, 36 to Mongo, 4 to `MONGO_URI` — all three are gone from the codebase |
| `architecture_document.md` (68 KB) | Describes a single-page `activeTab` router and "no authentication"; the app is a multi-route App Router with JWT auth and RBAC |
| `socket_io_architecture.md` | Socket auth built entirely around Clerk (8 references) |
| `SAP_Communication.md`, `working.md`, `task.md`, `README.md` | Mongo-era data flow |
| `frontend_transition.md`, `walkthrough.md` | Superseded by the migration they planned |

`PROJECT_CONTEXT.md` already flagged this directory as "partly stale" and singled out
`architecture_document.md` as still useful "for the SAP field-mapping catalog and P2P/BAPI
reference". That catalogue is no longer the best source: `backend/sap/contract.js`,
`backend/sap/mappings/fields.js` and `backend/sap/mappings/vendor-create.map.js` are
sandbox-verified and authoritative, and the old catalogue lists BAPIs the adapter never calls.
It is one `git show` away if anyone wants it.

### `PROJECT_ARCHITECTURE_FLOW.md` (43 KB)

Documents SAP adapter methods that `backend/sap/contract.js` explicitly removed and explains
at length why they cannot exist: `rfqCreate` (3 references), `invoiceCreate` (2),
`poProvision`/`deliveryCreate` (3). Anyone reading this document would believe the portal
writes purchase orders and invoices into SAP. It does not.

### `DESIGN.md` (root, 6 KB)

The "Kinetic Industrial Console" system — black canvas `#09090b`, electric-green accent
`#059669`, zero border-radius. `src/app/globals.css` implements "Cream & Coral" instead:
warm cream `#FAF9F5`, coral accent `#CC785C`, adapted from `claude/DESIGN.md`. The stylesheet
says so in its own header comment. The screenshots in the repository root
(`26-dashboard-cream-light.png` and after) confirm the change shipped.

`claude/DESIGN.md` is **kept** — `globals.css` cites it as the source of the current palette,
so it is a live reference despite the odd-looking filename.

### `docs/01-PRD.md` and `docs/02-TRD-architecture.md`

A v1.0 PRD and companion TRD for a product called **CustomerConnect**, dated 2026-07-25,
still marked "Status: For review". The TRD recommends **NestJS + TypeScript**, React 18 and
per-tenant subdomains. The application is Express 5, plain JavaScript, React 19. This pair
describes a system that was never built, under a name the product no longer uses.

## Kept, with reasons — because these look deletable and are not

| File | Why it stays |
|---|---|
| `PROJECT_CONTEXT.md` | Actively maintained and accurate. Its Clerk/Mongo references are explicit historical annotations ("Retired — the server refuses to boot if any is set"), which is the correct way to document a migration. Sections 11 and 12 were rewritten as part of this cleanup. |
| `DECISIONS.md` | An ADR log. An ADR referencing Mongoose is a record of a decision made at the time, not a stale claim about today. ADR-0001 (tenant isolation via a Mongoose plugin) should get a **superseding ADR** describing the Prisma Client Extension — add one rather than editing history. |
| `AGENTS.md` / `CLAUDE.md` | Current, and `AGENTS.md` carries the "when a test has to reach around the API, stop" rule that caught two real defects. One `workflow/` reference removed. |
| `SERVER_SETUP_QUICK_READ.md` | Already corrected — it now lists `CLERK_*` and `MONGO_URI` as *retired* variables. (This resolves the earlier `qa-issues/04-production-cannot-boot-from-docs.md`.) |
| `HOSTING_PROVIDER_HANDOFF.md` | Accurate against the code: Next.js 16, React 19, Express 5, Postgres via Prisma, PM2, Nginx. |
| `docs/03-verification-layer-design.md` | Marked "Status: proposal". It describes today's `verification.service.js` correctly and proposes a redesign that has **not** been built — verification is still mock-mode by default. Live work, not stale documentation. |
| `docs/04-sap-runtime-engineering-plan.md` | Phases 1–5 are implemented, but **Phase 0 is not** (`backend/models/` still exists with mongoose — see issue #27), and "Deferred A — On-premise connector agent" and "Deferred B — The ABAP asks" are both still open. Deleting this would delete outstanding work. |
| `docs/runbooks/*` (5 files) | Operational playbooks, all current. |
| `claude/DESIGN.md` | The source `globals.css` is built from. See above. |
| `product-info-vendor-portal.md` | Current marketing copy — but one of its claims is not supported by the implementation. Filed as issue #29 rather than deleted; that is a business decision, not a cleanup. |
| `README.md` | Should not be deleted — it should be **written**. It is still the create-next-app boilerplate. Filed as issue #28. |

## Reference updates already applied

These edits were made so the removals leave nothing dangling. They are in your working tree
now, unstaged:

| File | Change |
|---|---|
| `PROJECT_CONTEXT.md` | Removed `workflow/` and `PROJECT_ARCHITECTURE_FLOW.md` from the repo-tree map; repointed the design-system line at `claude/DESIGN.md`; **rewrote section 11** from "Kinetic Industrial Console" to "Cream & Coral" with `globals.css` named as the source of truth (including the warning that `--color-emerald-*` variable names must not be renamed, because `src/lib/branding.js` writes tenant brand colours into them per ADR-0030); **rewrote section 12** to drop `workflow/` and list what was removed and where to recover it; removed `workflow/` from the doc-precedence chain. |
| `AGENTS.md` | Dropped the "when it conflicts with older `workflow/` docs" clause. |
| `docs/04-sap-runtime-engineering-plan.md` | Typography convention now points at `src/app/globals.css` instead of the removed `DESIGN.md`. |

Stage them alongside the removals:

```bash
git add PROJECT_CONTEXT.md AGENTS.md docs/04-sap-runtime-engineering-plan.md
```

## Suggested commit

```
docs: remove superseded planning documents

Delete the workflow/ planning corpus, PROJECT_ARCHITECTURE_FLOW.md, the
Kinetic Industrial Console DESIGN.md, and the CustomerConnect PRD/TRD pair.
All describe a system that no longer exists: pre-auth, pre-Postgres,
pre-multi-route, a NestJS stack that was never built, and SAP adapter
methods the contract explicitly removed.

Update PROJECT_CONTEXT.md sections 11 and 12, AGENTS.md and the engineering
plan so no reference dangles. Section 11 now documents the Cream & Coral
system that src/app/globals.css actually implements.

Recoverable via git history.
```

## Not cleaned up here, because it is code rather than documentation

Tracked as issue #27, listed here so it is not forgotten alongside the docs pass:
`backend/models/PurchaseOrder.js` (dead Mongoose model), the `mongoose` and
`mongodb-memory-server` dependencies, `backend/probe.tmp.js` (a committed debug script that
dumps every client and vendor to stdout), and `backend/.env.bak-before-clerk-removal`.
