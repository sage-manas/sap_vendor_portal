# ABAP ask: name the parties on each `zpo_grn_vendor/Detail` row

**Raised:** issue #315 (order legitimacy). **Status:** written up, not yet sent. No ABAP
contact or change-request channel is available from this repo. Whoever owns that
relationship should file this and update this status once it is.

## What the endpoint does today

`zpo_grn_vendor/Detail` (`backend/sap/drivers/s4odata.driver.js`'s `fetchPoGrnDisplay`)
is called with `{ "vendor": "<LIFNR>" }` and returns that vendor's orders. Each row
carries a buyer name (`BUYER_NAME`) and a company code (`COM_CODE`), but no field naming
the seller. The portal therefore *assumes* every row belongs to the vendor it asked about.
If the report ever widens its selection (a blank or mistyped `LIFNR`, a partner-function
join, an alternative payee), another supplier's orders would be imported under the
wrong supplier, and nothing would notice.

The buyer side is partly covered: the portal drops any row whose `COM_CODE` is not one of
the tenant's declared company codes (issue #62). `BUYER_GSTIN` is already returned by the
single-order sibling `zpo_grn/Detail`, but not by this list.

## What to ask for

Three header fields on every row. All three are already on EKKO / LFA1 / the company
code's tax data, so this means adding them to the existing selection, not new logic:

1. **`VENDOR`**: the order's supplier, `EKKO-LIFNR`.
2. **`VENDOR_GSTIN`**: the supplier's GSTIN (`LFA1-STCD3`, or wherever this client keeps it).
3. **`BUYER_GSTIN`**: the buying company code's GSTIN, as `zpo_grn/Detail` already returns.

## What the portal does with them

Already shipped in #315 and waiting for the data:
- `VENDOR` and `BUYER_GSTIN` are read when present.
- A row whose `VENDOR` differs from the requested vendor code is refused.
- A row whose `BUYER_GSTIN` has a different PAN (characters 3–12) from the tenant's own
  GSTIN is refused.
- A missing field is never treated as a mismatch. So the change is safe to ship on
  either side first.

`VENDOR_GSTIN` is not read yet. Once it arrives, it can be checked against the supplier's
onboarded GSTIN (`Vendor.gstin`) the same way.
