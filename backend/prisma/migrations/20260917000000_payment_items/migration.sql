-- Issue #63: Payment was 1:1 with Invoice, so an F110 run settling several
-- invoices under one clearing document could not be represented — it either
-- got split into fabricated payments, or invoices silently never showed as
-- paid. Payment becomes a header (the remittance itself); PaymentItem is the
-- new child table carrying everything that used to be 1:1 on Payment.

-- CreateTable
CREATE TABLE "payment_items" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "paymentPk" UUID NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "sapMiroDoc" TEXT,
    "grossAmount" DECIMAL(14,2),
    "tdsDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "payment_items_pkey" PRIMARY KEY ("pk")
);

-- Carry every existing Payment row's per-invoice data into its own item
-- before the columns it came from are dropped below — a payment already on
-- file must not lose which invoice, amount or MIRO document it settled.
INSERT INTO "payment_items" ("pk", "clientId", "paymentPk", "invoiceId", "poId", "invoiceNumber", "sapMiroDoc", "grossAmount", "tdsDeducted", "netAmount")
SELECT gen_random_uuid(), "clientId", "pk", "invoiceId", "poId", "invoiceNumber", "sapMiroDoc", "grossAmount", "tdsDeducted", "netAmount"
FROM "payments";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_clientId_invoiceId_fkey";
ALTER TABLE "payments" DROP CONSTRAINT "payments_clientId_poId_fkey";

-- DropIndex
DROP INDEX "payments_clientId_invoiceId_idx";

-- AlterTable: the per-invoice columns above all moved to payment_items.
ALTER TABLE "payments"
  DROP COLUMN "invoiceId",
  DROP COLUMN "poId",
  DROP COLUMN "invoiceRef",
  DROP COLUMN "invoiceNumber",
  DROP COLUMN "sapMiroDoc";

-- CreateIndex — the clearing document is the natural key a find-or-create
-- upserts a Payment header by (see jobs/handlers/awaitPaymentRun.js); NULLs
-- (a payment recorded with no known clearing document) are not deduplicated
-- against each other, same as every other nullable unique column here.
CREATE UNIQUE INDEX "payments_clientId_sapPaymentDoc_key" ON "payments"("clientId", "sapPaymentDoc");

-- CreateIndex
CREATE INDEX "payment_items_clientId_invoiceId_idx" ON "payment_items"("clientId", "invoiceId");
CREATE UNIQUE INDEX "payment_items_paymentPk_invoiceId_key" ON "payment_items"("paymentPk", "invoiceId");

-- AddForeignKey
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_paymentPk_fkey" FOREIGN KEY ("paymentPk") REFERENCES "payments"("pk") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_clientId_invoiceId_fkey" FOREIGN KEY ("clientId", "invoiceId") REFERENCES "invoices"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_items" ADD CONSTRAINT "payment_items_clientId_poId_fkey" FOREIGN KEY ("clientId", "poId") REFERENCES "purchase_orders"("clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
