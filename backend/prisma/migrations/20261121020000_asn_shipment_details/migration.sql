-- The rest of the shipment details screen (ASN design, screen V4).
-- AlterTable
ALTER TABLE "asns" ADD COLUMN "taxableValue" DECIMAL(14,2),
ADD COLUMN "ewayBillDate" TIMESTAMP(3),
ADD COLUMN "arrivalTime" TEXT,
ADD COLUMN "vehicleType" TEXT,
ADD COLUMN "driverMobile" TEXT,
ADD COLUMN "transporterGstin" TEXT,
ADD COLUMN "packages" INTEGER,
ADD COLUMN "grossWeightKg" DECIMAL(13,3);
