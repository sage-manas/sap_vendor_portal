-- Issue #313: service entry sheets SAP posted against a PO line, read from
-- zpo_grn_vendor/Detail's GRN[] rows that carry SSES_NO. NULL for every
-- existing row: none were stored before, and the next sweep fills them in.
ALTER TABLE "purchase_order_items" ADD COLUMN "serviceEntries" JSONB;
