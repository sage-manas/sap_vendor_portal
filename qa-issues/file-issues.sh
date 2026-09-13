#!/usr/bin/env bash
# Files the QA findings in qa-issues/ as GitHub issues.
# Usage: bash file-issues.sh [--create]
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE="${1:-}"

if ! command -v gh >/dev/null; then echo "gh CLI not found: https://cli.github.com"; exit 1; fi
gh auth status >/dev/null || { echo "gh is not authenticated — run: gh auth login"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || { echo "Could not resolve target repo (run this from inside the git repo)"; exit 1; }
echo "Target repository: $REPO"
echo

ensure_label() {
  local name="$1" color="$2"
  if ! gh label list --limit 200 --json name -q '.[].name' | grep -qxF "$name"; then
    if [ "$CREATE" = "--create" ]; then
      if gh label create "$name" --color "$color" --force >/dev/null 2>&1; then
        echo "  + label $name"
      else
        echo "  ! could not create label $name (continuing)"
      fi
    else
      echo "  would create label: $name (#$color)"
    fi
  fi
}

echo "Labels:"
ensure_label "area:data" "BFD4F2"
ensure_label "area:deployment" "BFD4F2"
ensure_label "area:frontend" "BFD4F2"
ensure_label "area:infra" "BFD4F2"
ensure_label "area:rfq" "BFD4F2"
ensure_label "backend" "C2E0C6"
ensure_label "bug" "D73A4A"
ensure_label "chore" "CFD3D7"
ensure_label "documentation" "0075CA"
ensure_label "performance" "D4C5F9"
ensure_label "process" "5319E7"
ensure_label "security" "B60205"
ensure_label "severity:critical" "B60205"
ensure_label "severity:high" "D93F0B"
ensure_label "severity:low" "0E8A16"
ensure_label "severity:medium" "FBCA04"
ensure_label "tech-debt" "CFD3D7"
ensure_label "test" "1D76DB"
echo

CREATED_COUNT=0
FAILED_TITLES=()

file_issue() {
  local title="$1" body="$2" labels="$3"
  if [ "$CREATE" = "--create" ]; then
    local url err
    err="$(mktemp)"
    if url=$(gh issue create --title "$title" --body-file "$body" --label "$labels" 2>"$err"); then
      echo "  created: $url"
      CREATED_COUNT=$((CREATED_COUNT + 1))
    else
      echo "  FAILED: $title"
      sed 's/^/    /' "$err"
      FAILED_TITLES+=("$title")
    fi
    rm -f "$err"
    # be gentle with GitHub's secondary rate limits on rapid issue creation
    sleep 2
  else
    echo "  would create: $title  [$labels]"
  fi
}

echo "Issues:"
file_issue "SECURITY: any supplier can submit a bid on an RFQ they were not invited to" \
  "$DIR/01-uninvited-vendor-can-bid.md" \
  "security,severity:critical,area:rfq,backend"

file_issue "BUG: the first bid closes the RFQ — a competitive tender accepts exactly one bid" \
  "$DIR/02-first-bid-closes-bidding.md" \
  "bug,severity:high,area:rfq,backend"

file_issue "BUG: Express trust proxy is never set — rate limiting, audit IPs and the internal loopback guard are all wrong in production" \
  "$DIR/03-trust-proxy-not-set.md" \
  "bug,severity:high,security,area:infra,backend"

file_issue "BUG: production boot requires three dead Clerk variables, and SERVER_SETUP_QUICK_READ.md names a database variable that no longer exists" \
  "$DIR/04-production-cannot-boot-from-docs.md" \
  "bug,severity:high,area:deployment,documentation"

file_issue "SECURITY: CORS and Socket.io accept any localhost origin in production, with credentials enabled" \
  "$DIR/05-cors-localhost-in-production.md" \
  "security,severity:medium,area:infra,backend"

file_issue "BUG: a self-invited bidder is scored with rating 95 while a properly invited bidder defaults to 80" \
  "$DIR/06-self-invited-bidder-rating-advantage.md" \
  "bug,severity:medium,area:rfq,backend"

file_issue "PERF: nextSequentialId loads every matching row into memory on each id mint, inside a transaction" \
  "$DIR/07-nextsequentialid-loads-every-row.md" \
  "performance,severity:medium,area:data,backend"

file_issue "TEST: zero component, page or end-to-end coverage on the frontend" \
  "$DIR/08-no-frontend-test-coverage.md" \
  "test,severity:medium,area:frontend"

file_issue "CHORE: always-true branch in the tenant extension, committed debug script, and stale comments/docs" \
  "$DIR/09-code-hygiene-cleanup.md" \
  "chore,severity:low,tech-debt"

file_issue "PROCESS: two open defects are locked in by passing tests — add a review rule for API-bypassing test setup" \
  "$DIR/10-tests-encode-defects-as-requirements.md" \
  "process,test,severity:medium"

if [ "$CREATE" = "--create" ]; then
  echo
  echo "Done: $CREATED_COUNT/10 issues created."
  if [ "${#FAILED_TITLES[@]}" -gt 0 ]; then
    echo "Failed (${#FAILED_TITLES[@]}):"
    for t in "${FAILED_TITLES[@]}"; do echo "  - $t"; done
    echo "Re-run the script — it is safe to run again; gh label create --force is idempotent, and any issue already created will simply be duplicated only if you re-file it, so check GitHub before re-running the ones that failed."
    exit 1
  fi
else
  echo
  echo "Dry run. Re-run with --create to file these."
fi