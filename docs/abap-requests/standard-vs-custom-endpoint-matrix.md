# Standard-vs-custom matrix for the eleven Z endpoints

**Raised by:** issue #79, as the medium-term half of the same risk the authentication
disclosure (`z-endpoint-authentication-disclosure.md`) covers: this driver is coded against
one customer's custom ABAP, which is also a portability problem — a second customer will not
have these eleven Z services, so onboarding them means either building the same services
again or driving these reads through standard SAP OData APIs instead.

**Confidence, stated once so it isn't repeated eleven times:** nothing below has been run
against a live sandbox — the same "not run against a live system" caveat
`s4odata.driver.js`'s own header comment (lines 8-16) already carries for its unused standard
API declarations. Every "plausible" verdict is a starting hypothesis for Basis/MM to confirm
or reject, not a tested conclusion — treating it as more than that would be exactly the kind
of invented confidence ADR-0036/ADR-0037 already refuse elsewhere in this codebase.

| # | Z endpoint | Data | Standard OData candidate | Verdict |
|---|---|---|---|---|
| 1 | `/zpo_grn_vendor/Detail` | PO header + line items + nested GRNs, one vendor's whole history | `API_PURCHASEORDER_PROCESS_SRV` (PO header/items) + `API_MATERIAL_DOCUMENT_SRV` (goods receipts) — both already declared in `services()`, neither called from anywhere | **Plausible, but two calls where the Z service is one.** The nested GRN-per-line shape and the nowhere-else-available `GR_EXPECTED`/fiscal-year fields (see `grFiscalYear()`'s own comment on what's missing) would need reconstructing from two joined standard reads. Worth prototyping once a sandbox exists; not a drop-in replacement. |
| 2 | `/zmiro_display/MIRO` | MIRO (invoice verification) ledger for a vendor | `API_SUPPLIERINVOICE_PROCESS_SRV` — declared, unused | **Plausible.** Supplier invoice verification is exactly this service's stated purpose in the API Business Hub. Highest-confidence candidate on this list. |
| 3 | `/zpayment_api/payment` | Clearing/payment detail: gross, TDS, net, clearing doc, **UTR**, method | None declared. Payment-run (F110) clearing and bank UTR detail is not typically exposed through the standard API Business Hub catalogue at all in most S/4 editions. | **Likely genuinely custom.** The best-known standard alternative is a payment-medium/house-bank-statement API, which is a different data model (bank statement lines, not a per-invoice clearing lookup) and would need real design work, not a swap. |
| 4 | `/zvendor_create/VENDOR_CR` | **Write:** creates a vendor master record | `API_BUSINESS_PARTNER` — declared, unused. Standard S/4 vendor-as-business-partner creation goes through this service. | **Plausible**, and the highest-value one to actually build: `sap/mappings/vendor-create.map.js` already tracks the exact field mapping this Z endpoint expects, so the mapping work of "what does account group / BP grouping / tax-number-category mean here" is already half-done for whoever attempts the standard-API version. |
| 5 | `/zinv_milestone/plan` | Invoicing (milestone billing) plan schedule (FPLA/FPLT) | None declared. Milestone billing plans are not commonly exposed as a standalone OData service; they usually surface as a sub-entity of the sales/purchasing document itself. | **Likely needs custom or a deeper standard-API investigation** than a single declared service can answer — flag to MM/ABAP directly rather than guessing further here. |
| 6 | `/ZME43/ME43` | RFQ documents for a vendor | None. Sourcing/RFQ-to-external-vendor is explicitly called out in this driver's own header comment as "normally SAP Ariba/Business Network territory" — core S/4 does not expose a supplier-portal RFQ read the way this integration needs it. | **Needs custom**, by design — this was already the conclusion the driver's header comment reached when RFQs/bids/awards were moved into the application instead (see that comment for the full reasoning). |
| 7 | `/ZCL_ME48/vendor` | All purchasing documents for a vendor (not just quotations) | Same sourcing gap as #6. | **Needs custom**, same reasoning as #6. |
| 8 | `/ZQUOT_NETPR/QUOT_UPDPR` | **Write:** quotation net price update | Same sourcing gap as #6/#7. | **Needs custom.** |
| 9 | `/ZREGION_CODE/REGION` | Region code catalogue | Generic value-help / domain-value OData services exist in most S/4 systems, but which one (if any) exposes this specific domain is system-configuration-dependent. | **Unknown — ask Basis/MM directly**; low priority given the low sensitivity of this one. |
| 10 | `/zpaym_term/PAY_TERM` | Payment terms catalogue | Same as #9 — payment terms are often exposed via a standard value-help service, but confirming which one needs a live system. | **Unknown — ask Basis/MM directly.** |
| 11 | `/ZPAYM_METHOD/PAYM_METHOD` | Payment method catalogue | Same as #9/#10. | **Unknown — ask Basis/MM directly.** |

## Reading this table

- **Plausible (1, 2, 4):** worth a real prototyping pass once a design-partner sandbox exists
  (the same gate ADR-0036 recorded for Phase 8's real driver work) — these three are where a
  second customer's onboarding cost drops fastest if the standard APIs pan out.
- **Likely/needs custom (3, 5, 6, 7, 8):** these are the genuine "yes, ABAP has to build this"
  set — worth saying so explicitly now rather than promising a second customer a smaller
  integration than eleven Z services will actually turn out to be.
- **Unknown (9, 10, 11):** low-value, low-risk, low-priority to resolve — a five-minute Basis
  conversation once one is already happening about the higher-value items.

## What this does not do

This is not a build plan and commits to no work. It exists so the next person scoping
customer two's integration — or the next session picking up issue #79's medium-term half —
starts from this table instead of re-deriving it from the driver's source comments each time.
