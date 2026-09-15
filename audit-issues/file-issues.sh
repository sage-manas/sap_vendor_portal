#!/usr/bin/env bash
# Files the audit findings in audit-issues/ as GitHub issues.
# Usage: bash file-issues.sh [--create]
#
# Deliberately NOT 'set -e': one failing gh call must not abort the batch.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATE="${1:-}"

if ! command -v gh >/dev/null; then echo "gh CLI not found: https://cli.github.com"; exit 1; fi
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || { echo "Could not resolve the repo — run this from inside the git repository"; exit 1; }
echo "Target repository: $REPO"
echo

ensure_label() {
  local name="$1" color="$2"
  if ! gh label list --limit 200 --json name -q '.[].name' | grep -qxF "$name"; then
    if [ "$CREATE" = "--create" ]; then
      if gh label create "$name" --color "$color" --force >/dev/null 2>&1; then echo "  + label $name"
      else echo "  ! could not create label $name (continuing)"; fi
    else
      echo "  would create label: $name (#$color)"
    fi
  fi
}

echo "Labels:"
ensure_label "area:data" "BFD4F2"
ensure_label "area:infra" "BFD4F2"
ensure_label "area:rfq" "BFD4F2"
ensure_label "area:sap" "BFD4F2"
ensure_label "backend" "C2E0C6"
ensure_label "bug" "D73A4A"
ensure_label "chore" "CFD3D7"
ensure_label "documentation" "0075CA"
ensure_label "integrity" "5319E7"
ensure_label "performance" "D4C5F9"
ensure_label "security" "B60205"
ensure_label "severity:critical" "B60205"
ensure_label "severity:high" "D93F0B"
ensure_label "severity:low" "0E8A16"
ensure_label "severity:medium" "FBCA04"
ensure_label "tech-debt" "CFD3D7"
echo
CREATED=0
FAILED_TITLES=()

file_issue() {
  local title="$1" body="$2" labels="$3"
  if [ ! -f "$body" ]; then echo "  MISSING body file: $body"; FAILED_TITLES+=("$title"); return; fi
  if [ "$CREATE" = "--create" ]; then
    local url err
    err="$(mktemp)"
    if url=$(gh issue create --title "$title" --body-file "$body" --label "$labels" 2>"$err"); then
      echo "  created: $url"; CREATED=$((CREATED + 1))
    else
      echo "  FAILED: $title"; sed 's/^/    /' "$err"; FAILED_TITLES+=("$title")
    fi
    rm -f "$err"
    # GitHub secondary rate limits bite on rapid consecutive issue creation.
    sleep 2
  else
    echo "  would create: $title  [$labels]"
  fi
}

echo "Issues:"
file_issue "SECURITY: every supplier can read competitors' sealed bid prices on an open tender" \
  "$DIR/01-sealed-bids-exposed-to-competitors.md" \
  "security,severity:critical,area:rfq,backend"

file_issue "SECURITY: any supplier can read any other supplier's PO, invoice, payment, GRN and ASN by id" \
  "$DIR/02-cross-supplier-idor-on-document-reads.md" \
  "security,severity:critical,area:rfq,backend"

file_issue "SECURITY: a supplier can acknowledge, ship against, and invoice another supplier's purchase order" \
  "$DIR/03-cross-supplier-writes.md" \
  "security,severity:critical,area:rfq,backend"

file_issue "SECURITY: an approved supplier can change their own payout bank account with no re-verification and no audit entry" \
  "$DIR/04-vendor-bank-change-unverified-unaudited.md" \
  "security,severity:critical,area:data,backend"

file_issue "SECURITY: invoice totals are taken from the request body and never recomputed, and three-way match only warns" \
  "$DIR/05-invoice-totals-trusted-match-advisory.md" \
  "security,severity:high,area:data,backend"

file_issue "INTEGRITY: the backend writes fabricated Buyer, Finance, Quality and Warehouse chat replies, one claiming SAP was updated" \
  "$DIR/06-fabricated-chat-replies.md" \
  "bug,severity:critical,integrity,backend"

file_issue "INTEGRITY: PUT /api/payments/:id/status reports success while writing nothing" \
  "$DIR/07-update-payment-status-lies.md" \
  "bug,severity:high,integrity,backend"

file_issue "INTEGRITY: the invoice PDF fabricates an 18% GST split and prints it on a document headed TAX INVOICE" \
  "$DIR/08-invented-gst-split-on-tax-invoice.md" \
  "bug,severity:high,integrity,area:data,backend"

file_issue "INTEGRITY: a constant 80 is fed into bid ranking as a technical evaluation score" \
  "$DIR/09-default-technical-score-presented-as-evaluation.md" \
  "bug,severity:medium,area:rfq,backend"

file_issue "BUG: vendorVerifyKyc and vendorReject call no SAP service, and reference a dead Mongo field so every log entry records documentRef undefined" \
  "$DIR/10-kyc-noop-and-dead-mongo-field.md" \
  "bug,severity:medium,area:sap,backend"

