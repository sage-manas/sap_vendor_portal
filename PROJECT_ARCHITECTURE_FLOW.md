# VendorConnect Project Architectural Flow

This document maps the current project architecture from the source code. It explains the complete technology stack, where each technology lives, and how it works inside the SAP Vendor Portal.

## 1. Product Architecture In One View

VendorConnect is a multi-tenant supplier self-service portal for the procure-to-pay lifecycle:

```text
Tenant setup
  -> Supplier onboarding
  -> RFQ creation
  -> Vendor bidding
  -> Bid evaluation and award
  -> Purchase order
  -> ASN / dispatch
  -> GRN / goods receipt
  -> Invoice / MIRO
  -> Payment / F110
  -> Reports, audit, logs, analytics
```

The application is split into two runtime packages:

```text
sap_vendor_portal/
  src/                 Next.js frontend application
  backend/             Express, Socket.io, MongoDB API application
  public/              Static frontend assets
  docs/                Product, architecture, runbooks and technical docs
  workflow/            Older workflow and SAP reference docs
  deploy/              Nginx and PM2 deployment files
  mongodb_data/        Local MongoDB data artifact, not application source
```

The portal has three user-facing planes inside one Next.js app:

```text
Supplier portal     /             vendor users
Tenant workspace    /workspace    client_admin, buyer, finance
Platform console    /platform     super_admin, sap_manager
```

The backend has the matching split:

```text
/api/auth           supplier and tenant-staff identity
/api/platform       platform-operator identity and platform administration
/api/workspace      tenant back-office dashboard and settings
/api/vendors        supplier profile plus tenant supplier directory
/api/rfqs           sourcing lifecycle
/api/pos            purchase orders and ASN submission
/api/grns           goods receipts
/api/invoices       invoice and MIRO lifecycle
/api/payments       payment tracking
/api/chats          supplier communication
/api/uploads        document upload/download/delete
/api/reports        PDFs, statements and metrics
/api/logs           SAP payload log viewer
/api/dashboard      supplier and workspace summaries
```

## 2. Complete Tech Stack And Where It Works

| Layer | Technology | Where | How it works in the portal |
|---|---|---|---|
| Frontend framework | Next.js 16.2.7 App Router | `src/app`, `next.config.ts` | Provides route-based pages for supplier portal, workspace and platform console. `reactCompiler: true` is enabled. |
| UI runtime | React 19.2.4 | `src/app/layout.jsx`, `src/features`, `src/components` | All pages and feature views are React components. App state is composed through React context and feature hooks. |
| Styling | Tailwind CSS v4 | `src/app/globals.css`, `postcss.config.mjs` | Provides the design system utility classes and theme variables. The app is dark-first with a theme toggle. |
| Fonts | `next/font/google` Geist and Geist Mono | `src/app/layout.jsx` | Loads sans and mono font variables for portal chrome and tabular/SAP-style data. |
| UI primitives | Hand-written UI plus shadcn/base-ui dependency | `src/components/ui`, `components.json` | Cards, modals, drawers, badges, command palette, skeletons and button primitives used across all planes. |
| Icons | `lucide-react` | `package.json`, UI components | Supplies icons for navigation, actions and compact controls. |
| Charts | `recharts` | `src/lib/chartTheme.js`, analytics/performance views | Used for dashboard and performance visualizations. |
| Frontend API client | Browser `fetch` wrapper | `src/lib/api-client.js` | Attaches `jwt_token`, calls `NEXT_PUBLIC_API_URL`, clears session on 401, returns `null` on network failure. |
| Platform API client | Separate browser `fetch` wrapper | `src/lib/platform-client.js` | Uses `vc_platform_token`, calls `/api/platform/*`, keeps platform operator sessions separate from supplier/tenant sessions. |
| Realtime client | `socket.io-client` | `src/lib/socket.js`, `src/lib/portal-context.js` | Connects to backend Socket.io with JWT auth and listens for PO, GRN, payment, chat and SAP log events. |
| Backend framework | Express 5.2.1 | `backend/server.js`, `backend/routes` | Hosts REST API under `/api`, mounts security middleware, route modules and centralized error handling. |
| Realtime server | Socket.io 4.8.3 | `backend/server.js`, `backend/utils/socketEmitter.js` | Authenticates sockets by JWT and joins tenant-scoped vendor/procurement rooms. |
| Database | MongoDB | `backend/config/db.js`, `backend/models` | Stores tenants, users, vendors, RFQs, POs, ASNs, GRNs, invoices, payments, chats, documents, SAP logs and audits. |
| ODM | Mongoose 9.6.3 | `backend/models`, `backend/models/plugins` | Defines schemas, validation, indexes, tenant scoping, credentials behavior and encrypted SAP connection records. |
| Multi-tenancy | AsyncLocalStorage plus Mongoose plugin | `backend/utils/tenantContext.js`, `backend/models/plugins/tenantPlugin.js` | Binds `clientId` per request and auto-filters/stamps tenant-scoped model operations. Missing tenant context throws. |
| Auth | JWT and bcryptjs | `backend/utils/authToken.js`, `backend/middleware/auth.js`, `backend/models/plugins/credentialsPlugin.js` | Passwords are hashed, JWTs carry role, roleScope and clientId, and protected routes derive identity from the token. |
| RBAC | Permission registry | `backend/config/roles.js`, `backend/config/permissions.js`, `backend/middleware/auth.js` | Routes declare permissions and nav registries filter by the same server-reported permission list. |
| Validation | Zod | `backend/validators`, `backend/middleware/validate.js` | Validates request bodies for auth, vendor, RFQ, ASN, invoice, user and platform endpoints. |
| Security middleware | helmet, cors, compression, express-rate-limit, express-mongo-sanitize, hpp | `backend/server.js`, `backend/middleware/rateLimiter.js` | Protects headers, CORS, body size, NoSQL injection, HTTP parameter pollution and abusive traffic. |
| Logging | winston, daily rotate file, morgan-style request logging | `backend/utils/logger.js`, `backend/middleware/requestLogger.js`, `backend/logs` | Adds request IDs, client IDs and structured request/error logs. |
| SAP integration layer | Adapter contract and drivers | `backend/sap`, `backend/config/sapTransactions.js` | Controllers call `getSapAdapterForClient(clientId)`. The adapter writes SAP logs, stamps source/sync metadata and routes through mock/S4/ECC drivers. |
| SAP simulation | Mock driver | `backend/sap/drivers/mock.driver.js` | Simulates vendor master, RFQ, PO, GRN, MIRO and payment responses. Deferred GRN/payment events are timer driven in the driver. |
| SAP connection storage | Mongoose model with encrypted secrets | `backend/models/SapConnection.js`, `backend/utils/secretBox.js` | Stores per-tenant sandbox/production SAP config. Credentials are envelope encrypted and never returned to the UI. |
| Circuit breaker | Custom breaker | `backend/sap/circuitBreaker.js`, `backend/sap/index.js` | Protects each tenant SAP adapter from repeated driver failures. Platform health reports breaker state. |
| Email | nodemailer | `backend/utils/mailer.js`, `backend/config/emailTemplates.js` | Sends password reset, invitations, supplier welcome and supplier decision emails. |
| File uploads | multer | `backend/middleware/upload.js`, `backend/routes/upload.routes.js`, `backend/models/Document.js`, `backend/uploads` | Receives compliance and transaction files, stores document metadata and serves/deletes files. |
| PDF generation | pdfkit | `backend/controllers/reports.controller.js` | Generates vendor statements and invoice PDFs. |
| Billing integration point | Provider interface | `backend/services/billing.service.js` | Currently a `null` provider that logs tenant lifecycle and usage sync; ready for a real billing provider later. |
| Usage metering | Custom service | `backend/utils/usage.js` | Counts vendors and monthly RFQs against tenant plan limits and blocks over-limit creation with HTTP 402. |
| Testing frontend | Vitest | `vitest.config.mjs`, `src/**/*.test.{js,jsx}` | Tests validation, branding and nav permission registries. |
| Testing backend | Jest, Supertest, mongodb-memory-server | `backend/jest.config.js`, `backend/tests` | Tests auth, tenancy, RBAC, lifecycle, SAP adapter, platform console, workspace and operations. |
| CI | GitHub Actions | `.github/workflows/test.yml` | Runs frontend `npm test` and backend `npm test` on PRs and pushes to `master`. |
| Deployment | PM2 and Nginx | `deploy/ecosystem.config.js`, `deploy/nginx.conf` | Runs Next on port 3000 and Express/Socket.io on port 5000 behind one reverse proxy. |

