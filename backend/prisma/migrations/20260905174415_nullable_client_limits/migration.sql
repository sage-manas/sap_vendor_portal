-- AlterTable
ALTER TABLE "clients" ALTER COLUMN "limitVendors" DROP NOT NULL,
ALTER COLUMN "limitRfqsPerMonth" DROP NOT NULL,
ALTER COLUMN "limitStorageMb" DROP NOT NULL;
