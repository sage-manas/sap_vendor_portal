# PROJECT CONTEXT — VendorConnect / SAP Vendor Portal

> **Purpose of this file.** A single, self-contained reference that gives any developer or AI agent the *complete* mental model of this project — architecture, data model, every module, every API endpoint, the SAP-simulation design, conventions, and known gotchas — **without needing the codebase open**. Read this top to bottom and you can navigate, extend, or debug the system.
>
> **Last synced with code:** 2026-09-08 (Postgres/Prisma migration confirmed complete — Mongoose corpse removed, see §0/§6). If code and this file disagree, the code wins — but please update this file.
>
> ⚠️ **This app is now multi-tenant** (SaaS Phase 1 complete). Every tenant-scoped query
> runs inside a bound tenant context or it *throws*. Read §5.5 before writing any backend
> code; the SaaS plan lives in `SAAS_IMPLEMENTATION_PLAN.md` and the decisions in
> `DECISIONS.md`. Operational concerns — plan limits, billing, rate limits, structured
> logging, backups — are §5.7.

---

## 0. TL;DR

**VendorConnect Portal** is a full-stack, SAP-integrated **supplier self-service platform** for Indian manufacturing procurement. It digitizes the entire **Procure-to-Pay (P2P)** lifecycle — vendor onboarding → RFQ/bidding → PO → dispatch (ASN) → goods receipt (GRN) → invoice (MIRO) → payment (F110) — and surfaces every step as **simulated SAP BAPI/RFC/OData/IDoc payloads** in a live console.

- **Frontend:** Next.js 16 (App Router) + React 19 + Tailwind CSS v4, one client-side SPA shell. `src/`
- **Backend:** Express 5 REST API + Socket.io + PostgreSQL (Prisma). `backend/`
- **Auth:** JWT (bcrypt password hashing), **six roles across three planes** — `super_admin`/`sap_manager` (platform) · `client_admin`/`buyer`/`finance` (tenant) · `vendor` (supplier) — **tenant-scoped**: the token carries `clientId` + `roleScope`. There is no `admin` role any more.
- **Three front ends, one app:** the supplier portal (`/`), the platform console (`/platform`, §8.8) and the tenant back office (`/workspace`, §8.9). Each has its own layout, session and permission-filtered nav registry; they share the design system.
- **Multi-tenant:** every business document belongs to a `Client` tenant; isolation is enforced by a Prisma Client extension, not by convention (§5.5).
- **SAP is simulated** — no real RFC connection. "SAP sync" = writing `SapLog` records + `setTimeout`-driven fake GRN/payment runs. This is intentional and clearly boundaried in code.
- **Two separate npm packages** with two separate test suites: root (frontend, Vitest) and `backend/` (Jest + Supertest, against a real Postgres instance — `tests/setup.js` resets it between tests, see §10).

> ⚠️ **AGENTS.md warning (repo-wide):** This is a *modified* Next.js 16 — APIs/conventions may differ from training data. Before writing Next.js code, read the relevant guide under `node_modules/next/dist/docs/`.

---

## 1. Repository Layout (top level)

```
sap_vendor_portal/
├── src/                     ← Next.js frontend (App Router SPA)
├── backend/                 ← Express + Prisma/Postgres API server (own package.json)
├── public/                  ← static assets
├── deploy/                  ← ecosystem.config.js (PM2) and deploy tooling
├── docs/                    ← runbooks (docs/runbooks/) and forward-looking engineering plans
├── workflow/                ← long-form design/architecture/roadmap docs (see §12)
├── docker-compose.yml       ← local Postgres service matching DATABASE_URL
├── .github/workflows/test.yml ← CI: runs BOTH frontend + backend test suites
├── AGENTS.md / CLAUDE.md    ← agent instructions (CLAUDE.md just @-includes AGENTS.md)
├── DECISIONS.md             ← the ADR log — every numbered decision cited elsewhere in this file
├── DESIGN.md                ← "Kinetic Industrial Console" design system (tokens + rules)
├── HOSTING_PROVIDER_HANDOFF.md, SERVER_SETUP_QUICK_READ.md, PROJECT_ARCHITECTURE_FLOW.md ← deploy/ops reference
├── README.md                ← stock create-next-app readme (not project-specific)
├── package.json             ← FRONTEND package (Next, React, some backend deps duplicated)
├── next.config.ts           ← reactCompiler: true
├── components.json          ← shadcn/ui registry config
├── vitest.config.mjs        ← frontend test config (src/**/*.test.{js,jsx})
├── tsconfig.json, eslint.config.mjs, postcss.config.mjs
└── .cursor/ .gemini/ .impeccable/ ← "impeccable" design-linter tool skill (dev tooling, ignorable)
```

`backend/logs/` and `backend/uploads/` are committed artifacts (winston logs / an uploaded PDF) — **not** application source. The old `mongodb_data/` (a committed local MongoDB data dir) was removed once the Postgres migration was confirmed complete; nothing recreates it.

**Note on `package.json` duplication:** the root (frontend) package.json lists backend-ish deps (express, socket.io, bcryptjs, jsonwebtoken…) *and* frontend deps. The **actual backend** runs from `backend/package.json` (its own `node_modules`). When touching the API, use `backend/`.

---

## 2. Tech Stack

| Layer | Choice | Version | Notes |
|---|---|---|---|
| Frontend framework | Next.js (App Router) | 16.2.7 | `reactCompiler: true`; **modified** per AGENTS.md |
| UI runtime | React / React DOM | 19.2.4 | React Compiler auto-memoization |
| Styling | Tailwind CSS | v4 | `@tailwindcss/postcss`; tokens in `globals.css` |
| UI primitives | shadcn/ui + `@base-ui/react` | — | only `button.tsx` is a shadcn primitive; most UI is hand-rolled in `src/components/ui/` |
| Icons | lucide-react | ^1.17 | |
| Charts | recharts | ^3.8 | analytics/performance; theming in `src/lib/chartTheme.js` |
| Realtime (client) | socket.io-client | ^4.8 | `src/lib/socket.js` |
| Frontend tests | Vitest | ^4.1 | `npm test` at root |
| Backend framework | Express | ^5.2 | v5 async error propagation |
| DB / ORM | PostgreSQL / Prisma | `@prisma/client` ^6.16 | `backend/prisma/schema.prisma`; `db/prisma.js` is the single client |
| Realtime (server) | socket.io | ^4.8 | per-vendor rooms + `procurement` room |
| Auth | jsonwebtoken + bcryptjs | ^9 / ^3 | 30-day JWT default |
| Validation | zod | ^4 | `backend/validators/*` via `validate` middleware |
| Security | helmet, cors, express-rate-limit, express-mongo-sanitize, hpp, compression | — | see `server.js`. `express-mongo-sanitize` is kept post-migration — despite the name it's a generic `$`/`.`-key stripper on request bodies, not Mongo-specific |
| Logging | winston + winston-daily-rotate-file, morgan | — | `backend/logs/` |
| PDF | pdfkit | ^0.19 | statement / invoice PDFs (`reports.controller`) |
| Uploads | multer | ^2.1 | `backend/uploads/` |
| Backend tests | jest + supertest, against a real Postgres instance | — | `backend` package; `NODE_ENV=test`, `--forceExit`; `tests/setup.js` resets between tests (§10) |
| Node | v22.x | | |

---

## 3. How to Run

**Backend** (`cd backend`): copy `.env.example` → `.env`, set `DATABASE_URL` (`docker compose up -d postgres` at repo root starts a matching local instance), run `npx prisma migrate deploy` (or `migrate dev` for a fresh schema change), then `npm install` → `npm run dev` (nodemon, port **5000**) or `npm start`. Tests: `npm test` (needs migrations already applied against `DATABASE_URL`).

**Frontend** (repo root): `npm install` → `npm run dev` (Next dev, port **3000**). Build: `npm run build`. Tests: `npm test` (Vitest). Lint: `npm run lint`.

Frontend talks to backend via `NEXT_PUBLIC_API_URL` (default `http://localhost:5000/api`). Socket connects to the same host with `/api` stripped.

**CI:** `.github/workflows/test.yml` runs both suites on PRs and pushes to `master`.

---

## 4. Environment Variables (`backend/.env`)

| Var | Purpose |
|---|---|
| `PORT` | API port (default 5000) |
| `DATABASE_URL` | Postgres connection string for Prisma (`backend/db/prisma.js`, `backend/prisma/schema.prisma`). `docker compose up -d postgres` (repo root) starts a matching local instance. **Strictly required** — the app refuses to start without it (`config/validateEnv.js`). |
| `FRONTEND_URL`, `ALLOWED_ORIGINS` | CORS allowlist. Outside production any loopback origin (`localhost`, `127.0.0.1`, `[::1]`) on any port is also allowed; under `NODE_ENV=production` these two variables are the *only* accepted origins. One predicate in `config/corsOrigins.js` serves Express CORS, Socket.io CORS and the helmet CSP `connect-src`. |
| `NODE_ENV` | `development` \| `test` \| `production`. Gates rate limiting, mailer transport selection, and the dev-only "Reset ERP Database" UI. |
| `JWT_SECRET` | JWT signing key (falls back to `'secret'` outside production; **required** in production or boot fails) |
| `JWT_EXPIRES_IN` | default `30d` |
| `MASTER_KEY` | encrypts secrets at rest via `utils/secretBox.js` (operator MFA secrets now, SAP credentials in Phase 4). 32 bytes as hex/base64, or any passphrase. **Required in production**; dev/test derive one from `JWT_SECRET`. Rotating it makes existing ciphertext unreadable. |
| `ADMIN_BOOTSTRAP_EMAILS` | **Removed (ADR-0009).** If it is still set, the server refuses to start. Provision staff with `npm run seed:platform-admin` + the invitation flow. |
| `MAIL_TRANSPORT` | `smtp` \| `log` \| `memory`. Defaults: smtp in production, memory under test, log in development. Production accepts only `smtp`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | nodemailer SMTP config. `SMTP_HOST` is required whenever the transport is smtp. |
| `MAIL_DEBUG_BODY` | `true` prints email bodies to the log. Development only — bodies carry reset tokens and temporary passwords. |
| `PLATFORM_ADMIN_EMAIL` / `_NAME` / `_PASSWORD` | optional inputs to `scripts/seed-platform-admin.js` (CLI flags take precedence). |
| `DEFAULT_CLIENT_SLUG` | tenant an unauthenticated request registers into when no subdomain/`x-client-slug` says otherwise. Defaults to `legacy` (= `CLT-0001`). |
| `SAP_MOCK_MODE` | `true` (always mock; real RFC not implemented) |
| `GSTIN_PAN_VERIFY_MOCK_MODE` + `_API_URL` / `_API_KEY` | KYC verification mock vs live (see `services/verification.service.js`) |
| `LOG_LEVEL` | winston level |
| `TRUST_PROXY_HOPS` | reverse-proxy hops in front of the API; unset means `loopback` (the shipped nginx on the same host). See `config/trustProxy.js` — never `true`, which would let a client spoof `X-Forwarded-For`. |
| `UPLOAD_DIR`, `MAX_FILE_SIZE_MB` | multer config |
| `CLERK_*`, `MONGO_URI`, `ADMIN_BOOTSTRAP_EMAILS` | **Retired — the server refuses to boot if any is set** (`config/validateEnv.js`). Clerk was the original auth plan, replaced by local JWT (`clerkId`/`clerkUserId` names survive as legacy identifiers); `MONGO_URI` predates the Postgres migration and is now `DATABASE_URL`. |
| `TENANT_RATE_LIMIT_MAX` | per-tenant request cap, default 300/minute (`middleware/rateLimiter.js` `tenantLimiter`, §5.7). Disabled under `NODE_ENV=test`. |
| `BILLING_PROVIDER` | selects the billing provider, default `null` (logs and no-ops). See `services/billing.service.js`, §5.7. |
| `BACKUP_DRILL_DIR` | where `scripts/backup-restore-drill.js` writes its JSON dump. Defaults to `backend/backups/drill-<timestamp>/`. |