### Dependency and tooling inventory

This is the package-level inventory from the two `package.json` files, tied back to where each package is active or why it exists.

| Package/tool | Package | Current role |
|---|---|---|
| `next` | root | Frontend framework and production web server. Routes live in `src/app`; production starts through `next start -p 3000`. |
| `react`, `react-dom` | root | Component runtime for all frontend planes. |
| `babel-plugin-react-compiler` | root dev | React Compiler support; enabled by `reactCompiler: true` in `next.config.ts`. |
| `typescript`, `@types/*` | root dev | TypeScript support for config and TS/TSX utility files, including `next.config.ts`, `src/lib/utils.ts` and `src/components/ui/button.tsx`. |
| `eslint`, `eslint-config-next` | root dev | Frontend linting through `npm run lint`; configured in `eslint.config.mjs` and ignores `backend/**`. |
| `tailwindcss`, `@tailwindcss/postcss` | root | Tailwind v4 styling through `postcss.config.mjs` and `src/app/globals.css`. |
| `tw-animate-css` | root | Animation utilities imported in `src/app/globals.css`. |
| `shadcn` | root | UI registry/tooling and Tailwind CSS import; configured in `components.json`, with the main active primitive at `src/components/ui/button.tsx`. |
| `@base-ui/react` | root | Headless primitive behind the shared `Button` component. |
| `class-variance-authority` | root | Variant generation for `buttonVariants` in `src/components/ui/button.tsx`. |
| `clsx`, `tailwind-merge` | root | Classname composition through `cn()` in `src/lib/utils.ts`. |
| `lucide-react` | root | Icon set for frontend controls and navigation. |
| `recharts` | root | Charting in reporting/performance views. |
| `socket.io-client` | root | Browser realtime client in `src/lib/socket.js`. |
| `vitest` | root dev | Frontend test runner through `npm test`. |
| `impeccable` | root dev | Design-linting/dev critique tool referenced by project docs; not application runtime. |
| `express` | backend | REST API framework in `backend/server.js`. Also duplicated in the root package but the active API runs from `backend/package.json`. |
| `socket.io` | backend | Realtime server in `backend/server.js`. Also duplicated in root dependencies for historical/project convenience. |
| `mongoose` | backend | MongoDB ODM for all backend models. Also duplicated in root dependencies but active model code runs in `backend`. |
| `dotenv` | backend | Loads backend `.env` in `backend/server.js` and backend scripts. |
| `cors` | backend | CORS allowlist for API and Socket.io origins. |
| `helmet` | backend | HTTP security headers and CSP. |
| `compression` | backend | Response compression middleware. |
| `express-rate-limit` | backend | Production API limiter and per-tenant limiter. |
| `express-mongo-sanitize` | backend | NoSQL operator injection protection. |
| `hpp` | backend | HTTP parameter pollution protection. |
| `jsonwebtoken` | backend | JWT signing and verification. |
| `bcryptjs` | backend | Password hashing and password comparison. |
| `zod` | backend | Request validation schemas in `backend/validators`. |
| `multer` | backend | Multipart upload handling for `/api/uploads`. |
| `nodemailer` | backend | Email transport for password resets, invitations and supplier notices. |
| `pdfkit` | backend | Statement and invoice PDF generation. |
| `winston`, `winston-daily-rotate-file` | backend | Structured and rotating file logs. |
| `morgan` | backend | Installed for HTTP logging heritage, but the active request logger is the custom `backend/middleware/requestLogger.js`. |
| `cookie-parser` | backend/root | Installed but not mounted in current `backend/server.js`; auth currently uses bearer JWTs rather than cookies. |
| `nodemon` | backend/root dev | Development server restart tool used by `backend/package.json` `npm run dev`; also present at root. |
| `jest`, `supertest`, `mongodb-memory-server`, `cross-env` | backend dev | Backend test stack. `cross-env` sets `NODE_ENV=test JWT_SECRET=test-secret`; Supertest hits the Express test app; mongodb-memory-server supplies isolated MongoDB. |

