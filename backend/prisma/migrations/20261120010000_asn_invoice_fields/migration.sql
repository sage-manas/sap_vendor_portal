-- The supplier's invoice travelling with a shipment: its date and GST-inclusive value
-- (the number already lives in "invoiceReference").
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "invoiceDate" TIMESTAMP(3),
ADD COLUMN "invoiceValue" DECIMAL(14,2);
