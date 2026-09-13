<!-- title: TEST: zero component, page or end-to-end coverage on the frontend -->
<!-- labels: test,severity:medium,area:frontend -->

## Severity

**Medium** — structural. The two most serious open defects in this repo would
both have been caught by a single E2E flow.

## Summary

The frontend has seven test files, all under `src/lib/`, all testing pure
functions:

```
src/lib/branding.test.js
src/lib/onboarding.test.js
src/lib/platformNav.test.js
src/lib/workspaceNav.test.js
src/lib/sapDocuments.test.js
src/lib/sapFields.test.js
src/lib/syncState.test.js
```

There is **no test that renders a component**, exercises a page, or completes
a user flow — against 30+ backend suites. The pyramid is inverted at the top.

## What is good and should be kept

The cross-language registry-drift guards are a genuinely strong technique:
`platformNav.test.js` and `workspaceNav.test.js` load the **real backend**
permission map via `createRequire` and assert the frontend nav registry
matches, so a typo cannot silently hide a tab. `sapFields.test.js` does the
same for the field codec. Keep and extend this pattern.

## What is missing

Nothing asserts that:

- the supplier registration wizard validates and submits (GSTIN/PAN/IFSC rules
  in `src/features/profile/validation.js` are unit-tested; the **form** is not)
- a bid can be entered and submitted
- the workspace approval queue renders and approve/decline works
- the platform console MFA gate blocks the console until enrolment
- a `pending` sync state renders as "Awaiting SAP confirmation" rather than a
  document number — the honest-UI rule this product depends on
- the socket events (`po:new`, `grn:received`, `payment:cleared`) update the UI

## Why it matters concretely

Both of these open issues are trivially visible from the UI and invisible to
the current suite:

- Uninvited supplier can bid on any RFQ *(linked issue)*
- First bid closes bidding *(linked issue)*

An E2E test with two supplier accounts bidding on one tender fails on both.

## Blocker on record

`PROJECT_CONTEXT.md` §10: *"Route/component smoke tests deferred (need a
mocked `PortalProvider` with fetch + socket.io)."*

That mock is roughly a day of work and unblocks everything below it.

## Suggested plan

**1. Build the harness.** `src/test/renderWithPortal.jsx` — wraps
`ThemeProvider → ShellProvider → PortalProvider` with a stubbed `apiClient`
and a fake socket. Add `@testing-library/react` + `jsdom` to the root Vitest
config.

**2. Smoke-test each route.** One test per `src/app/*/page.jsx`: renders
without throwing, shows its heading, shows an empty state with no data. Cheap,
catches import cycles and provider mistakes.

**3. Cover the forms that carry money and compliance.** Registration
(GSTIN/PAN/MSME), bid submission, ASN, invoice. Assert validation fires and
the correct payload is sent.

**4. Add E2E on the mock driver.** Playwright is already available in the repo
toolchain. One spec walking the eight P2P stages, plus one with two supplier
accounts on the same tender. Run against `SAP_MOCK_MODE=true` with the
seeded demo tenant (`npm run seed:demo`).

**5. Wire into CI.** `.github/workflows/test.yml` already runs both suites;
add the E2E job with a Postgres service container.

## Acceptance criteria

- [ ] `renderWithPortal` harness exists and is documented in `PROJECT_CONTEXT.md`.
- [ ] Every `src/app/*/page.jsx` has a render smoke test.
- [ ] Registration, bid, ASN and invoice forms have submit-path tests.
- [ ] At least one Playwright spec completes RFQ → bid → award → ASN → GRN →
      invoice → payment against the mock driver.
- [ ] At least one Playwright spec has two suppliers bidding on one tender.
- [ ] E2E runs in CI.
