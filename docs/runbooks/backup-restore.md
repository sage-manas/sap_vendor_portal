# Backup and restore

## Running the drill

```
cd backend
npm run backup:drill
```

`scripts/backup-restore-drill.js`:

1. Connects to `DATABASE_URL` (the real database — this only *reads* from
   `public`).
2. Dumps every table to JSON under `backend/backups/drill-<timestamp>/`.
3. Restores each table into a scratch schema, `backup_drill`, on the same
   database.
4. Compares restored counts against source counts per table.
5. Drops the scratch schema.
6. Exits 0 if every table round-tripped, 1 otherwise, printing a table either
   way.

It needs no `pg_dump`/`pg_restore` binaries — it goes through the Prisma
driver directly (raw SQL), which is what makes it something CI or a scheduled
job can run without extra tooling installed on the runner.

**This talks to the real database over the network.** Run it against a
database you're allowed to create a scratch schema in. It does not modify the
source tables at any point — only reads from `public` and writes to
`backup_drill` — but it does need `CREATE`/`DROP SCHEMA` privilege on that
database.

Run it on a schedule (weekly, at minimum before any tenant termination or
schema migration) so "can we restore" is answered before an incident asks it.

## What the drill does *not* prove

- **Point-in-time recovery.** This drill proves the data currently in the
  database can be read out and written back in whole. It says nothing about
  restoring to an earlier point in time — that is a property of whatever
  backup mechanism the hosting provider offers (e.g. continuous WAL archiving
  / point-in-time recovery on a managed Postgres provider), not of this
  script.
- **Uploaded files.** `backend/uploads/` is not part of the drill or of the
  tenant export (`GET /api/platform/tenants/:clientId/export` — see
  [tenant-suspension.md](tenant-suspension.md)). Back those up separately;
  they are ordinary files on disk (or wherever `UPLOAD_DIR` points).
- **Restoring into production.** The drill deliberately never writes back
  into the source database. A real restore — recovering from an actual data
  loss — is a distinct, higher-stakes operation: point the application at a
  restored database (from the hosting provider's own backup/snapshot
  mechanism) or, for a single tenant, use its export as the source of truth
  for manual recovery. Never script a restore into a live multi-tenant
  database without isolating it to the affected tenant's `clientId` first —
  every tenant-scoped table carries one, and a restore that ignores that
  can overwrite other tenants' current data with stale rows.

## After a real incident

Re-run the drill once the database is healthy again, to confirm backups are
still being taken correctly and are still restorable — don't assume the
incident that required a restore didn't also break the backup path itself.
