# PROJECT CONTEXT — VendorConnect / SAP Vendor Portal

> **Purpose of this file.** A single, self-contained reference that gives any developer or AI agent the *complete* mental model of this project — architecture, data model, every module, every API endpoint, the SAP-simulation design, conventions, and known gotchas — **without needing the codebase open**. Read this top to bottom and you can navigate, extend, or debug the system.
>
> **Last synced with code:** 2026-08-12. If code and this file disagree, the code wins — but please update this file.
>
> ⚠️ **This app is now multi-tenant** (SaaS Phase 1 complete). Every tenant-scoped query
> runs inside a bound tenant context or it *throws*. Read §5.5 before writing any backend
> code; the SaaS plan lives in `SAAS_IMPLEMENTATION_PLAN.md` and the decisions in
> `DECISIONS.md`.

---

## 0. TL;DR

**VendorConnect Portal** is a full-stack, SAP-integrated **supplier self-service platform** for Indian manufacturing procurement. It digitizes the entire **Procure-to-Pay (P2P)** lifecycle — vendor onboarding → RFQ/bidding → PO → dispatch (ASN) → goods receipt (GRN) → invoice (MIRO) → payment (F110) — and surfaces every step as **simulated SAP BAPI/RFC/OData/IDoc payloads** in a live console.

- **Frontend:** Next.js 16 (App Router) + React 19 + Tailwind CSS v4, one client-side SPA shell. `src/`
- **Backend:** Express 5 REST API + Socket.io + MongoDB (Mongoose). `backend/`
- **Auth:** JWT (bcrypt password hashing), role-based (`vendor` | `admin`), **tenant-scoped** — the token carries `clientId` + `roleScope`.
- **Multi-tenant:** every business document belongs to a `Client` tenant; isolation is enforced in the ODM, not by convention (§5.5).
- **SAP is simulated** — no real RFC connection. "SAP sync" = writing `SapLog` records + `setTimeout`-driven fake GRN/payment runs. This is intentional and clearly boundaried in code.
- **Two separate npm packages** with two separate test suites: root (frontend, Vitest) and `backend/` (Jest + Supertest + mongodb-memory-server).

> ⚠️ **AGENTS.md warning (repo-wide):** This is a *modified* Next.js 16 — APIs/conventions may differ from training data. Before writing Next.js code, read the relevant guide under `node_modules/next/dist/docs/`.

---

## 1. Repository Layout (top level)

```
sap_vendor_portal/
├── src/                     ← Next.js frontend (App Router SPA)
├── backend/                 ← Express + Mongoose API server (own package.json)
├── public/                  ← static assets
├── mongodb_data/            ← a committed local MongoDB data dir (WiredTiger files) *
├── workflow/                ← long-form design/architecture/roadmap docs (see §12)
├── .github/workflows/test.yml ← CI: runs BOTH frontend + backend test suites
├── AGENTS.md / CLAUDE.md    ← agent instructions (CLAUDE.md just @-includes AGENTS.md)
├── PRODUCT.md               ← product brief (users, purpose, brand, a11y)
├── DESIGN.md                ← "Kinetic Industrial Console" design system (tokens + rules)
├── IMPLEMENTATION_PLAN.md   ← detailed audit + phased remediation log (Phases 1–6, mostly done)
├── README.md                ← stock create-next-app readme (not project-specific)
├── package.json             ← FRONTEND package (Next, React, some backend deps duplicated)
├── next.config.ts           ← reactCompiler: true
├── components.json          ← shadcn/ui registry config
├── vitest.config.mjs        ← frontend test config (src/**/*.test.{js,jsx})
├── tsconfig.json, eslint.config.mjs, postcss.config.mjs
└── .cursor/ .gemini/ .impeccable/ ← "impeccable" design-linter tool skill (dev tooling, ignorable)
```

\* `mongodb_data/` and `backend/logs/`, `backend/uploads/` are committed artifacts (local dev data / winston logs / an uploaded PDF). They are **not** application source.

