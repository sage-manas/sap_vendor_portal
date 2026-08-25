# VendorConnect — SaaS Implementation Plan

Version 1.0 · 2026-07-26 · Builds on `SAAS_FEASIBILITY_GUIDE.md` and `PROJECT_CONTEXT.md`. This is the executable plan; the feasibility guide is the rationale.

**Decisions taken (do not re-open):**
- **Evolve in place.** The SaaS layer is built inside the existing Express 5 + Mongoose + Next.js codebase. No rewrite, no port to another stack.
- **Three planes, three login surfaces.** Platform (Sage) → Client tenant (the buying enterprise) → Supplier (the tenant's vendors, who keep their existing self-service portal). There is no "customer" role anywhere — the external counterpart in this product is the supplier.

---

## 1. Target architecture

```
PLATFORM PLANE  (new)          /platform/*        super_admin, sap_manager
  ├─ Create / suspend / terminate tenants
  ├─ Configure + test each tenant's SAP connection, watch health
  ├─ Issue the first client_admin credentials for a new tenant
  └─ Platform health, audit, billing

CLIENT PLANE    (mostly exists as /admin)         client_admin, buyer, finance
  ├─ Approve/reject suppliers, manage own users
  ├─ RFQ → award → PO, GRN oversight
  └─ Invoices, payments, TDS, reports  — all scoped to one clientId

SUPPLIER PLANE  (exists — today's whole app)      vendor
  └─ Register, bid, acknowledge PO, ASN, invoice, payment status, chat
```

### 1.1 Roles (final list — six)

| Role | Plane | Scope | Who |
|---|---|---|---|
| `super_admin` | Platform | all tenants | You. Tenant CRUD, SAP config, billing, operators. |
| `sap_manager` | Platform | all tenants | Configures/monitors every tenant's SAP. No tenant CRUD, no billing. |
| `client_admin` | Client | one tenant | The client company's admin: users, supplier approval, everything in their tenant. |
| `buyer` | Client | one tenant | RFQs, evaluation, award, POs. |
| `finance` | Client | one tenant | Invoices, payments, TDS, statements. |
| `vendor` | Supplier | one tenant + one vendorId | Today's persona, unchanged in capability. |

**Hard rule:** platform roles carry `clientId: null` and may never read tenant business data through tenant endpoints — they operate on tenant *configuration*, not tenant *documents*. Tenant and supplier roles always carry a `clientId` and are structurally incapable of a query without it.

**Kill `ADMIN_BOOTSTRAP_EMAILS`.** It is replaced by: a seeded platform super admin (one-time script) → super admin creates a tenant → the creation flow issues the tenant's first `client_admin` credentials → that admin invites their own buyers/finance users → suppliers self-register into that tenant (or are invited).

### 1.2 Tenant resolution
Subdomain-first: `acme.vendorconnect.app` selects branding and the login realm; the JWT's `clientId` claim is what enforces access after login. A custom-domain CNAME map is a later addition. The platform console lives on its own host (`platform.vendorconnect.app`) and never resolves a tenant subdomain.

---

## 2. Data model changes

### 2.1 New collections
- **`Client`** (the tenant): `clientId` (e.g. `CLT-1042`), `companyName`, `slug` (subdomain), `status` (`Trial|Active|Suspended|Terminated`), `plan`, `branding{logo,primaryColor}`, `featureFlags{}`, `limits{vendors,rfqsPerMonth,storageMb}`, `createdBy`, `createdAt`, `activatedAt`, `suspendedAt`, `terminatedAt`.
- **`SapConnection`** (one per client, versioned): `clientId`, `driver` (`mock|s4_odata|ecc_rfc`), `environment` (`sandbox|production`), `baseUrl`/`host`, `clientNo`, `companyCode`, `purchasingOrg`, `plant`, `credentialRef`, `status`, `lastTestedAt`, `lastTestResult`, `updatedBy`. **Never store the secret here** — see 2.3.
- **`SapConnectionAudit`** — append-only: who changed which field, when, old/new (secrets redacted).
- **`PlatformUser`** — `super_admin`/`sap_manager` accounts. Deliberately a separate collection from `Vendor`: a platform operator is not a vendor and must not be findable by tenant queries.
- **`Invitation`** — `clientId`, `email`, `role`, `token` (hashed), `expiresAt`, `acceptedAt`, `invitedBy`.
- **`AuditLog`** — `clientId`, `actorId`, `actorRole`, `action`, `target`, `meta`, `at`.
- **`UsageCounter`** — `clientId`, `period`, `metric`, `value` (feeds limits + billing).

### 2.2 Every existing collection gets `clientId`
`Vendor, RFQ, PurchaseOrder, ASN, GRN, Invoice, Payment, ChatMessage, SapLog, Document` — all gain a required, indexed `clientId`. Compound indexes: `{clientId, vendorId}`, `{clientId, status}`, `{clientId, id}` (business IDs become unique *per tenant*, not globally — a migration concern: today `RFQ-2026-001` is globally unique).

Also: `Vendor` gains `role` widening (`vendor|client_admin|buyer|finance`) — or, cleaner, tenant staff move into a `User` collection and `Vendor` becomes supplier-master-only. **Recommended:** introduce `User` for tenant staff, keep `Vendor` as the supplier master + supplier login. Record the choice in an ADR either way; do not leave it implicit.

### 2.3 Secrets
SAP passwords, GSP keys and any client secret go through envelope encryption: a per-client data key (`ClientDataKey`) wrapped by a master key from env (KMS-swappable later). Stored ciphertext only; decrypted in-process at call time; never logged, never returned by an API, never in `SapConnectionAudit`.

---

## 3. The enforcement layer (the part that must not be optional)

This is the difference between "multi-tenant" and "multi-tenant and safe". Three mechanisms, all mandatory:

1. **Request context.** An `AsyncLocalStorage`-based `tenantContext` set by middleware from the JWT. A helper `runWithTenant(clientId, fn)` wraps every request.
2. **Mongoose tenant plugin.** Applied to all tenant-scoped schemas. It (a) auto-injects `clientId` into every `find/findOne/update/delete/count/aggregate`, (b) auto-stamps `clientId` on `save`, (c) **throws** if no tenant context is bound. A developer who forgets cannot leak data — the query fails loudly instead of returning another tenant's rows. Platform-only operations opt out explicitly via `withoutTenantScope()`, which is greppable and reviewable.
3. **Socket rooms.** `client:{clientId}:vendor:{vendorId}` and `client:{clientId}:procurement`. The socket handshake validates the JWT's `clientId` and joins only those rooms. `emitToVendor`/`emitToProcurement` take `clientId` as a required argument.

Plus a **cross-tenant isolation test suite** in CI: for each model, seed two tenants and assert that tenant A's token can never read, update or delete tenant B's document — expecting **404, not 403**, so the API never confirms another tenant's data exists.

---

## 4. SAP configuration & the adapter boundary

Today SAP is `setTimeout`. The SaaS promise is "we connect to *your* SAP", so the simulation must move behind an interface before it can be replaced per tenant.

- **`SapAdapter` contract** (`backend/adapters/sap/contract.js`): `health()`, `createVendorMaster()`, `createRfq()`, `createPurchaseOrder()`, `postGoodsReceipt()`, `postInvoice()` (MIRO), `runPayment()` (F110), `getVendorLedger()`, plus the reads the UI needs. Every method returns a result carrying `{data, source: 'sap'|'mock', syncedAt}` so the UI can be honest about freshness.
- **Drivers:** `mock` (today's simulator, moved wholesale behind the interface — including the 10s/12s timers, now explicit and configurable), `s4_odata`, `ecc_rfc` (skeletons throwing `not_implemented` until a design-partner sandbox exists).
- **Factory:** `getSapAdapterForClient(clientId)` resolves driver + config + decrypted credentials, with a per-client connection cache and circuit breaker. **No controller may import a driver.**
- **Test connection** action from the platform console calls `health()` and records the result on `SapConnection`.
- **Health monitor:** a scheduled job pings each active client's SAP, storing latency and last error; the platform console's health board reads it.

---

## 5. Implementation phases

Each phase ends green: both test suites pass, isolation tests pass, README/PROJECT_CONTEXT updated, decisions recorded.

### Phase 1 — Tenancy foundation (no UI)
`Client` model, `clientId` on all ten collections + compound indexes, tenant context + Mongoose plugin + `withoutTenantScope`, JWT gains `clientId`/`roleScope`, socket rooms become client-aware, cross-tenant isolation test suite, migration script that creates one "legacy" client and back-fills every existing document into it (so the current data set keeps working). **This phase is the whole risk of the project — do it before anything else and do not compress it.**

### Phase 2 — Identity & roles
Six-role enum with plane scoping; `PlatformUser` collection + separate platform login; `authorize()` extended to check plane + role; `Invitation` model and invite-accept flow; **a real mailer** (the reset-link-to-logs approach cannot ship); password reset hardened; remove `ADMIN_BOOTSTRAP_EMAILS`; remove the `x-vendor-id` dev fallback from any code path that could run in production; seed script for the first super admin. Route-by-route permission sweep + a generated route×role matrix test.

### Phase 3 — Platform console (`/platform`)
New route group in the Next app, own layout and nav, platform-only API under `/api/platform/*`:
- **Tenants:** list, create (company, slug, plan, limits, branding), detail, suspend/reactivate, terminate (soft, with data-export), edit.
- **Tenant creation issues the first `client_admin`** — generated credentials emailed, forced password change on first login. This is the flow you asked for end-to-end.
- **Operators:** CRUD for `super_admin`/`sap_manager`, MFA mandatory on this plane.
- **Audit explorer** across `AuditLog` + `SapConnectionAudit`.
- **Platform health:** per-tenant SAP status, error rates, usage vs limits, active users.

### Phase 4 — SAP configuration per tenant
`SapConnection` + audit + envelope-encrypted credentials; the `SapAdapter` contract with the existing simulator refactored into the `mock` driver; `getSapAdapterForClient`; platform screens for configure/edit/test/health; every controller's SAP touchpoint routed through the factory instead of inline `setTimeout`. Sandbox vs production config per tenant with an explicit promotion step. Driver skeletons for `s4_odata` and `ecc_rfc`.

### Phase 5 — Client workspace
Promote today's `/admin` page into a real tenant back office: dashboard, supplier directory with approve/reject, **supplier invite/register-from-dashboard** (the tenant-side mirror of self-registration, reusing the same validation), user management (invite buyers/finance), tenant settings (branding, feature flags, SLA/approval thresholds, notification policy), tenant audit view. Nav is permission-filtered so each role sees only its own tabs.

### Phase 6 — Supplier plane under tenancy
Vendor registration becomes tenant-aware (subdomain determines which client a supplier is registering to); supplier onboarding approval lands in that tenant's queue; all existing supplier screens continue to work, now scoped. Branding applied per tenant.

### Phase 7 — Operations & commercial
Usage metering against `limits`, plan enforcement, billing (behind an interface; stub first), tenant offboarding export, backup/restore drill, structured logging with `clientId` correlation, rate limits per tenant, status page, runbooks.

### Phase 8 — Real SAP (needs a design partner)
Implement `s4_odata` first against a sandbox; conformance suite per contract method producing a pass/fail report; then `ecc_rfc` via `node-rfc` or an on-prem agent. Feature-flag real drivers per tenant so mock and real can run side by side during a pilot.

---

## 6. Migration of existing data

One idempotent script: create `CLT-0001 "Legacy"`, stamp every existing document with it, create a `client_admin` from the current admin account, move platform-worthy accounts into `PlatformUser`, verify counts per collection before/after, and run the isolation suite against the migrated data. Business-ID uniqueness moves from global to per-tenant in the same migration.

---

## 7. Definition of done

- No query in the codebase can execute without a bound tenant context (proven by the plugin throwing, plus isolation tests).
- A super admin can create a tenant, configure and test its SAP, and hand over credentials; the new `client_admin` logs in, invites a buyer, approves a supplier; the supplier logs in and completes an RFQ→PO→ASN→GRN→invoice→payment cycle — all on the mock driver, all inside one tenant.
- A second tenant exists in parallel and neither can see the other's data, documents, sockets, or logs.
- Platform roles hold no tenant business data access; tenant roles hold no cross-tenant access; both are asserted by the route×role matrix test.
