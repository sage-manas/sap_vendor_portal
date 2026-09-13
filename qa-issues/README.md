# QA findings — ready-to-file GitHub issues

Repository: `devansh-7-gte/sap_vendor_portal`

Generated from a code review on 10 September 2026.


| # | File | Title | Labels |
|---|---|---|---|
| 1 | `01-uninvited-vendor-can-bid.md` | SECURITY: any supplier can submit a bid on an RFQ they were not invited to | `security` `severity:critical` `area:rfq` `backend` |
| 2 | `02-first-bid-closes-bidding.md` | BUG: the first bid closes the RFQ — a competitive tender accepts exactly one bid | `bug` `severity:high` `area:rfq` `backend` |
| 3 | `03-trust-proxy-not-set.md` | BUG: Express `trust proxy` is never set — rate limiting, audit IPs and the internal loopback guard are all wrong in production | `bug` `severity:high` `security` `area:infra` `backend` |
| 4 | `04-production-cannot-boot-from-docs.md` | BUG: production boot requires three dead Clerk variables, and SERVER_SETUP_QUICK_READ.md names a database variable that no longer exists | `bug` `severity:high` `area:deployment` `documentation` |
| 5 | `05-cors-localhost-in-production.md` | SECURITY: CORS and Socket.io accept any localhost origin in production, with credentials enabled | `security` `severity:medium` `area:infra` `backend` |
| 6 | `06-self-invited-bidder-rating-advantage.md` | BUG: a self-invited bidder is scored with rating 95 while a properly invited bidder defaults to 80 | `bug` `severity:medium` `area:rfq` `backend` |
| 7 | `07-nextsequentialid-loads-every-row.md` | PERF: nextSequentialId loads every matching row into memory on each id mint, inside a transaction | `performance` `severity:medium` `area:data` `backend` |
| 8 | `08-no-frontend-test-coverage.md` | TEST: zero component, page or end-to-end coverage on the frontend | `test` `severity:medium` `area:frontend` |
| 9 | `09-code-hygiene-cleanup.md` | CHORE: always-true branch in the tenant extension, committed debug script, and stale comments/docs | `chore` `severity:low` `tech-debt` |
| 10 | `10-tests-encode-defects-as-requirements.md` | PROCESS: two open defects are locked in by passing tests — add a review rule for API-bypassing test setup | `process` `test` `severity:medium` |

## Filing them

`gh` must be authenticated with access to the repo:

```bash
gh auth status
cd /path/to/sap_vendor_portal
bash file-issues.sh            # dry run: prints what it would do
bash file-issues.sh --create   # actually creates the issues
```

The script creates any missing labels first, then files each issue and prints
its URL. Issues are independent; file them in any order. Cross-references
between them are by title, so add the issue numbers by hand afterwards (or let
GitHub's autolinking catch them when you paste numbers into the bodies).

## Suggested triage order

1. **#1 uninvited bid** — security, and it blocks #6.
2. **#4 production boot** — anyone deploying today is stuck.
3. **#3 trust proxy** — one line, four defects.
4. **#2 first bid closes bidding** — core workflow.
5. **#10 process rule** — do this before #1 and #2 so the fixes land with the right tests.
6. Everything else.

