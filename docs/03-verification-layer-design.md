# Government Verification Layer — Design Note

Status: proposal · 2026-08-20 · scope: `backend/services/verification.service.js` and callers

## 1. What exists today

`verification.service.js` exposes a single function, `verifyGstinPan(gstin, pan)`, called
from exactly one place — `runGstinPanVerification()` in `vendor.controller.js`, which fires
on `POST /vendors/profile/submit` and again on approve if `verifiedAt` is unset. It sets
`gstinVerified` / `panVerified` / `verifiedAt` / `verificationDetails` on the Vendor and
mirrors the result to SAP via `sap.vendorVerifyKyc()`.

The single-writer discipline is right and should survive this redesign. Everything below
keeps it.

### Gaps

| # | Gap | Impact |
|---|-----|--------|
| 1 | `verifyMock` checks **format only** — GSTIN regex + "PAN is embedded in GSTIN chars 3–12". A structurally valid but **cancelled or non-existent** GSTIN passes. | Approving vendors whose GST registration is dead. Blocks ITC on their invoices. |
| 2 | `msmeNumber` and `cin` are captured on the Vendor model and `msmeCertificate` is uploaded, but **nothing verifies them**. | MSME status drives the 45-day payment rule under the MSMED Act. Unverified = compliance exposure, not just untidy data. |
| 3 | `accountNumber` / `ifscCode` captured, `cancelledCheque` uploaded, **no penny-drop**. | Wrong bank details reach the SAP vendor master and fail at payment run — the most expensive place to find out. |
| 4 | The live path swallows **all** errors into `{gstinValid: false, panValid: false}`. A provider outage is indistinguishable from a fraudulent GSTIN. | Approvals silently jam during an outage and staff are told "verification failed", which reads as the vendor's fault. |
| 5 | One-shot: `if (!vendor.verifiedAt)` means it never re-runs. | GSTIN status changes over time. A vendor verified in 2026 stays "verified" forever. |
| 6 | `GSTIN_PAN_VERIFY_API_KEY` is a **global plaintext env var**, not per-tenant and not through `secretBox`. | Multi-tenant SaaS: tenants can't bring their own provider account or be billed for their own usage. Inconsistent with how SAP credentials are already handled. |
| 7 | Live `fetch` has no timeout, no retry, no breaker. | A hanging provider hangs vendor submission. |
| 8 | The `vendor.validator.js` regexes deliberately "allow digits in alphabetic slots for testing". | Test convenience is in the production validation path. |

## 2. Where the data actually comes from

The government does not publish open verification APIs for most of this. Access is either
via a licensed intermediary or a KYB aggregator that wraps the official source.

| Check | Authoritative source | Practical access |
|---|---|---|
| GSTIN | GST Common Portal | GSP/ASP licence, or IRP `Get GSTIN Details` if already an e-invoice user, or an aggregator |
| PAN | Protean (NSDL) / CBDT | Protean Online PAN Verification (entity registration + annual fee), or aggregator |
| Udyam / MSME | Udyam portal, exposed as a DigiLocker issuer | APISetu/DigiLocker, or aggregator |
| CIN / company master | MCA21 V3 | MCA public master data, or aggregator |
| Bank account | NPCI rails | Penny-drop via Razorpay / Cashfree / Decentro / Signzy |

**Recommendation:** one aggregator contract covering GSTIN + PAN + Udyam + penny-drop +
MCA, rather than five integrations. Candidates: Karza/Perfios and IDfy (enterprise, common
in SAP vendor-master onboarding), Signzy, Decentro, Cashfree, Deepvue (cheaper, faster to
start). The design below is provider-agnostic so this choice stays reversible.

## 3. Proposed shape

### 3.1 Split into per-check verifiers behind one registry

Replace the single `verifyGstinPan` with a registry of independent checks, each with the
same contract. This is the same move `backend/sap/drivers/` already makes for SAP.

```
backend/services/verification/
  index.js            // registry + runVerification(vendor, checks)
  contract.js         // the CheckResult shape, frozen and asserted in tests
  providers/
    mock.provider.js      // format + internal-consistency, current behaviour
    karza.provider.js     // or whichever aggregator wins
  checks/
    gstin.check.js
    pan.check.js
    udyam.check.js
    bank.check.js
    cin.check.js
```

