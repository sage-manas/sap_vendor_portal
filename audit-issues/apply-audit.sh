#!/usr/bin/env bash
# Applies the 14 September 2026 audit to the repository, as two clean commits:
#
#   1. docs: remove superseded planning documents
#      (the git rm's from docs-cleanup.sh, plus the three reference updates
#       already sitting in your working tree)
#   2. docs: add audit-issues from the September 2026 codebase review
#      (the audit-issues/ directory)
#
# Nothing is pushed unless you pass --push.
#
# Usage:
#   bash audit-issues/apply-audit.sh            # dry run — shows exactly what it will do
#   bash audit-issues/apply-audit.sh --commit   # make the two commits
#   bash audit-issues/apply-audit.sh --commit --push
#
# Deliberately not 'set -e': this reports what failed rather than dying halfway
# through a commit sequence and leaving a half-staged index.
set -uo pipefail

MODE=""
PUSH="no"
for arg in "$@"; do
  case "$arg" in
    --commit) MODE="commit" ;;
    --push)   PUSH="yes" ;;
    *) echo "Unknown argument: $arg"; echo "Usage: bash audit-issues/apply-audit.sh [--commit] [--push]"; exit 1 ;;
  esac
done

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not inside a git repository."; exit 1; }
REPO_ROOT="$(pwd)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Repository: $REPO_ROOT"
echo "Branch:     $BRANCH"
echo

# --- Safety: refuse to run on top of a dirty index -------------------------
# Sweeping up someone's half-finished work into a docs commit is worse than
# making them run this twice.
if [ -n "$(git diff --cached --name-only)" ]; then
  echo "There are already staged changes:"
  git diff --cached --name-only | sed 's/^/  /'
  echo
  echo "Commit or unstage them first — this script will not fold them into its commits."
  exit 1
fi

# --- What goes ------------------------------------------------------------
STALE=(
  "workflow/README.md"
  "workflow/architecture_document.md"
  "workflow/frontend_transition.md"
  "workflow/SAP_Communication.md"
  "workflow/socket_io_architecture.md"
  "workflow/sprint_roadmap.md"
  "workflow/task.md"
  "workflow/walkthrough.md"
  "workflow/working.md"
  "PROJECT_ARCHITECTURE_FLOW.md"
  "DESIGN.md"
  "docs/01-PRD.md"
  "docs/02-TRD-architecture.md"
)

# --- What was edited so the removals leave nothing dangling ---------------
PATCHED=(
  "PROJECT_CONTEXT.md"
  "AGENTS.md"
  "docs/04-sap-runtime-engineering-plan.md"
)

echo "Commit 1 — remove superseded planning documents"
echo "  delete:"
present=0
for f in "${STALE[@]}"; do
  if [ -e "$f" ]; then
    printf "    %-42s %8s bytes\n" "$f" "$(wc -c <"$f" | tr -d ' ')"
    present=$((present + 1))
  else
    printf "    %-42s already absent, skipping\n" "$f"
  fi
done
echo "  update:"
for f in "${PATCHED[@]}"; do
  if git diff --quiet -- "$f" 2>/dev/null; then
    printf "    %-42s no local change (already committed?)\n" "$f"
  else
    printf "    %-42s modified\n" "$f"
  fi
done
echo
echo "Commit 2 — add the audit"
if [ -d audit-issues ]; then
  echo "    audit-issues/  ($(find audit-issues -type f | wc -l | tr -d ' ') files)"
else
  echo "    audit-issues/  MISSING — nothing to add"
fi
echo

if [ "$MODE" != "commit" ]; then
  echo "Dry run. Nothing changed. To apply:"
  echo "  bash audit-issues/apply-audit.sh --commit"
  exit 0
fi

# --- Commit 1 -------------------------------------------------------------
removed=0
for f in "${STALE[@]}"; do
  [ -e "$f" ] || continue
  if git rm -q "$f"; then removed=$((removed + 1)); else echo "  ! git rm failed: $f"; fi
done
[ -d workflow ] && [ -z "$(ls -A workflow 2>/dev/null)" ] && rmdir workflow

for f in "${PATCHED[@]}"; do
  [ -e "$f" ] && git add "$f"
done

if [ -z "$(git diff --cached --name-only)" ]; then
  echo "Commit 1: nothing to commit (already applied?)"
else
  git commit -q -F - <<'MSG'
docs: remove superseded planning documents

Delete the workflow/ planning corpus, PROJECT_ARCHITECTURE_FLOW.md, the
Kinetic Industrial Console DESIGN.md, and the CustomerConnect PRD/TRD pair.
All describe a system that no longer exists: pre-auth, pre-Postgres,
pre-multi-route, a NestJS stack that was never built, and SAP adapter
methods sap/contract.js explicitly removed.

Update PROJECT_CONTEXT.md sections 11 and 12, AGENTS.md and the SAP runtime
engineering plan so no reference dangles. Section 11 now documents the
"Cream & Coral" system that src/app/globals.css actually implements, with
globals.css named as the source of truth, and records that the
--color-emerald-* token names must not be renamed because
src/lib/branding.js injects tenant brand colours through them (ADR-0030).

Kept deliberately, with reasons recorded in audit-issues/DOCS-CLEANUP.md:
DECISIONS.md (an ADR log; superseded decisions belong in it),
docs/03-verification-layer-design.md (an unbuilt proposal, not stale),
docs/04-sap-runtime-engineering-plan.md (Phase 0 and both Deferred sections
are still open), and claude/DESIGN.md (globals.css is built from it).

All removals are recoverable via git history.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0184LGqrcttd2ELtgNQsXX3o
MSG
  if [ $? -eq 0 ]; then echo "Commit 1 created ($removed files removed)."; else echo "Commit 1 FAILED — check the hook output above."; exit 1; fi
fi
echo

# --- Commit 2 -------------------------------------------------------------
if [ -d audit-issues ]; then
  git add audit-issues
  if [ -z "$(git diff --cached --name-only)" ]; then
    echo "Commit 2: nothing to commit (already applied?)"
  else
    git commit -q -F - <<'MSG'
docs: add findings from the September 2026 codebase review

Thirty issues from an independent file-by-file review of the backend, SAP
integration layer, job runtime, data model and frontend, each anchored to a
file and line rather than to documentation. audit-issues/file-issues.sh
files them on GitHub; audit-issues/README.md indexes them and suggests an
order of work.

The five to read first are supplier-exploitable today: sealed bid prices are
returned to every supplier on a live tender (#01), every document-by-id route
is missing a supplier ownership check (#02), that gap is writable — a supplier
can invoice against another supplier's goods receipt (#03), an approved
supplier can rewrite their own payout bank details with no audit entry (#04),
and invoice totals are taken from the request body and never recomputed (#05).

Not re-filed: the uninvited-supplier bid and first-bid-closes-bidding defects
from the earlier qa-issues/ batch, both verified fixed (ADR-0037).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0184LGqrcttd2ELtgNQsXX3o
MSG
    if [ $? -eq 0 ]; then echo "Commit 2 created."; else echo "Commit 2 FAILED — check the hook output above."; exit 1; fi
  fi
fi
echo

git --no-pager log --oneline -3
echo
git status --short
echo

if [ "$PUSH" = "yes" ]; then
  echo "Pushing to origin/$BRANCH ..."
  git push origin "$BRANCH" || { echo "Push failed."; exit 1; }
else
  echo "Not pushed. When you are happy with the two commits above:"
  echo "  git push origin $BRANCH"
fi
