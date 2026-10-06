-- Issue #125. RFQ.purchasingOrg, RFQ.companyCode and rfq_items.plant each
-- carried a '1000' default -- SAP's IDES demo value, not this project's
-- sandbox (which uses SSDN). So every RFQ read "Org: 1000" whether or not
-- anyone had chosen it, and because awardBid carries the RFQ's scope onto the
-- purchase order it creates, the default the PO refuses to invent for itself
-- (issue #62) arrived through the RFQ anyway.
--
-- Three changes per column: drop the default, and drop NOT NULL so "nobody
-- said" is representable at all.
--
-- Existing rows are deliberately LEFT AS THEY ARE. Nulling a literal '1000'
-- would be safe only if no tenant genuinely uses that purchasing
-- organisation, and this migration cannot know that -- '1000' is a perfectly
-- real EKORG in plenty of SAP systems, which is exactly why the demo default
-- was indistinguishable from a chosen value. A tenant that wants its historic
-- rows cleared can do it knowingly; guessing on their behalf here would be
-- the same class of mistake as the default itself.

ALTER TABLE "rfqs" ALTER COLUMN "purchasingOrg" DROP DEFAULT;
ALTER TABLE "rfqs" ALTER COLUMN "purchasingOrg" DROP NOT NULL;

ALTER TABLE "rfqs" ALTER COLUMN "companyCode" DROP DEFAULT;
ALTER TABLE "rfqs" ALTER COLUMN "companyCode" DROP NOT NULL;

ALTER TABLE "rfq_items" ALTER COLUMN "plant" DROP DEFAULT;
ALTER TABLE "rfq_items" ALTER COLUMN "plant" DROP NOT NULL;