## 3. Runtime Request Flow

### Browser to frontend

1. A user opens a route served by Next.js from `src/app`.
2. `src/app/layout.jsx` wraps the application with:
   - `ThemeProvider` from `src/lib/theme-context.js`
   - `ShellProvider` from `src/lib/shell-context.js`
   - `PortalProvider` from `src/lib/portal-context.js`
   - `PortalLayout` from `src/components/portal/PortalLayout.jsx`
3. `PortalLayout` checks `src/lib/planes.js`:
   - supplier routes get header, sidebar, command palette and BAPI console
   - `/workspace/*` renders the workspace layout
   - `/platform/*` renders the platform layout
   - auth pages render centered auth chrome

### Frontend to backend API

1. Supplier and workspace screens call `apiClient` in `src/lib/api-client.js`.
2. `apiClient` sends requests to `NEXT_PUBLIC_API_URL` or `http://localhost:5000/api`.
3. It reads the browser token from `localStorage.jwt_token`.
4. Platform screens use `platformApi` in `src/lib/platform-client.js`.
5. `platformApi` reads `localStorage.vc_platform_token` and calls `/api/platform/*`.

### Backend API pipeline

`backend/server.js` builds this request pipeline:

```text
HTTP request
  -> helmet security headers
  -> compression
  -> query sanitization compatibility wrapper
  -> express-mongo-sanitize
  -> hpp
  -> cors allowlist
  -> JSON parser under /api
  -> requestLogger
  -> production apiLimiter
  -> /api routes
  -> errorHandler
```

For protected tenant routes:

```text
Authorization: Bearer <jwt>
  -> protect middleware
  -> verify token
  -> load Vendor or User by token role plane
  -> load Client
  -> reject suspended/terminated tenant
  -> bind AsyncLocalStorage tenant context
  -> tenantLimiter
  -> requirePermission(permission)
  -> controller
  -> tenantPlugin auto-injects clientId into Mongoose queries
```

For protected platform routes:

```text
Authorization: Bearer <platform jwt>
  -> protectPlatform
  -> load PlatformUser
  -> requireMfa after initial auth routes
  -> requirePermission(permission)
  -> platform controller
```

## 4. Frontend Architecture

### Supplier portal

Supplier routes live directly under `src/app`:

| Route | Component | Main feature/view |
|---|---|---|
| `/` | `src/app/page.jsx` | Dashboard |
| `/registration` | `src/app/registration/page.jsx` | Supplier onboarding form |
| `/rfqs` | `src/app/rfqs/page.jsx` | RFQ list, bidding, award/evaluation UI for permitted users |
| `/pos` | `src/app/pos/page.jsx` | Purchase orders, acknowledgment, ASN |
| `/invoices` | `src/app/invoices/page.jsx` | Invoice list |
| `/payments` | `src/app/payments/page.jsx` | Payment tracking and statement export |
| `/performance` | `src/app/performance/page.jsx` | Vendor performance |
| `/analytics` | `src/app/analytics/page.jsx` | Reports and analytics |
| `/chats` | `src/app/chats/page.jsx` | Supplier communication |
| `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`, `/accept-invitation`, `/change-password` | `src/app/*/page.jsx` | Auth and account recovery |

Feature code is organized by domain:

```text
src/features/profile          onboarding, GST/PAN/bank validation, profile API
src/features/rfq              RFQ creation, bidding, evaluation and award
src/features/purchase-order   PO list, acknowledgement, ASN, GRN state
src/features/billing          invoices and MIRO status
src/features/payments         payments, SAP payment status, statements
src/features/dashboard        dashboard, chats, reports and performance
```

Each feature generally follows:

```text
components/   page-level and panel UI
hooks/        stateful React hooks calling the service layer
services/     thin wrappers over apiClient endpoints
constants.js  static screen/domain constants
validation.js pure validation helpers
```

