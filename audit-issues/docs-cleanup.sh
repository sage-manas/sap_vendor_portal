#!/usr/bin/env bash
# Removes documentation that the code has outgrown.
#
# Every file below was read and checked against the code on 14 September 2026.
# See DOCS-CLEANUP.md in this directory for the reason each one is going, and
# for the list of documents that were considered and deliberately KEPT.
#
# Nothing is lost: these are tracked files, so `git log`/`git show` still has
# them. Run the dry run first.
#
# Usage: bash audit-issues/docs-cleanup.sh [--delete]

set -uo pipefail

DELETE="${1:-}"

cd "$(git rev-parse --show-toplevel)" || { echo "Not inside a git repository"; exit 1; }

# Superseded planning corpus: pre-authentication, pre-Postgres, pre-multi-route.
# workflow/sprint_roadmap.md alone mentions Clerk 143 times and MONGO_URI 4 times;
# architecture_document.md describes a single-page activeTab router and "no authentication".
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

  # Documents SAP adapter methods the contract explicitly removed
  # (rfqCreate x3, invoiceCreate x2, poProvision/deliveryCreate x3).
  "PROJECT_ARCHITECTURE_FLOW.md"

  # "Kinetic Industrial Console" — black canvas, electric-green accent.
  # src/app/globals.css implements "Cream & Coral" instead, adapted from
  # claude/DESIGN.md. PROJECT_CONTEXT.md section 11 has been rewritten to match.
  "DESIGN.md"

  # v1.0 PRD/TRD for a product called "CustomerConnect", dated 2026-07-25,
  # still marked "For review". The TRD specifies NestJS + TypeScript + React 18;
  # the application is Express 5 + plain JS + React 19. Never updated, never built.
  "docs/01-PRD.md"
  "docs/02-TRD-architecture.md"
)

missing=0
echo "Files to remove:"
for f in "${STALE[@]}"; do
  if [ -e "$f" ]; then
    printf "  %-42s %8s bytes\n" "$f" "$(wc -c <"$f" | tr -d ' ')"
  else
    printf "  %-42s MISSING (already gone?)\n" "$f"
    missing=$((missing + 1))
  fi
done
echo

if [ "$DELETE" != "--delete" ]; then
  echo "Dry run — nothing removed. Re-run with --delete to stage the removals:"
  echo "  bash audit-issues/docs-cleanup.sh --delete"
  echo
  echo "Then review with 'git status' and 'git diff --cached' before committing."
  exit 0
fi

removed=0
for f in "${STALE[@]}"; do
  [ -e "$f" ] || continue
  if git rm -q "$f"; then removed=$((removed + 1)); else echo "  ! git rm failed for $f"; fi
done

# workflow/ held nothing else; drop the directory if git left it empty.
[ -d workflow ] && [ -z "$(ls -A workflow 2>/dev/null)" ] && rmdir workflow

echo "Staged $removed removals${missing:+ ($missing were already absent)}."
echo
echo "Reference updates in PROJECT_CONTEXT.md, AGENTS.md and"
echo "docs/04-sap-runtime-engineering-plan.md were applied separately — stage them too:"
echo "  git add PROJECT_CONTEXT.md AGENTS.md docs/04-sap-runtime-engineering-plan.md"
echo
echo "Review, then commit:"
echo "  git status && git diff --cached --stat"
