-- A supplier can withdraw a shipment notice before its goods are received.
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelReason" TEXT;

-- What SAP's goods receipt recorded for each shipped line.
-- AlterTable
ALTER TABLE "asn_items" ADD COLUMN "receivedQuantity" DECIMAL(13,3);

-- The shipment a packing list / invoice copy / transport document belongs to.
-- AlterTable
ALTER TABLE "documents" ADD COLUMN "asnId" TEXT;

-- CreateIndex
CREATE INDEX "documents_clientId_asnId_idx" ON "documents"("clientId", "asnId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_clientId_asnId_fkey" FOREIGN KEY ("clientId", "asnId") REFERENCES "asns"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