Frontend uses `NEXT_PUBLIC_API_URL` only.

---

## 5. Domain Model & the P2P Lifecycle

The whole app models one pipeline. Each stage produces a Postgres row and emits SAP log(s):

```
Vendor onboarding → RFQ (bidding) → award → Purchase Order → ASN (dispatch)
   → GRN (goods receipt) → Invoice (MIRO) → Payment (F110 / UTR)
```

**SAP transaction-code mapping** (simulated, surfaced in UI/logs):
ME41 create RFQ · ME47 submit quotation · ME48 evaluate · ME58 award→PO · MIGO/MB01 goods receipt · MIRO invoice verification · F110 payment run · FBL1N ledger clearing · XK01/FI02 vendor master. **The portal writes only the vendor master (XK01) and sourcing documents; MIGO, MIRO and F110 are read, never posted.**

**Three deferred "SAP pushes" — since Phase 4 they are driver behaviour, not controller timers** (see §5.6):
- After **ASN submit** → MIGO goods receipt after `timings.goodsReceiptMs` (default 10s), creating a GRN and emitting `grn:received`.
- After **invoice submit** → F110 payment run after `timings.paymentRunMs` (default 12s), creating a Payment and emitting `payment:cleared`.
- On **registration submit** → vendor master confirmation after `timings.vendorApprovalMs` (default 5s).

All three default to **0ms under test**, are configurable per tenant on `SapConnection.config.timings`, and live in `sap/drivers/mock.driver.js`. There is no `setTimeout` left in any controller for SAP work.

The frontend `portal-context.js` also sets fallback refresh `setTimeout`s (~11s / ~13s) explicitly commented `// MOCK —` so they aren't mistaken for real polling.

---

### 5.5 Multi-tenancy (read this before touching the backend)

Every business document belongs to a **tenant** (`Client`, e.g. `CLT-0001`). Three
mechanisms enforce it; none of them is optional:

1. **Tenant context** (`utils/tenantContext.js`) — an `AsyncLocalStorage` store.
   `protect` binds the authenticated account's `clientId` for the whole request.
   Out-of-request work (scripts, jobs) must re-bind it itself with
   `runWithTenant(clientId, fn)`. Deferred SAP answers no longer do this by hand — the
   adapter wrapper re-binds the tenant before calling the handler (§5.6).
