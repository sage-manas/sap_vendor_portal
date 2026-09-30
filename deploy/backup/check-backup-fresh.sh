#!/usr/bin/env bash
# Exits non-zero when the last complete backup is older than BACKUP_MAX_AGE_HOURS
# (default 26: a nightly job plus slack) or has never run. Point an uptime check
# or a cron mail at it: a backup job that stops silently is the usual failure.
#
#   deploy/backup/check-backup-fresh.sh && echo fresh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/vendorconnect}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
MARKER="$BACKUP_DIR/last-success"

[ -f "$MARKER" ] || { echo "no backup has ever completed ($MARKER missing)" >&2; exit 2; }

AGE_HOURS=$(( ( $(date +%s) - $(date -r "$MARKER" +%s) ) / 3600 ))
if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  echo "last backup completed ${AGE_HOURS}h ago (limit ${MAX_AGE_HOURS}h): $(cat "$MARKER")" >&2
  exit 1
fi
echo "last backup ${AGE_HOURS}h ago: $(cat "$MARKER")"
