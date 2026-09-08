/*
  Warnings:

  - The `status` column on the `asns` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `frequency` column on the `invoice_plans` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `invoices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `rfqs` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "asns" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Submitted';

-- AlterTable
ALTER TABLE "invoice_plans" DROP COLUMN "frequency",
ADD COLUMN     "frequency" TEXT;

-- AlterTable
ALTER TABLE "invoices" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Submitted';

-- AlterTable
ALTER TABLE "rfqs" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'Bidding Open';

-- DropEnum
DROP TYPE "AsnStatus";

-- DropEnum
DROP TYPE "InvoiceStatus";

-- DropEnum
DROP TYPE "PlanFrequency";

-- DropEnum
DROP TYPE "RfqStatus";

-- CreateIndex
CREATE INDEX "asns_clientId_status_idx" ON "asns"("clientId", "status");

-- CreateIndex
CREATE INDEX "invoices_clientId_status_idx" ON "invoices"("clientId", "status");

-- CreateIndex
CREATE INDEX "rfqs_clientId_status_idx" ON "rfqs"("clientId", "status");
