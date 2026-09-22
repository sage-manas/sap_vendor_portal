-- Asset procurement fields on a purchase order line (account assignment
-- category A), set only on lines of an order the portal raised in SAP through
-- zasset_po/create. See ADR-0042.
--
-- All five are nullable with no default and no backfill: a line awarded from an
-- RFQ or discovered through zpo_grn_vendor/Detail genuinely has none of them,
-- and NULL here means "not an asset line", not "unknown". Nothing existing is
-- rewritten by this migration.
--
-- materialCode is deliberately NOT made nullable. An asset line is text-only
-- (SHORT_TEXT, no MATNR) and stores '' — already what zpo_grn_vendor/Detail
-- returns for a text line and what sweepPurchaseOrders stores for one.

ALTER TABLE "purchase_order_items" ADD COLUMN "assetNumber" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "assetSubNumber" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "materialGroup" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "storageLocation" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN "taxCode" TEXT;
