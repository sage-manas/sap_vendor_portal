# Decisions

Architecture decision records for the VendorConnect SaaS conversion. Newest first.
Each entry: the call, why, and what it costs.

---

## ADR-0022 — The driver owns *when*, the controller owns *what to persist*
**Phase 4 · 2026-08-13 · Accepted**

**Context.** Three of the simulator's behaviours are deferred: a goods receipt ten
seconds after an ASN, an F110 payment run twelve seconds after an invoice, a vendor
confirmation five seconds after submission. Each was a `setTimeout` in a controller wrapping
a `runWithTenant`, a state re-check, two model writes and two log writes. A real SAP would
deliver the same answers by webhook or poll — the *timing* mechanism differs, everything
else does not.

**Decision.** Deferred contract methods take a handler: `sap.awaitGoodsReceipt(args,
handler)`. The driver decides when the answer arrives and what is in it; the wrapper
re-binds the tenant context and writes the SapLog; the handler — which stays in the
controller — decides what to store. A handler returns what it persisted, or `null` to
decline the answer, and a declined answer produces no log entries and leaves any pending
call open, because as far as our records go it never happened.

**Consequences.** Swapping the mock for a real driver changes when the handler runs and
nothing else, which is the property Phase 8 needs. `runWithTenant` disappears from three
controllers; the only place a deferred answer re-binds a tenant is `sap/index.js`. The
timings become `SapConnection.config.timings`, so a demo runs at ten seconds, a test at
zero, and a pilot wherever the design partner wants — no code change. The cost is that a
handler runs outside any request: it has no `res` to fail into, so a thrown error becomes a
FAILED log line and a logger error, and nothing else. That is the same deal the old
`catch (err) { console.error(...) }` made, made explicit and in one place.

---

## ADR-0021 — Every SAP result says where it came from
**Phase 4 · 2026-08-13 · Accepted**

**Context.** With mock, sandbox and production drivers running side by side across tenants,
a number on a screen has no inherent provenance. "Cleared 12s ago by F110" reads identically
whether F110 ran in Walldorf or in `mock.driver.js`, and during a pilot both are true for
different tenants at the same time.

**Decision.** The adapter wrapper stamps `{ source, syncedAt }` on every result, `source`
being the driver key. `mock` is a truthful answer, not a placeholder. It also stamps
`transaction: { code, type }` from the registry, so a caller that wants to announce a call
over a socket reads it from the result instead of retyping the BAPI name — which is how the
old code ended up with `'BAPI_GOODSMVT_CREATE'` written in four places.

**Consequences.** The health board can distinguish "no traffic" from "no connection", and a
tenant on the simulator can be shown as such rather than implied to be live. Phase 5 and 6
screens inherit the guarantee for free. The cost is a slightly larger result object on every
call, and one rule for driver authors: return `{ data, log }`, never a bare value.

---

## ADR-0020 — Connection config is stored per environment; promotion is a separate act
**Phase 4 · 2026-08-13 · Accepted**

**Context.** A tenant needs somewhere to prove a connection before their live traffic
depends on it. Editing one row and hoping nobody transacts during the edit is not that
place.

**Decision.** `SapConnection` is unique on `{clientId, environment}` with two environments,
sandbox and production. Which one a tenant's traffic uses is a single field on `Client`,
`sapEnvironment`, and only `POST /sap/promote` writes it. Promotion *to* production requires
`lastTest.ok`; going back to sandbox requires nothing, because a rollback you have to
qualify for is a rollback you cannot use in an incident. Any edit to a connection clears its
`lastTest`, since a green tick against settings that have since changed is worse than no
tick at all.

**Consequences.** Configuring and going live are two audited actions with different
preconditions, and "who put this tenant on production, when, and had it been tested" is one
query. The mock driver is the default for an unconfigured tenant, so a freshly created
workspace works before anyone has visited the SAP screen — which is exactly what every
tenant did before this phase. The cost is that two rows exist per tenant and an operator has
to understand which one is live; the console marks it and the board lists it.

---

## ADR-0019 — SAP credentials use envelope encryption, and `SapConnection` is not tenant-scoped
**Phase 4 · 2026-08-13 · Accepted**