**Note on `package.json` duplication:** the root (frontend) package.json lists backend-ish deps (express, mongoose, socket.io, bcryptjs, jsonwebtoken…) *and* frontend deps. The **actual backend** runs from `backend/package.json` (its own `node_modules`). When touching the API, use `backend/`.

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
| DB / ODM | MongoDB / Mongoose | ^9.6 | |
| Realtime (server) | socket.io | ^4.8 | per-vendor rooms + `procurement` room |
| Auth | jsonwebtoken + bcryptjs | ^9 / ^3 | 30-day JWT default |
| Validation | zod | ^4 | `backend/validators/*` via `validate` middleware |
| Security | helmet, cors, express-rate-limit, express-mongo-sanitize, hpp, compression | — | see `server.js` |
| Logging | winston + winston-daily-rotate-file, morgan | — | `backend/logs/` |
| PDF | pdfkit | ^0.19 | statement / invoice PDFs (`reports.controller`) |
| Uploads | multer | ^2.1 | `backend/uploads/` |
| Backend tests | jest + supertest + mongodb-memory-server | — | `backend` package; `NODE_ENV=test`, `--forceExit` |
| Node | v22.x | | |

---

## 3. How to Run

**Backend** (`cd backend`): copy `.env.example` → `.env`, set `MONGO_URI` (Atlas or local), then `npm install` → `npm run dev` (nodemon, port **5000**) or `npm start`. Tests: `npm test`.

**Frontend** (repo root): `npm install` → `npm run dev` (Next dev, port **3000**). Build: `npm run build`. Tests: `npm test` (Vitest). Lint: `npm run lint`.

Frontend talks to backend via `NEXT_PUBLIC_API_URL` (default `http://localhost:5000/api`). Socket connects to the same host with `/api` stripped.

**CI:** `.github/workflows/test.yml` runs both suites on PRs and pushes to `master`.

---

## 4. Environment Variables (`backend/.env`)

| Var | Purpose |
|---|---|
| `PORT` | API port (default 5000) |
| `MONGO_URI` | MongoDB connection string |
| `FRONTEND_URL`, `ALLOWED_ORIGINS` | CORS allowlist (localhost:3000-3002/5173 always allowed) |
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
| `UPLOAD_DIR`, `MAX_FILE_SIZE_MB` | multer config |
| `CLERK_*` | **Deprecated/unused** — Clerk was the original auth plan; replaced by local JWT. `clerkId`/`clerkUserId` names survive as legacy identifiers. |

Frontend uses `NEXT_PUBLIC_API_URL` only.

---

## 5. Domain Model & the P2P Lifecycle

The whole app models one pipeline. Each stage produces a MongoDB document and emits SAP log(s):

```
Vendor onboarding → RFQ (bidding) → award → Purchase Order → ASN (dispatch)
   → GRN (goods receipt) → Invoice (MIRO) → Payment (F110 / UTR)
```

**SAP transaction-code mapping** (simulated, surfaced in UI/logs):
ME41 create RFQ · ME47 submit quotation · ME48 evaluate · ME58 award→PO · VL31N ASN/inbound delivery · MIGO/MB01 goods receipt · MIRO invoice verification · F110 payment run · FBL1N ledger clearing · XK01/FI02 vendor master.

**Two simulated async timers drive the "SAP push":**
- After **ASN submit** → backend fakes MIGO goods receipt via a **~10s `setTimeout`** (`[SIMULATOR]` logs), creating a GRN and emitting `grn:received`.
- After **invoice submit** → backend fakes F110 payment run via a **~12s `setTimeout`**, creating a Payment and emitting `payment:cleared`.
- On **registration submit** → a **5s `setTimeout`** auto-approves the vendor (why backend tests need `--forceExit`).

The frontend `portal-context.js` also sets fallback refresh `setTimeout`s (~11s / ~13s) explicitly commented `// MOCK —` so they aren't mistaken for real polling.

---

### 5.5 Multi-tenancy (read this before touching the backend)

Every business document belongs to a **tenant** (`Client`, e.g. `CLT-0001`). Three
mechanisms enforce it; none of them is optional:

1. **Tenant context** (`utils/tenantContext.js`) — an `AsyncLocalStorage` store.
   `protect` binds the authenticated account's `clientId` for the whole request.
   Out-of-request work (the simulator `setTimeout`s, scripts, future jobs) must re-bind it
   itself with `runWithTenant(clientId, fn)`.
2. **Tenant plugin** (`models/plugins/tenantPlugin.js`) — applied to all ten tenant-scoped
   schemas. Auto-injects `clientId` into find/findOne/update/delete/count/distinct/
   aggregate, auto-stamps it on save/insertMany, ignores caller-supplied `clientId`,
   refuses to move a document between tenants, and **throws `MissingTenantContextError`
   when nothing is bound**. `estimatedDocumentCount` is not intercepted (it takes no
   filter) — use `countDocuments`.