`src/lib/portal-context.js` is the supplier portal orchestrator. It:

- creates the feature hooks
- exposes a single `usePortal()` API
- redirects unauthenticated users to `/sign-in`
- forces temporary-password accounts to `/change-password`
- manages selected RFQ/PO/GRN modal state
- manages supplier onboarding, bid, RFQ, ASN, invoice, chat and reset handlers
- starts Socket.io for signed-in suppliers
- receives realtime events and refreshes the relevant feature hooks
- pushes toast notifications through `ToastNotification`

`src/lib/shell-context.js` holds the docked SAP/BAPI console logs. It hydrates from `localStorage.sap_vendor_portal_logs`, refreshes from `/api/logs`, and caps the local console at 100 entries.

### Tenant workspace

Workspace routes live under `src/app/workspace`.

| Route | Purpose | Backend API |
|---|---|---|
| `/workspace` | Tenant overview, queues, usage, SLA and finance/sourcing summary | `GET /api/workspace/overview` |
| `/workspace/suppliers` | Supplier directory, create supplier, invite, approve/reject | `/api/vendors`, `/api/vendors/invitations` |
| `/workspace/users` | Staff directory, invite users, role/status changes | `/api/users` |
| `/workspace/settings` | Branding, feature flags, thresholds, notifications | `/api/workspace/settings` |
| `/workspace/audit` | Tenant-scoped audit trail | `/api/workspace/audit` |

The workspace has its own layout in `src/app/workspace/layout.jsx`, its own session provider in `src/lib/workspace-session.js`, and permission-filtered navigation in `src/lib/workspaceNav.js`.

It shares the normal `jwt_token` and `/api/auth/me` identity surface because tenant staff are tenant accounts, not platform operators.

### Platform console

Platform routes live under `src/app/platform`.

| Route | Purpose | Backend API |
|---|---|---|
| `/platform` | Platform health and tenant/SAP overview | `GET /api/platform/health` |
| `/platform/tenants` | Tenant list and creation | `/api/platform/tenants` |
| `/platform/tenants/[clientId]` | Tenant detail, lifecycle, export, admin credentials | `/api/platform/tenants/:clientId` |
| `/platform/sap` | Cross-tenant SAP configuration overview | `/api/platform/health`, tenant SAP routes |
| `/platform/tenants/[clientId]/sap` | Tenant SAP connection configuration, test and promote | `/api/platform/tenants/:clientId/sap` |
| `/platform/operators` | Platform operator management and MFA reset | `/api/platform/operators` |
| `/platform/audit` | Platform audit trail | `/api/platform/audit` |
| `/platform/reset-password` | Operator password reset | `/api/platform/auth/reset-password` |

The platform has:

- `src/app/platform/layout.jsx` for platform chrome
- `src/lib/platform-session.js` for staged session flow
- `src/lib/platform-client.js` for token-isolated API access
- `src/lib/platformNav.js` for permission-filtered navigation
- `src/components/platform/PlatformGate.jsx` for sign-in, password change, MFA enrolment, MFA verification and console access

Platform sessions progress through:

```text
signed_out -> change_password -> enrol_mfa -> verify_mfa -> console
```

## 5. Backend Architecture

### Route mounting

All backend routes mount from `backend/routes/index.js`.

Public routes:

```text
GET  /api/health
GET  /api/status
GET  /api/test-error
POST /api/auth/register
POST /api/auth/login
POST /api/auth/forgot-password
POST /api/auth/reset-password
GET  /api/auth/workspace
GET  /api/auth/invitations/:token
POST /api/auth/invitations/accept
POST /api/platform/auth/login
POST /api/platform/auth/forgot-password
POST /api/platform/auth/reset-password
```

Tenant and supplier routes are protected by `protect` and most business routes also require `requireOnboarded` for suppliers.

Platform routes are protected by `protectPlatform`; most platform routes also require MFA through `requireMfa`.

### Controllers

| Controller | Responsibility |
|---|---|
| `auth.controller.js` | Supplier/staff registration, login, session, workspace realm, password reset/change |
| `vendor.controller.js` | Supplier profile, tenant supplier directory, supplier creation/invitation, approval/rejection, KYC verification, performance |
| `rfq.controller.js` | RFQ list/create/cancel/reissue, bid submission, evaluation, award to PO, SAP RFQ and quotation cross-checks |
| `po.controller.js` | PO list/detail, acknowledge, simulated inbound PO, ASN submission, deferred GRN handling, SAP PO/GRN cross-check |
| `grn.controller.js` | GRN list/detail |
| `invoice.controller.js` | Invoice list/detail, 3-way match, SAP MIRO post, deferred payment-run handling, SAP invoice cross-check |
| `payment.controller.js` | Payment list/detail/create/manage and SAP payment cross-check |
| `chat.controller.js` | Supplier messages and simulated system replies |
| `upload.controller.js` | Upload metadata, downloads and deletion |
| `reports.controller.js` | Statement and invoice PDF generation plus metrics |
| `saplog.controller.js` | Tenant-scoped SAP log list |
| `dashboard.controller.js` | Dashboard summaries |
| `workspace.controller.js` | Tenant workspace overview, settings and audit |
| `user.controller.js` | Tenant staff users, roles and statuses |
| `invitation.controller.js` | Staff and supplier invitations |
| `platformAuth.controller.js` | Operator login, password reset/change, MFA enrolment/verification |
| `platformTenant.controller.js` | Tenant list/create/update/lifecycle/export/billing sync |
| `platformSap.controller.js` | SAP configuration, test, promote and connection audit |
| `platformOperator.controller.js` | Platform operator CRUD/lifecycle/MFA reset |
| `platformAudit.controller.js` | Platform-wide audit query and filters |
| `platformHealth.controller.js` | Cross-tenant health, usage, SAP traffic and SAP connection state |

