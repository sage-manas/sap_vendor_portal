-- Issue #347: the S/4 driver used to read ME43's item netPrice as the RFQ
-- item's target price. That price is the vendor's own quotation (ME47, which
-- submitBid writes), so SAP-origin RFQs showed a supplier its own earlier
-- quote as the buyer's target. SAP's RFQ has no target price at all, so clear
-- it on every SAP-origin RFQ item. Only sweepQuotations sets rfqs.sapDocNumber,
-- so portal-created RFQs (with a buyer-entered target price) are untouched.
UPDATE "rfq_items" AS i
SET "targetPrice" = NULL
FROM "rfqs" AS r
WHERE i."rfqPk" = r."pk"
  AND r."sapDocNumber" IS NOT NULL
  AND i."targetPrice" IS NOT NULL;
