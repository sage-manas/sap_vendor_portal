#!/usr/bin/env bash
# Nightly backup of the VendorConnect database and uploaded files.
#
#   deploy/backup/pg-backup.sh            (run by vendorconnect-backup.timer)
#
# What it writes, into $BACKUP_DIR (default /var/backups/vendorconnect):
#   db-<UTC timestamp>.dump.gpg       pg_dump custom format, encrypted
#   uploads-<UTC timestamp>.tar.gpg   backend/uploads (vendor documents), encrypted
#   *.sha256                          checksum of each encrypted file
#   last-success                      timestamp of the last complete run (monitor this)
#
# Encryption is PUBLIC-KEY (gpg --encrypt): this server only ever holds the
# public key, so someone who takes over the server cannot read old backups, and
# the private key lives with the operators, not here. Nothing is written to disk
# unencrypted: pg_dump and tar are piped straight into gpg.
#
# Offsite copy is a hook, because where copies go is not decided yet:
# BACKUP_OFFSITE_CMD is run once per encrypted file with the path as $1, e.g.
#   BACKUP_OFFSITE_CMD='rclone copyto "$1" remote:vendorconnect-backups/$(basename "$1")'
#   BACKUP_OFFSITE_CMD='aws s3 cp "$1" s3://bucket/vendorconnect/'
#   BACKUP_OFFSITE_CMD='scp -q "$1" backup@other-host:/srv/vendorconnect/'
# A failing hook fails the run, so a broken offsite path is not silent. Running
# without one is refused unless BACKUP_ALLOW_LOCAL_ONLY=true, because a backup on
# the same machine is lost with the machine.
#
# Required environment (normally /etc/vendorconnect/backup.env, mode 0600):
#   DATABASE_URL            libpq URL of the database. A Prisma-style ?schema=public
#                           suffix is removed before pg_dump sees it.
#   BACKUP_GPG_RECIPIENT    key id / email of the operators' public key (imported
#                           into the backup user's keyring beforehand)
# Optional:
#   BACKUP_DIR, BACKUP_RETENTION_DAYS (default 14), UPLOADS_DIR (default
#   <repo>/backend/uploads), BACKUP_OFFSITE_CMD, BACKUP_ALLOW_LOCAL_ONLY,
#   BACKUP_GPG_HOME (a keyring directory other than ~/.gnupg)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vendorconnect}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
UPLOADS_DIR="${UPLOADS_DIR:-$REPO_DIR/backend/uploads}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

die() { echo "backup: $*" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT is required (the operators public key)}"
if [ -z "${BACKUP_OFFSITE_CMD:-}" ] && [ "${BACKUP_ALLOW_LOCAL_ONLY:-}" != "true" ]; then
  die "BACKUP_OFFSITE_CMD is not set. A backup that never leaves this server is lost with it; set the hook, or BACKUP_ALLOW_LOCAL_ONLY=true to accept that knowingly."
fi
command -v pg_dump >/dev/null || die "pg_dump not found (apt install postgresql-client)"
command -v gpg >/dev/null || die "gpg not found (apt install gnupg)"

GPG=(gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT")
[ -n "${BACKUP_GPG_HOME:-}" ] && GPG=(gpg --homedir "$BACKUP_GPG_HOME" --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT")

# pg_dump does not understand Prisma's ?schema= parameter.
PG_URL="${DATABASE_URL%%\?*}"

umask 077
mkdir -p "$BACKUP_DIR"

finish_file() {
  local file="$1"
  [ -s "$file" ] || die "$file is empty"
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
  if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
    bash -c "$BACKUP_OFFSITE_CMD" _ "$file" || die "offsite copy of $(basename "$file") failed"
    bash -c "$BACKUP_OFFSITE_CMD" _ "$file.sha256" || die "offsite copy of $(basename "$file").sha256 failed"
  fi
  echo "backup: $(basename "$file") ($(du -h "$file" | cut -f1))"
}

DB_FILE="$BACKUP_DIR/db-$STAMP.dump.gpg"
# pipefail makes a pg_dump failure fail the whole pipeline; the partial file is
# removed so it can never be mistaken for a backup.
if ! pg_dump --format=custom --no-owner "$PG_URL" | "${GPG[@]}" --output "$DB_FILE"; then
  rm -f "$DB_FILE"
  die "pg_dump failed"
fi
finish_file "$DB_FILE"

if [ -d "$UPLOADS_DIR" ]; then
  UP_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gpg"
  if ! tar -C "$UPLOADS_DIR" -cf - . | "${GPG[@]}" --output "$UP_FILE"; then
    rm -f "$UP_FILE"
    die "archiving uploads failed"
  fi
  finish_file "$UP_FILE"
else
  echo "backup: $UPLOADS_DIR does not exist, skipping uploads" >&2
fi

# Local retention only; offsite retention is the offsite store's own policy
# (lifecycle rule / cron on the other host).
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*' -o -name 'uploads-*' \) -mtime +"$RETENTION_DAYS" -delete

date -u +%FT%TZ > "$BACKUP_DIR/last-success"
echo "backup: complete"
