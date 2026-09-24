-- An RFQ SAP raised directly (ME41) carries no bid-deadline field on either
-- read that names it (ZME43/ME43, zpo_grn/Detail). Null means "no cutoff
-- enforced" — see the RFQ.deadlineDate comment in schema.prisma.
ALTER TABLE "rfqs" ALTER COLUMN "deadlineDate" DROP NOT NULL;