3. **Socket rooms** — `client:{clientId}:vendor:{vendorId}` and
   `client:{clientId}:procurement`. The handshake requires a JWT carrying a `clientId`;
   `emitToVendor(io, clientId, vendorId, …)` and `emitToProcurement(io, clientId, …)` take
   it as a required argument.

**The escape hatch** is `withoutTenantScope(fn)` — deliberately greppable, for
platform-plane work and the handful of pre-authentication lookups (login, register,
password reset, `protect`'s own account lookup) that must run before a tenant is known.
Never call it from a tenant endpoint.

**Gotcha that will bite you:** a Mongoose Query is lazy, so it must be *executed* inside
the context. `runWithTenant`/`withoutTenantScope` await their callback for exactly this
reason; if you write your own wrapper, do the same.

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

## 6. Database Schemas (Mongoose, `backend/models/`)

**All ten transactional collections carry a required, indexed `clientId`** (added by the
tenant plugin, not written by hand) plus compound indexes — `{clientId, id}` unique,
`{clientId, vendorId}`, `{clientId, status}`. **Business IDs are unique per tenant, not
globally**: two tenants may both hold `RFQ-2026-001`. The exception is `Vendor`, whose
`vendorId`/`email`/`gstin` remain globally unique because they are login identities
(ADR-0002); its `sapVendorCode` is per-tenant.

### Client (`Client.js`) — the tenant. **Not** tenant-scoped; only the platform plane owns it
- `clientId` (`CLT-0001`, unique), `companyName`, `slug` (subdomain, unique), `status`
  (`Trial|Active|Suspended|Terminated`), `plan`, `branding{logo,primaryColor}`,
  `featureFlags{}`, `limits{vendors,rfqsPerMonth,storageMb}`, `createdBy`,
  `activatedAt`/`suspendedAt`/`terminatedAt`.
- `isOperational()` — only `Trial`/`Active` tenants may authenticate or transact.

All string business IDs (`id`, `vendorId`, `poId`, …) are human-readable and unique; `_id` is the Mongo ObjectId. `vendorId` (a string like `VND-40013`) is the cross-collection link to a vendor — **not** the Mongo `_id`. Legacy field `clerkId`/`vendorId` are matched with `$or` in several places.

### Vendor (`Vendor.js`) — master data / auth principal
- `vendorId` (unique, e.g. `VND-40013`), `clerkId` (deprecated), `role` (`vendor`|`admin`, default `vendor`).
- `password` (bcrypt, `select:false`), `resetPasswordToken`/`resetPasswordExpires` (`select:false`).
- Company: `companyName`(req), `tradeName`, `businessType`, `incorporationDate`, `gstin`(req, unique, upper), `gstType`, `pan`(req, upper), `cin`, `msmeNumber`, `tdsSection`, `email`(req, unique, lower), `phone`.
- **Flat** address (`address/city/state/postalCode`) and bank (`bankName/accountNumber/ifscCode/accountName/bankBranch`). Responses re-nest bank into a `bankDetails` object for backward compat (`formatVendorResponse`).
- Compliance doc filenames: `cancelledCheque, panCardCopy, gstCertificate, incorporationCertificate, msmeCertificate, isoCertificate, itReturns`.
- KYC: `gstinVerified`, `panVerified`, `verifiedAt`, `verificationDetails`.
- SAP/status: `sapVendorCode` (unique sparse), `status` (`Draft`|`Pending`|`Pending Approval`|`Under Review`|`Approved`|`Rejected`, default `Draft`), `rejectionReason`, `vendorCategory`, `submittedAt`, `approvedAt`.
- Hooks: pre-save bcrypt hash; `comparePassword()` method.

### RFQ (`RFQ.js`) — transaction, embeds bids
- `id` `RFQ-YYYY-NNN` (unique, sequential), `description`, `status` (`Draft`|`Bidding Open`|`Submitted`|`Under Review`|`Awarded`|`Closed`, default `Bidding Open`), `deadlineDate`, `rfqType` (`AN`|`AB`), `paymentTerms`, `purchasingOrg`/`companyCode` (`1000`), `currency` (`INR`), `deliveryLocation`.
- `items[]`: `line, materialCode, description, quantity, uom(EA), targetPrice, plant(1000), deliveryDate`.
- `bids[]`: `vendorId, vendorDbId(ObjectId), vendorName, unitPrices(Map<lineNo,price>), gstRate, taxCode(G1..G4), freight, deliveryLeadTimeDays, vendorRating, technicalScore(80), validityDate, moq, remarks, uploadedDocs[], submittedAt`.
- `invitedVendors[]`: `{id, name, status, rating}`; plus `awardedVendorId/Name/awardedAt/convertedPoId`.

### PurchaseOrder (`PurchaseOrder.js`)
- `id` `PO-YYYY-NNNN`, `sapPoNumber` (`4500######`), `vendorId`, `vendorDbId`, `buyerName`, `plant`, `paymentTerms`, `currency`, `incoterms`, `deliveryAddress`, `status` (`Open`|`Acknowledged`|`Dispatched`|`Delivered`|`Invoiced`|`Paid`), `acknowledgedAt`, `fromRfqId`.
- `items[]`: `line, materialCode, description, quantity, grnQuantity, unitPrice, netValue, uom`.

### ASN (`ASN.js`) — advance shipping notice
- `id` `ASN-######`, `poId`, `vendorId`, `status` (`Submitted`|`In Transit`|`Received`), `shipDate`, `estimatedDeliveryDate`, `carrierName`, `trackingNumber`, `vehicleNumber`, `invoiceReference`, `ewayBillNo`, `sapInboundDelivery`, `documentIds[]`, `items[]` (`line, materialCode, description, shippedQuantity, uom`).

### GRN (`GRN.js`) — goods receipt (MIGO)
- `id` `GRN-…`, `poId`, `asnId`, `vendorId`, `sapMigoDoc`, `postingDate`, `receivedBy`, `invoiceSubmitted`.
- `items[]`: `line, materialCode, description, receivedQuantity, acceptedQuantity, rejectedQuantity, rejectionReason, uom`.
- Virtuals: `totalAccepted`, `rejectionRate` (serialized to JSON).

### Invoice (`Invoice.js`)
- `id`, `grnId`, `poId`, `vendorId`, `invoiceNumber`, `invoiceDate`, `sapMiroDoc`, `status` (`Submitted`|`Under Review`|`Match Warning`|`Approved`|`Posted in SAP`|`Cleared`), `subTotal`, `taxAmount`, `totalAmount`, `taxCode`(G1), `currency`, `matchWarning`, `items[]`, `postedAt`, `clearedAt`. Tax is computed at **18% GST**.

### Payment (`Payment.js`) — F110
- `id`, `invoiceId`, `poId`, `vendorId`, `invoiceRef`, `invoiceNumber`, `sapMiroDoc`, `grossAmount`, `tdsDeducted`, `netAmount`, `paymentDate`, `utrCode`, `paymentMethod` (`NEFT`|`RTGS`|`IMPS`), `sapPaymentDoc`, `bankName`, `runId` (F110 run). TDS certificate fields: `fiscalYear, quarter, tdsSection, deducteePan, deductorTan, totalTds`.

### ChatMessage (`ChatMessage.js`) — Communications hub
- `vendorId`, `sender` (`Vendor`|`Buyer`|`System`|`Finance`|`Quality`|`Warehouse`), `message`(≤1000), `linkedPoId`, `linkedRfqId`, `timestamp`, `isRead`.

### SapLog (`SapLog.js`) — the BAPI/RFC audit trail (drives the console)
- `vendorId`, `type` (`BAPI`|`RFC`|`OData`|`IDoc`|`SYS`|`KYC`), `direction` (`OUTBOUND`|`INBOUND`), `name` (e.g. `BAPI_RFQ_CREATE`), `payload` (JSON string), `status` (`SUCCESS`|`PENDING`|`FAILED`), `errorMessage`, `documentRef`, `timestamp`. **TTL index auto-purges after 30 days.**

### AuditLog (`AuditLog.js`) — the platform + tenant action trail. **Not** tenant-scoped (ADR-0014)
- `clientId` (optional — null for platform actions concerning no tenant), `actorId`, `actorRole`, `actorEmail`, `plane`, `action` (enum from `config/auditActions.js`), `target{type,id,label}`, `meta` (secrets redacted), `ip`, `at`. Indexes: `{at:-1}`, `{clientId,at:-1}`, `{action,at:-1}`, `{actorId,at:-1}`. **Append-only** — update/delete hooks throw. Written only through `utils/audit.js`.

### Document (`Document.js`) — uploaded files metadata
- `vendorId`, `fileName`, `originalName`, `mimeType`, `size`, `filePath`, `linkedTo` (`ASN`|`RFQ`|`Profile`|`Invoice`). Actual files land in `backend/uploads/`.

---

## 7. Backend Architecture (`backend/`)

**Entry:** `server.js` — loads `.env`, `validateEnv()`, builds Express app + HTTP server + Socket.io. Middleware order: helmet(CSP) → compression → Express-5 query redefinition shim → `express-mongo-sanitize` → `hpp` → CORS → JSON body limit (10kb, skipped for `/uploads`) → `requestLogger` → (prod only) `apiLimiter` → `/api` routes → `errorHandler`. Connects DB **before** listening.

**Socket.io auth (`io.use`)**: requires a valid JWT in `handshake.auth.token` carrying a `clientId` — there is no anonymous or `x-vendor-id` fallback any more (ADR-0006). On connect the socket joins `client:{clientId}:vendor:{vendorId}`; `join_procurement_room` joins `client:{clientId}:procurement`. A client cannot name the room it joins. `app.set('io', io)` so controllers can emit.

**Routing (`routes/index.js`):** everything under `/api`.
- `/api/health`, `/api/test-error` — public.
- `/api/auth` — public arms (register, login, forgot/reset password, invitation preview + accept); `/me` and `/change-password` carry their own guard.
- `/api/platform` — the platform plane, behind `protectPlatform`. **No tenant is bound here.** The `/auth/*` arm carries `protectPlatform` alone (it is how an operator reaches a full session); **everything else sits behind `router.use(protectPlatform, requireMfa)`** — tenants, operators, audit, health.
- **All other route groups are mounted behind `protect`** (JWT): `vendors, users, rfqs, pos, grns, invoices, payments, chats, uploads, reports, asns, logs, dashboard`. Inside each group **every route declares one permission** with `requirePermission(...)`; `config/permissions.js` decides which roles hold it (ADR-0012). `vendor.routes.js` applies `protect` per-route because `POST /vendors/profile` is public.

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
- `requirePlane(...planes)` — plane assertion for permissions held on more than one plane.

**Other middleware:** `errorHandler` (central, uses `ApiError`), `rateLimiter` (`apiLimiter`), `requestLogger`, `validate(schema)` (zod), `upload` (multer).

**Utils:** `ApiError` (badRequest/unauthorized/forbidden/notFound/conflict factories), `asyncHandler`, `logger` (winston), `sapLogger.createSapLog(...)` (writes `SapLog`), `socketEmitter` (`EVENTS` map + `emitToVendor` / `emitToProcurement`), `authToken` (signs/verifies session tokens for all three planes), `requestScope` (`vendorScope` / `requireVendorScope` / `withVendorScope` — the one answer to "whose rows is this request about"), `mailer` (smtp/log/memory transports; `assertMailerConfigured()` runs at boot).

**Registries — one module each, read everywhere, duplicated nowhere:** `config/roles.js` (roles → planes → account collection), `config/permissions.js` (role → permissions), `config/emailTemplates.js` (all outbound copy), `config/auditActions.js` (every auditable action; `recordAudit` rejects anything else), `config/tenantModels.js` (the tenant-scoped collections, iterated by the export and the per-tenant counts), and on the frontend `src/lib/platformNav.js` (console nav → permission).

**Secrets and MFA (Phase 3):** `utils/secretBox.js` — AES-256-GCM with a versioned envelope (`v1:iv:tag:ciphertext`), keyed by `MASTER_KEY`; production refuses to boot without it, dev/test derive one from `JWT_SECRET`. Phase 4's per-client SAP data keys extend the same format. `utils/totp.js` — RFC 6238, hand-rolled on node crypto, verified against the RFC vectors in `tests/crypto-primitives.test.js`. `utils/audit.js` — the only writer of `AuditLog`: stamps actor/plane/tenant, redacts secret-shaped keys, throws on an unregistered action.

**Services:** `tenantProvisioning.service.js` — creates a `Client` **and** its first `client_admin` as one operation (generated password, emailed once, `mustChangePassword`), rolling the Client back if the admin cannot be created. Also owns slug rules (reserved list, format) and `CLT-####` allocation.

**Socket events** (`utils/socketEmitter.js` `EVENTS`): `po:new`, `grn:received`, `payment:cleared`, `rfq:awarded`, `rfq:bid_received`, `chat:message`, `vendor:approved`, `log:new`. Emitters take `clientId` as a required first argument after `io`.

**Services:** `verification.service.js` — GSTIN/PAN KYC verification (mock or live third-party per env).

**Ad-hoc scripts (dev, not part of the app):** `check_all_data.js`, `seed_payments.js`, `test_endpoints.js`, `test_remaining_endpoints.js`, `test_week2_endpoints.js`, root `test_sockets.js`.

### 7.1 Complete API Endpoint Map

Base path `/api`. Auth column: **Public** / the permission the route declares (see `config/permissions.js` for who holds it). Phase 2 additions: `/api/users` (staff + invitations), `/api/vendors/invitations`, `/api/auth/invitations/:token`, `/api/auth/invitations/accept`, `/api/auth/change-password`, `/api/platform/auth/*`.

**Auth** (`auth.routes.js`, public):
| Method | Path | Controller | Notes |
|---|---|---|---|
| POST | `/auth/register` | register | zod `registerSchema`; assigns `vendorId` server-side if absent (`VND-#####`); `ADMIN_BOOTSTRAP_EMAILS`→admin; self-reg starts `Draft`; returns `{token, vendor}` |
| POST | `/auth/login` | login | by email or vendorId; returns `{token, vendor}` |
| GET | `/auth/me` | getMe | JWT |
| POST | `/auth/forgot-password` | forgotPassword | generic response (no enumeration); logs reset link (no mailer) |
| POST | `/auth/reset-password` | resetPassword | SHA-256 token, 1h expiry |

**Vendors** (`vendor.routes.js`):
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/vendors/profile` | JWT | current vendor profile |
| POST | `/vendors/profile` | — | create profile (`profileCreateSchema`) |
| PUT | `/vendors/profile` | JWT | update (`profileUpdateSchema`); flattens legacy nested address/bank |
| POST | `/vendors/profile/submit` | JWT | submit registration → 5s auto-approve timer |
| GET | `/vendors/performance` | JWT | scorecard KPIs |
| GET | `/vendors` | **Admin** | list vendors (filterable) |
| PUT | `/vendors/:id/approve` | **Admin** | approve |
| PUT | `/vendors/:id/reject` | **Admin** | reject (`rejectVendorSchema`) |

**RFQs** (`rfq.routes.js`, all JWT):
| Method | Path | Notes |
|---|---|---|
| GET | `/rfqs` | invited-vendor filtered unless `?all=true`; paginated |
| POST | `/rfqs` | create (`rfqCreateSchema`) → `BAPI_RFQ_CREATE` log |
| GET | `/rfqs/:id` | |
| PUT | `/rfqs/:id/cancel` | → status `Closed` |
| PUT | `/rfqs/:id/reissue` | new deadline, status → `Bidding Open` (`reissueRfqSchema`) |
| POST | `/rfqs/:id/bid` | submit quotation (`bidSchema`); validates deadline/status/all-lines-priced; GST→taxCode; first bid flips status to `Submitted` |
| GET | `/rfqs/:id/evaluate` | ME48 weighted scoring matrix |
| POST | `/rfqs/:id/award` | award winner → creates PO with bid prices, status `Awarded` |

**Evaluation formula (ME48):** `weighted = price*0.40 + technical*0.30 + delivery*0.20 + rating*0.10`, where `priceScore = lowestTotalCost/vendorTotalCost*100`, `deliveryScore = shortestLeadTime/vendorLeadTime*100`, technical default 80. **GST→tax code:** 5%→G3, 12%→G2, 18%→G1, 28%→G4.

**POs** (`po.routes.js`, JWT): `GET /pos`, `POST /pos/simulate` (spawn a demo inbound PO), `GET /pos/:id`, `PUT /pos/:id/acknowledge`, `PUT /pos/:id/status`, `POST /pos/:id/asn` (`asnCreateSchema` → fakes GRN in ~10s), `GET /pos/:id/asn`.

**ASNs** (`asn.routes.js`, JWT): `GET /asns`.

**GRNs** (`grn.routes.js`, JWT): `GET /grns`, `GET /grns/:id`.

**Invoices** (`invoice.routes.js`, JWT): `GET /invoices`, `POST /invoices` (`invoiceCreateSchema` → fakes F110 payment in ~12s), `GET /invoices/:id`, `PUT /invoices/:id/status`, `POST /invoices/:id/miro` (post MIRO doc).

**Payments** (`payment.routes.js`, JWT): `GET /payments`, `POST /payments`, `GET /payments/:id`, `PUT /payments/:id/status`.

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
| GET/POST | `/platform/operators` | `operator:manage` | super_admin only; new operators get emailed credentials + must enrol MFA |
| PUT | `/platform/operators/:id` | `operator:manage` | name/role; cannot change your own role |
| POST | `/platform/operators/:id/suspend` · `/reactivate` | `operator:manage` | cannot suspend yourself or the last active super admin |
| POST | `/platform/operators/:id/mfa/reset` | `operator:manage` | lost-device recovery; kills their sessions' console access |
| GET | `/platform/audit` | `platform:audit:read` | `?clientId,?action,?subject,?actorId,?plane,?from,?to`, paginated |
| GET | `/platform/audit/filters` | `platform:audit:read` | filter values from the registries, not from the data |
| GET | `/platform/health` | `platform:health:read` | per-tenant SAP status, error rate, usage vs limits, active users |

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
| `/admin` | admin console (inline) | admin-only, redirects non-admins |
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

- **`src/lib/planes.js`** — `isPlatformPath(pathname)`. Three places consult it, and they are the whole integration with the supplier portal: `PortalLayout` renders `children` bare under `/platform`, `PortalProvider` does not redirect an operator to `/sign-in`, and `api-client.js` does not hijack a 401 there.
- **`src/lib/platform-client.js`** — its own fetch wrapper, its own token key (`vc_platform_token`), and `PlatformApiError` carrying `status` / `reason` / field `errors`.
- **`src/lib/platform-session.js`** — `PlatformSessionProvider` + `usePlatformSession()`. The server decides the flow: `STAGE.SIGNED_OUT → CHANGE_PASSWORD → ENROL_MFA → VERIFY_MFA → CONSOLE`, derived from `/platform/auth/me`. Exposes `can(permission)`.
- **`src/components/platform/PlatformGate.jsx`** — renders the right step of that flow, or the console. `/platform/reset-password` is its only public route.
- **`src/lib/platformNav.js`** — the nav registry; the layout filters it by the operator's permissions, so an `sap_manager` never sees Operators.
- **`src/components/platform/primitives.jsx`** — `PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate`. `useResource(loader, key)` reloads when `key` changes and exposes `reload`.

---

## 9. Authentication & Authorization (current, real)

- **Registration** (`POST /auth/register`): resolves the target workspace first (`utils/resolveClient.js`, ADR-0004) and creates the vendor inside that tenant; bcrypt-hashed password; server assigns `vendorId` (`VND-#####`) unless supplied; email in `ADMIN_BOOTSTRAP_EMAILS` → `role:'admin'` (the *only* way to become admin); self-registered vendors start `Draft`. Returns JWT (30d).
- **Login**: by email or vendorId; bcrypt compare; JWT. Password hash is stripped from all responses (`formatVendorResponse` deletes it — `select:false` alone doesn't cover `create()`/`+password`).
- **Password reset**: `forgot-password` issues a SHA-256-hashed 1h token, logs the link (no mail service), returns a generic message (no user enumeration); `reset-password` consumes it.
- **RBAC**: `authorize('admin')` gates `GET /vendors`, approve, reject. Frontend `/admin` also redirects non-admins client-side (UX only; server is the real boundary).
- **Identity is server-derived**: the frontend no longer sends `x-vendor-id`; JWT is the source of truth. The `x-vendor-id` header only works as a **dev/test** fallback and is inert when `NODE_ENV=production`.

---

## 10. Testing

**Backend** (`backend/`, Jest + Supertest + `mongodb-memory-server`, `NODE_ENV=test`, `--forceExit`):
`tests/setup.js` (in-memory Mongo), `tests/testApp.js` (real routes + errorHandler, no sockets/CORS/rate-limit), `tests/helpers.js` (`registerVendor`, `createTenantUser`, `createPlatformUser`, `createOperatorSession` — an operator who has already cleared MFA — and `asTenant`). Suites: `auth.test.js`, `auth-middleware.test.js`, `vendor.test.js`, `rfq.test.js` (full lifecycle + scoring math + award), `password-reset.test.js`, `identity.test.js`, **`route-role-matrix.test.js`** (walks the real router; a route with no permission fails CI), **`tenant-plugin.test.js`** (the enforcement layer), **`tenant-isolation.test.js`** (2 tenants × every model × read/update/delete/count, plus API-level 404s), **`migrate-tenancy.test.js`**, **`platform-console.test.js`** (tenant lifecycle, the end-to-end provisioning acceptance test, MFA gating, operator management, audit, health, plane separation), **`crypto-primitives.test.js`** (TOTP against the RFC 6238 vectors; AES-GCM round-trip and tamper rejection). 196 tests.

`tests/setup.js` seeds the `CLT-0001` tenant before each test, because every request path now resolves one. Test code touching models directly must bind a tenant with the `asTenant()` helper — the same rule application code follows.

**Frontend** (root, Vitest, `src/**/*.test.{js,jsx}`): currently `src/features/profile/validation.test.js` (15 tests). Route/component smoke tests deferred (need a mocked `PortalProvider` with fetch + socket.io).

**Bugs found & fixed by tests (documented in IMPLEMENTATION_PLAN.md):** RFQ `submitBid` TDZ crash on non-invited vendors; password hash leaking in register/login responses.

**Known product quirk:** the first submitted bid flips RFQ status `Bidding Open`→`Submitted`, which then blocks a *second* vendor from bidding ("Bidding is closed"). Tests seed multi-bid scenarios directly via the model. Flagged for a product decision.

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

## 12. Docs in `workflow/` (context, but partly stale)

`architecture_document.md` (huge v1.0 architecture doc — **stale in places**: it predates auth + Mongoose models + the multi-route migration, and describes a single-page `activeTab` router and "no authentication"; use it for the SAP field-mapping catalog and P2P/BAPI reference, not current wiring), plus `SAP_Communication.md`, `socket_io_architecture.md`, `frontend_transition.md`, `sprint_roadmap.md`, `walkthrough.md`, `working.md`, `task.md`, `README.md`. `PRODUCT.md` = product brief. `IMPLEMENTATION_PLAN.md` = the authoritative recent audit + remediation log (Phases 1–6).

**When docs conflict with code, trust the code**, then this PROJECT_CONTEXT.md, then IMPLEMENTATION_PLAN.md, then the `workflow/` docs (oldest).

---

## 13. Conventions & Gotchas (read before editing)

1. **Two packages, two test suites.** Backend changes → `cd backend`. Frontend build/test at root.
2. **SAP is fully simulated.** "Sync" = `createSapLog(...)` + `setTimeout` fake GRN/payment, each wrapped in `runWithTenant` (ADR-0005). Don't add real RFC without a defined SAP contract. Keep the `// MOCK —` comments. SaaS Phase 4 moves all of this behind a `SapAdapter`.
3. **`vendorId` (string) is the link, not `_id`.** Many queries use `$or: [{vendorId}, {clerkId: vendorId}]` for legacy compat.
4. **`clerk*` names are legacy.** Clerk auth was abandoned for local JWT; `clerkUserId`/`clerkId` persist as identifiers only.
5. **App Router is real** — pages live in `src/app/*/page.jsx`; navigation is `router.push`. Ignore older "activeTab-only SPA" descriptions.
6. **Feature-sliced pattern:** put new domain logic in `src/features/<domain>/{components,hooks,services}`; hooks return `{success, error}`; don't swallow errors; surface via `addToast`.
7. **Design rules are strict:** 0px radius, no shadows, mono font for data. See §11.
8. **Admin role** only via `ADMIN_BOOTSTRAP_EMAILS` at first registration. There is no role-elevation endpoint. Roles and their planes live in `config/roles.js` — never inline a role list.
9. **Modified Next.js 16** — consult `node_modules/next/dist/docs/` before using Next APIs (AGENTS.md mandate).
10. **Committed artifacts** (`mongodb_data/`, `backend/logs/`, `backend/uploads/`, root `node_modules` entries in git) are not source; don't treat them as such.
11. **`apiClient` returns `null` on network failure** (doesn't throw) — callers must handle null.
12. **Backend tests need `--forceExit`** because `submitRegistration` schedules a 5s auto-approve timer.
```
