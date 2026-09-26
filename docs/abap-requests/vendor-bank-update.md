# ABAP ask: an endpoint that updates an existing vendor's bank details

**Raised:** go-live audit, September 2026. **Status:** written up, not yet sent — whoever
owns the ABAP relationship should file this and update this doc's status once it is.

## Why

A supplier can ask to change their payout bank account in the portal, and a client admin
approves it there. But the F110 payment run pays from **SAP's** vendor master (LFBK), not
from the portal's copy — so an approval that never reaches SAP leaves the portal showing
the new account while SAP keeps paying the old one.

The only vendor write the portal has today is `zvendor_create/VENDOR_CR`, which creates a
vendor and cannot change one. So, for now, approving a bank change in the portal records the
approval and waits: someone updates the bank data by hand in XK02, then clicks "Confirm
updated in SAP" on the supplier's page. This endpoint removes that manual step.

## What to build

A custom Z REST endpoint in the same family as `VENDOR_CR` (plain POST, `sap-client` as a
query parameter), e.g. `POST /zvendor_bank/UPDATE`, that **replaces** the vendor's bank
details for one vendor:

```json
{
  "vendor": "1120250081",
  "bank_country": "IN",
  "bank_key": "HDFC0000999",
  "account_number": "99999999999",
  "account_holder": "Kaveri Forge & Fittings",
  "bank_name": "HDFC Bank",
  "branch": "Pune Camp"
}
```

- `vendor` is LIFNR. `bank_key` is the IFSC code, as the vendor master already stores it
  for Indian banks.
- **Replace, not append:** the vendor should end up with exactly this one bank line.
  Leaving the old line in place would let F110 keep choosing it.
- **Response:** a `STATUS` of `S`/`E` and a `MESSAGE`, the same shape as `QUOT_UPDPR`'s, so a
  refusal (unknown vendor, blocked vendor, invalid bank key) comes back as a readable
  reason, not an HTTP 200 with an empty body.
- **Authentication:** please require it (see `z-endpoint-authentication-disclosure.md`). An
  unauthenticated endpoint that repoints a vendor's payout account is the single most
  valuable thing an attacker on the network could find.

## What changes in the portal once it exists

Only the driver: `backend/sap/drivers/s4odata.driver.js` gets a `vendorBankUpdate` method
that calls this endpoint (plus a `vendorBankUpdatePath` connection setting). The approve
flow in `controllers/vendor.controller.js` already asks SAP first and applies the change
only if SAP accepted it; it falls back to the manual confirmation step only while the driver
reports `not_implemented`. Nothing else needs to change.
