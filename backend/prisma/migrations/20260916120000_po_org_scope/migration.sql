-- Issue #62: PurchaseOrder carried no company code, purchasing organisation,
-- purchasing group or document type — every SAP read was keyed on the
-- vendor code alone, so a vendor trading with several company codes had all
-- of their orders pulled into whichever single tenant asked, regardless of
-- entity. None of the four get a default: an unset value here means
-- genuinely unknown, never a silently-assumed '1000'.
ALTER TABLE "purchase_orders" ADD COLUMN "companyCode" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "purchasingOrg" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "purchasingGroup" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "docType" TEXT;

-- Plant moves from the PO header to the line item: a multi-line order can
-- span more than one plant, and the header value used to be guessed from
-- items[0] both at award time and at SAP discovery time.
ALTER TABLE "purchase_order_items" ADD COLUMN "plant" TEXT;
ALTER TABLE "purchase_orders" DROP COLUMN "plant";
