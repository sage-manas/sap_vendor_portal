# Claude Code Prompt — VendorConnect SaaS Conversion

## Paste everything below the line into Claude Code in the `sap_vendor_portal` repo.

---

Convert **VendorConnect** from a single-company portal into a multi-tenant SaaS, following `SAAS_IMPLEMENTATION_PLAN.md`. This is a working codebase — read before you write, and do not rewrite what already works.

## Orient first (before any code)

1. `AGENTS.md` — **this is a modified Next.js 16**; read the relevant guide under `node_modules/next/dist/docs/` before writing any Next.js code. Do not trust training-data conventions.
2. `PROJECT_CONTEXT.md` — the complete mental model: models, controllers, endpoint map, SAP simulation, gotchas. Trust the code over the doc where they disagree.
3. `SAAS_IMPLEMENTATION_PLAN.md` — **the authority for this work**: target architecture, six roles, data model, enforcement layer, phases, definition of done.
4. `SAAS_FEASIBILITY_GUIDE.md` — the rationale behind those decisions.
5. `DESIGN.md` — the "Kinetic Industrial Console" design system. All new UI obeys it; no new colours, no new type scale.

Two decisions are already made and are not open for reconsideration: **evolve in place** (Express 5 + Mongoose + Next.js — no stack change, no monorepo port) and **three planes** (platform → client tenant → supplier). There is no "customer" role in this product.

## Non-negotiable rules for every phase

- **No query without a tenant.** All tenant-scoped Mongoose models go through the tenant plugin; a query with no bound `clientId` context must **throw**, not silently return everything. Platform operations opt out only via an explicit, greppable `withoutTenantScope()`.
- **Cross-tenant access answers 404, never 403.** The API must not confirm that another tenant's document exists.
- **Platform roles hold no tenant business data.** `super_admin`/`sap_manager` operate on tenant *configuration*; they never read a tenant's RFQs, POs or invoices through tenant endpoints.
- **Secrets are encrypted, never returned, never logged, never audited in plaintext.**
- **No controller imports a SAP driver.** Everything goes through `getSapAdapterForClient(clientId)`.
- **Registries, not duplication.** Roles→permissions, nav items, statuses, SAP transaction codes and notification templates each live in exactly one module; screens and guards read from them.
- Both test suites (root Vitest, `backend/` Jest) stay green; every phase adds its own tests. Conventional Commits, PR-sized.
- Record every judgement call in a new `DECISIONS.md` at the repo root, ADR-style, newest first.

## Phases — strictly sequential. Do not start a phase before the previous one is green.

### Phase 1 — Tenancy foundation (highest risk; do not compress)
`Client` model. Add required, indexed 
`clientId` to `Vendor, RFQ, PurchaseOrder, ASN, GRN, Invoice, Payment, ChatMessage, SapLog, Document` with compound indexes (`{clientId, vendorId}`, `{clientId, status}`, `{clientId, id}`) — business IDs become unique **per tenant**, not globally. Build the `AsyncLocalStorage` tenant context, the Mongoose tenant plugin (auto-inject on read, auto-stamp on write, throw when unbound), and `withoutTenantScope()`. JWT gains `clientId` and `roleScope`. Socket rooms become `client:{clientId}:vendor:{vendorId}` / `client:{clientId}:procurement`, and `emitToVendor`/`emitToProcurement` take `clientId` as a required argument. Write the **cross-tenant isolation test suite** (two seeded tenants × every model × read/update/delete → expect 404) and the idempotent migration that creates `CLT-0001 "Legacy"` and back-fills all existing documents. No UI in this phase.

