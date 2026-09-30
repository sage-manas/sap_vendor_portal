#!/usr/bin/env bash
# Monthly restore drill: proves the newest backup can actually be read back.
# A backup nobody has restored is a hope, not a backup.
#
#   deploy/backup/pg-restore-drill.sh [path/to/db-<stamp>.dump.gpg]
#
# It (1) verifies the checksum, (2) decrypts with the PRIVATE key, (3) restores
# into a scratch database, (4) checks the restored schema and data are really
# there, (5) does the same listing check on the newest uploads archive, and
# (6) drops the scratch database. It never writes to the live database.
#
# The private key is not kept on the server. Run the drill where the key is
# available (an operator's machine, after copying the backup down from the
# offsite store), or import it into a temporary keyring for the run:
#   BACKUP_GPG_HOME=/path/to/keyring-with-private-key
#
# Environment:
#   DRILL_ADMIN_URL   libpq URL of a maintenance database on the server to
#                     restore INTO (postgresql://user:pw@host:5432/postgres). Needs
#                     CREATEDB. Point it at a throwaway server when you can.
#   BACKUP_DIR        where backups are (default /var/backups/vendorconnect)
#   BACKUP_GPG_HOME   keyring holding the private key (default ~/.gnupg)
#   DRILL_MIN_TABLES  fail if fewer tables than this come back (default 20)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/vendorconnect}"
MIN_TABLES="${DRILL_MIN_TABLES:-20}"
: "${DRILL_ADMIN_URL:?DRILL_ADMIN_URL is required (a maintenance database to restore into)}"

die() { echo "drill: $*" >&2; exit 1; }
for tool in psql pg_restore gpg sha256sum; do command -v "$tool" >/dev/null || die "$tool not found"; done

newest() { ls -1t "$BACKUP_DIR"/$1 2>/dev/null | head -n1; }
DB_FILE="${1:-$(newest 'db-*.dump.gpg')}"
[ -n "$DB_FILE" ] && [ -f "$DB_FILE" ] || die "no db-*.dump.gpg found in $BACKUP_DIR"

GPG=(gpg --batch --yes)
[ -n "${BACKUP_GPG_HOME:-}" ] && GPG=(gpg --homedir "$BACKUP_GPG_HOME" --batch --yes)

WORK="$(mktemp -d)"
DRILL_DB="vc_drill_$(date -u +%Y%m%d%H%M%S)"
ADMIN_URL="${DRILL_ADMIN_URL%%\?*}"
# The scratch database lives on the same server/credentials as the admin URL.
DRILL_URL="${ADMIN_URL%/*}/$DRILL_DB"

cleanup() {
  psql "$ADMIN_URL" -qAt -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "drill: using $(basename "$DB_FILE")"

# 1. Checksum, if one was kept alongside.
if [ -f "$DB_FILE.sha256" ]; then
  ( cd "$(dirname "$DB_FILE")" && sha256sum --check --status "$(basename "$DB_FILE").sha256" ) || die "checksum mismatch: the backup is corrupt or altered"
  echo "drill: checksum ok"
else
  echo "drill: no .sha256 next to the backup, skipping checksum" >&2
fi

# 2. Decrypt.
"${GPG[@]}" --decrypt --output "$WORK/db.dump" "$DB_FILE" 2>/dev/null || die "could not decrypt (is the private key in BACKUP_GPG_HOME?)"

# 3. Restore into a scratch database.
psql "$ADMIN_URL" -qAt -c "CREATE DATABASE \"$DRILL_DB\"" >/dev/null || die "could not create the scratch database (CREATEDB privilege?)"
pg_restore --no-owner --exit-on-error --dbname "$DRILL_URL" "$WORK/db.dump" || die "pg_restore failed"

# 4. Is the data really there?
TABLES="$(psql "$DRILL_URL" -qAt -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
[ "$TABLES" -ge "$MIN_TABLES" ] || die "only $TABLES tables restored (expected at least $MIN_TABLES)"
MIGRATIONS="$(psql "$DRILL_URL" -qAt -c 'SELECT count(*) FROM _prisma_migrations')"
[ "$MIGRATIONS" -gt 0 ] || die "restored database has no migration history"
echo "drill: $TABLES tables, $MIGRATIONS migrations restored"
echo "drill: row counts of the tables that hold business data:"
for table in clients vendors users platform_users purchase_orders invoices payments documents; do
  # A missing table is a failed restore, not a zero.
  count="$(psql "$DRILL_URL" -qAt -c "SELECT count(*) FROM \"$table\"")" || die "table $table is missing from the restore"
  printf '  %-16s %s
' "$table" "$count"
done

# 5. The uploads archive, if there is one: it must decrypt and list.
UP_FILE="$(newest 'uploads-*.tar.gpg' || true)"
if [ -n "${UP_FILE:-}" ]; then
  "${GPG[@]}" --decrypt "$UP_FILE" 2>/dev/null | tar -tf - >/dev/null || die "uploads archive does not decrypt and list"
  echo "drill: uploads archive $(basename "$UP_FILE") ok"
fi

echo "drill: PASSED ($(basename "$DB_FILE"))"
