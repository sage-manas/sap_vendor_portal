# Tenant suspension, reactivation, termination

Three actions, all in `/platform` → tenant detail, and all `POST` under
`/api/platform/tenants/:clientId/{suspend,reactivate,terminate}`, permission
`tenant:manage` (ADR from Phase 3, `controllers/platformTenant.controller.js`
`TRANSITIONS`).

## Suspend

- **Legal from:** Trial, Active.
- **Effect:** `client.status = 'Suspended'`. Every request from that tenant's
  users and suppliers is refused on the very next call — `protect` re-checks
  `client.isOperational()` on every request (ADR-0013's mechanism, applied to
  the tenant rather than the account). No session store to clear, nothing
  else to do.
- **Data:** untouched. Nothing is deleted, exported, or hidden from the
  tenant's own eventual reactivation.
- **When:** non-payment, abuse investigation, a tenant's own request to pause.

## Reactivate

- **Legal from:** Suspended only.
- **Effect:** `client.status = 'Active'`. Access resumes on the next request.
- **Nothing needs to be "warmed up"** — there is no cache keyed on tenant
  status other than `isOperational()` itself.

## Terminate

- **Legal from:** Trial, Active, Suspended.
- **Effect:** `client.status = 'Terminated'`, permanent (no transition leads
  back out of it). Access is refused the same way as suspension.
- **Data is retained, not deleted.** There is no endpoint that deletes a
  tenant's documents — destruction after a retention period is a deliberate,
  out-of-band job that does not exist in this codebase yet (ADR-0015). Do not
  improvise one by hand-deleting collections; if a real deletion is required,
  it needs its own reviewed script, not this runbook.

## Before terminating: export

`GET /api/platform/tenants/:clientId/export` (`tenant:manage`) produces a
whole-tenant JSON archive — every tenant-scoped collection, whole documents,
in one audited call (`AUDIT_ACTIONS.TENANT_EXPORTED`). This is the offboarding
deliverable; hand it to the tenant or file it before termination, since
termination does not trigger an export on its own.

**Known gap:** the export contains database rows, not uploaded files.
Anything in `backend/uploads/` for that tenant is not bundled — if the
tenant's documents (compliance PDFs, etc.) matter for the handoff, copy that
tenant's files separately before termination.

## Audit trail

Every transition writes an `AuditLog` row (`tenant.suspended` /
`tenant.reactivated` / `tenant.terminated`) with `from`/`to`/`reason`, visible
in the platform audit explorer and, for the tenant's own view, in
`GET /api/workspace/audit` (labelled "VendorConnect operations" per
ADR-0025 — the tenant sees that something happened, not which operator).
