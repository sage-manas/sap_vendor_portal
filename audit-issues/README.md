# Audit issues — full codebase review, 14 September 2026

30 issues from an independent file-by-file review of the backend, SAP integration
layer, job runtime, data model and frontend. Documentation was deliberately ignored; every
finding is anchored to a file and line in the code as it stood on 14 September 2026.

Two defects from the earlier `qa-issues/` batch — the uninvited-supplier bid and the
first-bid-closes-bidding bug — were verified as **fixed** (see ADR-0037) and are not re-filed.

## Filing them

```bash
bash audit-issues/file-issues.sh            # dry run, prints what it would create
bash audit-issues/file-issues.sh --create   # actually files them
```

Requires the `gh` CLI, authenticated (`gh auth login`), run from inside the repository.
The script creates any missing labels first, files each issue independently, and prints a
created/failed summary at the end — one failure does not abort the rest.

## The issues

| # | File | Title | Labels |
|---|---|---|---|
| 1 | [`01-sealed-bids-exposed-to-competitors.md`](01-sealed-bids-exposed-to-competitors.md) | SECURITY: every supplier can read competitors' sealed bid prices on an open tender | security,severity:critical,area:rfq,backend |
| 2 | [`02-cross-supplier-idor-on-document-reads.md`](02-cross-supplier-idor-on-document-reads.md) | SECURITY: any supplier can read any other supplier's PO, invoice, payment, GRN and ASN by id | security,severity:critical,area:rfq,backend |
| 3 | [`03-cross-supplier-writes.md`](03-cross-supplier-writes.md) | SECURITY: a supplier can acknowledge, ship against, and invoice another supplier's purchase order | security,severity:critical,area:rfq,backend |
| 4 | [`04-vendor-bank-change-unverified-unaudited.md`](04-vendor-bank-change-unverified-unaudited.md) | SECURITY: an approved supplier can change their own payout bank account with no re-verification and no audit entry | security,severity:critical,area:data,backend |
| 5 | [`05-invoice-totals-trusted-match-advisory.md`](05-invoice-totals-trusted-match-advisory.md) | SECURITY: invoice totals are taken from the request body and never recomputed, and three-way match only warns | security,severity:high,area:data,backend |
| 6 | [`06-fabricated-chat-replies.md`](06-fabricated-chat-replies.md) | INTEGRITY: the backend writes fabricated Buyer, Finance, Quality and Warehouse chat replies, one claiming SAP was updated | bug,severity:critical,integrity,backend |
| 7 | [`07-update-payment-status-lies.md`](07-update-payment-status-lies.md) | INTEGRITY: PUT /api/payments/:id/status reports success while writing nothing | bug,severity:high,integrity,backend |
| 8 | [`08-invented-gst-split-on-tax-invoice.md`](08-invented-gst-split-on-tax-invoice.md) | INTEGRITY: the invoice PDF fabricates an 18% GST split and prints it on a document headed TAX INVOICE | bug,severity:high,integrity,area:data,backend |
| 9 | [`09-default-technical-score-presented-as-evaluation.md`](09-default-technical-score-presented-as-evaluation.md) | INTEGRITY: a constant 80 is fed into bid ranking as a technical evaluation score | bug,severity:medium,area:rfq,backend |
| 10 | [`10-kyc-noop-and-dead-mongo-field.md`](10-kyc-noop-and-dead-mongo-field.md) | BUG: vendorVerifyKyc and vendorReject call no SAP service, and reference a dead Mongo field so every log entry records documentRef undefined | bug,severity:medium,area:sap,backend |
| 11 | [`11-po-status-is-header-level.md`](11-po-status-is-header-level.md) | DESIGN: purchase order state is header-level, so a partially delivered or partially invoiced order cannot be represented | bug,severity:high,area:sap,area:data,backend |
| 12 | [`12-sap-document-numbers-lack-year.md`](12-sap-document-numbers-lack-year.md) | BUG: SAP document numbers are stored without fiscal or material-document year, so GRN ids will collide when SAP recycles a number range | bug,severity:high,area:sap,area:data,backend |
| 13 | [`13-no-company-code-on-purchase-order.md`](13-no-company-code-on-purchase-order.md) | BUG: purchase orders carry no company code or purchasing organisation, and the sweep discards the one SAP returns | bug,severity:high,area:sap,area:data,backend |
| 14 | [`14-payment-is-one-to-one-with-invoice.md`](14-payment-is-one-to-one-with-invoice.md) | DESIGN: Payment is modelled one-to-one with Invoice, so an F110 run paying several invoices cannot be represented | bug,severity:high,area:sap,area:data,backend |
| 15 | [`15-invoice-match-cannot-disambiguate-periodic-plans.md`](15-invoice-match-cannot-disambiguate-periodic-plans.md) | BUG: matching invoices to SAP on purchase order plus gross amount can never resolve a periodic invoicing plan | bug,severity:high,area:sap,backend |
| 16 | [`16-quantities-are-float.md`](16-quantities-are-float.md) | BUG: quantities are Float while money is Decimal, and those quantities drive invoice match variance | bug,severity:medium,area:data,backend |
| 17 | [`17-gst-modelled-as-single-header-tax-code.md`](17-gst-modelled-as-single-header-tax-code.md) | DESIGN: GST is modelled as one header tax code and one tax amount, with no CGST/SGST/IGST, HSN or place of supply | bug,severity:high,area:data,backend |
| 18 | [`18-vendor-gstin-globally-unique.md`](18-vendor-gstin-globally-unique.md) | BUG: Vendor.gstin is globally unique, so one supplier cannot be onboarded by two tenants | bug,severity:high,area:data,backend |
| 19 | [`19-job-release-has-no-lease-guard.md`](19-job-release-has-no-lease-guard.md) | BUG: the job runtime releases a job without checking it still holds the lease, so a slow handler can clobber another worker's result | bug,severity:high,area:infra,backend |
| 20 | [`20-po-grn-full-history-dump-per-attempt.md`](20-po-grn-full-history-dump-per-attempt.md) | PERF: every goods-receipt check re-downloads the supplier's entire purchase order history from SAP | performance,severity:high,area:sap,backend |
| 21 | [`21-circuit-breaker-counts-not-implemented.md`](21-circuit-breaker-counts-not-implemented.md) | BUG: the circuit breaker counts not_implemented errors, so calling an unbuilt driver method trips SAP for every other method | bug,severity:medium,area:sap,backend |
| 22 | [`22-sap-read-fanout-and-unbounded-parallelism.md`](22-sap-read-fanout-and-unbounded-parallelism.md) | PERF: the invoice SAP-status endpoint fans out one uncapped SAP call per matched invoice | performance,severity:medium,area:sap,backend |
| 23 | [`23-invoice-submission-not-transactional.md`](23-invoice-submission-not-transactional.md) | BUG: invoice submission performs four independent writes with no transaction | bug,severity:medium,area:data,backend |
| 24 | [`24-sweep-never-resyncs-a-synced-po.md`](24-sweep-never-resyncs-a-synced-po.md) | BUG: the discovery sweep never re-reads a purchase order it has already correlated, so SAP-side changes are lost forever | bug,severity:medium,area:sap,backend |
| 25 | [`25-no-session-invalidation-on-password-change.md`](25-no-session-invalidation-on-password-change.md) | SECURITY: changing a password does not invalidate existing tokens, and sockets never re-check account status | security,severity:high,area:infra,backend |
| 26 | [`26-csv-injection-in-exports.md`](26-csv-injection-in-exports.md) | SECURITY: CSV and XLS exports do not neutralise formula injection, and supplier names are attacker-controlled | security,severity:medium,area:data,backend |
| 27 | [`27-dead-mongo-artifacts.md`](27-dead-mongo-artifacts.md) | CHORE: dead Mongoose model and Mongo dependencies remain, and a debug script that dumps tenant data is committed | chore,severity:low,tech-debt,backend |
| 28 | [`28-readme-is-boilerplate.md`](28-readme-is-boilerplate.md) | DOCS: the repository README is still the unmodified create-next-app boilerplate | documentation,severity:low,chore |
| 29 | [`29-marketing-claim-contradicts-implementation.md`](29-marketing-claim-contradicts-implementation.md) | DOCS: the product one-pager claims zero SAP re-keying, but accounts payable must key every invoice into MIRO by hand | documentation,severity:medium,integrity |
| 30 | [`30-sap-integration-depends-on-unauthenticated-custom-z-endpoints.md`](30-sap-integration-depends-on-unauthenticated-custom-z-endpoints.md) | RISK: the entire SAP integration depends on custom Z REST endpoints that are documented as unauthenticated | security,severity:high,area:sap,documentation |