**Context.** ADR-0017 left `v2` as the seam for per-client data keys. This phase needs it:
SAP credentials are long-lived, per tenant, and the kind of secret an auditor asks about
key rotation for.

**Decision.** A random 32-byte data key per connection encrypts each credential (`v2:` blob);
the data key is wrapped under the master key (`v1:` blob) and stored beside it. Rotating the
master key re-wraps N small keys instead of re-encrypting every secret, and a KMS swap
replaces exactly two functions — `wrapDataKey` and `unwrapDataKey` — because nothing else
touches the master key. `wrappedDataKey` is `select: false`, so a document loaded for
display physically cannot decrypt; `decryptSecrets()` is a greppable method with one caller,
the driver factory. `toJSON` strips both halves.

`SapConnection` and `SapConnectionAudit` do **not** carry the tenant plugin, for the reason
ADR-0014 gave for `AuditLog`: they are tenant *configuration*, written only from the platform
plane where no tenant is bound, so the plugin would make `withoutTenantScope()` the normal
path on these collections. `clientId` is an ordinary required indexed field and every read
takes it as an argument.

**Consequences.** No endpoint returns a credential — the API answers with the *names* of the
ones that are set, which is what the console renders, and the test suite asserts the
plaintext appears in no response, no audit row and no log line. The trade for opting out of
the plugin is that these two models are not covered by the isolation suite's blanket rule
and need their own cases; they have them. `SapConnectionAudit` is append-only by the same
mechanism as `AuditLog`, and records field-level before/after for config while recording
only *names* for credentials.

---

## ADR-0018 — One registry of SAP transactions, and the adapter writes the log
**Phase 4 · 2026-08-13 · Accepted**

**Context.** `'BAPI_GOODSMVT_CREATE'` and its two companions `type: 'BAPI'` and
`direction: 'INBOUND'` were written out at each of twenty-five call sites across five
controllers. Nothing checked that the three agreed, and a typo produced a `SapLog` row no
filter would ever match.

**Decision.** `config/sapTransactions.js` declares each transaction once — code, type,
direction, label — and `transaction(key)` throws on an unknown key, the same bargain
`config/auditActions.js` makes. Controllers no longer call `createSapLog` at all: the driver
returns `{ data, log }` and the adapter wrapper writes the entry, so a log row cannot
disagree with the call it describes. A failed call is logged too, because a log that records
only successes is the one you cannot debug with.

**Consequences.** `createSapLog` is gone; `recordSapCall`/`resolveSapCall` replace it and
have one caller. Adding a transaction is one registry entry plus the driver method that
uses it. Controllers got shorter and stopped knowing what a BAPI is — `po.controller.js`
lost roughly seventy lines. The cost is one indirection between "we called SAP" and "it was
logged", which is what makes the log trustworthy.

---

## ADR-0017 — Secrets at rest go through one box, and the TOTP is ours
**Phase 3 · 2026-08-12 · Accepted**

**Context.** Mandatory MFA needs a shared TOTP secret stored per operator. It is the
first true secret the application holds, and Phase 4 adds SAP credentials behind the same
requirement: stored, never returned, never logged.

**Decision.** `utils/secretBox.js` — AES-256-GCM, random 12-byte IV per message, stored as
a versioned self-describing string `v1:<iv>:<tag>:<ciphertext>`. The key comes from
`MASTER_KEY`; production refuses to start without it, while development and test derive a
stable key from `JWT_SECRET` so nobody has to configure two secrets to run the app.
`utils/totp.js` implements RFC 6238 on node's crypto rather than adding a dependency, and
is tested against the RFC's own published vectors plus drift and constant-time comparison.

**Consequences.** The version prefix is the seam Phase 4 needs: per-client data keys wrapped
by this master key become `v2`, with `v1` still readable. Two costs. The derived
development key means a dev database's MFA secrets are decryptable by anyone holding
`JWT_SECRET` — acceptable because production cannot use that path. And we own ~60 lines of
crypto arithmetic; the RFC vectors are what make that defensible, and they are in
`tests/crypto-primitives.test.js`.

---

## ADR-0016 — MFA is mandatory on the platform plane, and the token carries the proof
**Phase 3 · 2026-08-12 · Accepted**

**Context.** The console can create, suspend and terminate every tenant on the platform.
A stolen operator password cannot be allowed to be sufficient, and "MFA is available in
settings" is not a control.