## 6. Data Model Architecture

### Tenant root

`Client` in `backend/models/Client.js` is the tenant root. It is not tenant-scoped because it defines the tenant.

It stores:

- `clientId`, for example `CLT-0001`
- tenant company name and slug
- lifecycle status: `Trial`, `Active`, `Suspended`, `Terminated`
- plan and limits
- branding and feature flags
- settings
- active SAP environment: `sandbox` or `production`

Only `Trial` and `Active` tenants are operational.

### Identity models

| Model | Plane | File | Purpose |
|---|---|---|---|
| `PlatformUser` | platform | `backend/models/PlatformUser.js` | `super_admin` and `sap_manager` operators, with MFA fields |
| `User` | tenant | `backend/models/User.js` | `client_admin`, `buyer`, `finance` tenant staff |
| `Vendor` | supplier | `backend/models/Vendor.js` | supplier login plus supplier master/onboarding/compliance profile |

`credentialsPlugin` adds shared password, reset token, forced password change and last-login behavior to all identity collections.

### P2P transaction models

| Model | File | Role in lifecycle |
|---|---|---|
| `Vendor` | `backend/models/Vendor.js` | Supplier master, GST/PAN/bank/KYC data and SAP vendor code |
| `RFQ` | `backend/models/RFQ.js` | Sourcing document with items, invited vendors, bids and award result |
| `PurchaseOrder` | `backend/models/PurchaseOrder.js` | Awarded order with line quantities, prices, status and SAP PO number |
| `ASN` | `backend/models/ASN.js` | Dispatch notice with carrier, shipment, e-way bill, inbound delivery and shipped items |
| `GRN` | `backend/models/GRN.js` | Goods receipt from SAP/MIGO, accepted/rejected quantities and invoice flag |
| `Invoice` | `backend/models/Invoice.js` | Vendor invoice, 3-way match status, SAP MIRO document and amounts |
| `Payment` | `backend/models/Payment.js` | F110 payment details, UTR, TDS, bank and payment document metadata |

Supporting models:

| Model | File | Purpose |
|---|---|---|
| `ChatMessage` | `backend/models/ChatMessage.js` | Tenant-scoped vendor communication |
| `Document` | `backend/models/Document.js` | Uploaded file metadata |
| `SapLog` | `backend/models/SapLog.js` | Tenant-scoped SAP/BAPI/RFC/OData/KYC call logs with 30-day TTL |
| `SapConnection` | `backend/models/SapConnection.js` | Per-tenant SAP driver/config/secrets by environment |
| `SapConnectionAudit` | `backend/models/SapConnectionAudit.js` | Field-level SAP connection change history |
| `Invitation` | `backend/models/Invitation.js` | Hashed-token staff/supplier invitations |
| `AuditLog` | `backend/models/AuditLog.js` | Append-only platform/tenant/supplier/system audit events |

### Tenant isolation

Most business models use `tenantPlugin`:

```text
Vendor, User, RFQ, PurchaseOrder, ASN, GRN, Invoice, Payment,
ChatMessage, Document, SapLog, Invitation
```

The plugin:

- adds required `clientId`
- filters reads, updates, deletes, counts, distinct queries and aggregations by bound tenant
- stamps new documents with the bound tenant
- strips caller-supplied `clientId` from updates
- refuses saves that move a document between tenants
- throws if no tenant context is bound

The explicit escape hatch is `withoutTenantScope(fn)`, used for platform work and pre-auth lookups where the tenant is not known yet.

## 7. Authentication And Authorization Flow

### Roles and planes

Roles are defined in `backend/config/roles.js`:

```text
platform: super_admin, sap_manager
tenant:   client_admin, buyer, finance
supplier: vendor
```

Permissions are defined in `backend/config/permissions.js`.

Every protected route declares a permission through `requirePermission(...)`. The frontend does not hard-code role behavior for protected actions; it reads the permission list returned by `/api/auth/me` or `/api/platform/auth/me` and filters navigation.

### Supplier self-registration

```text
POST /api/auth/register
  -> resolve workspace by subdomain/header/default
  -> enforce tenant operational status
  -> enforce self-registration setting or invitation
  -> check global identity collisions
  -> enforce tenant vendor plan limit
  -> create Vendor in tenant context
  -> return JWT and vendor profile
```

### Supplier or tenant-staff login

```text
POST /api/auth/login
  -> find User by email, else Vendor by email/vendorId
  -> optionally enforce subdomain realm
  -> bcrypt password compare
  -> account.canAuthenticate()
  -> Client must be Trial or Active
  -> update lastLoginAt
  -> return JWT, role, mustChangePassword and user/vendor shape
```

### Platform login

```text
POST /api/platform/auth/login
  -> authenticate PlatformUser
  -> return platform token
  -> platform session asks /platform/auth/me
  -> force password change if needed
  -> force MFA enrolment if missing
  -> force MFA code verification
  -> unlock platform console
```

## 8. SAP Integration Architecture

All SAP calls go through `backend/sap/index.js`:

```js
const sap = await getSapAdapterForClient(req.clientId);
await sap.rfqCreate({ rfq, vendorId });
```

