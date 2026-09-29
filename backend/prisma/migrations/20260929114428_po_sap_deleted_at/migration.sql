-- issue #73: the discovery sweep now marks a purchase order absent from a
-- fresh full-history read of SAP's vendor ledger, since that feed carries no
-- deletion flag of its own.
-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN "sapDeletedAt" TIMESTAMP(3);
