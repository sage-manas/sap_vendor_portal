# ABAP ask: filters on `zpo_grn_vendor/Detail`

**Raised:** issue #69 (performance). **Status:** written up, not yet sent — no ABAP
contact/change-request channel is available from this repo; whoever owns that
relationship should file this and update this doc's status once it is.

## What the endpoint does today

`zpo_grn_vendor/Detail` (`backend/sap/drivers/s4odata.driver.js`'s `fetchPoGrnDisplay`)
returns every purchase order SAP has for a vendor, with every line item and every goods
receipt nested inside, for one request body: `{ "vendor": "<LIFNR>" }`. There is no
document number, date, or company-code parameter. Confirmed against the live sandbox: this
takes 22-84 seconds and returns roughly half a megabyte for 173 orders.

The portal now caches this response per vendor for a short window (issue #69's own fix,
`vendorResponseCacheMs` in the same file) so N open shipments for one vendor cost one call
per cadence instead of N. That bounds the damage; it does not fix the underlying problem —
every call still downloads a vendor's entire order history, and the portal still has to
walk it client-side to answer "is there a goods receipt for PO 4500001234 yet?".

## What to ask for

Three filters on the same report, additive — none require new functionality, only
narrowing what an existing report already selects on:

1. **A purchase-order-number parameter.** `{ "vendor": "<LIFNR>", "po_number": "<EBELN>" }`
   (or a list, for a vendor with several open documents at once) returning just that
   order's rows. This is the one that matters most: a goods-receipt check for a known PO
   should not have to download every other order the vendor has ever had.
2. **A changed-since date parameter.** `{ "vendor": "<LIFNR>", "changed_since": "<date>" }`
   returning only orders/GRNs touched on or after that date, so the discovery sweep
   (`jobs/handlers/sweepPurchaseOrders.js`) can ask "what's new" instead of re-reading and
   re-diffing everything every cycle.
3. **A company-code parameter**, bundled here per the issue's own suggestion since it's the
   same report. The portal already filters the response to the tenant's declared company
   codes after the fact (`declaredCompanyCodes` in the same file, issue #62) — this would
   let SAP do that scoping itself instead of shipping every other company's rows over the
   wire first.

Separately (already noted inline where it's felt, not repeated here): `MJAHR`/`GR_YEAR` is
missing from the GRN rows this endpoint nests — see `fetchPoGrnDisplay`'s comment on
`grFiscalYear()` for that ask's own detail. Worth raising in the same conversation, since
it's the same report.

## What does not need ABAP

The per-vendor response cache and the ambient share between a targeted watch
(`awaitGoodsReceipt`/`awaitPaymentRun`) and the same-tick discovery sweep — both shipped in
issue #69's PR without waiting on this. This document is only the piece that does need a
change on SAP's side.

## Load test

Issue #69 also asked for a load-test measurement (50 suppliers, 20 open ASNs each, calls
per hour before/after). Not run here: a meaningful number needs a live or credibly-simulated
SAP sandbox under load, which this environment does not have (same gap ADR-0036 recorded for
Phase 8's real driver work) — a number produced against nothing is exactly the kind of
invented evidence this codebase's own conventions (ADR-0036, ADR-0037) refuse to fabricate.

What issue #69's fix changes, stated as a bound rather than a measurement: before, one
`vendorPoGrnDisplay` call per open ASN's `awaitGoodsReceipt` attempt — twenty open ASNs on
one vendor meant twenty calls per cadence tick, not one, and the same shape of multiplication
applied to `vendorMiroDisplay` per open invoice. After, every caller sharing that vendor's
code within `vendorResponseCacheMs` (default 20s) — every open ASN's watch, every open
invoice's watch, and a same-tick discovery sweep — collapses to at most one call, regardless
of how many documents that vendor has open. The fifty-supplier, twenty-ASN scenario in the
issue goes from one call per open ASN per tick to one call per *vendor* per tick: a
50x reduction for that specific fleet shape, from the structure of the fix rather than a
measured run. Replace this with a real number the day a sandbox is available to run
`scripts/sap-conformance.js`-style load against.