Controllers do not import a specific SAP driver.

### SAP adapter responsibilities

The adapter wrapper:

1. Resolves the tenant's active SAP environment from `Client.sapEnvironment`.
2. Loads the matching `SapConnection`.
3. Falls back to the mock driver when no connection exists.
4. Decrypts credentials only inside the driver factory.
5. Caches the adapter per tenant and connection revision.
6. Runs calls through the tenant circuit breaker.
7. Writes `SapLog` rows from `backend/config/sapTransactions.js`.
8. Stamps results with `source`, `syncedAt` and `transaction`.
9. Re-binds tenant context when deferred driver responses arrive.

### SAP drivers

| Driver | File | Status | Use |
|---|---|---|---|
| `mock` | `backend/sap/drivers/mock.driver.js` | implemented | Current simulator for demos, tests and tenants without real connection |
| `s4_odata` | `backend/sap/drivers/s4odata.driver.js` | partial | S/4HANA OData configuration and connection test, broader contract still growing |
| `ecc_rfc` | `backend/sap/drivers/eccrfc.driver.js` | skeleton | ECC/RFC configuration placeholder, no real RFC transport yet |

### SAP transaction registry

`backend/config/sapTransactions.js` defines every SAP-facing transaction once:

```text
Vendor master:       BAPI_VENDOR_CREATE, OData_VENDOR_CONFIRM, OData_VENDOR_REJECT, GSTIN_PAN_VERIFY
RFQ and sourcing:    BAPI_RFQ_CREATE, RFC_RFQ_CANCEL, RFC_RFQ_REISSUE, RFC_RFQ_SUBMIT_BID, BAPI_INFORECORD_CREATE
Purchase orders:     OData_PO_INBOUND_SYNC, /API_PURCHASEORDER_PROCESS_SRV, RFC_PO_ACKNOWLEDGE
Delivery and GRN:    BAPI_DELIVERYPROCESSING_EXEC, BAPI_GOODSMVT_CREATE, BAPI_GOODSMVT_GETDETAIL
Invoice and payment: BAPI_INCOMINGINVOICE_CREATE, FBL1N_RFITEMGL
Connectivity:        RFC_PING
```

This registry supplies code, type, direction and human label for SAP logs.

## 9. Procure-To-Pay Architectural Flow

### A. Tenant provisioning

```text
Platform operator
  -> POST /api/platform/tenants
  -> platformTenant.controller.createTenant
  -> tenantProvisioning.service provisions Client and first User(client_admin)
  -> credentials are emailed
  -> AuditLog records tenant creation and admin provisioning
  -> billing provider receives onTenantCreated
```

How it appears:

- Platform console pages under `src/app/platform`
- API client `src/lib/platform-client.js`
- Data in `Client`, `User`, `AuditLog`

### B. Supplier onboarding

```text
Supplier
  -> /sign-up or tenant-created welcome/reset flow
  -> POST /api/auth/register or POST /api/vendors
  -> Vendor created as Draft
  -> supplier fills /registration
  -> profileService calls /api/vendors/profile and /api/vendors/profile/submit
  -> vendor.controller.submitRegistration
  -> GSTIN/PAN verification through verification.service
  -> SAP adapter logs VENDOR_KYC_VERIFY
  -> vendor status waits for tenant decision
```

Approval:

```text
Tenant admin in /workspace/suppliers
  -> PUT /api/vendors/:id/approve
  -> verify KYC if needed
  -> sap.vendorCreate()
  -> SAP log BAPI_VENDOR_CREATE
  -> Vendor gets sapVendorCode and Approved status
  -> optional decision email
  -> AuditLog VENDOR_APPROVED
```

Rejection:

```text
PUT /api/vendors/:id/reject
  -> Vendor status Rejected
  -> sap.vendorReject()
  -> optional email
  -> AuditLog VENDOR_REJECTED
```

### C. RFQ creation and bidding

Creation:

```text
Buyer/client_admin
  -> /rfqs or workspace sourcing UI
  -> rfqService.createRFQ()
  -> POST /api/rfqs
  -> rfq.controller.createRFQ
  -> enforce monthly RFQ plan limit
  -> create RFQ with sequential RFQ-YYYY-###
  -> sap.rfqCreate()
  -> SAP log BAPI_RFQ_CREATE
```

Bidding:

```text
Vendor
  -> /rfqs
  -> rfqService.submitBid()
  -> POST /api/rfqs/:id/bid
  -> require vendor scope
  -> validate RFQ is open and before deadline
  -> validate prices for every line
  -> convert GST rate to SAP-style tax code
  -> insert or replace vendor bid
  -> sap.rfqSubmitBid()
  -> SAP log RFC_RFQ_SUBMIT_BID
```

Evaluation:

```text
GET /api/rfqs/:id/evaluate
  -> calculate total cost per vendor
  -> priceScore = lowestTotalCost / vendorTotalCost * 100
  -> deliveryScore = shortestLeadTime / vendorLeadTime * 100
  -> weightedScore = price 40% + technical 30% + delivery 20% + rating 10%
  -> return vendors sorted by weightedScore descending
```

Award:

```text
POST /api/rfqs/:id/award
  -> choose winning vendor
  -> map RFQ lines plus winning prices into PO lines
  -> create PurchaseOrder PO-YYYY-####
  -> update RFQ to Awarded
  -> sap.infoRecordCreate()
  -> sap.poInboundSync()
  -> return PO
```