file_issue "DESIGN: purchase order state is header-level, so a partially delivered or partially invoiced order cannot be represented" \
  "$DIR/11-po-status-is-header-level.md" \
  "bug,severity:high,area:sap,area:data,backend"

file_issue "BUG: SAP document numbers are stored without fiscal or material-document year, so GRN ids will collide when SAP recycles a number range" \
  "$DIR/12-sap-document-numbers-lack-year.md" \
  "bug,severity:high,area:sap,area:data,backend"

file_issue "BUG: purchase orders carry no company code or purchasing organisation, and the sweep discards the one SAP returns" \
  "$DIR/13-no-company-code-on-purchase-order.md" \
  "bug,severity:high,area:sap,area:data,backend"

file_issue "DESIGN: Payment is modelled one-to-one with Invoice, so an F110 run paying several invoices cannot be represented" \
  "$DIR/14-payment-is-one-to-one-with-invoice.md" \
  "bug,severity:high,area:sap,area:data,backend"

file_issue "BUG: matching invoices to SAP on purchase order plus gross amount can never resolve a periodic invoicing plan" \
  "$DIR/15-invoice-match-cannot-disambiguate-periodic-plans.md" \
  "bug,severity:high,area:sap,backend"

file_issue "BUG: quantities are Float while money is Decimal, and those quantities drive invoice match variance" \
  "$DIR/16-quantities-are-float.md" \
  "bug,severity:medium,area:data,backend"

file_issue "DESIGN: GST is modelled as one header tax code and one tax amount, with no CGST/SGST/IGST, HSN or place of supply" \
  "$DIR/17-gst-modelled-as-single-header-tax-code.md" \
  "bug,severity:high,area:data,backend"

file_issue "BUG: Vendor.gstin is globally unique, so one supplier cannot be onboarded by two tenants" \
  "$DIR/18-vendor-gstin-globally-unique.md" \
  "bug,severity:high,area:data,backend"

file_issue "BUG: the job runtime releases a job without checking it still holds the lease, so a slow handler can clobber another worker's result" \
  "$DIR/19-job-release-has-no-lease-guard.md" \
  "bug,severity:high,area:infra,backend"

file_issue "PERF: every goods-receipt check re-downloads the supplier's entire purchase order history from SAP" \
  "$DIR/20-po-grn-full-history-dump-per-attempt.md" \
  "performance,severity:high,area:sap,backend"

file_issue "BUG: the circuit breaker counts not_implemented errors, so calling an unbuilt driver method trips SAP for every other method" \
  "$DIR/21-circuit-breaker-counts-not-implemented.md" \
  "bug,severity:medium,area:sap,backend"

file_issue "PERF: the invoice SAP-status endpoint fans out one uncapped SAP call per matched invoice" \
  "$DIR/22-sap-read-fanout-and-unbounded-parallelism.md" \
  "performance,severity:medium,area:sap,backend"

file_issue "BUG: invoice submission performs four independent writes with no transaction" \
  "$DIR/23-invoice-submission-not-transactional.md" \
  "bug,severity:medium,area:data,backend"

file_issue "BUG: the discovery sweep never re-reads a purchase order it has already correlated, so SAP-side changes are lost forever" \
  "$DIR/24-sweep-never-resyncs-a-synced-po.md" \
  "bug,severity:medium,area:sap,backend"

file_issue "SECURITY: changing a password does not invalidate existing tokens, and sockets never re-check account status" \
  "$DIR/25-no-session-invalidation-on-password-change.md" \
  "security,severity:high,area:infra,backend"

file_issue "SECURITY: CSV and XLS exports do not neutralise formula injection, and supplier names are attacker-controlled" \
  "$DIR/26-csv-injection-in-exports.md" \
  "security,severity:medium,area:data,backend"

file_issue "CHORE: dead Mongoose model and Mongo dependencies remain, and a debug script that dumps tenant data is committed" \
  "$DIR/27-dead-mongo-artifacts.md" \
  "chore,severity:low,tech-debt,backend"

file_issue "DOCS: the repository README is still the unmodified create-next-app boilerplate" \
  "$DIR/28-readme-is-boilerplate.md" \
  "documentation,severity:low,chore"

file_issue "DOCS: the product one-pager claims zero SAP re-keying, but accounts payable must key every invoice into MIRO by hand" \
  "$DIR/29-marketing-claim-contradicts-implementation.md" \
  "documentation,severity:medium,integrity"

file_issue "RISK: the entire SAP integration depends on custom Z REST endpoints that are documented as unauthenticated" \
  "$DIR/30-sap-integration-depends-on-unauthenticated-custom-z-endpoints.md" \
  "security,severity:high,area:sap,documentation"

if [ "$CREATE" = "--create" ]; then
  echo
  echo "Done: $CREATED/30 issues created."
  if [ "${#FAILED_TITLES[@]}" -gt 0 ]; then
    echo "Failed (${#FAILED_TITLES[@]}):"
    for t in "${FAILED_TITLES[@]}"; do echo "  - $t"; done
    echo "Check GitHub for what already exists before re-running, so you do not duplicate."
    exit 1
  fi
else
  echo
  echo "Dry run. Re-run with --create to file these."
fi
