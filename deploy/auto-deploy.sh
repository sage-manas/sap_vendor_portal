#!/usr/bin/env bash
# Deploys master to this server whenever it moves and its CI checks are green.
#
# Pull-based on purpose: the server's SSH port is not reachable from the
# internet, so GitHub cannot push to it. Run from cron every few minutes:
#
#   */3 * * * * /opt/vp/app/deploy/auto-deploy.sh >> /opt/vp/logs/auto-deploy.log 2>&1
#
# Each run is cheap: one `git fetch`, and a GitHub API call only when master
# is ahead of what is deployed. Setup and recovery: docs/runbooks/auto-deploy.md.
#
# State lives outside the checkout, in STATE_DIR:
#   deployed-sha   the commit the running processes were built from
#   failed-sha     a commit whose deploy failed; skipped until master moves on
#   status         the latest one-line answer ("waiting for CI", ...)
#
# FORCE=1 deploys even if CI is not green or the commit already failed once.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vp/app}"
STATE_DIR="${STATE_DIR:-/opt/vp/state}"
BACKUP_DIR="${BACKUP_DIR:-/opt/vp/backups}"
REPO="${REPO:-sage-manas/sap_vendor_portal}"
BRANCH="${BRANCH:-master}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
say() { echo "$*" > "$STATE_DIR/status"; }

mkdir -p "$STATE_DIR" "$BACKUP_DIR"

# One deploy at a time; a second cron tick while a build runs just leaves.
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0

# cron has no login profile, so Node and PM2 (installed under nvm) are not on PATH.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$APP_DIR"
git fetch -q origin "$BRANCH"
TARGET="$(git rev-parse FETCH_HEAD)"
DEPLOYED="$(cat "$STATE_DIR/deployed-sha" 2>/dev/null || true)"
FAILED="$(cat "$STATE_DIR/failed-sha" 2>/dev/null || true)"

if [ "$TARGET" = "$DEPLOYED" ]; then
  say "up to date at ${TARGET:0:7}"
  exit 0
fi

if [ "$TARGET" = "$FAILED" ] && [ -z "${FORCE:-}" ]; then
  say "${TARGET:0:7} failed to deploy earlier; waiting for a newer commit (FORCE=1 to retry)"
  exit 0
fi

# Never deploy a commit CI has not passed: master can be broken for a few
# minutes between a merge and its checks reporting. Prints one word on stderr:
# green, failed or pending; anything else is a GitHub problem.
ci_state() {
  node -e '
    const [repo, sha] = process.argv.slice(1);
    const url = "https://api.github.com/repos/" + repo + "/commits/" + sha + "/check-runs?per_page=100";
    fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "vp-auto-deploy" },
      signal: AbortSignal.timeout(20000),
    })
      .then((res) => {
        if (!res.ok) throw new Error("GitHub answered " + res.status);
        return res.json();
      })
      .then(({ check_runs: runs }) => {
        const done = runs.length > 0 && runs.every((run) => run.status === "completed");
        const passing = ["success", "skipped", "neutral"];
        const green = done && runs.every((run) => passing.includes(run.conclusion));
        console.error(green ? "green" : done ? "failed" : "pending");
      })
      .catch((error) => console.error(error.message));
  ' "$REPO" "$TARGET" 2>&1 >/dev/null | head -n 1
}

if [ -z "${FORCE:-}" ]; then
  CI="$(ci_state)"
  case "$CI" in
    green) ;;
    failed) say "${TARGET:0:7}: CI failed, not deploying"; exit 0 ;;
    pending) say "${TARGET:0:7}: waiting for CI to finish"; exit 0 ;;
    *) say "${TARGET:0:7}: could not read CI status (${CI:-no answer}); will retry"; exit 0 ;;
  esac
fi

log "deploying ${DEPLOYED:0:7} -> ${TARGET:0:7}"
say "deploying ${TARGET:0:7}"

# The production env file is not in git; keep a copy next to every deploy.
cp backend/.env "$BACKUP_DIR/backend.env.$(date +%Y%m%d%H%M%S)"
ls -1t "$BACKUP_DIR"/backend.env.2* 2>/dev/null | tail -n +11 | xargs -r rm -f

git reset -q --hard "$TARGET"

if SKIP_GIT=1 bash deploy/deploy.sh "$BRANCH"; then
  echo "$TARGET" > "$STATE_DIR/deployed-sha"
  rm -f "$STATE_DIR/failed-sha"
  say "deployed ${TARGET:0:7} at $(date -u +%FT%TZ)"
  log "deployed ${TARGET:0:7}"
else
  echo "$TARGET" > "$STATE_DIR/failed-sha"
  say "${TARGET:0:7} FAILED to deploy at $(date -u +%FT%TZ)"
  log "FAILED to deploy ${TARGET:0:7}"
  # deploy.sh runs the fallible steps (install, build) before it touches the
  # database or restarts anything, so a failure there leaves the old processes
  # serving. Put the files back as they were so a later restart builds from
  # known code. A failure after "Database migrations" is different: see the runbook.
  if [ -n "$DEPLOYED" ]; then
    git reset -q --hard "$DEPLOYED" && log "checkout restored to ${DEPLOYED:0:7}"
  fi
  exit 1
fi