Frontend `awardVendorBidWrapper` in `portal-context.js` refreshes PO state, shows toast, and adds SAP console messages.

### D. Purchase order and acknowledgement

```text
Vendor
  -> /pos
  -> poService.getPOs()
  -> GET /api/pos
  -> PurchaseOrder.find(withVendorScope(req))
```

Acknowledgement:

```text
PUT /api/pos/:id/acknowledge
  -> PO must be Open
  -> set status Acknowledged
  -> sap.poAcknowledge()
  -> Socket.io log:new to vendor room
```

Inbound simulation:

```text
POST /api/pos/simulate
  -> sap.poProvision()
  -> create local PurchaseOrder
  -> sap.poProvisioned()
  -> Socket.io po:new and log:new
```

### E. ASN and goods receipt

```text
Vendor
  -> /pos
  -> submit ASN against acknowledged PO
  -> POST /api/pos/:id/asn
  -> validate shipped quantities against remaining PO quantities
  -> sap.deliveryCreate()
  -> create ASN with sapInboundDelivery
  -> update PO status to Dispatched
  -> Socket.io log:new
```

Deferred goods receipt:

```text
sap.awaitGoodsReceipt({ asn, po, vendorId }, handler)
  -> mock driver waits configured goodsReceiptMs
  -> adapter re-binds tenant context
  -> handler creates GRN
  -> ASN status Received
  -> PO status Delivered
  -> PO line grnQuantity increments
  -> SAP logs BAPI_GOODSMVT_CREATE and BAPI_GOODSMVT_GETDETAIL
  -> Socket.io grn:received
```

The supplier UI receives `grn:received` in `portal-context.js`, refreshes PO/ASN/GRN hooks, shows a toast and adds BAPI console entries.

### F. Invoice and MIRO

```text
Vendor
  -> create invoice from GRN
  -> POST /api/invoices
  -> invoice.controller.submitInvoice
  -> require GRN exists and has not been invoiced
  -> load PO
  -> perform 3-way match:
       invoice item vs GRN accepted quantity
       invoice item price vs PO unit price
  -> warning status if variance found
  -> sap.invoiceCreate()
  -> store SAP MIRO document number
  -> create Invoice
  -> mark GRN invoiceSubmitted
  -> set PO status Invoiced
  -> Socket.io log:new
```

Manual/repost MIRO:

```text
POST /api/invoices/:id/miro
  -> sap.invoiceCreate()
  -> update invoice.sapMiroDoc
```

SAP invoice cross-check:

```text
GET /api/invoices/sap-status
  -> sap.vendorMiroDisplay()
  -> for matched MIRO docs, sap.invoicePaymentDetail()
  -> return documents and paymentDetails
```

### G. Payment and F110

Deferred payment run:

```text
sap.awaitPaymentRun({ invoice, vendor, vendorId }, handler)
  -> mock driver waits configured paymentRunMs
  -> adapter re-binds tenant context
  -> handler creates Payment with UTR, TDS, runId and bank data
  -> Invoice status Cleared
  -> PO status Paid
  -> SAP log FBL1N_RFITEMGL
  -> Socket.io payment:cleared
```

Payment views:

```text
GET /api/payments
  -> list internal Payment rows

GET /api/payments/sap-status
  -> sap.vendorPaymentDisplay()
  -> show SAP payment ledger cross-check
```

The frontend payment hook refreshes payments and SAP payment details when `payment:cleared` arrives.

## 10. Realtime Flow

Socket.io server setup is in `backend/server.js`.

Connection flow:

```text
Browser initSocket(token)
  -> Socket.io handshake auth.token
  -> backend verifies JWT
  -> socket.clientId = decoded.clientId
  -> socket.clerkUserId = decoded.vendorId, for suppliers
  -> supplier socket joins client:{clientId}:vendor:{vendorId}
  -> procurement listeners can join client:{clientId}:procurement
```

Room helpers are in `backend/utils/socketEmitter.js`:

```text
emitToVendor(io, clientId, vendorId, event, data)
emitToProcurement(io, clientId, event, data)
```

Main events:

| Event | Emitted by | Consumed by |
|---|---|---|
| `po:new` | PO simulation/provisioning | Supplier portal refreshes PO list and BAPI console |
| `grn:received` | Deferred goods receipt handler | Supplier portal refreshes PO/ASN/GRN |
| `payment:cleared` | Deferred payment handler | Supplier portal refreshes payment/invoice state |
| `chat:message` | Chat controller and auto-reply | Supplier portal refreshes chats |
| `log:new` | SAP-calling controllers/deferred handlers | Supplier BAPI console |

## 11. Document, Report And Chat Flow

### Uploads

```text
Frontend FileUploadZone
  -> POST /api/uploads multipart/form-data
  -> multer middleware
  -> uploadController stores file and creates Document
  -> Document is tenant-scoped and linked to Profile, ASN, RFQ or Invoice
```

Download/list/delete:

```text
GET    /api/uploads
GET    /api/uploads/:id
DELETE /api/uploads/:id
```

### Reports

```text
GET /api/reports/statement
  -> pdfkit statement PDF

GET /api/reports/invoice/:id
  -> pdfkit invoice PDF

GET /api/reports/metrics
  -> platform/reporting metrics
```

### Chat

```text
GET  /api/chats
POST /api/chats
  -> feature flag features.supplierChat must be enabled
  -> store ChatMessage
  -> emit chat:message
  -> simulated delayed system/buyer reply
```

