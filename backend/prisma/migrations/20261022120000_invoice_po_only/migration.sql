-- An invoice SAP posted against a purchase order with no goods receipt behind
-- it has no receipt to point at, and never will.
--
-- 20260904102238_append_only_and_checks made grnId/invoicePlanRef an XOR —
-- exactly one — on the reading that every invoice bills either a specific
-- receipt or a specific invoicing-plan date. A portal-side submission always
-- did name one, but invoice creation was removed from the portal (a9fe9ac):
-- an Invoice row now only ever comes from jobs/handlers/sweepInvoices.js
-- discovering a MIRO document AP has already posted, and AP may post one
-- straight against the PO whenever the vendor master has GR-based invoice
-- verification off (`Vendor.grBasedInvoiceVerification`, false by default
-- here). Found against a live sandbox doing exactly that: MIRO 5105609771 on
-- PO 4500022838, one line, invoiced qty 10, zero GRNs.
--
-- Under the XOR the sweep could create no row for it at all, so the document
-- stayed invisible to the supplier and was silently rediscovered on every
-- tick (issue #300, part b; part a shipped in #301).
--
-- The invariant that still holds — and all this ever needed to say — is that
-- a receipt and a plan date are mutually exclusive, not that one must be
-- present. `poId` is already NOT NULL, so every invoice remains anchored to
-- a purchase order.
ALTER TABLE "invoices" DROP CONSTRAINT "invoice_grn_xor_plan_ref";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoice_grn_nand_plan_ref"
  CHECK (NOT ("grnId" IS NOT NULL AND "invoicePlanRef" IS NOT NULL));
