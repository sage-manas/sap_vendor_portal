# Backup and restore

## Running the drill

```
cd backend
npm run backup:drill
```

`scripts/backup-restore-drill.js`:

1. Connects to `MONGO_URI` (the real database — this only *reads* from it).
2. Dumps every collection to newline-free JSON under
   `backend/backups/drill-<timestamp>/`.
3. Restores each collection into a scratch database,
   `<original-db-name>_backup_drill`, on the same cluster.
4. Compares restored counts against source counts per collection.
5. Drops the scratch database.
6. Exits 0 if every collection round-tripped, 1 otherwise, printing a table
   either way.

It needs no `mongodump`/`mongorestore` binaries — it goes through the driver
directly, which is what makes it something CI or a scheduled job can run
without extra tooling installed on the runner.

**This talks to the real database over the network.** Run it against a
cluster you're allowed to create a scratch database on. It does not modify
the source database at any point — only reads from it and writes to the
scratch one — but it does need write access on that cluster/user to create
and drop `<db>_backup_drill`.

Run it on a schedule (weekly, at minimum before any tenant termination or
schema migration) so "can we restore" is answered before an incident asks it.

## What the drill does *not* prove

- **Point-in-time recovery.** This drill proves the data currently in the
  database can be read out and written back in whole. It says nothing about
  restoring to an earlier point in time — that is a property of whatever
  backup mechanism the hosting provider offers (e.g. Atlas continuous
  backups), not of this script.
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
  every tenant-scoped collection carries one, and a restore that ignores that
  can overwrite other tenants' current data with stale rows.

## After a real incident

Re-run the drill once the database is healthy again, to confirm backups are
still being taken correctly and are still restorable — don't assume the
incident that required a restore didn't also break the backup path itself.
