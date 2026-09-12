# Decisions

Architecture decision records for the VendorConnect SaaS conversion. Newest first.
Each entry: the call, why, and what it costs.

---

## ADR-0037 — API-bypassing test setup is a defect report, enforced at review rather than by a grep
**QA remediation · 2026-09-12 · Accepted**

**Context.** The two highest-severity defects found in the QA sweep — an uninvited supplier
could bid on a sealed tender (#17), and the first bid closed that tender to every other
invited supplier (#18) — both survived a suite of 30+ backend files. Neither path was
untested. Both were tested *wrongly*, and in each case the author could evidently see the
problem, because the evidence is in their own words:

```js
it('accepts a bid from a non-invited vendor by dynamically inviting them', …)
//  ^ an authorisation hole written down as expected behaviour

// Seed two competing bids directly (API closes bidding after the first bid)
//  ^ an accurate bug report that never became one
```

The second is the more interesting failure. The ME48 evaluation test validated the scoring
arithmetic correctly — on data the API could not produce. The maths was right and
unreachable, and the comment explaining why sat in the file for as long as the bug did.

An untested path is a known unknown: coverage tooling finds it and nobody argues. A wrongly
tested path is worse on every axis — it reads as covered, it goes green on every run, and it
actively resists repair, because fixing the code turns the test red. Under deadline pressure
the test is at least as likely to be "fixed" as the code.

**Decision.** Three rules, carried where the people and the agents doing the work will meet
them: `.github/pull_request_template.md` (two checkboxes) and `AGENTS.md` (the reasoning,
since most sessions here are agent-driven).

1. **API-bypassing setup is a defect report.** Writing through Prisma to construct a state
   the API is supposed to be able to produce is a finding about the API — fix it, or file it
   and link the issue from the test. Seeding *preconditions* the test does not exercise (a
   tenant, an approved supplier, historical rows, another tenant's data) stays normal and
   expected.
2. **No test name describes a defect approvingly.** A reviewer scanning names should be able
   to tell.
3. **A test pinning known-imperfect behaviour links the issue** tracking the decision, so the
   debt stays visible rather than curing into "that's just how it works".

**What we did not build, and why.** The issue proposed an optional CI grep flagging
`prisma.*.create(` inside `backend/tests/*.test.js`. Measured before building: 102
occurrences across 18 files, almost all of them legitimate. `tenant-isolation.test.js` alone
accounts for 31 and could not exist otherwise — writing directly as one tenant and reading as
another *is* the test. A warning that fires 102 times teaches everyone to ignore it, and the
next real instance scrolls past with the rest.

The signal that actually distinguishes the two cases is not "writes directly to the
database" but "writes the state the endpoint under test is supposed to produce" — which is
semantic, and which a grep cannot see. So this one is enforced by review, deliberately, and
this paragraph exists so the guard is not re-proposed on the assumption nobody thought of it.

**Cost.** A rule enforced by review is a rule that can be skipped by a rushed review; there
is no mechanical backstop, and we have accepted that in exchange for not training the team to
ignore a noisy one. The two example tests have been rewritten (#17, #18), so the pattern no
longer has a live instance in the repo to point at — which is itself a reason the reasoning
is written down here rather than left in the diffs.

---

## ADR-0036 — Phase 8 stays gated on a design-partner sandbox; only the conformance harness ships
**Phase 8 · 2026-08-14 · Accepted**

**Context.** The plan is explicit: "Phase 8 — Real SAP (only with a design-partner
sandbox)." No sandbox credentials exist anywhere in this repo or were available when this
phase was picked up. Writing a "real" `s4_odata`/`ecc_rfc` implementation with no system to
call it against would mean guessing at OData/RFC request and response shapes and asserting
tests pass against fixtures invented for the occasion — exactly the kind of pretending the
skeletons in `sap/drivers/s4odata.driver.js` and `eccrfc.driver.js` were built (Phase 4,
ADR-0019-ish) to refuse. The scope question was also raised and settled separately: SAP
connections stay `Client`-scoped, not `Vendor`-scoped (matches the existing per-tenant
architecture), and no third driver type (Business One, generic webhook) is added
speculatively — one gets built when a concrete tenant needs it.

**Decision.** Build the piece of Phase 8 that doesn't need a sandbox: the conformance
suite. `sap/conformance/runner.js` runs every method in the `SapAdapter` contract
(`sap/contract.js`) against a live adapter and reports `passed` / `not_implemented` / `failed`
per method, with a timeout so a driver that never answers doesn't hang the suite forever.
`sap/conformance/fixtures.js` holds one representative payload per method, shaped like
`sap/drivers/mock.driver.js` reads them, so the same fixtures exercise the mock, the
skeletons, and — unchanged — whatever real driver eventually replaces them.
`scripts/sap-conformance.js` is the CLI: `--client <id>` runs it against an
already-configured tenant, `--driver <key> --config file.json --secrets file.json` runs it
against a throwaway adapter for a sandbox with no tenant set up yet. Both raise (or, for
`--client`, warn about) the per-adapter circuit breaker's failure threshold for the run,
because 5 consecutive `not_implemented` results would otherwise trip it and hide every
method after the fifth behind `sap_circuit_open` instead of the honest answer. The script
also disables Mongoose's write-buffering — without a live DB connection each failed call's
`SapLog` write was blocking for the driver's 10s buffering timeout, turning an
instant 18-method skeleton run into three minutes.

`s4_odata` and `ecc_rfc` remain exactly the skeletons Phase 4 left them: `testConnection`
and `health` answer for real, everything else throws `not_implemented`. Nothing here claims
otherwise.

**Consequences.** The moment a design-partner sandbox exists, pointing
`sap-conformance.js --driver s4_odata --config sandbox.json --secrets creds.json` at it is
the first thing to run, before or after any implementation work — it will report
`not_implemented` for everything until the driver's methods are actually filled in, then
flip to `passed`/`failed` one at a time as they are, which is the pass/fail-per-method
progress report the plan asked for. Until then this phase produces no forward motion on the
real drivers themselves — that work is genuinely blocked, not simulated.

---

## ADR-0035 — The offboarding export already existed; it is not re-litigated in Phase 7
**Phase 7 · 2026-08-13 · Accepted**

**Context.** The Phase 7 brief lists "tenant offboarding export" among its deliverables.
Phase 3 already built one (`GET /platform/tenants/:clientId/export`, ADR-0015): a whole-
tenant JSON archive, audited, the one place a platform operator sees tenant documents.

**Decision.** No new export endpoint. `docs/runbooks/tenant-suspension.md` documents the
existing one as the offboarding deliverable and records the one real gap found while writing
that runbook: the export bundles database rows, not the files in `backend/uploads/` — a
tenant's compliance PDFs are not in the archive. That gap is recorded, not fixed, in this
phase: bundling files means either reading them into the JSON response (memory cost
proportional to a tenant's total upload size) or switching the endpoint to a streamed zip,
which is a larger, separately-reviewable change than "add usage metering."

**Consequences.** The offboarding flow works today with a known, documented limitation
rather than an undocumented one. Whoever picks up file-bundling next has the shape of the
problem already written down instead of having to rediscover it mid-incident.

---

## ADR-0034 — Plan limits are enforced at the write, counted fresh, and null means unlimited
**Phase 7 · 2026-08-13 · Accepted**

**Context.** `Client.limits` and `usage.js`'s `against()` helper (vendors, RFQs-this-month)
existed since Phase 3/5 for *display* — the health board and workspace overview could show a
tenant it was over its plan, but nothing stopped them from going further over it. Enforcing
a limit needs a decision the display code never had to make: what does a limit of `0` mean?

**Decision.** `assertCanCreate(client, metric)` counts the metric fresh — no cached counter
that could drift from the truth — and refuses the write with `402 plan_limit_reached` when
`used >= limit`. It treats a limit as unlimited only when it is `null`/`undefined`
(`limit == null`); `0` is a real limit and blocks immediately. This reads differently from
the pre-existing `against()` display helper, which uses `Boolean(limit && …)` and so shows
`0` the same as unlimited — a pre-existing quirk in a read path, left alone rather than
changed as a side effect of adding enforcement. It is called from every place a vendor or an
RFQ is created: `POST /auth/register`, `POST /vendors/profile` (both self-registration),
`POST /vendors` (tenant-created), and `POST /rfqs`.

**Consequences.** A tenant cannot exceed its plan by racing the count — the assertion and
the creation both run inside the same tenant-bound context, and there is no window between
"checked" and "created" that a second concurrent request widens in practice for this
workload (a real race under heavy concurrent load could still admit one extra document; a
hard atomic guard would need a conditional update on a running counter, which is future work
if plan limits become a real commercial lever rather than today's soft cap). The cost is one
extra count query per creation — acceptable at this scale, and the same query the health
board already ran.

---

## ADR-0033 — Billing is an interface with one provider, and it never blocks the request it's attached to
**Phase 7 · 2026-08-13 · Accepted**

**Context.** "Billing behind an interface, stub first" is explicit in the plan. There is no
payment processor integrated yet and, per the plan, none is expected until there's a real
commercial need — this phase has to leave the seam without pretending there's a provider
behind it.

**Decision.** `services/billing.service.js` mirrors the shape `utils/mailer.js` and
`sap/index.js` already established for this codebase: a small contract
(`onTenantCreated`, `onTenantStatusChanged`, `reportUsage`), a provider registry keyed by
name, and env-var selection (`BILLING_PROVIDER`, default `null`). The `null` provider logs
every call and returns a stub success — it is a truthful "nothing happened," not a silent
no-op. Usage reporting is operator-triggered (`POST
/platform/tenants/:clientId/billing/sync-usage`) rather than scheduled, because there is no
job runner anywhere in this codebase to schedule it on; adding one would be infrastructure
this phase doesn't need yet to prove the seam works.

**Consequences.** Wiring a real processor later is one more entry in `PROVIDERS` behind the
env var — nothing that calls `getBillingProvider()` changes. Tenant creation and every
lifecycle transition call the provider unconditionally and await it, so a future real
provider's failure needs its own decision (retry? block the transition? log and proceed?)
that this phase does not have to make yet because the only provider that exists cannot fail.

---

## ADR-0032 — Rate limiting gets a second axis: the tenant, not just the IP
**Phase 7 · 2026-08-13 · Accepted**

**Context.** `apiLimiter` (Phase 1 and earlier) is IP-keyed and production-only. On a
shared deployment, a single noisy tenant — a runaway integration, a buggy poll loop — is
invisible to it if that tenant's calls come from many addresses (a NAT, a cloud egress
pool), and one IP-keyed bucket doesn't stop one tenant's traffic from starving every other
tenant's share of it.

**Decision.** `tenantLimiter` (`middleware/rateLimiter.js`) is keyed on `req.clientId`,
which only exists once `protect` has bound it — so it is mounted immediately after `protect`
on every tenant/supplier route (`routes/index.js`'s `protectTenant = [protect,
tenantLimiter]`, and the same pairing added route-by-route in `vendor.routes.js` for the
routes that mount `protect` individually). It is independent of `apiLimiter` and always on
except under `NODE_ENV=test`, where per-tenant throttling would make the test suite's rapid
sequential requests fail for a reason that has nothing to do with what's being tested.

**Consequences.** A noisy tenant now gets `429`s scoped to itself; every other tenant's
traffic is unaffected because they don't share a bucket. The cost is one more middleware
array to remember when adding a new protected route — `protectTenant`, not bare `protect` —
and a fallback to IP-keying (via `express-rate-limit`'s `ipKeyGenerator`, required by the
library for correct IPv6 handling) for the sliver of a request that could reach the limiter
without a bound tenant, which should not happen given the mount order but must not crash if
it somehow does.

---

## ADR-0031 — `req.log` carries clientId by construction; the sweep of every existing log call is deliberately not done
**Phase 7 · 2026-08-13 · Accepted**

**Context.** "Structured logging with clientId correlation" could mean either "make the
correlation available" or "guarantee every log line in the codebase carries it." The second
is a mechanical sweep of every `logger.info`/`.warn`/`.error` call site across every
controller — dozens of call sites, most of them unrelated to anything this phase is
otherwise touching, and each one a chance to introduce an unrelated bug in a change whose
whole point is operational safety.

**Decision.** `middleware/requestLogger.js` attaches `req.log` once, right where
`requestId` is generated: `req.log.info/warn/error(message, meta)` stamps `requestId` and,
once `protect` (or a pre-auth resolver) has set `req.clientId`, `clientId` — automatically,
for any call site that chooses to use it. The two log lines that already existed for every
request — the completion line in `requestLogger.js` and the error line in
`errorHandler.js` — were updated to include `clientId` directly, since those two see every
request and every error respectively and are the ones an incident actually greps first (see
`docs/runbooks/incident-response.md` §3). New or touched call sites should use `req.log`;
existing ones were not swept.

**Consequences.** The two log lines that matter most for tracing an incident to a tenant —
"this request happened" and "this request failed" — carry the correlation on every request,
today, with no further work. Deep-in-a-controller `logger.info()` calls that predate this
phase do not yet carry `clientId` unless and until they're touched and switched to `req.log`;
that is an accepted, incremental gap rather than a today problem, since the two universal log
lines already answer "which tenant hit this error."

---

## ADR-0030 — A tenant's brand moves one variable, not a palette
**Phase 6 · 2026-08-13 · Accepted**

**Context.** Suppliers arrive at their buyer's address and should find their buyer's
workspace, not ours. But `DESIGN.md` says no new colours and no new type scale, and a
tenant with a colour picker is a tenant who can produce an unreadable console — white text
on white, or a palette that fails contrast on every surface.

**Decision.** Branding is two things and no more: a logo URL and an accent. The accent
moves `--color-emerald-default-rgb`, the single variable the Kinetic Industrial Console
already derives every accented surface from — buttons, focus rings, the sidebar rail, the
BAPI console — and nothing else changes. `accentVariables()` is a pure function that
returns `{}` for anything that is not a six-digit hex colour, so a malformed setting is
the default, never a broken one. The variables go on `<html>`, since accented surfaces are
not all in one subtree.

**Consequences.** Every tenant's portal is legible by construction: backgrounds, text
colours and contrast ratios are the ones the design system shipped, and the accent is the
only thing that travels. A tenant who wants their exact brand colour on a surface the
accent does not touch cannot have it, which is the intended limit. The platform console
stays unbranded — it is VendorConnect's own plane, and painting it in a tenant's colour
would misrepresent whose screen it is.

---

## ADR-0029 — The full-cycle acceptance test goes through the API, not a browser
**Phase 6 · 2026-08-13 · Accepted**

**Context.** The phase brief asks for a Playwright path proving an RFQ→award→PO→ASN→GRN→
invoice→payment cycle inside one tenant with a second tenant invisible. Playwright would
add a browser download, a dev server and a seeded database to CI, and its assertions would
still be about what the API answered — read through three layers of chrome that can only
blur the result.

**Decision.** `backend/tests/lifecycle-e2e.test.js` drives the whole cycle over HTTP with
supertest against the real router and the mock driver, then asks the second tenant for
every document by id (404 on each) and for every list (empty, not filtered). It runs in
seven seconds inside the suite that already exists.

**Consequences.** The isolation claim — the one that matters — is asserted at the boundary
that enforces it, on every commit, with no new infrastructure. What is not covered is the
browser layer: that the screens render those documents and that the branding lands. Those
are UI regressions, not tenancy leaks, and they stay a manual check until there is a
reason to pay for a browser in CI. The mock driver's zero test timings (Phase 4) are what
make this possible at all; the same test against the 10s/12s demo timings would take half
a minute per cycle.

---

## ADR-0028 — The subdomain is the front door; a header is only a dev key
**Phase 6 · 2026-08-13 · Accepted**

**Context.** Since Phase 1 an unauthenticated request found its tenant through
`x-client-slug`, then the hostname, then a default — a deliberate placeholder, because a
header any browser can set must not be able to choose a workspace. Phase 6 has to settle
it, and settle what happens when an account from one tenant signs in at another's address.

**Decision.** The hostname's first label decides the tenant, with `www`/`platform`/`api`/
`app`/`admin` reserved and a bare IP never read as one. `x-client-slug` still works
outside production and is ignored outright when `NODE_ENV=production`. The resolver
returns *how* it decided (`subdomain` / `header` / `default`), and only a real subdomain is
trusted enough to refuse a login: at `contoso.vendorconnect.io`, a Northwind account gets
`Invalid credentials` — the same answer as a wrong password, so the door never reports
that an account exists somewhere else. `GET /api/auth/workspace` serves the realm to
signed-out screens and answers 404 for both an unknown slug and a suspended tenant.

**Consequences.** A tenant's address is now a real boundary rather than a label, and it
holds without a session. Local development and the test suite keep working through the
header, which is the affordance that lets one machine be any tenant. The cost is that the
deployment now needs wildcard DNS and a wildcard certificate before a second tenant can be
onboarded, and that a misconfigured proxy which drops `X-Forwarded-Host` sends every
visitor to `DEFAULT_CLIENT_SLUG` — a loud failure (the wrong company's name on the sign-in
screen) rather than a silent one, which is the right way round.

---

## ADR-0027 — The chrome asks the server who is signed in
**Phase 5 · 2026-08-13 · Accepted**

**Context.** The supplier portal decided who was an administrator with
`email.endsWith('@enterprise.com') || role === 'admin'` — in the sidebar and, separately,
in the command palette. Phase 2 deleted the `admin` role, so both checks had quietly
become "does this address end in @enterprise.com", which is not an authorisation rule at
all. Meanwhile the workspace layout has a full session provider that neither component is
inside of.

**Decision.** A small `useWhoami()` hook reads `GET /api/auth/me` once, caches the promise
at module scope so the two components share the request, and answers one question:
`isTenantStaff`. The back-office link appears when the server says the account is on the
tenant plane.

**Consequences.** The link is shown by the same fact the API enforces, and the two copies
of the rule became one. It costs one extra request on portal load for signed-in users, and
the cache lives until the page reloads — which is what sign-out does anyway. The full
session provider stays where it belongs, in the workspace layout; lifting it into the
portal shell to serve one boolean would have been the larger change.

---

## ADR-0026 — A tenant-created supplier gets a record, not a password
**Phase 5 · 2026-08-13 · Accepted**

**Context.** A tenant needs to add a supplier who will never fill in a registration form
themselves. That account needs credentials, and the obvious shapes are both wrong: letting
the tenant choose the supplier's password hands one party the other's login, and creating a
passwordless document leaves a row that `comparePassword` can never refuse safely.

**Decision.** `POST /api/vendors` creates the supplier with a random password nobody ever
sees, sets `mustChangePassword`, issues the ordinary reset token and emails a
`supplierWelcome` link. The record starts as `Draft` — the same place a self-registered
supplier starts — so the submit-then-approve path that follows is the existing one. The
route validates with `vendorCreateSchema`, which is `profileCreateSchema.omit({ vendorId,
status })`: the tenant supplies the same fields minus the two it does not own.

**Consequences.** There is exactly one field list for a supplier's identity, on both sides
of the wire — the API derives its schema, and the form renders from
`SUPPLIER_IDENTITY_FIELDS` in `src/features/profile/validation.js`, running the same
per-field rules the supplier's own form runs. The supplier's banking details and documents
stay theirs to enter. The cost is that a tenant can create a record for an email that never
answers, which shows up as a `Draft` in the directory and nothing worse. Plan limits are
not enforced on this path yet; metering is Phase 7's, and enforcing it here alone would
have made the two creation routes behave differently.

---

## ADR-0025 — A tenant reads its own trail, and an operator is "VendorConnect operations"
**Phase 5 · 2026-08-13 · Accepted**

**Context.** `AuditLog` is deliberately not tenant-scoped (ADR-0014), so the tenant audit
view has to scope itself. Two questions followed: may a tenant see rows a platform operator
wrote about them, and if so, may they see which operator.

**Decision.** Yes, and no. `GET /api/workspace/audit` filters on `req.clientId` — taken
from the token, never from the query, so there is no request shape that names another
tenant — and includes platform-plane rows, because a workspace being suspended is its own
business. `formatAuditEntry` reduces a platform actor to the label "VendorConnect
operations" and drops their email and IP for the tenant view. The formatter, the subject
filter and the pagination now live in `utils/auditView.js`, shared with the platform
explorer, which reads the same rows whole.

**Consequences.** A tenant can answer "what happened to us, and roughly by whom" without
learning our staff's names or addresses. One formatter serves both planes, so a field added
to the trail appears in both views and is redacted in exactly one place. The cost is that a
tenant investigating an incident may have to ask us who acted — which is the same
conversation they would have had anyway.

---

## ADR-0024 — The workspace is its own plane, not a tab in the supplier portal
**Phase 5 · 2026-08-13 · Accepted**

**Context.** The tenant back office was one `/admin` page inside the supplier portal's
shell: same sidebar, same BAPI console, same session, gated on a role that no longer
exists. Phase 5 turns it into five screens for three roles.

**Decision.** `/workspace` becomes a route group with its own layout, its own session
provider over `GET /api/auth/me`, and its own nav registry (`src/lib/workspaceNav.js`)
filtered by the permissions the API reports — the same contract `/platform` already uses.
`src/lib/planes.js` grew `hasOwnChrome()`, which is what tells the portal layout to step
aside. `/admin` is now a redirect. The shared vocabulary — tables, page headers, notices,
`useResource` — moved from `components/platform/` to `components/console/` and is used by
both back offices.

**Consequences.** Three planes, three shells, one design system, and a nav item is hidden
by the same permission that would have refused the request behind it — asserted by
`workspaceNav.test.js`, which reads the real permission map rather than a copy. Tenant
staff still use the portal's own RFQ, PO and invoice screens; scoping those properly is
Phase 6's job, so for now the workspace links across to them.

---

## ADR-0023 — Tenant settings are a registry, and a feature flag closes the API
**Phase 5 · 2026-08-13 · Accepted**

**Context.** Branding, feature flags, approval thresholds and notification policy are four
kinds of thing that all want to be "a settings screen". Written the obvious way, each field
appears in five places: the model, the validator, the screen, the reader, and the default
it falls back to when nobody set it.

**Decision.** `backend/config/tenantSettings.js` holds one entry per setting — its dot path
on `Client`, its type, its default, its label and hint, and the note of what reads it. The
screen renders from `describeSettings()`, the PATCH endpoint validates through
`applySettings()`, and every consumer asks `settingValue(client, key)`, so "what happens
when it was never set" is answered once. A patch is rejected whole rather than
half-applied, with a `{ key: message }` map in the same shape a zod failure returns.
Branding and feature flags keep the `Client` fields the platform plane already edits;
thresholds and notifications live under a new `Client.settings`.

**Decision, second half.** A feature flag closes the API, not just the screen.
`requireFeature('features.supplierChat')` sits on `/api/chats` and answers **404** — to a
workspace without messaging the endpoint does not exist, and "forbidden" would tell a
supplier about a feature they do not have. Self-registration is the same flag pattern, with
one exemption: an invited supplier is not self-service, so a pending or accepted invitation
reopens the door for that email.

**Consequences.** Adding a setting is one entry, and no screen changes. Every setting in
the registry is read by something — the `readBy` field is there to keep it that way, and a
setting nobody reads is a lie the screen tells. The cost is that `Client.settings` is
`Mixed`, so Mongoose does not validate it; the registry does, and it is the only writer.
Statuses moved to `config/statuses.js` for the same reason and are served to the directory
with the list, so the filter dropdown offers the registry's answer rather than its own.

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
