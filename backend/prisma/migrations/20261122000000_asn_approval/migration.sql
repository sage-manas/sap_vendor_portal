-- The tenant admin's decision on a shipment notice.
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedBy" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "rejectedBy" TEXT,
ADD COLUMN "rejectionReason" TEXT;
