-- AlterTable
ALTER TABLE "asns" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "grns" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "sapDocNumber" TEXT,
ADD COLUMN     "sapSyncError" TEXT,
ADD COLUMN     "sapSyncState" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "sapSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "asns_clientId_sapSyncState_idx" ON "asns"("clientId", "sapSyncState");

-- CreateIndex
CREATE INDEX "grns_clientId_sapSyncState_idx" ON "grns"("clientId", "sapSyncState");

-- CreateIndex
CREATE INDEX "invoices_clientId_sapSyncState_idx" ON "invoices"("clientId", "sapSyncState");

-- CreateIndex
CREATE INDEX "payments_clientId_sapSyncState_idx" ON "payments"("clientId", "sapSyncState");

-- CreateIndex
CREATE INDEX "purchase_orders_clientId_sapSyncState_idx" ON "purchase_orders"("clientId", "sapSyncState");

-- CreateIndex
CREATE INDEX "rfqs_clientId_sapSyncState_idx" ON "rfqs"("clientId", "sapSyncState");

-- Backfill (Phase 3 of docs/04-sap-runtime-engineering-plan.md): every row
-- that already carries a real SAP document number in its typed correlation
-- field is `synced`, with that number copied into the new uniform
-- `sapDocNumber`. Everything else keeps the column default, `local`.
--
-- RFQ is untouched — sourcing has no SAP document number to have backfilled
-- (it is portal-internal by design; see the RFQ.sapSyncState comment in
-- schema.prisma), so every RFQ stays at the default.
UPDATE "purchase_orders" SET
  "sapDocNumber" = "sapPoNumber",
  "sapSyncState" = 'synced',
  "sapSyncedAt" = "updatedAt"
WHERE "sapPoNumber" IS NOT NULL;

-- A PurchaseOrder with no sapPoNumber yet is still meant to be matched
-- against SAP eventually (unlike an RFQ) — see the note on
-- PurchaseOrder.sapSyncState in schema.prisma — so it starts `pending`, not
-- `local`.
UPDATE "purchase_orders" SET "sapSyncState" = 'pending' WHERE "sapPoNumber" IS NULL;

UPDATE "grns" SET
  "sapDocNumber" = "sapMigoDoc",
  "sapSyncState" = 'synced',
  "sapSyncedAt" = "updatedAt"
WHERE "sapMigoDoc" IS NOT NULL;

UPDATE "invoices" SET
  "sapDocNumber" = "sapMiroDoc",
  "sapSyncState" = 'synced',
  "sapSyncedAt" = "updatedAt"
WHERE "sapMiroDoc" IS NOT NULL;

-- An invoice with no MIRO doc yet is awaiting a payment run, same reasoning
-- as an unmatched PurchaseOrder above.
UPDATE "invoices" SET "sapSyncState" = 'pending' WHERE "sapMiroDoc" IS NULL;

-- A Payment row is only ever created once SAP has actually cleared it
-- (jobs/handlers/awaitPaymentRun.js — there is no "pending" Payment), so
-- every existing row is synced; sapPaymentDoc (the F110 clearing document)
-- is its own identity, same field jobs/handlers/awaitPaymentRun.js writes
-- into sapDocNumber going forward.
UPDATE "payments" SET
  "sapDocNumber" = COALESCE("sapPaymentDoc", "sapMiroDoc"),
  "sapSyncState" = 'synced',
  "sapSyncedAt" = "updatedAt";

-- A GRN, likewise, is only ever created from a found goods receipt — every
-- existing row without a sapMigoDoc (should not happen, but the column was
-- always nullable) still counts as synced: its mere existence *is* the SAP
-- answer.
UPDATE "grns" SET "sapSyncState" = 'synced', "sapSyncedAt" = "updatedAt" WHERE "sapMigoDoc" IS NULL;

-- ASN has no pre-existing correlation field (sapInboundDelivery is always
-- null by design — the portal issues no inbound delivery, see the note in
-- sap/drivers/s4odata.driver.js). A Received shipment already has its GRN,
-- so it is synced with that GRN's document number; a still-Submitted one
-- has no in-flight watch under the old timer-based design and genuinely
-- needs one, so it starts pending rather than the honest-but-unhelpful
-- `local`.
UPDATE "asns" a SET
  "sapDocNumber" = g."sapMigoDoc",
  "sapSyncState" = 'synced',
  "sapSyncedAt" = g."updatedAt"
FROM "grns" g
WHERE g."asnId" = a."id" AND g."clientId" = a."clientId" AND a."status" = 'Received';

UPDATE "asns" SET "sapSyncState" = 'pending' WHERE "status" = 'Submitted';