2. **Tenant extension** (`db/tenantExtension.js`, a Prisma Client extension) — applied to
   every tenant-scoped model listed in `TENANT_SCOPED_MODELS` (mirrors
   `config/tenantModels.js` plus the relational child/line-item tables the Mongoose
   version didn't have, e.g. `RfqItem`, `PurchaseOrderItem`). Auto-injects `clientId` into
   `findMany`/`findFirst`/`updateMany`/`deleteMany`/`count`/`aggregate`/`groupBy`,
   auto-stamps it on `create`, ignores caller-supplied `clientId`, and **throws
   `MissingTenantContextError` when nothing is bound**. `Client`, `AuditLog`,
   `SapConnection`, `SapConnectionAudit` and `PlatformUser` are deliberately absent —
   no plugin was ever applied to them under Mongoose either. **Nested writes bypass the
   extension** (a nested `create` on a relation doesn't re-enter it) — a child row must
   either carry `clientId` explicitly in the nested payload or be written as a top-level
   call.
3. **Socket rooms** — `client:{clientId}:vendor:{vendorId}` and
   `client:{clientId}:procurement`. The handshake requires a JWT carrying a `clientId`;
   `emitToVendor(io, clientId, vendorId, …)` and `emitToProcurement(io, clientId, …)` take
   it as a required argument.

**The escape hatch** is `withoutTenantScope(fn)` — deliberately greppable, for
platform-plane work and the handful of pre-authentication lookups (login, register,
password reset, `protect`'s own account lookup) that must run before a tenant is known.
Never call it from a tenant endpoint.

**Gotcha that will bite you:** a Prisma query is a lazily-started `PrismaPromise`, so it
must be *awaited* inside the context — returning one un-awaited executes it after the
store has unwound and the tenant filter is lost. `runWithTenant`/`withoutTenantScope`
await their callback for exactly this reason; if you write your own wrapper, do the same.

**JWT** now carries `clientId` and `roleScope` (plane). **Roles → planes live in one
registry**, `config/roles.js` — never inline a role list. Platform-plane accounts are
rejected at tenant endpoints with 403 before any query runs.

**Cross-tenant reads answer 404, never 403** — the API must not confirm another tenant's
document exists.

**Migration:** `npm run migrate:tenancy` (`:dry` for a dry run) creates `CLT-0001 "Legacy"`,
back-fills every existing document, drops the obsolete global unique indexes and syncs the
new per-tenant compound ones. It is idempotent and covered by `tests/migrate-tenancy.test.js`.

**Adding a tenant-scoped model?** Register it with the plugin **and** add a case to
`MODEL_CASES` in `tests/tenant-isolation.test.js` in the same commit.

---

### 5.6 The SAP adapter (read this before touching anything SAP)

Since Phase 4 there is exactly one way to talk to SAP:

```js
const sap = await getSapAdapterForClient(req.clientId);   // backend/sap/index.js
const { documents } = await sap.vendorMiroDisplay({ vendor });   // the portal reads; it never posts
```

**`backend/sap/`**

| File | What it is |
|---|---|
| `contract.js` | the `SapAdapter` method list — every method, the transaction it speaks, whether it is deferred. `assertImplements` fails at load time on an incomplete driver; `notImplementedDriver()` builds one whose every method throws `not_implemented`. |
| `drivers/index.js` | the driver registry: `mock`, `s4_odata`, `ecc_rfc` — label, description, `implemented`, `validateConfig`, and the `configFields`/`secretFields` the console renders a form from. |
| `drivers/mock.driver.js` | the simulator, moved here wholesale. Invents SAP's *answers* (document numbers, accepted quantities, TDS, timing) and touches no database. |
| `drivers/s4odata.driver.js` · `eccrfc.driver.js` | skeletons. Only `testConnection` is real (S/4 checks gateway reachability; ECC honestly reports it has no transport). Everything else throws `not_implemented`. |
| `circuitBreaker.js` | one breaker per tenant adapter: closed → open after N consecutive failures → half-open after a cooldown. State is computed on read, so an idle tenant costs nothing. |
| `index.js` | `getSapAdapterForClient` / `invalidateSapAdapter` / `buildTransientAdapter`, and the wrapper described below. |
| `conformance/runner.js` · `conformance/fixtures.js` | Phase 8's conformance suite (ADR-0036): runs every contract method against a live adapter and reports `passed`/`not_implemented`/`failed` per method, with a timeout so a driver that never answers can't hang it. `scripts/sap-conformance.js` is the CLI — `--client <id>` against a configured tenant, `--driver s4_odata --config f.json --secrets f.json` against a throwaway adapter for a sandbox with no tenant yet. This is the tool to point at a design-partner sandbox the moment one exists; `s4_odata`/`ecc_rfc` themselves are still the Phase 4 skeletons. |

**The portal does not write documents into SAP (except the vendor master).**
The contract is now read-mostly. Removed by design: `invoiceCreate`,
`deliveryCreate`, `poProvision`/`poProvisioned`, `poInboundSync`, and the five
sourcing writes (`rfqCreate`, `rfqCancel`, `rfqReissue`, `rfqSubmitBid`,
`infoRecordCreate`). What remains that writes: `vendorCreate` (the vendor master,
on approval), `poAcknowledge` (a supplier confirming an order SAP already
owns), `quotationUpdatePrice` (ME47 net price on a document SAP holds) and
`poInvoicePlanUpdate` (the invoicing plan on an order SAP holds — a buyer's
change to a document SAP owns, same category as the acknowledgement, and paired
with the read-only `poInvoicePlanDisplay`; **neither has been run against a live
system**, so its paths and field names in `s4odata.driver.js` are provisional
config, flagged inline). Why:

- **MIRO is AP's transaction, not a supplier's.** Invoice verification is a
  three-way match performed against the buyer's own books; a portal that posts it
  on the vendor's behalf puts the supplier inside the buyer's ledger and skips the
  AP review the `finance` role exists for. `POST /invoices` records the invoice and
  leaves `sapMiroDoc` **null**. `awaitPaymentRun` then does two reads: it
  *discovers* the document AP posted by matching `zmiro_display/MIRO` on purchase
  order and gross amount (`sap/mappings/invoice-match.js`), then follows it to its
  clearing via `zpayment_api/payment`. The discovered number is written back, so a
  match happens once. The matcher returns null on ambiguity rather than guessing —
  paying against the wrong invoice is worse than showing one as unrecognised.
- **No inbound delivery either.** The supplier's dispatch notice is recorded in the
  portal; `awaitGoodsReceipt` polls SAP's own PO/GRN ledger keyed on the **purchase
  order number**, which never referenced a delivery document anyway. `ASN.sapInboundDelivery`
  is always null.
- **Sourcing is portal-internal.** Core S/4 exposes no public API for issuing an
  RFQ to, or capturing a bid from, an external portal vendor — that is SAP
  Ariba/Business Network territory. The five sourcing methods called a custom
  Z-OData `sourcing` service that was never built, so **`POST /rfqs`, cancel,
  reissue and bid submission all threw a 502 on any tenant using `s4_odata`**;
  only the mock made them appear to work. RFQs, bids and awards now live entirely
  in this application, and what SAP holds is read back through `vendorRfqDisplay`
  and `vendorQuotationDisplay`.
- **The portal creates no purchase orders in SAP.** `POST /pos/simulate` (the
  "Simulate SAP PO (ME21N)" button) and its `poProvision`/`poProvisioned` pair are
  gone. Awarding an RFQ still creates the local `PurchaseOrder` the ASN → GRN →
  invoice chain hangs off, but `sapPoNumber` is now **null**: it used to be
  `'4500' + six random digits`, indistinguishable from a real SAP order number.
  An order gets a real number only by being matched against SAP's own ledger
  (`vendorPoGrnDisplay`). **Consequence:** `awaitGoodsReceipt` and
  `awaitPaymentRun` both key on `sapPoNumber`, so a portal-awarded order sits
  waiting until SAP's order is correlated — honest, but it means the end-to-end
  chain only completes for orders SAP actually knows about.
- **There is no simulation fallback in `s4_odata`.** It used to fall back to the mock
  when the OData gateway had no credentials, which handed a misconfigured tenant an
  invented MIRO number and, seconds later, a fabricated payment — a made-up UTR and
  TDS figure a supplier could reconcile their books against. A tenant that declares a
  real SAP now waits for real answers; the simulator is reachable only by selecting the
  `mock` driver outright.

**What the wrapper does, so no driver has to:** runs the call through the tenant's circuit
breaker; writes the `SapLog` entry using the transaction registry's own code, type and
direction; stamps `{ source, syncedAt, transaction }` on every result (ADR-0021); and, for
deferred methods, re-binds the tenant context before calling the handler (ADR-0022).

**Immediate vs deferred.** An immediate method is `fn(args) -> { data, log }`. A deferred
one is `fn(args, handler)`: the driver decides *when* SAP answers, the handler — in the
controller — decides what to persist, and returning `null` declines the answer so no log is
written and any pending call stays open. Pass `onCall` in `args` to be told about each log
entry (used to emit `log:new` over sockets without retyping BAPI names).

**Configuration.** `SapConnection` is unique on `{clientId, environment}` with `sandbox` and
`production`; `Client.sapEnvironment` says which one the tenant's traffic uses, and only the
promote endpoint writes it. Credentials are envelope-encrypted (ADR-0019) and never
returned. A tenant with no connection row gets the mock driver on defaults. Adapters are
cached per client and keyed on the connection's `updatedAt`, so an edit takes effect on the
next call.

---

### 5.7 Operations & commercial (Phase 7)

| Concern | Where | Notes |
|---|---|---|
| **Usage metering** | `utils/usage.js` | `usageAgainstLimits(client)` — vendors and RFQs-this-month against `Client.limits`, shared by the workspace overview, the platform health board, and enforcement. `null` limit = unlimited; `0` is a real limit, not "unset" (they are checked differently — see the gotcha below). |
| **Plan enforcement** | `usage.js` `assertCanCreate(client, metric)` | Called before the write in `POST /auth/register`, `POST /vendors/profile`, `POST /vendors` and `POST /rfqs`. Throws `402` with `reason: 'plan_limit_reached'` when the tenant is at or over its limit. Counted fresh on every call — no cached counter to drift. |
| **Billing** | `services/billing.service.js` | `getBillingProvider()` — one interface (`onTenantCreated`, `onTenantStatusChanged`, `reportUsage`), one implementation today (`null`, logs and no-ops), selected by `BILLING_PROVIDER`. Wired into tenant create/suspend/reactivate/terminate; `POST /platform/tenants/:clientId/billing/sync-usage` reports on demand (operator-triggered — there is no job runner in this codebase). |
| **Structured logging** | `middleware/requestLogger.js` | `req.log.{info,warn,error}` stamps `requestId` and, once bound, `clientId` on every call automatically. The request-completion and error-handler log lines carry `clientId` too, so any log line can be traced to the tenant and request that produced it. |
| **Per-tenant rate limits** | `middleware/rateLimiter.js` `tenantLimiter` | Keyed on `req.clientId` (falls back to IP), mounted after `protect` on every tenant/supplier route (`routes/index.js` `protectTenant = [protect, tenantLimiter]`). Independent of `apiLimiter`, which is per-IP and production-only — this one guards against one noisy tenant regardless of how many addresses it calls from. Disabled under `NODE_ENV=test`. `TENANT_RATE_LIMIT_MAX` (default 300/min). |
| **Backup/restore drill** | `scripts/backup-restore-drill.js`, `npm run backup:drill` | Dumps every table to JSON, restores into a scratch schema, asserts counts match, drops the scratch schema. No `pg_dump`/`pg_restore` binary required — goes through the Prisma driver directly. Talks to the real `DATABASE_URL` over the network (read-only against `public`) — see `docs/runbooks/backup-restore.md` before running it. |
| **Status page** | `GET /api/status` (`controllers/status.controller.js`) | Public, unauthenticated, deliberately anonymous — aggregate counts only (DB connectivity, count of operational tenants, summed SAP call/failure rate), never a tenant name, slug or `clientId`. JSON by default; renders a minimal HTML page for a browser (`Accept: text/html`). Per-tenant detail stays behind `GET /platform/health`. |
| **Runbooks** | `docs/runbooks/` | Incident response, tenant suspension/termination, key rotation (`JWT_SECRET` vs `MASTER_KEY` — very different blast radius), the backup drill, and diagnosing a SAP outage. |

**Gotcha:** `assertCanCreate` treats a limit as unlimited only when it is `null`/`undefined`
(`limit == null`) — a limit of `0` is enforced. The older `usage.js` `against()` helper (used
for *display* on the health board and workspace overview, inherited from Phase 3/5) reads
`0` as falsy and so displays it the same as unlimited; that display quirk was not changed
alongside enforcement to avoid touching an already-tested read path. Don't copy that
`Boolean(limit && …)` pattern into new enforcement code — use `limit == null`.

---

## 6. Database Schemas (Prisma / Postgres, `backend/prisma/schema.prisma`)

**Every tenant-scoped table carries a required, indexed `clientId`** (stamped by
`db/tenantExtension.js`, not written by hand) plus compound indexes — `{clientId, id}`
unique, `{clientId, vendorId}`, `{clientId, status}`. **Business IDs are unique per tenant,
not globally**: two tenants may both hold `RFQ-2026-001`. The exception is `Vendor`, whose
`vendorId`/`email`/`gstin` remain globally unique because they are login identities
(ADR-0002); its `sapVendorCode` is per-tenant.

### Client — the tenant. **Not** tenant-scoped; only the platform plane owns it
- `clientId` (`CLT-0001`, unique), `companyName`, `slug` (subdomain, unique), `status`
  (`Trial|Active|Suspended|Terminated`), `plan`, `branding{logo,primaryColor}`,
  `featureFlags{}`, `settings{}` (thresholds + notification policy; shape declared by
  `config/tenantSettings.js`, never here — ADR-0023),
  `limits{vendors,rfqsPerMonth,storageMb}`, `createdBy`,
  `activatedAt`/`suspendedAt`/`terminatedAt`, `sapEnvironment` (`sandbox|production` —
  which `SapConnection` the tenant's traffic uses; **only** the promote endpoint writes it).
- `isOperational()` — only `Trial`/`Active` tenants may authenticate or transact.

Every table has its own Postgres-generated `pk` (a UUID, the Prisma `@id`) that nothing
outside its own row ever references. All string business IDs (`id`, `vendorId`, `poId`, …)
are the human-readable, application-level identifiers everything else is joined and
displayed on. `vendorId` (a string like `VND-40013`) is the cross-table link to a vendor —
**not** its `pk`. Legacy field `clerkId`/`vendorId` are matched with a Prisma `OR` in
several places (a holdover from the abandoned Clerk-auth plan, §4).

### Vendor — master data / auth principal
- `vendorId` (unique, e.g. `VND-40013`), `clerkId` (deprecated), `role` (`vendor`|`admin`, default `vendor`).
- `password` (bcrypt, `select:false`), `resetPasswordToken`/`resetPasswordExpires` (`select:false`).
- Company: `companyName`(req), `tradeName`, `businessType`, `incorporationDate`, `gstin`(req, unique, upper), `gstType`, `pan`(req, upper), `cin`, `msmeNumber`, `tdsSection`, `email`(req, unique, lower), `phone`.
- **Flat** address (`address/city/state/postalCode`) and bank (`bankName/accountNumber/ifscCode/accountName/bankBranch`). Responses re-nest bank into a `bankDetails` object for backward compat (`formatVendorResponse`).
- Compliance doc filenames: `cancelledCheque, panCardCopy, gstCertificate, msmeCertificate`.
- KYC: `gstinVerified`, `panVerified`, `verifiedAt`, `verificationDetails`.
- SAP/status: `sapVendorCode` (unique sparse), `status` (`Draft`|`Pending`|`Pending Approval`|`Under Review`|`Approved`|`Rejected`, default `Draft`), `rejectionReason`, `vendorCategory`, `submittedAt`, `approvedAt`.
- Hooks: pre-save bcrypt hash; `comparePassword()` method.

### RFQ — transaction; bids and items are **child tables**, not embedded documents
- `id` `RFQ-YYYY-NNN` (unique, sequential), `description`, `status` (`Draft`|`Bidding Open`|`Submitted`|`Under Review`|`Awarded`|`Closed`, default `Bidding Open`), `deadlineDate`, `rfqType` (`AN`|`AB`), `paymentTerms`, `purchasingOrg`/`companyCode` (`1000`), `currency` (`INR`), `deliveryLocation`; plus `awardedVendorId/Name/awardedAt/convertedPoId`.
- `RfqItem[]` (`rfqPk` FK, cascade delete): `line, materialCode, description, quantity, uom(EA), targetPrice, plant(1000), deliveryDate`.
- `RfqBid[]` (`rfqPk` FK): `vendorId` (legacy external id string) + optional `vendorPk` FK to `Vendor`, `vendorName, gstRate, taxCode(G1..G4), freight, deliveryLeadTimeDays, vendorRating, technicalScore(80), validityDate, moq, remarks, submittedAt`. Its own children: `RfqBidUnitPrice[]` (`lineNumber, price` — replaces the old Mongoose `Map<lineNo,price>` with a joinable row per line) and `RfqBidDocument[]` (`documentId, originalName, url`).
- `RfqInvitedVendor[]` (`rfqPk` FK): `vendorExtId, name, status, rating`.

### PurchaseOrder
- `id` `PO-YYYY-NNNN`, `sapPoNumber` (`4500######`), `vendorId` + optional `vendorPk` FK, `buyerName`, `plant`, `paymentTerms`, `currency`, `incoterms`, `deliveryAddress`, `status` (`Open`|`Acknowledged`|`Dispatched`|`Delivered`|`Invoiced`|`Paid`), `acknowledgedAt`, `fromRfqId`.
- `PurchaseOrderItem[]` (`poPk` FK, cascade delete): `line, materialCode, description, quantity, grnQuantity, unitPrice, netValue, uom`, and a 1:1 optional `InvoicePlan`.
- `InvoicePlan` (one row per item, `itemPk` unique FK) — SAP's invoicing plan (FPLA header + FPLT dates), **off unless `enabled`**: `enabled, planNumber (FPLA-FPLNR), type` (`Periodic`|`Partial`)`, startDate, endDate, frequency` (`Weekly`|`Monthly`|`Quarterly`|`Half-Yearly`|`Yearly`)`, invoicingRule` (`Advance`|`Arrears`, FPLA-FAKKO)`, periodicAmount, currency, reference, source` (`portal`|`sap`)`, syncedAt`, and `InvoicePlanLine[]` — the FPLT dates: `lineNumber (FPLTR), description, settlementDate (AFDAT), billingDate (FKDAT), percentage (FPROZ), amount (FAKWR), status` (`Open`|`Invoiced`|`Blocked`|`Cancelled`, from FKSAF)`, blocked (FAKSP), invoiceId, invoiceNumber, invoicedAt, sapMiroDoc`.
- **A line with an invoicing plan is not invoiced against goods receipts.** Periodic bills the same amount each period; partial splits the line value across milestone dates that must reconcile to it exactly. The arithmetic lives in `services/invoicePlan.service.js` (pure — periodic dates are anchored to the plan start date, not stepped, so a 31 Jan monthly plan is twelve dates and not thirteen; a partial split absorbs its rounding remainder into the last instalment). Re-planning a schedule carries every already-invoiced date forward untouched.

### ASN — advance shipping notice
- `id` `ASN-######`, `poId`, `vendorId`, `status` (`Submitted`|`In Transit`|`Received`), `shipDate`, `estimatedDeliveryDate`, `carrierName`, `trackingNumber`, `vehicleNumber`, `invoiceReference`, `ewayBillNo`, `sapInboundDelivery`. `AsnItem[]` (`asnPk` FK): `line, materialCode, description, shippedQuantity, uom`.

### GRN — goods receipt (MIGO)
- `id` `GRN-…`, `poId`, `asnId`, `vendorId`, `sapMigoDoc`, `postingDate`, `receivedBy`, `invoiceSubmitted`. `GrnItem[]` (`grnPk` FK): `line, materialCode, description, receivedQuantity, acceptedQuantity, rejectedQuantity, rejectionReason, uom`.
- `totalAccepted`/`rejectionRate` were Mongoose virtuals; now an app-layer compute-after-fetch helper over `GrnItem[]` (same formula), not a stored/generated column.

### Invoice
- `id`, `grnId` (**optional, nullable FK** — a plan invoice has no goods receipt; mutually exclusive with `invoicePlanRef` via a CHECK constraint in the migration SQL, since Prisma has no native cross-field CHECK), `invoicePlanRef` (Json: `line, planLineNumber, planType, settlementDate` — set instead of `grnId` when the invoice bills an invoicing-plan date), `poId`, `vendorId`, `invoiceNumber`, `invoiceDate`, `sapMiroDoc`, `status` (`Submitted`|`Under Review`|`Match Warning`|`Approved`|`Posted in SAP`|`Cleared`), `subTotal`, `taxAmount`, `totalAmount`, `taxCode`(G1), `currency`, `matchWarning`, `postedAt`, `clearedAt`; `InvoiceItem[]` (`invoicePk` FK): `line, materialCode, description, quantity, unitPrice, amount`. Tax is computed at **18% GST**. Decimal columns (`Decimal(14,2)`) — read via `utils/money.js` `toNumber()`, never implicit coercion.

### Payment — F110
- `id`, `invoiceId`, `poId`, `vendorId`, `invoiceRef`, `invoiceNumber`, `sapMiroDoc`, `grossAmount`, `tdsDeducted`, `netAmount`, `paymentDate`, `utrCode`, `paymentMethod` (`NEFT`|`RTGS`|`IMPS`), `sapPaymentDoc`, `bankName`, `runId` (F110 run). TDS certificate fields: `fiscalYear, quarter, tdsSection, deducteePan, deductorTan, totalTds`.

### ChatMessage — communications hub
- `vendorId`, `sender` (`Vendor`|`Buyer`|`System`|`Finance`|`Quality`|`Warehouse`), `message`, `linkedPoId`, `linkedRfqId`, `timestamp`, `isRead`.

### SapLog — the BAPI/RFC audit trail (drives the console)
- `vendorId`, `type` (`BAPI`|`RFC`|`OData`|`IDoc`|`SYS`|`KYC`), `direction` (`OUTBOUND`|`INBOUND`), `name` (e.g. `BAPI_RFQ_CREATE`), `payload` (JSON-serialized **string**, kept verbatim — deliberately not a `Json` column), `status` (`SUCCESS`|`PENDING`|`FAILED`), `errorMessage`, `documentRef`, `timestamp`. Mongoose's TTL index auto-purged rows after 30 days for free; **Postgres has no schema-level equivalent, and nothing currently replicates it** (the schema comment flags `pg_cron` / an app cron as the intended replacement — not yet built, so `sap_logs` grows unbounded until one exists).

### AuditLog — the platform + tenant action trail. **Not** tenant-scoped (ADR-0014)
- `clientId` (optional — null for platform actions concerning no tenant), `actorId`, `actorRole`, `actorEmail`, `plane`, `action` (from `config/auditActions.js`), `target` (Json `{type,id,label}`), `meta` (Json, secrets redacted), `ip`, `at`. Indexes: `{at desc}`, `{clientId,at desc}`, `{action,at desc}`, `{actorId,at desc}`. **Append-only** — enforced by `db/appendOnlyExtension.js` plus a Postgres `REVOKE` on `UPDATE`/`DELETE`, not a Mongoose hook. Written only through `utils/audit.js`.

### SapConnection — one tenant's SAP config, per environment. **Not** tenant-scoped (ADR-0019)
- `clientId` (indexed), `environment` (`sandbox|production`), `driver` (`mock|s4_odata|ecc_rfc`), `config` (Json, validated by the driver), `wrappedDataKey` (never returned — see `omit` in `db/prisma.js`), `lastTest` (Json: `ok,message,latencyMs,driver,detail,at,testedBy`), `promotedAt`/`promotedBy`, `createdBy`/`updatedBy`. Unique on `{clientId, environment}`. Its own child table `SapConnectionSecret[]` (`connectionPk` FK, unique on `{connectionPk, name}`) replaces Mongoose's `Map<String,String>` of `v2:`-prefixed ciphertext with one row per credential name.
- `setSecrets(values)` (empty string clears a name, absent names are left alone), `decryptSecrets()` (one caller: the driver factory), `secretNames()` (what the API returns) — now plain functions in `db/sapConnectionHelpers.js`/`utils/secretBox.js`, not model methods.

### SapConnectionAudit — the connection change trail. **Not** tenant-scoped, **append-only**
- `clientId`, `environment`, `action` (a `sap.*` value from `config/auditActions.js`), `driver`, `changes` (Json, field-level `{from,to}` for **non-secret** config), `secretsChanged` (`String[]` — credential **names** only, never a value, hash or length), `result` (Json test outcomes), `actorId`/`actorEmail`/`actorRole`/`ip`, `at`. Append-only the same way as `AuditLog`.

### Document — uploaded files metadata
- `vendorId`, `fileName`, `originalName`, `mimeType`, `size`, `filePath`, `linkedTo` (`ASN`|`RFQ`|`Profile`|`Invoice`). Actual files land in `backend/uploads/`.

---

## 7. Backend Architecture (`backend/`)

**Entry:** `server.js` — loads `.env`, `validateEnv()`, builds Express app + HTTP server + Socket.io. Middleware order: helmet(CSP) → compression → Express-5 query redefinition shim → `express-mongo-sanitize` → `hpp` → CORS → JSON body limit (10kb, skipped for `/uploads`) → `requestLogger` → (prod only) `apiLimiter` → `/api` routes → `errorHandler`. Connects DB **before** listening.

**Socket.io auth (`io.use`)**: requires a valid JWT in `handshake.auth.token` carrying a `clientId` — there is no anonymous or `x-vendor-id` fallback any more (ADR-0006). On connect the socket joins `client:{clientId}:vendor:{vendorId}`; `join_procurement_room` joins `client:{clientId}:procurement`. A client cannot name the room it joins. `app.set('io', io)` so controllers can emit.

**Routing (`routes/index.js`):** everything under `/api`.
- `/api/health`, `/api/test-error` — public.
- `/api/auth` — public arms (workspace realm, register, login, forgot/reset password, invitation preview + accept); `/me` and `/change-password` carry their own guard.

**Which tenant is an unauthenticated request for? (`utils/resolveClient.js`, ADR-0028)** The **hostname's first label** decides it — `northwind.vendorconnect.io` → slug `northwind` — with `www`/`platform`/`api`/`app`/`admin` reserved and a bare IP never read as a subdomain. `x-client-slug` overrides it **outside production only** (it is how localhost and the test suite act as any tenant) and is ignored when `NODE_ENV=production`; last comes `DEFAULT_CLIENT_SLUG`, defaulting to `legacy`. `realmFromRequest()` reports the `source` (`subdomain` / `header` / `default`), because only a real subdomain is trusted enough to refuse a login. Registration, the realm endpoint and login all read this one resolver.
- `/api/platform` — the platform plane, behind `protectPlatform`. **No tenant is bound here.** The `/auth/*` arm carries `protectPlatform` alone (it is how an operator reaches a full session); **everything else sits behind `router.use(protectPlatform, requireMfa)`** — tenants, operators, audit, health.
- **All other route groups are mounted behind `protect`** (JWT): `vendors, workspace, users, rfqs, pos, grns, invoices, payments, chats, uploads, reports, asns, logs, dashboard`. Inside each group **every route declares one permission** with `requirePermission(...)`; `config/permissions.js` decides which roles hold it (ADR-0012). `vendor.routes.js` applies `protect` per-route because `POST /vendors/profile` is public.
- **Feature-gated groups** additionally carry `requireFeature('features.…')` (`middleware/requireFeature.js`), which reads the tenant settings registry and answers **404** when the workspace has switched that module off — `/api/chats` is the first (ADR-0023).

**The registries (one module each, and nothing else may restate them):** `config/roles.js` (roles, planes, descriptions) · `config/permissions.js` (role→permission) · `config/statuses.js` (the supplier lifecycle, served to the directory with the list) · `config/tenantSettings.js` (what a tenant may configure) · `config/auditActions.js` (what may be recorded) · `config/sapTransactions.js` (transaction codes) · `config/emailTemplates.js` · `config/tenantModels.js`.

**Identity (three collections, three planes — ADR-0007/0008):**
- `Vendor` — supplier plane. Supplier master record *and* supplier login. Role enum is `vendor` only.
- `User` — tenant plane (`client_admin`, `buyer`, `finance`). Tenant-scoped. Created by invitation or tenant provisioning, never by public registration.
- `PlatformUser` — platform plane (`super_admin`, `sap_manager`). Not tenant-scoped; its own login surface under `/api/platform/auth`.
- All three share `models/plugins/credentialsPlugin.js` (bcrypt hashing, single-use hashed reset tokens, `mustChangePassword`, `lastLoginAt`).
- `Invitation` — tenant-scoped, covers staff *and* supplier invites; only the token hash is stored, 7-day expiry, one live invite per email per tenant.

**Auth middleware (`middleware/auth.js`):**
- `protect` — verifies the `Bearer` token, loads the account from the collection its `accountType` names (unscoped, since identity precedes tenancy), **401s if the account's role no longer matches the token** (ADR-0013), rejects platform accounts with 403, then sets `req.auth` (`accountType/id/role/plane/email/clientId/permissions`) plus `req.client`, `req.clientId`, and either `req.vendor`/`req.vendorId`/`req.scopeVendorId` (suppliers) or `req.user` with a null `req.scopeVendorId` (staff), and **binds the tenant context for the rest of the request**. There is no `x-vendor-id` fallback in any environment (ADR-0010).
- `protectPlatform` — the same resolution for `/api/platform/*`, but binds **no** tenant, and answers **404** to a tenant-plane account so the console's existence is never confirmed.
- `requireMfa` — the platform plane's second gate (ADR-0016). Requires that the operator has enrolled an authenticator **and** that this token cleared it (`mfa: true` claim, minted only by `POST /platform/auth/mfa/verify`). Its two refusals are distinguishable via the response's `reason`: `mfa_enrolment_required` vs `mfa_verification_required`.
- `requirePermission(permission)` — the only route guard. Reads `config/permissions.js`; the declaration is discoverable as `fn.permission`, which `tests/route-role-matrix.test.js` walks.
- `requireOnboarded` (`middleware/requireOnboarded.js`) — the **second** supplier gate, and not a permission. Holding `rfq:bid` is a fact about the role; whether the supplier has actually registered is a fact about the record, and a `Draft` account holds the whole supplier permission set from the moment it exists. Refuses `403 { reason: 'registration_incomplete' }` to a supplier whose status is in `VENDOR_PRE_SUBMISSION` (`Draft`/`Pending`/`Rejected` — `config/statuses.js`). Mounted in `routes/index.js` as `protectOnboarded` on rfqs, pos, grns, invoices, payments, chats, reports, asns and logs; deliberately **not** on `/vendors`, `/uploads` or `/dashboard`, which are the registration form, the documents it collects and the shell it renders in. Tenant staff pass through untouched. The frontend mirror is `src/lib/onboarding.js`, and `onboarding.test.js` checks the two status lists against each other.
- `requirePlane(...planes)` — plane assertion for permissions held on more than one plane.

**Other middleware:** `errorHandler` (central, uses `ApiError`), `rateLimiter` (`apiLimiter`), `requestLogger`, `validate(schema)` (zod), `upload` (multer).

**Utils:** `ApiError` (badRequest/unauthorized/forbidden/notFound/conflict factories), `asyncHandler`, `logger` (winston), `sapLogger.createSapLog(...)` (writes `SapLog`), `socketEmitter` (`EVENTS` map + `emitToVendor` / `emitToProcurement`), `authToken` (signs/verifies session tokens for all three planes), `requestScope` (`vendorScope` / `requireVendorScope` / `withVendorScope` — the one answer to "whose rows is this request about"), `mailer` (smtp/log/memory transports; `assertMailerConfigured()` runs at boot).

**Registries — one module each, read everywhere, duplicated nowhere:** `config/roles.js` (roles → planes → account collection), `config/permissions.js` (role → permissions), `config/emailTemplates.js` (all outbound copy), `config/auditActions.js` (every auditable action; `recordAudit` rejects anything else), `config/tenantModels.js` (the tenant-scoped collections, iterated by the export and the per-tenant counts), `config/sapTransactions.js` (every BAPI/RFC/OData call — code, type, direction, label; `transaction()` throws on anything else), `sap/drivers/index.js` (the driver catalogue, including the form fields the console renders), and on the frontend `src/lib/platformNav.js` (console nav → permission, asserted against the backend map in `platformNav.test.js`).

**Secrets (Phase 3, extended in Phase 4):** `utils/secretBox.js` — AES-256-GCM with a versioned envelope, keyed by `MASTER_KEY`; production refuses to boot without it, dev/test derive one from `JWT_SECRET`. Two versions: `v1:iv:tag:ciphertext` encrypted directly under the master key (operator MFA secrets), and `v2:…` encrypted under a random per-connection **data key** which is itself wrapped as a `v1` blob (SAP credentials — ADR-0019). A KMS swap replaces `wrapDataKey`/`unwrapDataKey` and nothing else. `utils/totp.js` — RFC 6238, hand-rolled on node crypto, verified against the RFC vectors in `tests/crypto-primitives.test.js`. `utils/audit.js` — the only writer of `AuditLog`: stamps actor/plane/tenant, redacts secret-shaped keys, throws on an unregistered action.

**Services:** `tenantProvisioning.service.js` — creates a `Client` **and** its first `client_admin` as one operation (generated password, emailed once, `mustChangePassword`), rolling the Client back if the admin cannot be created. Also owns slug rules (reserved list, format) and `CLT-####` allocation.

**Socket events** (`utils/socketEmitter.js` `EVENTS`): `po:new`, `grn:received`, `payment:cleared`, `rfq:awarded`, `rfq:bid_received`, `chat:message`, `vendor:approved`, `log:new`. Emitters take `clientId` as a required first argument after `io`.

**Services:** `verification.service.js` — GSTIN/PAN KYC verification (mock or live third-party per env).

**Ad-hoc scripts (dev, not part of the app):** `check_all_data.js`, `seed_payments.js`, `test_endpoints.js`, `test_remaining_endpoints.js`, `test_week2_endpoints.js`, root `test_sockets.js`.

### 7.1 Complete API Endpoint Map

Base path `/api`. Auth column: **Public** / the permission the route declares (see `config/permissions.js` for who holds it). Phase 2 additions: `/api/users` (staff + invitations, plus `GET /users/roles` — the invitable roles and what each means, served from `config/roles.js`), `/api/vendors/invitations`, `/api/auth/invitations/:token`, `/api/auth/invitations/accept`, `/api/auth/change-password`, `/api/platform/auth/*`. Phase 5 additions: `/api/workspace/*` and `POST /api/vendors`. Phase 6 addition: `GET /api/auth/workspace`. Phase 7 additions: `GET /api/status` (public), `POST /platform/tenants/:clientId/billing/sync-usage`.

`GET /health` (liveness — DB state, socket count) and `GET /status` (public status page — see §5.7) sit directly on the router, ahead of everything else, with no `clientId`.

**Auth** (`auth.routes.js`, public):
| Method | Path | Controller | Notes |
|---|---|---|---|
| POST | `/auth/register` | register | zod `registerSchema`; assigns `vendorId` server-side if absent (`VND-#####`); self-reg starts `Draft`; refused when the workspace has closed self-registration unless the email holds an invitation (ADR-0023); returns `{token, vendor}` |
| POST | `/auth/login` | login | by email or vendorId; returns `{token, vendor}`. On a **real subdomain**, an account belonging to another tenant is refused with the same `Invalid credentials` as a wrong password (ADR-0028) |
| GET | `/auth/workspace` | getWorkspace | Public. Which tenant this hostname is — identity, branding, feature flags — for the signed-out screens. **404** for an unknown slug *and* for a suspended tenant |
| GET | `/auth/me` | getMe | JWT; returns `auth` (role, plane, **permissions**) + `workspace` (identity, branding, feature flags) — the three front ends filter their nav on it |
| POST | `/auth/forgot-password` | forgotPassword | generic response (no enumeration); the link is **emailed**, never logged (ADR-0011) |
| POST | `/auth/reset-password` | resetPassword | SHA-256 token, 1h expiry |

**Vendors** (`vendor.routes.js`):
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/vendors/profile` | JWT | current vendor profile |
| POST | `/vendors/profile` | — | create profile (`profileCreateSchema`) |
| PUT | `/vendors/profile` | JWT | update (`profileUpdateSchema`); flattens legacy nested address/bank |
| POST | `/vendors/profile/submit` | JWT | submit registration → 5s auto-approve timer |
| GET | `/vendors/performance` | JWT | scorecard KPIs |
| POST | `/vendors/invitations` | `vendor:invite` | invite a supplier into this workspace |
| POST | `/vendors` | `vendor:create` | **tenant-side create** (`vendorCreateSchema` = the self-registration schema minus `vendorId`/`status`); random password + emailed set-password link (ADR-0026) |
| GET | `/vendors` | `vendor:read` | `?status` (validated against the registry) · `?search` (name/ID/email/GSTIN) · paginated; response carries `filters.statuses` |
| PUT | `/vendors/:id/approve` | `vendor:approve` | approve; audits `vendor.approved`, emails the supplier if the workspace wants that |
| PUT | `/vendors/:id/reject` | `vendor:approve` | reject (`rejectVendorSchema`); audits `vendor.rejected` |
| GET | `/vendors/:id` | `vendor:read` | **one supplier in full** — profile, KYC state and documents, plus `activity` (PO/invoice counts and values by status, payments net of TDS, RFQ invitations, GRNs, ASNs — all aggregated live), `recentOrders` (5) and `awaitingDecision` from the status registry. Accepts either the Postgres `pk` (uuid) or the `vendorId`. **Registered last**, or `/:id` swallows `/profile`, `/performance` and `/sap-reference-data` above it |

**Workspace — the tenant back office** (`workspace.routes.js`, behind `protect`; nothing here takes a `clientId`, it comes from the token):
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/workspace/overview` | `workspace:read` | supplier queue + SLA breaches, sourcing/finance counts, staff, usage vs `limits` |
| GET | `/workspace/settings` | `settings:read` | the registry, grouped, with effective values |
| PATCH | `/workspace/settings` | `settings:manage` | `{settings:{key:value}}`; rejected whole on any bad key (`errors` map); audits `settings.updated` |
| GET | `/workspace/audit` | `audit:read` | this tenant's rows only; platform actors anonymised (ADR-0025) |

**The RFQ screen's three tabs** (`src/features/rfq/components/RfqView.jsx`): *RFQ Monitor & History* (this app's own RFQs), *Submit Quotation* (portal-internal — a bid is recorded here and **not** transmitted to SAP), and *My SAP Documents*. The last merges the two vendor-scoped SAP reads — `GET /rfqs/sap-status` (ME43, `ZME43/ME43`) and `GET /rfqs/sap-quotations` (ME48, `ZCL_ME48/vendor`) — into one deduplicated list. **ME48 returns the vendor's whole EKKO set including the 6xxxxxxx documents ME43 reports**, so the same quotation arrives from both; `src/lib/sapDocuments.js` normalises the two shapes (`sapRfqNumber` vs `documentNumber`), merges on document number, and sorts newest first. Both reads are kept rather than trusting ME48 to be a complete superset. Neither takes an RFQ id — they are keyed on `sapVendorCode` alone, which is why this is a tab and not a panel inside one RFQ's detail pane. Live-payload contract tests: `backend/tests/sap-read-contracts.test.js`, merge rules: `src/lib/sapDocuments.test.js`.

Each row in the *My SAP Documents* table whose type is `Quotation` (the 6xxxxxxx `ebeln` range) carries an **Update Price (ME47)** action — a genuine SAP write, `POST /rfqs/:id/sap-quote-price` → `quotationUpdatePrice` → `ZQUOT_NETPR/QUOT_UPDPR`, confirmed live against the sandbox. This is the one sourcing write that survived the "sourcing is portal-internal" decision above: it updates the net price on line items of a document **SAP already holds**, not a bid against a portal RFQ. Because ME48/ME43 return no line items to price against, the modal has the vendor pick one of their own portal RFQs (from RFQ Monitor & History) to supply the line numbers/materials, and the `:id` in the route is that portal RFQ — its items are what `sap-quote-price` validates against, `sapRfqNumber` in the body is the unrelated SAP document number the vendor is pricing. See `contract.js`'s `quotationUpdatePrice` and `sapTransactions.js`'s `QUOTATION_PRICE_UPDATE` for the full rationale.

**RFQs** (`rfq.routes.js`, all JWT):
| Method | Path | Notes |
|---|---|---|
| GET | `/rfqs` | invited-vendor filtered unless `?all=true`; paginated |
| POST | `/rfqs` | create (`rfqCreateSchema`) → `BAPI_RFQ_CREATE` log |
| GET | `/rfqs/:id` | |
| PUT | `/rfqs/:id/cancel` | → status `Closed` |
| PUT | `/rfqs/:id/reissue` | new deadline, status → `Bidding Open` (`reissueRfqSchema`) |
| POST | `/rfqs/:id/bid` | submit quotation (`bidSchema`); validates invitation/deadline/status/all-lines-priced; GST→taxCode; RFQ stays `Bidding Open` so every invited vendor can bid, not just the first |
| POST | `/rfqs/:id/sap-quote-price` | ME47 — pushes a net price to a SAP-native quotation document (real SAP write, see above); `:id` is the portal RFQ supplying the line numbers |
| GET | `/rfqs/:id/evaluate` | ME48 weighted scoring matrix |
| POST | `/rfqs/:id/award` | award winner → creates PO with bid prices, status `Awarded` |
| GET | `/rfqs/:id/export?format=` | the export bridge (see below); `csv` \| `xlsx` \| `json` \| `idoc`, default `csv` |

**The export bridge** (`backend/services/export.service.js`, docs/04-sap-runtime-engineering-plan.md §5.2): once an RFQ is awarded, `GET /rfqs/:id/export` hands back the resulting PO as a downloadable file rather than a live SAP write — the deliberate alternative to the `Z_PORTAL_MAINTAIN_RFQ`/BDC screen-scrape the original spec asked for, which needs ABAP this project doesn't have and breaks on any SAP patch or screen variant. Four formats, all built from one `buildExportPayload({ rfq, po })`: **CSV** (one row per PO line, header fields repeated — the pragmatic default), **structured JSON** (for a buyer's own middleware), an **XLSX-equivalent** (SpreadsheetML/Excel-2003-XML, written by hand with no third-party library — the `xlsx` npm package carries unpatched prototype-pollution/ReDoS CVEs, and this service only ever *produces* a workbook, never parses one, so the dependency wasn't worth taking on), and a **flat-file IDoc** shaped like `ORDERS05`/`PORDCR` (`EDI_DC40`/`E1EDK01`/`E1EDP01` segments, tab-separated — illustrative of the layout, not a byte-exact binary IDoc dump) that a buyer's Basis team can feed through WE19/WE16 if they choose. No WE20 partner profile, no ABAP, no inbound network path from this service. The RFQ detail pane's "Order raised" card (`RfqView.jsx`) surfaces the four format buttons once `status === 'Awarded'`, alongside a "managed in VendorConnect" label making the sourcing boundary a stated product decision rather than a code comment — sourcing itself has no SAP write path (see the "Sourcing is portal-internal" note above); only the resulting PO leaves as a file.

**Evaluation formula (ME48):** `weighted = price*0.40 + technical*0.30 + delivery*0.20 + rating*0.10`, where `priceScore = lowestTotalCost/vendorTotalCost*100`, `deliveryScore = shortestLeadTime/vendorLeadTime*100`, technical default 80. Every default in that formula — vendor rating, technical score, lead time — comes from `config/scoring.js`, so the two invitation paths cannot disagree about them again. **GST→tax code:** 5%→G3, 12%→G2, 18%→G1, 28%→G4.

**POs** (`po.routes.js`, JWT): `GET /pos`, `GET /pos/sap-status` (SAP's own PO/GRN ledger), `GET /pos/:id`, `PUT /pos/:id/acknowledge`, `PUT /pos/:id/status`, `POST /pos/:id/asn` (`asnCreateSchema`; recorded locally, GRN discovered from SAP), `GET /pos/:id/asn`. `POST /pos/simulate` is **gone** — see §5.6.
Invoicing plans: `GET /pos/:id/invoice-plan` (`po:read` — the plans on the order, each with a summary, plus a flat `billable[]` of what may be invoiced today), `PUT /pos/:id/items/:line/invoice-plan` (`po:manage`, `invoicePlanSchema` — configures or replaces a plan and pushes it to SAP before saving), `DELETE /pos/:id/items/:line/invoice-plan` (`po:manage`; refused once a date has been billed), `PUT /pos/:id/items/:line/invoice-plan/lines/:lineNumber/block` (`po:manage` — FPLT-FAKSP, withholds one date without touching the schedule), `POST /pos/:id/invoice-plan/sync` (`po:manage` — adopt what SAP holds). Suppliers hold `po:read` but never `po:manage`, so they read a plan and bill it; they do not set one.

**ASNs** (`asn.routes.js`, JWT): `GET /asns`.

**GRNs** (`grn.routes.js`, JWT): `GET /grns`, `GET /grns/:id`.

**Invoices** (`invoice.routes.js`, JWT): `GET /invoices`, `POST /invoices` (`invoiceCreateSchema`; records the supplier's invoice — **nothing is posted to SAP**), `GET /invoices/:id`, `PUT /invoices/:id/status`, `POST /invoices/plan` (`planInvoiceSchema` — one invoice against one invoicing-plan date; the **plan** sets the amount, the supplier states only their invoice number, date and tax, and a date cannot be billed before its settlement date, twice, or while blocked. A plan invoice does not move the PO's status — a periodic plan has more instalments to come), `GET /invoices/sap-status` (reconciliation against SAP's own MIRO ledger). `POST /invoices/:id/miro` and the `invoice:post` permission are **gone** — see §5.6.

**Payments** (`payment.routes.js`, JWT): `GET /payments`, `POST /payments`, `GET /payments/sap-status` (SAP's own ledger for this vendor), `GET /payments/tds-summary` (TDS deducted per fiscal quarter — see below), `GET /payments/:id`, `PUT /payments/:id/status`.

**TDS and Form 16A.** `GET /payments/tds-summary` aggregates the tenant's own `Payment`
rows by **Indian fiscal quarter** (`utils/fiscalPeriod.js` — FY runs Apr–Mar, Q1 is
Apr–Jun; the older code filed rows by *calendar* quarter of *now*, which put a January
payment in the wrong return period). It reports tax actually withheld, and leaves
`section`/`deductorTan` **null** until SAP supplies them — they need the withholding-tax
reporting API. It is deliberately **not** a Form 16A: that is a statutory certificate the
buyer issues from TRACES after filing its quarterly Form 26Q, and the portal cannot know
whether that happened, so no row carries a filing status. The screen's "Request
Certificate" action routes to Finance through the chat endpoint. Until Phase 8 this
registry was five **hardcoded** quarters with invented amounts and reference numbers,
badged "Filed & Signed" against the supplier's real PAN.

**Chats** (`chat.routes.js`, JWT): `GET /chats`, `POST /chats` (`chatMessageSchema`) — also used as the generic "reach a human" channel (payment disputes, Form 16A requests).

**Uploads** (`upload.routes.js`, JWT): `POST /uploads` (multer single `file`), `GET /uploads` (list), `GET /uploads/:id` (download), `DELETE /uploads/:id`.

**Reports** (`report.routes.js`, JWT): `GET /reports/statement` (PDF account statement), `GET /reports/invoice/:id` (PDF), `GET /reports/metrics` (platform metrics).

**SAP logs** (`saplog.routes.js`, JWT): `GET /logs` — the BAPI console feed.

**Dashboard** (`dashboard.routes.js`, JWT): `GET /dashboard/summary`.

**Platform console** (`platform.routes.js`). `/auth/*` needs an operator token; **everything below it also needs `requireMfa`**. A tenant or supplier token gets **404** anywhere here.
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/platform/auth/login` | Public | returns a half-session (`mfa:false`) + `next`: `change_password` \| `enrol_mfa` \| `verify_mfa` |
| POST | `/platform/auth/forgot-password` · `/reset-password` | Public | generic response; link points at `/platform/reset-password` |
| GET | `/platform/auth/me` | `self:read` | adds `mfa: {enrolled, verified}` so the console knows which step to show |
| POST | `/platform/auth/change-password` | `self:read` | returns a fresh token keeping its MFA standing |
| POST | `/platform/auth/mfa/enrol` | `self:read` | returns the secret + `otpauth://` URI **once**; stored encrypted |
| POST | `/platform/auth/mfa/verify` | `self:read` | completes enrolment or clears the factor; mints the only token `requireMfa` accepts |
| GET | `/platform/tenants` | `tenant:read` | `?status`, `?plan`, `?q`, paginated |
| POST | `/platform/tenants` | `tenant:manage` | **creates the tenant and its first `client_admin`**; credentials emailed, never returned |
| GET | `/platform/tenants/:clientId` | `tenant:read` | configuration + administrators + per-collection counts |
| PUT | `/platform/tenants/:clientId` | `tenant:manage` | `companyName/plan/limits/branding/featureFlags` only — `clientId` and `slug` are immutable |
| POST | `/platform/tenants/:clientId/suspend` · `/reactivate` · `/terminate` | `tenant:manage` | termination is **soft** (ADR-0015); takes effect on the tenant's next request |
| GET | `/platform/tenants/:clientId/export` | `tenant:manage` | the one place an operator sees tenant documents; one audited action |
| POST | `/platform/tenants/:clientId/administrators/:userId/credentials` | `tenant:manage` | re-issues a temporary password by email |
| POST | `/platform/tenants/:clientId/billing/sync-usage` | `tenant:manage` | computes current usage and reports it to the billing provider (§5.7); operator-triggered |
| GET/POST | `/platform/operators` | `operator:manage` | super_admin only; new operators get emailed credentials + must enrol MFA |
| PUT | `/platform/operators/:id` | `operator:manage` | name/role; cannot change your own role |
| POST | `/platform/operators/:id/suspend` · `/reactivate` | `operator:manage` | cannot suspend yourself or the last active super admin |
| POST | `/platform/operators/:id/mfa/reset` | `operator:manage` | lost-device recovery; kills their sessions' console access |
| GET | `/platform/audit` | `platform:audit:read` | `?clientId,?action,?subject,?actorId,?plane,?from,?to`, paginated |
| GET | `/platform/audit/filters` | `platform:audit:read` | filter values from the registries, not from the data |
| GET | `/platform/health` | `platform:health:read` | per-tenant SAP status, driver, circuit, error rate, usage vs limits, active users |
| GET | `/platform/tenants/:clientId/sap` | `sap:configure` | both environments + the driver catalogue; credential **names** only |
| PUT | `/platform/tenants/:clientId/sap/:environment` | `sap:configure` | configure/edit; validated by the driver; clears `lastTest` |
| POST | `/platform/tenants/:clientId/sap/:environment/test` | `sap:configure` | tests on a transient adapter; never trips the live circuit |
| POST | `/platform/tenants/:clientId/sap/promote` | `sap:configure` | switches `Client.sapEnvironment`; production requires a passing test |
| GET | `/platform/tenants/:clientId/sap/audit` | `sap:configure` | the append-only `SapConnectionAudit` for this tenant |

---

## 8. Frontend Architecture (`src/`)

### 8.1 App Router routes (`src/app/*/page.jsx`)
This *is* a real multi-route App Router app (the older `workflow/` docs describing a single-page `activeTab` router are **outdated**). Each page is a thin `'use client'` wrapper that pulls state from `usePortal()` and renders a feature View:

| Route | Renders | Feature |
|---|---|---|
| `/` | `DashboardView` | dashboard |
| `/registration` | `RegistrationView` | profile |
| `/rfqs` | `RfqView` | rfq (full lifecycle UI, large) |
| `/pos` | `PurchaseOrdersView` | purchase-order |
| `/invoices` | `InvoiceProcessingView` | billing |
| `/payments` | `PaymentTrackingView` | payments |
| `/chats` | `CommunicationsView` | dashboard |
| `/performance` | `PerformanceView` | dashboard |
| `/analytics` | `ReportsAnalyticsView` | dashboard |
| `/admin` | — | **gone**: redirects to `/workspace` (Phase 5 promoted it, ADR-0024) |
| `/workspace`, `/workspace/suppliers`, `/workspace/suppliers/[id]` (one supplier in full — profile, compliance documents, trading history; the row click from the directory), `/workspace/users`, `/workspace/settings`, `/workspace/audit` | the tenant back office | **a different plane** — see §8.9 |
| `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` | auth pages | rendered in a centered "auth-mode" layout, no shell |
| `/platform`, `/platform/tenants`, `/platform/tenants/[clientId]`, `/platform/operators`, `/platform/audit`, `/platform/reset-password` | the platform console | **a different plane** — see §8.8 |

`activeTab` is derived from `pathname`; `setActiveTab(id)` does `router.push`.

### 8.2 Providers & layout (`src/app/layout.jsx`)
Nesting: `ThemeProvider` → `ShellProvider` → `PortalProvider` → `PortalLayout` → `{children}`. A `beforeInteractive` inline script resolves dark/light theme pre-paint (localStorage `vc-theme`) to avoid flash. Fonts: Geist + Geist Mono via `next/font`.

- **`ThemeProvider`** (`lib/theme-context.js`) — light/dark toggle.
- **`ShellProvider`** (`lib/shell-context.js`) — owns `sapPayloadLogs` (the BAPI console feed): seeds a `PORTAL_INITIALIZE` log, hydrates from `localStorage('sap_vendor_portal_logs')`, fetches `/logs` when authed, exposes `addSapLog / clearSapLogs / refreshSapLogs`. Caps at 100 logs.
- **`PortalProvider`** (`lib/portal-context.js`) — **the central orchestrator** (see §8.3).
- **`PortalLayout`** (`components/portal/PortalLayout.jsx`) — if on an auth page, renders a centered wrapper; otherwise the app chrome: `Header`, `CommandPalette`, `Sidebar`, `<main>` with the page, and the docked `BapiConsole`.

### 8.3 `PortalProvider` — the hub (`lib/portal-context.js`)
Composes all feature hooks and exposes them plus cross-cutting handlers via `usePortal()`:
- Instantiates: `useProfile`, `usePOs(profile)`, `usePayments`, `useInvoices(profile, …)`, `useRFQs(profile)`, `useDashboard(profile, clearSapLogs)`.
- **Toasts + notifications:** `addToast(type, message)` pushes an auto-dismissing toast **and** appends to a capped (30) `notifications` history (for the Header bell). `<ToastNotification>` is mounted here app-wide.
- **Auth gating:** redirects to `/sign-in` when no `jwt_token` (except on auth pages); multi-tab logout via `storage` event; `logout()` clears localStorage + redirects.
- **Socket wiring:** on `profile.vendorId`, `initSocket(token, vendorId)` and subscribes to `po:new`, `grn:received`, `payment:cleared`, `chat:message`, `log:new` — each refreshes the relevant hook, fires a toast, and writes SAP logs.
- **Cross-cutting action handlers** (async, toast success/error from real backend results): `handleCreateRFQ`, `handleBidSubmit`, `handleReissueRFQ`, `handleCancelRFQ`, `awardVendorBidWrapper`, `handleAsnSubmit`, `handleInvoiceSubmit`, `handleCompanySubmit`, `handleSendMessage`, `handleResetDatabase` (dev-only; only clears localStorage + reloads — never hit a real DB despite the label).
- A legacy `state` object (`{profile, rfqs, pos, asns, grns, invoices, payments, chats, logs, performance}`) is assembled for component back-compat.

### 8.4 Feature-sliced structure (`src/features/<domain>/`)
Each domain follows **`components/` + `hooks/` + `services/`** (+ sometimes `constants.js`, `validation.js`):

| Domain | Key pieces |
|---|---|
| `profile/` | `RegistrationView`, `useProfile`, `profileService`, `validation.js` (+`.test.js`) — pure `validateField` (PIN/email/phone/PAN/GSTIN/account/IFSC) |
| `rfq/` | `RfqView` (create/bid/evaluate/award, largest component), `useRFQs`, `rfqService`, `constants.js` |
| `purchase-order/` | `PurchaseOrdersView`, `usePOs`, `poService` |
| `billing/` | `InvoiceProcessingView`, `InvoicesView`, `useInvoices`, `invoiceService` |
| `payments/` | `PaymentTrackingView` (ledger CSV export, TDS registry, dispute→chat, Form-16A request→chat), `usePayments`, `paymentService` |
| `dashboard/` | `DashboardView`, `CommunicationsView`, `PerformanceView`, `ReportsAnalyticsView`, `useDashboard`, `dashboardService`, `constants.js` (INITIAL_CHATS / INITIAL_PERFORMANCE seeds) |

**Convention:** `service` = thin `apiClient` wrappers per endpoint; `hook` = React state + calls the service, returns `{success, error, ...}` shaped results (errors propagate, not swallowed); `View` = presentation, reads from `usePortal()`/props.

### 8.5 Shared UI (`src/components/`)
- `portal/`: `Header` (branding, theme toggle, notifications bell), `Sidebar` (nav + live badge counts; Admin Console link only for `role==='admin'` or `@enterprise.com`; dev-only Reset), `BapiConsole` (docked SAP payload debugger), `PortalLayout`, `ToastNotification`.
- `ui/`: hand-rolled primitives — `Card, KPICard, Modal, Drawer, StatusBadge, EmptyState, Spinner, SkeletonLoader, TableSkeleton, CommandPalette, Page`, plus shadcn `button.tsx`.
- `shared/`: `FileUploadZone`, `SkeletonLoader`. `ErrorBoundary.jsx`.

### 8.6 `src/lib/`
`api-client.js` (fetch wrapper: attaches `Bearer` JWT, 401→clears storage+redirect to `/sign-in` unless on a public auth page, network errors return `null`), `socket.js` (singleton socket init/close), `portal-context.js`, `shell-context.js`, `theme-context.js`, `statusColors.js`, `chartTheme.js`, `utils.ts` (`cn()`).

### 8.7 Client-side persistence (localStorage keys)
`jwt_token`, `clerk_user_id` (legacy), `sap_vendor_profile_data`, `sap_vendor_portal_logs`, `vc-theme`, `sap_vendor_portal_quote_draft`, `sap_vendor_portal_rfq_draft` (RFQ/quote draft autosave/restore), and — deliberately separate from all of the above — `vc_platform_token` for the platform console.

### 8.8 The platform console (`src/app/platform/`)
A second plane inside the same Next app, sharing only the design system.

- **`src/lib/planes.js`** — `isPlatformPath` / `isWorkspacePath` / `hasOwnChrome(pathname)`. Three places consult it, and they are the whole integration with the supplier portal: `PortalLayout` renders `children` bare under `/platform` and `/workspace`, `PortalProvider` does not redirect an operator to `/sign-in`, and `api-client.js` does not hijack a 401 on the platform plane.
- **`src/lib/platform-client.js`** — its own fetch wrapper, its own token key (`vc_platform_token`), and `PlatformApiError` carrying `status` / `reason` / field `errors`.
- **`src/lib/platform-session.js`** — `PlatformSessionProvider` + `usePlatformSession()`. The server decides the flow: `STAGE.SIGNED_OUT → CHANGE_PASSWORD → ENROL_MFA → VERIFY_MFA → CONSOLE`, derived from `/platform/auth/me`. Exposes `can(permission)`.
- **`src/components/platform/PlatformGate.jsx`** — renders the right step of that flow, or the console. `/platform/reset-password` is its only public route.
- **`src/lib/platformNav.js`** — the nav registry; the layout filters it by the operator's permissions, so an `sap_manager` never sees Operators.
- **`src/components/console/primitives.jsx`** — `PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate`, **shared with the tenant workspace** (it moved out of `components/platform/` in Phase 5). `useResource(loader, key)` reloads when `key` changes and exposes `reload`.

### 8.9 The tenant workspace (`src/app/workspace/`)
The third plane: the client's own back office, for `client_admin` / `buyer` / `finance`. Same contract as §8.8, different plane — and it shares the supplier portal's token (`jwt_token`) and `api-client.js`, because tenant staff and suppliers authenticate through the same `/api/auth` surface.

- **`src/lib/workspace-session.js`** — `WorkspaceSessionProvider` + `useWorkspaceSession()`. Reads `GET /api/auth/me`; stages are `LOADING → SIGNED_OUT | WRONG_PLANE | WORKSPACE`. Exposes `user`, `workspace` (identity + branding + feature flags), `permissions`, `can()`, `refresh()`.
- **`src/lib/workspaceNav.js`** — the nav registry, filtered by the permissions the API reports. `workspaceNav.test.js` checks its permission strings against the **real** backend map, so a typo cannot silently hide a tab.
- **`src/app/workspace/layout.jsx`** — the chrome (tenant name, branding logo, permission-filtered nav) plus the gate: signed-out redirects to `/sign-in`, a supplier gets "not your workspace" rather than a 403 wall.
- **Screens.** `/workspace` overview (queue, SLA breaches, sourcing/finance counts, usage vs limits — every tile links to the screen that acts on it) · `/suppliers` (directory, search, status filter, approve/decline, invite, and the tenant-side create form that renders from `SUPPLIER_IDENTITY_FIELDS` and runs the supplier form's own `validateField` rules) · `/users` (staff, role changes, suspend/reactivate, invitations; roles come from `GET /users/roles`) · `/settings` (renders entirely from the settings registry the API serves — it knows how to draw a boolean, a number and a string, and nothing about which settings exist) · `/audit`.
- **`src/lib/whoami.js`** — `useWhoami()`, the one bit of session the supplier portal's sidebar and command palette need in order to show the back-office link (ADR-0027).

**The supplier plane under tenancy (Phase 6).**
- **`src/lib/workspace-realm.js`** — `useWorkspaceRealm()`, reading `GET /auth/workspace` once (module-cached, like `whoami.js`): whose front door this is, before anyone is signed in. `known` separates "still loading" from "no workspace at this address"; `selfRegistrationOpen` assumes open until told otherwise, because the API is the enforcement point.
- **`src/lib/branding.js`** — pure. `accentVariables(hex)` moves **one** variable, `--color-emerald-default-rgb`, and returns `{}` for anything that is not a six-digit hex colour (ADR-0030); `brandMark(workspace)` picks the tenant's logo or the product's. `branding.test.js` checks it against the real settings registry.
- **`src/components/portal/TenantBranding.jsx`** — sets those variables on `<html>` for the supplier portal and its auth pages; renders nothing. The platform console is deliberately not branded.
- **`src/components/portal/WorkspaceBrand.jsx`** — the mark on a signed-out screen: the buyer's name and logo, VendorConnect as the caption. `/sign-in` hides the register link and `/sign-up` explains itself when the workspace admits suppliers by invitation only.

---

## 9. Authentication & Authorization (current, real)

- **Registration** (`POST /auth/register`): resolves the target workspace first (`utils/resolveClient.js`, ADR-0004) and creates the vendor inside that tenant; bcrypt-hashed password; server assigns `vendorId` (`VND-#####`) unless supplied; self-registered vendors start `Draft`. Self-registration only ever produces a supplier — staff accounts come from an invitation or from tenant provisioning, and `ADMIN_BOOTSTRAP_EMAILS` is gone (ADR-0009). A workspace may close self-registration entirely; an invited supplier still gets in. Returns JWT (30d).
- **Login**: by email or vendorId; bcrypt compare; JWT. Password hash is stripped from all responses (`formatVendorResponse` deletes it — `select:false` alone doesn't cover `create()`/`+password`).
- **Password reset**: `forgot-password` issues a SHA-256-hashed 1h token and **emails** the link (ADR-0011), returning a generic message (no user enumeration); `reset-password` consumes it. The same mechanism gives a tenant-created supplier their first password (ADR-0026).
- **RBAC**: every route declares one permission with `requirePermission(...)`; `config/permissions.js` decides who holds it, and `route-role-matrix.test.js` fails CI on a route that declares none. Nav registries on all three planes filter on the permission list `/auth/me` reports, so a hidden tab and a refused request are the same rule (UX only; the server is the boundary).
- **Identity is server-derived**: the frontend no longer sends `x-vendor-id`; JWT is the source of truth. The `x-vendor-id` header only works as a **dev/test** fallback and is inert when `NODE_ENV=production`.
- **A supplier's scope is not negotiable.** `?all=true` widens a list for tenant staff only. `GET /rfqs` and `GET /logs` used to honour it for anyone, which handed a supplier every RFQ in the tenant and every SAP log payload in it — `VENDOR_CREATE` entries carry other suppliers' bank details. Both now check `isSupplier(req)` first; every other list endpoint already went through `withVendorScope`, which is unconditional. `tests/rbac-hardening.test.js` covers it.
- **Temporary passwords are enforced, not just reported.** Tenant provisioning and operator creation both issue a generated password with `mustChangePassword`. `req.auth.mustChangePassword` is reported on **every** session by `GET /auth/me` (not only in the login response), and `lib/portal-context.js` redirects to `/change-password` until it clears — so a refresh is not a way past it. The platform console enforces the same rule in its own gate (`lib/platform-session.js`).
- **Invitations land on `/accept-invitation`.** `POST /users/invitations` and `POST /vendors/invitations` email a link to that page, which previews the invitation, then creates the staff account outright or hands a supplier off to `/sign-up` when the API answers `next: 'register'`. The public-path list the layout, the session provider and `api-client.js` each need lives once, in `lib/planes.js` (`isAuthPath`).

---

## 10. Testing

**Backend** (`backend/`, Jest + Supertest against a real Postgres instance, `NODE_ENV=test`, `--forceExit`):
`tests/setup.js` resets every table (`DELETE` with `session_replication_role = 'replica'` to skip FK-trigger ordering, falling back to `TRUNCATE ... CASCADE` if the DB role lacks the privilege) before and after each test — needs `npx prisma migrate deploy` already run against `DATABASE_URL`; `tests/testApp.js` (real routes + errorHandler, no sockets/CORS/rate-limit), `tests/helpers.js` (`registerVendor`, `createTenantUser`, `createPlatformUser`, `createOperatorSession` — an operator who has already cleared MFA — and `asTenant`). Suites include: `auth.test.js`, `auth-middleware.test.js`, `vendor.test.js`, `vendor-detail.test.js`, `vendor-create-map.test.js`, `rfq.test.js` (full lifecycle + scoring math + award), `rfq-sap-quotations.test.js`, `password-reset.test.js`, `identity.test.js`, **`route-role-matrix.test.js`** (walks the real router; a route with no permission fails CI), **`tenant-isolation.test.js`** (2 tenants × every model × read/update/delete/count, plus API-level 404s), **`tenant-wide-visibility.test.js`**, **`rbac-hardening.test.js`**, **`platform-console.test.js`** (tenant lifecycle, the end-to-end provisioning acceptance test, MFA gating, operator management, audit, health, plane separation), **`crypto-primitives.test.js`** (TOTP against the RFC 6238 vectors; AES-GCM round-trip and tamper rejection), **`sap-adapter.test.js`**, **`sap-conformance.test.js`**, **`sap-read-contracts.test.js`**, **`po-sap-status.test.js`**, **`decimal-money-fields.test.js`**, **`sequential-id-overflow.test.js`**, **`id-collision-retry.test.js`**, **`prisma-error-mapping.test.js`**, **`tds-summary.test.js`**, **`phase7-operations.test.js`**, **`invoice-plan.test.js`**, **`workspace.test.js`** (the tenant back office: overview scoping and SLA counting, the settings registry and its whole-or-nothing patch, feature flags closing `/api/chats` for one tenant and not another, self-registration closed but invitations still admitted, tenant-side supplier creation, decision emails, and the audit view's tenant scope and operator anonymisation), **`tenant-realm.test.js`** (subdomain resolution and its reserved labels, the header ignored in production, the public realm endpoint's 404s, registration and login addressed to one workspace), **`lifecycle-e2e.test.js`** (the phase-6 acceptance test: a full RFQ→bid→award→PO→ASN→GRN→invoice→payment cycle on the mock driver, with a second tenant running the same cycle and seeing none of it — 404 per document, empty lists, no cross-realm login; ADR-0029). 29 suites, 448 passing + 2 skipped as of the Postgres/Mongoose-removal baseline (§0).

**Running them.** `npx jest --runInBand` in `backend/` — parallel is unreliable (shared Postgres instance, table-reset races), so serial is the dependable way to run the whole suite locally and in CI.

`tests/setup.js` seeds the `CLT-0001` tenant before each test, because every request path now resolves one. Test code touching models directly must bind a tenant with the `asTenant()` helper — the same rule application code follows.

**Frontend** (root, Vitest + jsdom + Testing Library, `src/**/*.test.{js,jsx}`). 20 files, 191 tests.

*Pure functions:* `src/features/profile/validation.test.js`, `src/lib/platformNav.test.js` and `src/lib/workspaceNav.test.js` — the two nav registries are checked against the real backend permission map via `createRequire`, so the two languages cannot drift silently — plus `branding`, `onboarding`, `sapDocuments`, `sapFields` and `syncState`.

*The harness* — `src/test/renderWithPortal.jsx`. **The seam is `fetch`, not the modules above it**: stubbing `api-client.js` would skip the code that builds the request, attaches the token and turns a non-2xx body into an error carrying `errors`/`reason`, which is exactly the code a form test needs to be real. A test declares what the *server* says and everything below the component runs for real.

```js
renderWithPortal(<RfqsPage />, {
  plane: 'supplier',            // 'supplier' | 'workspace' | 'platform' | 'bare'
  route: '/rfqs',               // what usePathname() returns
  api: { 'GET /rfqs': { rfqs: [] } },   // '<METHOD> <path>' → body, or { status, body }, or a fn
});
// → { apiMock, socket, navigation, ...RTL }
```

Each plane wraps the page in the provider stack its real layout gives it. `apiMock.unmatched` lists routes the page asked for that the fixture set does not describe; `apiMock.lastBody(method, path)` is the submitted payload. `socket.emitServerEvent('po:new', …)` pushes a server event at the mounted tree. `src/test/fixtures.js` holds empty-but-correctly-shaped responses per endpoint, taken from the controllers that serve them. Two gotchas the harness absorbs: a dynamic route's `params` must be passed through `routeParams()` (a plain `Promise` never settles under the test renderer, and the page suspends forever), and `next/navigation`, `next/link` and `lib/socket` are mocked globally in `src/test/setup.jsx`.

*Coverage:* every `src/app/**/page.jsx` has a render/heading/empty-state smoke test (`supplier-routes`, `workspace-routes`, `platform-routes`, `auth-routes`, `detail-routes`), and **`route-coverage.test.jsx` fails if a new route has none** — the same drift guard the nav registries use, applied to routes. Submit-path tests cover the bid form, ASN, invoice and registration (`bid-submission`, `asn-invoice-submission`, `registration-form`). Behaviour tests cover the platform MFA gate (`platform-gate`), the realtime listeners (`socket-events`) and the honest-SAP-state rule the product rests on (`honest-sap-state`). End-to-end browser coverage (Playwright) is not here yet — see issue #24's remaining criteria.

**Bugs found & fixed by tests (historical — the audit log that documented these, `IMPLEMENTATION_PLAN.md`, has since been removed; see `git log` for detail):** RFQ `submitBid` TDZ crash on non-invited vendors; password hash leaking in register/login responses.

---

## 11. Design System — "Kinetic Industrial Console" (`DESIGN.md`)

High-density, high-contrast **industrial terminal** aesthetic (think Bloomberg, not soft SaaS). Rules that matter when writing UI:
- **Zero border-radius everywhere. No drop shadows** — depth via 1px zinc borders + tonal background shifts.
- Palette: base black `#09090b`, surfaces `#131315`–`#18181b`, borders `#27272a`/`#3f3f46`, primary/success electric green `#059669` (black text on it), error `#e11d48`, warning `#d97706`, muted `#71717a`, near-white text `#fafafa`.
- **Dual font:** Inter for chrome; JetBrains Mono for *all* tabular data, IDs, amounts, compliance codes (GST/TDS/MSME), and BAPI payloads (`tabular-nums`).
- Tight 4px spacing grid, 32–40px row heights.
- India-compliance anchors (GST/TDS/MSME) are primary visual elements. Target WCAG 2.1 AA (≥4.5:1 contrast), keyboard-navigable, respect `prefers-reduced-motion`.

(Actual token values live in `src/app/globals.css`; the runtime app is dark-first with a light theme toggle.)

**`.impeccable/` + `.cursor/`/`.gemini/` skills:** an "impeccable" design-linter dev tool (critiques stored in `.impeccable/critique/`). Not application code.

---

## 12. Docs in `workflow/` and `docs/` (context, but partly stale)

`workflow/architecture_document.md` (huge v1.0 architecture doc — **stale in places**: it predates auth + the original Mongoose models + the multi-route migration, and describes a single-page `activeTab` router and "no authentication"; use it for the SAP field-mapping catalog and P2P/BAPI reference, not current wiring), plus `SAP_Communication.md`, `socket_io_architecture.md`, `frontend_transition.md`, `sprint_roadmap.md`, `walkthrough.md`, `working.md`, `task.md`, `README.md`. `PRODUCT.md` and `IMPLEMENTATION_PLAN.md` (the earlier audit + remediation log) have been removed from the repo root; consult `git log`/`git show` for their content if needed.

`docs/runbooks/` holds the operational playbooks (incident response, tenant suspension/termination, key rotation, the backup drill — §5.7). `docs/*.md` at that level holds forward-looking engineering plans meant to be executed phase-by-phase (e.g. `docs/04-sap-runtime-engineering-plan.md`) — read a plan's own "Status" line before assuming it's still current against the code.

**When docs conflict with code, trust the code**, then this PROJECT_CONTEXT.md, then `docs/`, then the `workflow/` docs (oldest).

---

## 13. Conventions & Gotchas (read before editing)

1. **Two packages, two test suites.** Backend changes → `cd backend`. Frontend build/test at root.
2. **SAP goes through the adapter, always.** No controller imports a driver or writes a SapLog: it calls `getSapAdapterForClient(req.clientId)` and then a contract method (§5.6). The simulator is the `mock` driver. Adding a call means adding a transaction to `config/sapTransactions.js`, a method to `sap/contract.js`, and an implementation to every driver — the skeletons inherit `not_implemented` automatically.
3. **`vendorId` (string) is the link, not `pk`.** Many queries use `OR: [{vendorId}, {clerkId: vendorId}]` for legacy compat.
4. **`clerk*` names are legacy.** Clerk auth was abandoned for local JWT; `clerkUserId`/`clerkId` persist as identifiers only.
5. **App Router is real** — pages live in `src/app/*/page.jsx`; navigation is `router.push`. Ignore older "activeTab-only SPA" descriptions.
6. **Feature-sliced pattern:** put new domain logic in `src/features/<domain>/{components,hooks,services}`; hooks return `{success, error}`; don't swallow errors; surface via `addToast`.
7. **Design rules are strict:** 0px radius, no shadows, mono font for data. See §11.
8. **There is no role-elevation endpoint, and no `admin` role.** `ADMIN_BOOTSTRAP_EMAILS` was removed by ADR-0009 and the server refuses to start if it is still set (§4) — staff arrive by invitation or tenant provisioning. Roles and their planes live in `config/roles.js`; statuses in `config/statuses.js` — never inline either list.
9. **Modified Next.js 16** — consult `node_modules/next/dist/docs/` before using Next APIs (AGENTS.md mandate).
10. **Committed artifacts** (`backend/logs/`, `backend/uploads/`, root `node_modules` entries in git) are not source; don't treat them as such.
11. **`apiClient` returns `null` on network failure** (doesn't throw) — callers must handle null.
12. **Backend tests need `--forceExit`** because `submitRegistration` schedules a 5s auto-approve timer.
13. **Sequential business ids come from a counter, not a scan.** `utils/nextSequentialId.js` allocates `RFQ-YYYY-NNN` / `PO-YYYY-NNNN` with one atomic `UPDATE ... RETURNING` against `document_counters` (one row per tenant + prefix), so it is O(1) in the tenant's document count and two allocators — an award inside its transaction, a discovery sweep outside one — can never be handed the same number. A counter with no row yet seeds itself past the highest suffix already present, which is how rows predating the table and SAP-originated documents are absorbed. Gaps from rolled-back transactions are expected and harmless. Never compare id suffixes as strings (`'1000' < '999'`); see `tests/sequential-id-overflow.test.js`.
```
