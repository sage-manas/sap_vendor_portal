# Runbooks

Operational procedures for VendorConnect. Each one assumes the reader has
platform-console access (`super_admin` or `sap_manager`) and, for anything
touching the database directly, a shell on a host with `DATABASE_URL` set.

- [incident-response.md](incident-response.md) — first steps when something is down or degraded, and where to look.
- [tenant-suspension.md](tenant-suspension.md) — suspending, reactivating and terminating a tenant; what each does and doesn't do.
- [key-rotation.md](key-rotation.md) — rotating `MASTER_KEY` and `JWT_SECRET` without breaking sessions or secrets at rest.
- [backup-restore.md](backup-restore.md) — running the backup/restore drill and what to do with a real restore.
- [sap-outage.md](sap-outage.md) — a tenant's SAP connection is failing or its circuit breaker has opened.

None of these describe hosting infrastructure (there isn't any committed to
this repo yet — see `SAAS_IMPLEMENTATION_PLAN.md` Phase 8 and the "only with a
design-partner sandbox" note). They describe the application's own behaviour,
which is what exists today.