**Decision.** Sign-in is always two steps. The password check mints a token carrying
`mfa: false`; it opens `/api/platform/auth/*` and nothing else. `verifyMfa` mints the only
token `requireMfa` accepts. `requireMfa` guards the whole console via a single
`router.use(protectPlatform, requireMfa)`, and distinguishes its two refusals with a
machine-readable `reason` — `mfa_enrolment_required` versus `mfa_verification_required` —
because "set up an authenticator" and "type your code" are different screens. Enrolment
cannot be skipped and there is no endpoint that turns MFA off; a lost device is recovered
by a super admin clearing the enrolment (`operator:manage`), which forces a fresh one.

**Consequences.** An operator with no authenticator cannot use the console at all, including
the operator who bootstrapped the platform — deliberate. Clearing enrolment immediately
demotes every session that account holds, since `requireMfa` re-reads `mfaEnabled` on each
request. `ApiError` gained an options bag to carry `reason`; the response's existing `code`
field still means the HTTP status, so nothing downstream changed.

---

## ADR-0015 — Termination is soft, and the export is the one place the platform reads tenant data
**Phase 3 · 2026-08-12 · Accepted**

**Context.** The plan's hard rule is that platform roles hold no tenant business data. But
offboarding a tenant means handing back everything they put in, and a tenant that can be
deleted through an API is a tenant that can be deleted by mistake.

**Decision.** `terminate` is a status change plus a timestamp; no endpoint deletes a
tenant's documents, and destruction after the retention period is a deliberate out-of-band
job. `GET /tenants/:clientId/export` is the single exception to the no-tenant-data rule: it
requires `tenant:manage`, produces a whole-tenant archive in one audited action, and is not
a browsing surface — there is no endpoint that returns one tenant's RFQs, invoices or
messages to an operator. Everything else the console shows about a tenant is counts and
totals, produced by `countDocuments` inside `runWithTenant`. `config/tenantModels.js` is the
registry both the export and those counts iterate, and the test suite asserts the two agree.

**Consequences.** An exit right that only the tenant can exercise is worthless when their
own admin has left, so this is the shape the right has to take; the price is one operator
capability that must be watched, which is why it is audited with per-collection counts.
Suspension and termination both take effect on the next request, because `protect` already
re-checks `client.isOperational()` every time.

---

## ADR-0014 — `AuditLog` is not tenant-scoped, and is append-only
**Phase 3 · 2026-08-12 · Accepted**

**Context.** Every other collection carrying a `clientId` gets the tenant plugin. The audit
trail cannot: creating an operator concerns no tenant at all, and reading across tenants is
the console's entire purpose. Applying the plugin would mean either a `required` clientId
that platform actions cannot supply, or a `withoutTenantScope()` on every read — the escape
hatch as the normal path, which is how escape hatches stop being noticed.

**Decision.** `clientId` is an ordinary optional indexed field, and `utils/audit.js` is the
only way anything is written: it stamps the bound tenant automatically, derives actor,
plane and IP from the request, redacts secret-shaped keys, and rejects any action not in
`config/auditActions.js`. The model refuses updates and deletes outright.

**Consequences.** A tenant-plane action cannot be recorded without its `clientId`, because
the recorder reads it from the context rather than from the call site. The trade is that
Phase 5's tenant-facing audit view must filter explicitly rather than being filtered for it
— that view will go through a helper that requires a `clientId`, and it is the one place
this decision has to be remembered. A typo'd action throws rather than logging, because an
unlisted action would be invisible to every filter in the explorer; a failed audit *write*
only logs an error, since losing the trail must not also lose the operation it described.

---

## ADR-0013 — A role change invalidates every token that account already holds
**Phase 2 · 2026-08-12 · Accepted**

**Context.** Tokens live for 30 days and carry the role they were minted with. A
client_admin demoted to buyer — or suspended outright — would otherwise keep administrator
permissions until their token expired.

**Decision.** `protect` compares the token's `role` claim against the account's current
role and answers 401 ("session is stale — sign in again") when they differ. `canAuthenticate()`
is re-checked on every request, not only at login.

