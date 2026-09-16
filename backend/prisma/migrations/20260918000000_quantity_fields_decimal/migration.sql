-- Issue #65: quantities move from double precision (Float) to a fixed-point
-- DECIMAL(13,3), matching SAP's own MENGE field type. Money already made
-- this move (see 20260907054607_money_fields_decimal) for the same reason:
-- binary floating point cannot represent most decimal fractions exactly, and
-- these values accumulate (a line's grnQuantity sums across however many
-- partial receipts it gets) and feed a tolerance comparison (the invoice
-- quantity-variance check) — 0.1 + 0.2 + 0.7 as Float is 0.9999999999999999,
-- not 1, which is exactly what made a fully-received line's
-- `grnQuantity >= quantity` false.
--
-- Postgres has a built-in assignment cast from double precision to numeric,
-- so ALTER COLUMN ... SET DATA TYPE needs no explicit USING clause here.

-- AlterTable
ALTER TABLE "rfq_items" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(13,3);

-- AlterTable
ALTER TABLE "purchase_order_items"
  ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(13,3),
  ALTER COLUMN "grnQuantity" SET DATA TYPE DECIMAL(13,3);

-- AlterTable
ALTER TABLE "asn_items" ALTER COLUMN "shippedQuantity" SET DATA TYPE DECIMAL(13,3);

-- AlterTable
ALTER TABLE "grn_items"
  ALTER COLUMN "receivedQuantity" SET DATA TYPE DECIMAL(13,3),
  ALTER COLUMN "acceptedQuantity" SET DATA TYPE DECIMAL(13,3),
  ALTER COLUMN "rejectedQuantity" SET DATA TYPE DECIMAL(13,3);

-- AlterTable
ALTER TABLE "invoice_items" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(13,3);