## 12. Operational Architecture

### Settings and branding

Tenant settings are described and validated through `backend/config/tenantSettings.js`, then consumed by:

- signed-out workspace realm: `GET /api/auth/workspace`
- supplier branding: `src/components/portal/TenantBranding.jsx`
- workspace settings screen: `src/app/workspace/settings/page.jsx`
- feature flag middleware: `backend/middleware/requireFeature.js`
- operational thresholds in `workspace.controller.js`

Tenant branding is deliberately constrained on the frontend. `src/lib/branding.js` only moves the existing accent CSS variable, instead of introducing arbitrary themes.

### Usage and plan enforcement

`backend/utils/usage.js` is the single usage source:

```text
vendors      -> Vendor.countDocuments()
rfqsPerMonth -> RFQ.countDocuments({ createdAt >= first day of month })
```

Used by:

- supplier self-registration
- tenant-side supplier creation
- RFQ creation
- workspace overview
- platform health
- billing usage sync

### Billing

`backend/services/billing.service.js` defines the billing provider contract:

```text
onTenantCreated
onTenantStatusChanged
reportUsage
```

The current provider is `null`, which logs and returns success. It is a clear integration point for Stripe, Chargebee or another provider.

### Audit

`AuditLog` is append-only and used by:

- tenant creation/update/lifecycle/export
- tenant admin credential reissue
- supplier creation/approval/rejection
- settings updates
- platform and workspace audit screens

`SapConnectionAudit` is a second, more detailed audit trail for SAP connection changes and tests. It records config field diffs and credential names only, never secret values.

### Logging and health

Backend logs are structured through:

- `backend/utils/logger.js`
- `backend/middleware/requestLogger.js`

Health surfaces:

```text
GET /api/health             basic API, Mongo and socket health
GET /api/status             anonymous public aggregate status
GET /api/platform/health    per-tenant SAP, usage and activity health
```

### Deployment

Production deployment files:

```text
deploy/ecosystem.config.js
  vendorconnect-api -> backend/server.js on port 5000
  vendorconnect-web -> next start -p 3000

deploy/nginx.conf
  /api/       -> Express backend
  /socket.io/ -> Express/Socket.io backend with upgrade headers
  /           -> Next.js frontend
```

PM2 is configured in fork mode. The API comment notes Socket.io needs sticky sessions before cluster mode is used.

## 13. Testing Architecture

Frontend:

```text
npm test
  -> vitest run
  -> src/**/*.test.{js,jsx}
```

Current frontend tests cover:

- profile validation
- onboarding/branding utilities
- platform nav permission strings
- workspace nav permission strings

Backend:

```text
cd backend
npm test
  -> cross-env NODE_ENV=test JWT_SECRET=test-secret jest --runInBand --forceExit
```

Backend tests use:

- Jest
- Supertest
- mongodb-memory-server
- `backend/tests/setup.js`
- `backend/tests/testApp.js`

Important backend test coverage areas:

- auth and auth middleware
- password reset and identity rules
- tenant plugin and tenant isolation
- RBAC route-permission matrix
- RFQ and P2P lifecycle
- SAP adapter and conformance runner
- platform console
- tenant workspace
- billing/usage/operations
- migration scripts

CI runs both root and backend suites in `.github/workflows/test.yml`.

## 14. Key Architectural Boundaries

1. Frontend and backend are separate npm packages. Frontend commands run at repo root; backend commands run under `backend/`.
2. Platform operator sessions use `vc_platform_token`; supplier and tenant staff sessions use `jwt_token`.
3. Platform routes configure tenants and SAP connections but do not browse tenant business data except explicit audited export.
4. Tenant-scoped backend queries must run inside `runWithTenant(clientId, fn)` or request-bound `protect`.
5. `withoutTenantScope(fn)` is only for platform work and pre-auth lookups.
6. Controllers call the SAP adapter contract, never a concrete driver.
7. SAP is simulated by default. `s4_odata` and `ecc_rfc` exist as configured driver paths, but only the mock driver is fully implemented.
8. SAP secrets are encrypted at rest and returned only as configured secret names.
9. SAP logs are tenant-scoped and expire after 30 days.
10. Vendor identity uses `vendorId` as the business link, with legacy `clerkId` compatibility in some queries.
11. There is no current `admin` role. The active roles are `super_admin`, `sap_manager`, `client_admin`, `buyer`, `finance` and `vendor`.
12. The UI should follow the strict industrial console design system in `DESIGN.md`.

## 15. End-To-End System Diagram

```text
User browser
  |
  | Next.js route in src/app
  v
React layout/providers
  |
  | Supplier: PortalProvider + apiClient + socket client
  | Workspace: WorkspaceSessionProvider + apiClient
  | Platform: PlatformSessionProvider + platformApi
  v
Express API /api
  |
  | security middleware
  | auth middleware
  | tenant context
  | permission guard
  v
Controller
  |
  | Mongoose model operations
  | SAP adapter calls
  | audit/log/email/socket side effects
  v
MongoDB collections
  |
  | Client, User, Vendor, RFQ, PurchaseOrder, ASN, GRN,
  | Invoice, Payment, ChatMessage, Document, SapLog,
  | SapConnection, SapConnectionAudit, Invitation, AuditLog
  v
Responses and realtime events
  |
  | JSON API response
  | Socket.io event to tenant-scoped room
  | PDF/file response where applicable
  v
Frontend hooks refresh state
  |
  v
User sees updated portal, workspace, platform console and BAPI log
```