**Consequences.** Demotion and suspension take effect on the next request, with no
revocation list or session store. The cost is one extra failure mode for clients: a role
change forces a re-login, which the UI must handle as "sign in again" rather than as an
error. Legacy tokens minted before Phase 2 carry no role claim and are accepted as
supplier tokens, re-validated against the account.

---

## ADR-0012 — Routes declare a permission; the registry decides who holds it
**Phase 2 · 2026-08-12 · Accepted**

**Context.** Authorization was `authorize('admin')` inline in three route files, and
everything else was open to any authenticated account. Six roles across three planes makes
that unworkable, and the plan forbids duplicated role lists.

**Decision.** `config/permissions.js` is the single map of role → permissions. Every route
declares exactly one permission via `requirePermission(PERMISSIONS.X)`; no route names a
role. The declaration is readable off the middleware function (`fn.permission`), and
`tests/route-role-matrix.test.js` walks the real Express router and fails when a route
declares nothing, declares an unknown permission, or declares one no role holds. Public
endpoints are an explicit allow-list inside that test.

**Consequences.** Adding a role is a one-file change; adding a route without thinking about
authorization breaks CI on the same commit. The matrix test also asserts the plan's hard
rule directly: platform roles hold no tenant-business permission and tenant/supplier roles
hold no platform permission. The cost is one permission per route — coarser than per-field
rules, which is deliberate for now.

---

## ADR-0011 — Reset links and invitations are emailed, and never logged
**Phase 2 · 2026-08-12 · Accepted**

**Context.** `forgotPassword` wrote the reset URL to the application log because no mail
service existed. That put a working credential-reset token into log files, log shipping and
anyone's `grep`.

**Decision.** `utils/mailer.js` with three transports: `smtp` (nodemailer), `log`
(development — prints recipient, subject and template name, never the body) and `memory`
(tests assert against it). Selection is `MAIL_TRANSPORT`, else smtp in production, memory
under test, log in development. `assertMailerConfigured()` runs at boot and refuses to start
a production server on anything but SMTP. All copy lives in `config/emailTemplates.js`.

**Consequences.** A production deployment now needs `SMTP_HOST` (and normally
`SMTP_USER`/`SMTP_PASSWORD`/`MAIL_FROM`) or it will not start — deliberate, since
invitations and resets are the only way staff accounts are created. `MAIL_DEBUG_BODY=true`
restores body logging in development only.

---

## ADR-0010 — The `x-vendor-id` header is gone from every environment
**Phase 2 · 2026-08-12 · Accepted**

**Context.** `protect` authenticated a tokenless request from an `x-vendor-id` header
whenever `NODE_ENV !== 'production'`, and eleven controllers independently resolved "whose
data is this" as `req.clerkUserId || req.headers['x-vendor-id'] || 'mock_vendor_id'`. The
header path meant any caller could name any supplier — and, in the last fallback, a
fictional one — with the production guard sitting in one place and the header reads in
another.

**Decision.** Removed entirely: from `protect`, from every controller, from the upload
middleware's storage path, and from the CORS allow-list (`x-client-slug` replaces it there).
Scope now comes from the principal via `utils/requestScope.js` — a supplier is pinned to
their own `vendorId` whatever the request says, and tenant staff see their whole tenant
unless they narrow it with `?vendorId=`.

