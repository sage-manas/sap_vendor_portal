-- The lines SAP's inbound delivery was last given, so a change waiting for approval
-- can be sent to SAP once approved.
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "sapLines" JSONB;
