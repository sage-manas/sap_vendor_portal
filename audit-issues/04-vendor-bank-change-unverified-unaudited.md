<!-- title: SECURITY: an approved supplier can change their own payout bank account with no re-verification and no audit entry -->
<!-- labels: security,severity:critical,area:data,backend -->

**Severity:** Critical — the single most exploited fraud vector in accounts payable.

## Summary

`updateProfile` writes any field not listed in `PROTECTED_VENDOR_FIELDS` straight to the
Vendor row. `bankName`, `accountNumber`, `ifscCode` and `accountName` are not in that list.
There is no status check (an already-approved supplier may edit), no re-verification, no
dual approval, no audit record, and no re-push or flag to SAP vendor master.

`createVendor`, `approveVendor` and `rejectVendor` all call `recordAudit`
(`controllers/vendor.controller.js:289`, `:403`, `:438`). `updateProfile` does not.

## Evidence

`backend/controllers/vendor.controller.js:302-325` — the write, with no audit call and no
bank-field special case.

`backend/validators/vendor.validator.js:91-95` — no format validation on any bank field:
```js
bankName: optionalText, accountNumber: optionalText, ifscCode: optionalText, accountName: optionalText,
```

`backend/prisma/schema.prisma:260-264` — bank details are plain columns. Note the contrast:
SAP connection credentials get AES-256-GCM envelope encryption via `utils/secretBox.js`;
supplier bank accounts get none.

## Steps to reproduce

1. Approve a supplier so `status = 'Approved'` and `sapVendorCode` is set.
2. As that supplier:
   ```
   curl -X PUT -H "Authorization: Bearer $SUPPLIER_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"accountNumber":"99999999999","ifscCode":"XXXX0000999","accountName":"Not The Supplier"}' \
        http://localhost:5000/api/vendors/profile
   ```
3. The row is updated. `GET /api/audits` shows no entry. `verifiedAt` is unchanged. SAP
   still holds the old bank details, and nothing records the divergence.

## Expected

A bank-detail change on an approved supplier is a controlled event:

- It is always audited, with before/after values.
- It does not take effect immediately — it enters a pending state requiring tenant approval
  (`vendor:approve`), like the original onboarding did.
- It re-runs verification and clears `verifiedAt` until re-verified.
- It notifies the tenant's finance role, and ideally the supplier's registered email, so an
  account takeover is visible to both parties.
- Payments are held while a change is pending.

## Suggested fix

Add bank fields to a new `SENSITIVE_VENDOR_FIELDS` set. When any is present in the update
body, write to a pending-change record rather than the live row, call `recordAudit` with
`vendor.bank_change_requested`, and expose an approve/reject action on the tenant side.
Consider encrypting `accountNumber` at rest with the existing `secretBox` envelope.

## Acceptance criteria

- [ ] A bank-field change by an approved supplier does not alter the live row directly.
- [ ] `recordAudit` is called with old and new values for every bank-field change.
- [ ] Payments for a supplier with a pending bank change are blocked.
- [ ] Test asserts an approved supplier's direct PUT leaves `accountNumber` unchanged.
