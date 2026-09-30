# Backup and restore

VendorConnect runs on one Linux server we manage (PostgreSQL 16, nginx, PM2), so
backups are our job. There are three layers; the first two are scripts in
`deploy/backup/`, the third is the older application-level drill below.

| Layer | What | Where it runs | How often |
|---|---|---|---|
| Nightly backup | encrypted `pg_dump` + encrypted archive of `backend/uploads` | the server (systemd timer) | nightly, 02:30 |
| Restore drill | decrypt, restore into a scratch database, check it | **not** the server (needs the private key) | monthly, and before any migration or tenant termination |
| Table round-trip drill | `npm run backup:drill` (below) | the server | weekly |

## 1. Nightly encrypted backup

`deploy/backup/pg-backup.sh`, run by `vendorconnect-backup.timer`.

**Design**
- **Public-key encryption (gpg).** The server holds only the *public* key. Anyone
  who takes over the server can add or read nothing in old backups; the private
  key lives with the operators (a password manager plus one offline copy), never
  on the server. Nothing is written to disk unencrypted: `pg_dump` and `tar` are
  piped into gpg.
- **Offsite copy is a hook**, `BACKUP_OFFSITE_CMD`, run once per file with the
  path as `$1`. Where copies should go is **not decided yet**; any of these works
  and the script does not care which:
  - `rclone copyto "$1" remote:vendorconnect-backups/$(basename "$1")` (S3, Azure, B2, SFTP, ...)
  - `aws s3 cp "$1" s3://<bucket>/vendorconnect/`
  - `scp -q "$1" backup@other-host:/srv/vendorconnect/`
  A failing hook fails the run. The script **refuses to run with no hook** unless
  `BACKUP_ALLOW_LOCAL_ONLY=true`: a backup on the same machine is lost with it.
- Local copies are kept `BACKUP_RETENTION_DAYS` (default 14). Retention offsite is
  the store's own lifecycle policy: set one (suggest 35 daily + 12 monthly).
- Each file gets a `.sha256`; `last-success` records the last complete run.

**One-time setup**
```
# on an operator machine: make the key pair (keep the private key OFF the server)
gpg --quick-gen-key "vendorconnect-backups <ops@your.domain>" default default never
gpg --export ops@your.domain > vendorconnect-backup-public.asc
gpg --export-secret-keys --armor ops@your.domain > vendorconnect-backup-PRIVATE.asc   # store safely, then delete the file

# on the server
sudo apt install postgresql-client gnupg
sudo -u vendorconnect gpg --import vendorconnect-backup-public.asc
sudo install -d -m 0700 -o vendorconnect /etc/vendorconnect
sudo tee /etc/vendorconnect/backup.env >/dev/null <<'EOF'
DATABASE_URL=postgresql://sap_portal:<password>@localhost:5432/sap_vendor_portal?schema=public
BACKUP_GPG_RECIPIENT=ops@your.domain
BACKUP_OFFSITE_CMD=rclone copyto "$1" remote:vendorconnect-backups/$(basename "$1")
EOF
sudo chmod 600 /etc/vendorconnect/backup.env && sudo chown vendorconnect /etc/vendorconnect/backup.env
sudo cp deploy/backup/vendorconnect-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vendorconnect-backup.timer
sudo systemctl start vendorconnect-backup.service && journalctl -u vendorconnect-backup -e   # run once now
```

**Monitor it.** `deploy/backup/check-backup-fresh.sh` exits non-zero when the last
complete backup is older than 26 hours or has never run; wire it into the uptime
check or a cron mail. A backup that stops silently is the usual failure.

## 2. Monthly restore drill (the one that counts)

A backup nobody has restored is a hope. Put a recurring reminder in the team
calendar for the first working day of the month.

1. Copy the newest `db-*.dump.gpg`, its `.sha256` and the newest `uploads-*.tar.gpg`
   from the offsite store to the machine that has the private key (**not** the
   production server), into one directory.
2. Have a PostgreSQL 16 server you can create databases on (a local Docker
   `postgres:16` is fine; do **not** use production).
3. Run:
   ```
   BACKUP_DIR=/path/to/that/directory    BACKUP_GPG_HOME=~/.gnupg    DRILL_ADMIN_URL=postgresql://postgres:<pw>@localhost:5432/postgres    deploy/backup/pg-restore-drill.sh
   ```
   It verifies the checksum, decrypts, restores into a scratch database, checks
   that the schema, the migration history and the business tables came back, lists
   the uploads archive, and drops the scratch database. `PASSED` is the goal; any
   `die` is an incident with the backup path, to be fixed the same day.
4. Record the date and the result in the ops log.

The script was exercised end to end against a throwaway database: real backup,
offsite hook, decrypt with a separate key, restore, and it fails on a tampered
file and on a failing offsite hook.

## 3. Real restore (data loss)

1. Stop the app: `pm2 stop all`. Decide the restore point (usually the newest backup).
2. Restore into a **new** database first (drill steps 1-3 with a real name), check it,
   then point `DATABASE_URL` at it, or swap names. Do not restore over the live one
   until you have looked at both.
3. Uploads: `gpg --decrypt uploads-<stamp>.tar.gpg | tar -C backend/uploads -xf -`.
4. `cd backend && npx prisma migrate deploy` (no-op if the backup is current), then
   `pm2 start deploy/ecosystem.config.js`.
5. Everything since the backup is gone. Tell affected tenants what the last good
   time was. SAP is the system of record for documents: run the reconciliation
   sweep (platform console, Reconciliation) so portal state catches up to SAP.
6. Re-run the drill afterwards: the incident may also have broken the backup path.
Never restore a single tenant by overwriting rows in a live multi-tenant database
without filtering on `clientId`; you can overwrite other tenants' current data.

## 4. Optional: WAL archiving for point-in-time recovery

A nightly dump loses up to a day of data. If that is too much, add continuous WAL
archiving (needs a server restart; **not applied or tested here**, review first):
```
# postgresql.conf
wal_level = replica
archive_mode = on
archive_timeout = 300
archive_command = '/usr/local/bin/vc-archive-wal %p %f'
```
`vc-archive-wal` must gpg-encrypt `%p` with the same public key and run the same
offsite hook, and return non-zero on any failure (Postgres retries and keeps the
WAL). Take a weekly encrypted base backup (`pg_basebackup -D - -Ft -z` piped into
gpg). To recover: restore the base backup, set `restore_command` to fetch and
decrypt segments, and `recovery_target_time` to the moment before the incident.
Test the recovery on a scratch server before relying on it.

## 5. Application-level table round-trip drill

### Running it

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
- **Uploaded files.** `backend/uploads/` is not part of this drill or of the tenant export (`GET /api/platform/tenants/:clientId/export`, see [tenant-suspension.md](tenant-suspension.md)). The nightly backup (section 1) archives it and the monthly drill (section 2) checks the archive.
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
