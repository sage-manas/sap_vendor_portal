-- A goods receipt SAP posted with no portal ASN behind it has no shipment to point at.
-- AlterTable
ALTER TABLE "grns" ALTER COLUMN "asnId" DROP NOT NULL;
