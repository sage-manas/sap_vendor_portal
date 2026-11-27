-- Issue #351. Two kinds of fact the portal used to assert without SAP saying so.

-- 1. Inspection. SAP's goods-receipt read carries no inspection result, but
--    every receipt recorded from it wrote acceptedQuantity = received and
--    rejectedQuantity = 0, so the screen showed "QC Passed". Null now means
--    "not inspected". Existing rows keep their values: which of them came
--    from SAP rather than a portal-side inspection is not recorded on the row.
ALTER TABLE "grn_items" ALTER COLUMN "acceptedQuantity" DROP NOT NULL;
ALTER TABLE "grn_items" ALTER COLUMN "rejectedQuantity" DROP NOT NULL;
ALTER TABLE "grn_items" ALTER COLUMN "rejectedQuantity" DROP DEFAULT;

-- 2. Payment details. paymentMethod was an NEFT/RTGS/IMPS enum defaulting to
--    NEFT: SAP's own method ('C', Cheque, on the live sandbox) could not be
--    stored at all, and a payment SAP reported no method for read as NEFT.
--    utrCode was required, but a cheque has none. Existing values carry over
--    as text.
ALTER TABLE "payments" ALTER COLUMN "paymentMethod" DROP DEFAULT;
ALTER TABLE "payments" ALTER COLUMN "paymentMethod" TYPE TEXT USING "paymentMethod"::TEXT;
ALTER TABLE "payments" ALTER COLUMN "paymentMethod" DROP NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "utrCode" DROP NOT NULL;
DROP TYPE "PaymentMethod";