Every check returns the same envelope:

```js
{
  check: 'gstin',
  outcome: 'verified' | 'mismatch' | 'not_found' | 'inactive' | 'unavailable' | 'skipped',
  provider: 'MOCK' | 'KARZA',
  checkedAt: '2026-08-20T…',
  ttlDays: 90,
  fields: { legalName, tradeName, status, registrationDate, … },  // normalised
  raw: { … },        // provider response verbatim, for audit
  error: null
}
```

`outcome` is the fix for gap #4. `unavailable` is **not** a failure — it means "ask again",
and the approval UI must say so. Only `mismatch` / `not_found` / `inactive` are vendor
problems. This distinction is the single most important change in this document.

### 3.2 Move verification results off the Vendor into their own collection

`gstinVerified` / `panVerified` / `verifiedAt` / `verificationDetails` are four fields for
two checks; adding MSME, bank and CIN would make it ten. Introduce
`VendorVerification` — one document per vendor per check per attempt, holding the envelope
above. The Vendor keeps a small denormalised summary for list views:

```js
verification: {
  status: 'pending' | 'passed' | 'failed' | 'stale' | 'unavailable',
  lastRunAt: Date,
  summary: { gstin: 'verified', pan: 'verified', udyam: 'not_found', bank: 'skipped' }
}
```

Keeping every attempt (rather than overwriting) is what makes this defensible in an audit —
you can show what was known at the moment of approval, not just what is true now.

### 3.3 Verified name vs declared name

Once a real provider is in play, GSTIN lookup returns the registered legal name. Comparing
it to `companyName` is the highest-value check available and costs nothing extra — most
vendor-master data problems are name mismatches, not fake GSTINs. Fuzzy-match, surface the
delta to the approver, don't auto-reject.

### 3.4 Re-verification

Add a `ttlDays` per check (GSTIN 90, PAN 365, Udyam 180, bank once-per-change). A scheduled
job marks vendors `stale` past TTL. Re-verify on: TTL expiry, any edit to the underlying
field, and immediately before SAP vendor-master sync. Approval reads the summary; it does
not itself trigger a network call.

### 3.5 Per-tenant provider credentials

Store provider config on the `Client` (tenant), key encrypted through `utils/secretBox.js`
exactly as `SapConnection` does, with the global env var as the platform-default fallback.
Reuse the `SapConnectionAudit` pattern for credential-change auditing.

### 3.6 Resilience

Wrap provider calls in the existing `sap/circuitBreaker.js` (or a sibling), add a hard
timeout (5s) and one retry on 5xx/timeout only. An open breaker yields `unavailable`, never
`failed`.

## 4. Suggested sequencing

1. **Contract + outcome enum.** Refactor the current mock behind the new envelope, no
   behaviour change beyond `unavailable` ≠ `failed`. Fixes gap #4 with zero vendor spend.
2. **`VendorVerification` collection + migration** from the four Vendor fields
   (`scripts/migrate-*.js` precedent exists).
3. **Tighten the validator regexes**; move the loose ones into test fixtures. Gap #8.
4. **Udyam/MSME check** in mock form + surface MSME status in the approval UI and on the
   payment-terms path. Gap #2 is the one with statutory teeth.
5. **Sign the aggregator**, implement one live provider against the frozen contract.
6. **Penny-drop** — separate provider, separate consent, own commercial call. Gap #3.
7. **TTL + re-verification job.** Gap #5.

Steps 1–4 are internal and can land before any vendor contract exists.

## 5. Open questions

- Is verification a **hard gate** on approval, or advisory with an override + reason? Today
  it is hard. With a real provider and an `unavailable` outcome, an operator override path
  is probably necessary — and should be audited via `config/auditActions.js`.
- Does the tenant or the platform pay for verification calls? Determines whether §3.5 is
  needed in v1 or can wait.
- Should a failed verification block **SAP sync** as well as approval? Currently approval
  is the only gate; a vendor edited after approval could sync unverified data.