## Suggested order

**Fix this week — a supplier can exploit these today.**
#01 sealed bids exposed, #02 cross-supplier reads, #03 cross-supplier writes,
#04 unaudited bank changes, #05 unvalidated invoice totals.

#01–#03 share one root cause — no supplier ownership check on document-by-id routes — so they
are one fix and one test matrix, not three.

**Next — the system says things that are not true.**
#06 fabricated chat, #07 the payment status endpoint that writes nothing, #08 the invented
GST split, #09 the constant technical score, #10 the no-op KYC call.

**Then — a business decision is needed before more engineering.**
#29 the re-keying claim and #30 the unauthenticated Z endpoints. Both are conversations, not
commits, and both change what the roadmap should contain.

**Then — SAP domain model, best done as one sequenced piece of work.**
#11 line-level PO state, #12 document-year keys, #13 company code, #14 payment-to-many-invoices,
#17 GST detail. These touch the same tables; doing them together is one migration instead of five.
#15 (periodic plan matching) and #16 (decimal quantities) can land independently.

**Then — runtime and scale, before the first production tenant.**
#19 lease guard, #20 the full-history dump, #21 the circuit breaker, #22 fan-out,
#23 transactional submission, #24 stale synced orders, #25 session invalidation.

**Hygiene, any time.**
#26 CSV injection, #27 Mongo leftovers (this is Phase 0 of the engineering plan, still open),
#28 the README.
