-- A shipment can carry lines from several orders for one plant. Each line now names its
-- own order; every existing line belongs to its shipment's single order.
-- AlterTable
ALTER TABLE "asn_items" ADD COLUMN "poId" TEXT;

UPDATE "asn_items" ai SET "poId" = a."poId" FROM "asns" a WHERE a.pk = ai."asnPk";

ALTER TABLE "asn_items" ALTER COLUMN "poId" SET NOT NULL;

-- The receiving plant the shipment's lines share.
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "plant" TEXT;

-- CreateIndex
CREATE INDEX "asn_items_clientId_poId_idx" ON "asn_items"("clientId", "poId");

-- AddForeignKey
ALTER TABLE "asn_items" ADD CONSTRAINT "asn_items_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
