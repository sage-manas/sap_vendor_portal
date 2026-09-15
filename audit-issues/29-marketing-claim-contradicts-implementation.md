<!-- title: DOCS: the product one-pager claims zero SAP re-keying, but accounts payable must key every invoice into MIRO by hand -->
<!-- labels: documentation,severity:medium,integrity -->

**Severity:** Medium — an external-facing claim the implementation does not support.

## Summary

`product-info-vendor-portal.md`, written for the uvira.ai landing page, leads with
*"One portal. Every supplier. Zero SAP re-keying."*

The implementation does not eliminate re-keying on the invoice path. The SAP adapter
contract is explicit that the portal does not post invoices:

> "There is no invoiceCreate either, and deliberately so: MIRO is invoice verification, an
> AP clerk's transaction against the buyer's own books… The portal collects the invoice; AP
> posts it in SAP on their own schedule"

So the actual flow is: supplier submits in the portal → an AP clerk keys it into MIRO → the
portal then tries to recognise its own invoice in SAP's ledger by matching on purchase order
and gross amount.

The same applies to shipments: there is no `deliveryCreate`, so an ASN does not become an
inbound delivery in SAP.

The architectural decision is defensible and honestly documented in the code. The marketing
claim is the part that does not match.

## Evidence

`product-info-vendor-portal.md:12` — the tagline.

`backend/sap/contract.js:147-155` — the contract's own explanation.

`backend/sap/contract.js:139-145` — the same for deliveries.

`backend/sap/drivers/s4odata.driver.js:1080-1082` — even PO acknowledgement writes nothing
unless an extension field is configured, and it is not configured by default:
```js
logger.warn('[sap:s4_odata] poAcknowledge: no config.fields.poAcknowledgeField set — recording locally only, nothing written to SAP');
```

## Expected

Public claims match what the system does. Either the copy changes, or the capability is
built.

## Suggested fix

Pick one deliberately, as a business decision:

1. **Change the copy.** The honest version is still strong: suppliers self-serve, AP stops
   chasing documents, the portal reconciles automatically against SAP. "Zero re-keying"
   becomes something like "your suppliers stop emailing PDFs".
2. **Build the capability.** Posting supplier invoices into SAP needs either an invoice
   management product (OpenText VIM or similar) or an inbound IDoc/`INVOIC` path — an ABAP
   and licensing conversation, not a portal change.

Whichever is chosen, record it so the sales conversation and the roadmap agree.

## Acceptance criteria

- [ ] The one-pager's claims are each traceable to an implemented capability.
- [ ] The decision between (1) and (2) is recorded as an ADR.
- [ ] If (2), the ABAP/licensing requirement is scoped before it is sold.