### Phase 2 — Identity, roles, invitations
Six roles with plane scoping: `super_admin`, `sap_manager` (platform) · `client_admin`, `buyer`, `finance` (tenant) · `vendor` (supplier). Decide and ADR whether tenant staff live in a new `User` collection or in a widened `Vendor` — the plan recommends a separate `User`, keeping `Vendor` as supplier master + supplier login. Add `PlatformUser` (separate collection, separate login surface). Extend `authorize()` to check plane **and** role. Build `Invitation` + invite-accept flow and **a real mailer** — logging reset links cannot ship. Harden password reset; remove `ADMIN_BOOTSTRAP_EMAILS`; ensure the `x-vendor-id` dev fallback cannot execute in production. Seed script for the first super admin. Then sweep every route's guard and add a **generated route×role matrix test** that fails CI when a route declares no permission.

### Phase 3 — Platform console
New `/platform` route group in the Next app (own layout, own nav filtered by permission) and `/api/platform/*` on the backend. Screens: tenant list / create / detail / edit / suspend / reactivate / terminate (soft, with data export); operator CRUD with **mandatory MFA on this plane**; audit explorer over `AuditLog` + `SapConnectionAudit`; platform health (per-tenant SAP status, error rates, usage vs limits, active users). **Tenant creation issues the first `client_admin` credentials** — generated, emailed, forced change on first login. That end-to-end flow is the acceptance test for this phase.

### Phase 4 — SAP configuration per tenant
`SapConnection` (+ append-only audit) with envelope-encrypted credentials (per-client data key wrapped by a master key from env, KMS-swappable). Define the `SapAdapter` contract and **move today's simulator wholesale into the `mock` driver** — the 10s GRN and 12s F110 timers become explicit, configurable driver behaviour rather than `setTimeout` scattered in controllers. Add `s4_odata` and `ecc_rfc` skeletons that throw `not_implemented`. Build `getSapAdapterForClient(clientId)` with per-client caching and a circuit breaker, and route every controller SAP touchpoint through it. Platform screens: configure / edit / **test connection** / health, sandbox vs production per tenant with an explicit promotion step. Every adapter result carries `{source, syncedAt}` so the UI can show freshness honestly.

### Phase 5 — Client workspace
Promote today's single `/admin` page into a real tenant back office: dashboard; supplier directory with approve/reject; **supplier invite / register-from-dashboard** reusing the same validation as self-registration (zero duplicated field lists); user management (invite buyers and finance users); tenant settings (branding, feature flags, approval thresholds, notification policy) driven by a settings registry; tenant audit view. Nav is permission-filtered — each role sees only its own tabs.

### Phase 6 — Supplier plane under tenancy
Supplier registration becomes tenant-aware (subdomain determines which client they register to); approval lands in that tenant's queue; every existing supplier screen keeps working, now scoped; per-tenant branding applied. Add a Playwright/e2e path proving a full RFQ → award → PO → ASN → GRN → invoice → payment cycle inside one tenant on the mock driver, with a second tenant present and invisible.

### Phase 7 — Operations & commercial
Usage metering against `Client.limits`, plan enforcement, billing behind an interface (stub first), tenant offboarding export, structured logging with `clientId` correlation, per-tenant rate limits, backup/restore drill, runbooks, status page.

### Phase 8 — Real SAP (only with a design-partner sandbox)
`s4_odata` first, plus a conformance suite that runs the contract against a real system and reports pass/fail per method; then `ecc_rfc` via `node-rfc` or an on-prem agent. Feature-flag real drivers per tenant so mock and real run side by side during a pilot.

## How to work

- Before each phase: post a short plan (files, models, indexes, routes, migrations). After each: run **both** test suites plus the isolation suite, update `PROJECT_CONTEXT.md`, record ADRs, commit in small pieces.
- Every new tenant-scoped model must be registered with the tenant plugin **and** get a case in the isolation test suite in the same commit.
- If you are about to write a role list, status list or nav array inline — stop, put it in a registry, and read from it.
- On ambiguity: choose the tenant-safe, contract-first, mock-first option; write the ADR; keep moving.

Start with Phase 1. Read `backend/models/`, `backend/middleware/auth.js`, `backend/utils/socketEmitter.js` and `routes/index.js` fully, then post your plan.
