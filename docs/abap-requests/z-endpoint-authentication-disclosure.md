# Disclosure: the custom Z REST endpoints this integration depends on are unauthenticated

**For:** the customer's Basis and security teams. **Raised by:** issue #79.
**Status: drafted, not yet sent.** No channel to that team exists from this repo — whoever
owns that relationship needs to send this and get it acknowledged, then update this file's
status line and DECISIONS.md's ADR-0040 once that's done. Nothing here should be read as "the
disclosure happened" until it actually has.

## What this is

Every read this portal performs against your SAP system, and the four writes it makes — a
vendor master record, a quotation net price, a purchase order's invoicing plan, and the
creation of an asset purchase order — go through fourteen custom Z REST services rather than
the standard SAP OData APIs. `backend/sap/drivers/s4odata.driver.js` — the code that calls them — documents
that these currently answer with **no authentication at all**: the standard OData gateway
needs a technical user this integration has not been issued credentials for, so the code
silently omits the `Authorization` header rather than failing, and the requests still succeed.

That is workable for a sandbox nobody but this integration talks to. It must not be true of
a system carrying real vendor, purchase order, invoice or payment data, and this integration
is not the party who can fix it — only your Basis/security team can enable authentication on
these services. This document lists exactly what each endpoint returns, so that decision can
be made with full information rather than a general "some endpoints are open."

## The fourteen endpoints, and what each exposes

| Endpoint | Method | What it returns |
|---|---|---|
| `/zpo_grn_vendor/Detail` | GET (filter in body) | Every purchase order for a given vendor code — header, every line item, every goods receipt posted against it, quantities, prices, net/gross amounts. No filter beyond the vendor code: one call returns the vendor's *entire* order history. |
| `/zmiro_display/MIRO` | GET (filter in body) | Every MIRO (invoice verification) document for a vendor — document number, amounts, tax code, payment terms, line items. |
| `/zpayment_api/payment` | GET | Clearing/payment detail for one MIRO document: gross amount, TDS deducted, net disbursed, clearing document, **UTR (bank transfer reference)**, payment method. |
| `/zvendor_create/VENDOR_CR` | POST | **Write.** Creates a vendor master record from a flat JSON payload — company name, GSTIN, PAN, bank details, address. One of the four writes in this list, and — with `zasset_po/create` — one of the two that create rather than amend; an unauthenticated version of this endpoint lets anyone who can reach it create vendor master records in your system. |
| `/zinv_milestone/plan` | GET | An invoicing (milestone billing) plan's schedule — line numbers, dates, percentages/amounts, SAP document references once posted. |
| `/zpo_grn/Detail` | GET (filter in body) | One purchase order in full — header, buyer and ship-to addresses, vendor name and address, every line item with prices and received/invoiced quantities, nested goods receipts, and each line's invoicing plan number. The single-order sibling of `/zpo_grn_vendor/Detail`: narrower in scope per call, but keyed on a **purchase order number alone**, so it needs no knowledge of a vendor code to read one order in full. |
| `/zinv_plan/update` | POST | **Write.** Creates or replaces the invoicing (milestone billing) plan on a purchase order line — the dates, percentages and values on which that order becomes billable, and the billing block on each. A consequential write: an unauthenticated version lets anyone who can reach it change *when and how much* an order invoices. |
| `/zasset_po/create` | POST | **Write — and the most consequential one in this list.** Creates a **purchase order** in your system, with asset account assignment: supplier, company code, purchasing org, line items, quantities, prices and the fixed asset the capex posts to. Every other entry here reads data or amends an existing document; this one brings a new financial commitment into existence. An unauthenticated version lets anyone who can reach it raise purchase orders against any supplier, in any company code, for any amount. |
| `/ZME43/ME43` | GET | RFQ (request for quotation) documents for a vendor. |
| `/ZCL_ME48/vendor` | GET | Every purchasing document type for a vendor (not only quotations, despite the ME48 name) — a second, differently-shaped read of much of the same PO/quotation data. |
| `/ZQUOT_NETPR/QUOT_UPDPR` | POST | **Write.** Updates a quotation's net price (ME47-equivalent). |
| `/ZREGION_CODE/REGION` | GET | Region code catalogue (value-help data — low sensitivity, listed for completeness). |
| `/zpaym_term/PAY_TERM` | GET | Payment terms catalogue (value-help data — low sensitivity). |
| `/ZPAYM_METHOD/PAYM_METHOD` | GET | Payment method catalogue (value-help data — low sensitivity). |

Eleven of the fourteen carry real business and financial data — vendor master records, full
purchase history, invoice amounts, invoicing schedules, and bank transfer references among
them; four of those eleven are **writes** (`VENDOR_CR`, `QUOT_UPDPR`, `zinv_plan/update`,
`zasset_po/create`). The remaining three are reference/catalogue data and lower risk, but are
included for a complete accounting of every endpoint this integration touches.

If this list is triaged rather than fixed wholesale, the two worth closing first are
`zasset_po/create` (creates purchase orders) and `zvendor_create/VENDOR_CR` (creates vendor
master records) — together they would let an unauthenticated caller invent a supplier and
then raise orders against it.

## What we are asking for

1. **Authentication enabled on all fourteen**, with a technical user (a service account, not a
   named individual's login) issued specifically to this integration, scoped to only what it
   needs.
2. **Confirmation of what these Z services can already do for company-code and date/document
   filtering** — several currently return a vendor's *entire* history with no way to narrow the
   request (see the related, separate performance/filtering asks tracked as GitHub issues
   #13, #20, and #69's ABAP write-up at `docs/abap-requests/zpo_grn_vendor-filters.md`) — worth
   settling in the same conversation as authentication, since it is the same set of services.
3. **A window to test this integration against the authenticated versions** before any tenant
   is promoted to a production connection — `validateConfig` (see the code change accompanying
   this document) now refuses to save a production connection with no credentials configured,
   but that only proves credentials are *present*, not that the endpoints actually enforce them
   or that this integration still works once they do.

## What is NOT being asked

Building new Z services, or changing what data these already return — only turning on
authentication for the fourteen that exist today, and answering the filtering questions
alongside it since Basis will already be in that code.
