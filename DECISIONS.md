# Decisions

Architecture decision records for the VendorConnect SaaS conversion. Newest first.
Each entry: the call, why, and what it costs.

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
