# Open items before go-live

Carried over from the go-live remediation (Sprints 1-5). Nothing here is
started; each needs an answer or an action from a person.

## Decisions (blocked on the owner)

- [ ] **Hosting and backup target.** Backup and restore scripts and the
  runbook exist (`docs/runbooks/backup-restore.md`), but provider-specific
  steps (offsite copy, WAL/PITR) wait on where this is hosted and where
  encrypted backups go.
- [ ] **Object storage provider.** Uploads use an S3-compatible API with
  encryption and signed links (`docs/runbooks/object-storage.md`). The provider
  and bucket have to be chosen, and existing uploaded files moved across.

## Actions (not code)

- [ ] **Send the SAP Z-endpoint authentication disclosure** to the customer's
  SAP team: `docs/abap-requests/z-endpoint-authentication-disclosure.md`.
  TLS and authentication on the Z endpoints are theirs to fix; the portal
  already rejects `http://` and missing credentials for the production
  environment.
- [ ] **Enable code scanning** (GitHub repo settings, Code security) so CodeQL
  results from `security-scan.yml` appear, and confirm the first run is green.
- [ ] **Staging pass before a pen test.** Run the full flow on a staging
  instance behind the real domain, with real TLS and the real SAP.

## Follow-ups

- [ ] **Pagination ceiling.** `limit` is capped at 200 (`validators/pagination.validator.js`);
  the original spec said 100. Tighten it if 100 is wanted (the workspace and
  new-asset pages request 200 today).
- [ ] **Nine unpaginated list routes**, tracked in issue #186.