**Consequences.** One rule, one file, no environment-dependent auth. The `'mock_vendor_id'`
literal is gone from the backend. Tests and dev tools must sign a token; anything that
relied on the header now gets a 401. Actions that need a supplier and are performed by staff
(raising a payment, uploading on a supplier's behalf) must name the `vendorId` in the
request body, and get a 400 if they do not.

---

## ADR-0009 — `ADMIN_BOOTSTRAP_EMAILS` is removed, and its presence fails boot
**Phase 2 · 2026-08-12 · Accepted**

**Context.** An email listed in that env var received `role: 'admin'` on registration — a
public, unauthenticated endpoint minting an administrator, with the safety property being
"remember to unset the variable afterwards".

**Decision.** Deleted. Staff accounts come from an invitation or from tenant provisioning;
the first platform operator comes from `scripts/seed-platform-admin.js`. `validateEnv()`
exits with an explanatory message if `ADMIN_BOOTSTRAP_EMAILS` is still set anywhere.

**Consequences.** Self-registration can only ever produce a supplier, which the test suite
asserts. Existing deployments must remove the variable before the server will start —
loud, on purpose, because silently ignoring it would leave operators believing a
provisioning path still exists.

---

## ADR-0008 — Platform operators are a separate collection with a separate login
**Phase 2 · 2026-08-12 · Accepted**

**Context.** The platform plane holds no tenant, so its accounts cannot live in a
tenant-scoped collection. They could have been `User` documents with a null `clientId`.

**Decision.** `PlatformUser` is its own collection, not tenant-scoped, reachable only
through `/api/platform/auth/*` behind `protectPlatform`. Operator credentials are rejected
at `/api/auth/login` and tenant credentials at the platform login. A tenant account calling
a platform endpoint gets **404**, not 403 — the same "never confirm what you may not see"
rule the plan sets for cross-tenant reads, applied to the console itself.

**Consequences.** A tenant query can never surface an operator, whatever goes wrong with
scoping, because there is no operator in that collection to surface. MFA fields live on
`PlatformUser` now and Phase 3 makes enrolment mandatory before the console loads. The cost
is a second login surface and a second reset flow, which is the point.

---

## ADR-0007 — Tenant staff live in a new `User` collection, not a widened `Vendor`
**Phase 2 · 2026-08-12 · Accepted**

**Context.** Today's tenant administrator is a `Vendor` document with `role: 'admin'` —
carrying GSTIN, PAN, bank details, compliance uploads and an onboarding status, none of
which mean anything for a buyer or a finance user. Phase 2 needs three tenant roles.

**Decision.** A separate `User` collection for `client_admin`/`buyer`/`finance`, tenant-scoped
by the same plugin. `Vendor` stays exactly what it is: the supplier master record plus
supplier login, and its role enum narrows to `vendor` alone. Password and reset-token
behaviour is shared by all three identity collections through `models/plugins/credentialsPlugin.js`
so the rules cannot drift apart. Email remains globally unique in both collections, because
login resolves an account before any tenant is known. `scripts/migrate-identity.js` moves
existing admin vendors across, carrying their password hash so their credentials keep
working, and refuses to touch any admin vendor that also has business documents.

**Consequences.** `protect` now resolves three account kinds, and `req.vendor` is set only
for suppliers — tenant staff get `req.user` and a null `req.scopeVendorId`, which is what
makes them see the whole tenant instead of one supplier's rows. The login response returns
`user` rather than `vendor` for staff; the current `/admin` screen still speaks the old
shape and is rebuilt in Phase 5. Two collections must be searched at login and on password
reset — an acceptable cost for not carrying a compliance record around every buyer.

---

## ADR-0006 — Anonymous socket connections are no longer possible
**Phase 1 · 2026-08-12 · Accepted**

**Context.** The socket handshake accepted a `vendorId` from `handshake.auth`, falling
back to the literal `'mock_vendor_id'`, and joined a room named after it. Rooms are now
keyed on `clientId`, which only the JWT can be trusted to carry.

**Decision.** The handshake requires a valid JWT containing a `clientId`. The
`vendorId`/`x-vendor-id`/`mock_vendor_id` fallbacks are removed from the socket path
entirely, in every environment.

**Consequences.** A client can no longer name the room it joins — it gets
`client:{clientId}:vendor:{vendorId}` from its own token and nothing else. Any dev tool
that opened a tokenless socket (e.g. the root `test_sockets.js` script) must now sign a
token first. `src/lib/socket.js` still sends an `auth.vendorId` field; it is inert and is
cleaned up when the supplier plane is reworked in Phase 6.

---

## ADR-0005 — The simulator timers re-bind the tenant context explicitly
**Phase 1 · 2026-08-12 · Accepted**

**Context.** The SAP simulation runs in `setTimeout` callbacks (5s vendor auto-approve,
10s GRN, 12s F110 payment run, 2s chat auto-reply). These fire after the request has
ended, so the `AsyncLocalStorage` context is gone and every query inside them would throw.

**Decision.** Each timer captures `req.clientId` at schedule time and wraps its body in
`runWithTenant(clientId, …)`.

**Consequences.** Deferred work is tenant-safe today, and the pattern is the one any
future job or queue consumer must follow: whoever schedules the work carries the tenant to
it. Phase 4 moves these timers wholesale into the `mock` SAP driver, where the same
binding requirement applies at the adapter boundary instead of in controllers.

---

## ADR-0004 — Unauthenticated endpoints resolve their tenant from the request
**Phase 1 · 2026-08-12 · Accepted**

**Context.** `POST /api/auth/register` and `POST /api/vendors/profile` create suppliers
without a JWT, so there is no tenant to bind from. The plan makes tenant resolution
subdomain-driven, but that is Phase 6 work.

**Decision.** A single resolver, `utils/resolveClient.js`, determines the workspace in this
order: an explicit `x-client-slug` header (dev affordance) → the host's subdomain, when
the host is a real multi-label hostname and not a bare IP → `DEFAULT_CLIENT_SLUG` →
`legacy`. An unknown slug is a 400; a non-operational tenant is a 403.

**Consequences.** The existing single-tenant deployment keeps working unchanged, because
everything lands in `CLT-0001`. Phase 6 replaces the header affordance with real subdomain
routing without touching the call sites.

---

## ADR-0003 — Platform accounts are rejected at tenant endpoints, not merely unscoped
**Phase 1 · 2026-08-12 · Accepted**

**Context.** The plan's hard rule is that platform roles hold no tenant business data.
Relying on those accounts simply having `clientId: null` would mean the tenant plugin
throws a 500 on their first query — the right outcome, but for the wrong reason and with an
unhelpful error.

**Decision.** `config/roles.js` is the single registry of roles → planes. `protect` reads
the plane and refuses platform-plane accounts at tenant endpoints with an explicit 403,
before any query runs.

**Consequences.** The registry is in place for the six roles Phase 2 introduces, with only
`admin` (tenant) and `vendor` (supplier) populated today. Phase 3 gives the platform plane
its own `/api/platform/*` surface, and this guard is what keeps the two apart in the
meantime.

---

## ADR-0002 — Supplier login identities stay globally unique; everything else is per-tenant
**Phase 1 · 2026-08-12 · Accepted**

**Context.** Business IDs (`RFQ-2026-001`, `PO-2026-0001`, …) become unique per tenant, via
compound `{clientId, id}` indexes. `Vendor` is different: it is both supplier master data
*and* the login principal, and login happens before any tenant is known.

**Decision.** `Vendor.vendorId`, `Vendor.email` and `Vendor.gstin` keep their **global**
unique indexes. `Vendor.sapVendorCode` becomes unique **per tenant** (partial compound
index), since it is issued by each tenant's own SAP. All other collections move to
per-tenant uniqueness.

**Consequences.** Login stays unambiguous with no realm selection in the UI, and the
pre-auth lookups are honest about being cross-tenant (they go through
`withoutTenantScope()`). The cost: one company cannot register as a supplier to two
tenants with the same email or GSTIN. That is a real limitation, and the point at which it
bites is the point at which suppliers should be split into a global identity plus a
per-tenant supplier record — revisit in Phase 6 when registration becomes subdomain-aware.

---

## ADR-0001 — Tenant isolation is enforced by a Mongoose plugin that throws, not by convention
**Phase 1 · 2026-08-12 · Accepted**

**Context.** The alternatives were database-per-tenant, a shared database with
discipline-enforced `clientId` filters, or a shared database with enforcement in the ODM.
Discipline fails silently and in the worst direction: a forgotten filter returns *every*
tenant's rows.

**Decision.** An `AsyncLocalStorage` tenant context bound by `protect`, plus a Mongoose
plugin applied to all ten tenant-scoped schemas. It injects `clientId` into every
find/update/delete/count/aggregate, stamps it on save, ignores any caller-supplied
`clientId`, refuses to move a document between tenants — and **throws** when no context is
bound. Platform work opts out through the single, greppable `withoutTenantScope()`.

**Consequences.** The failure mode of forgetting the tenant is a loud 500 in development,
not a silent leak in production. Two costs, both accepted: (1) queries must execute
*inside* the context, so the helpers `await` their callback — returning a lazy Mongoose
Query un-awaited would run it after the store unwound (this bit during implementation and
is now commented at the source); (2) test code that touches models directly must bind a
tenant too, via the `asTenant()` helper. `estimatedDocumentCount` is deliberately not
intercepted — it takes no filter and cannot be made tenant-safe; use `countDocuments`.
