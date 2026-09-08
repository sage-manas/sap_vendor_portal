-- Currency amounts move from double precision (Float) to a fixed-point
-- DECIMAL(14,2) — see prisma/schema.prisma's field comments. Binary floating
-- point cannot represent most decimal fractions exactly (0.1 has no exact
-- binary representation), so a long enough sequence of money arithmetic —
-- summing invoice lines, applying 18% GST, deducting 1% TDS — drifts by a
-- paisa here and there. DECIMAL(14,2) stores exactly the value written, with
-- room up to 999,999,999,999.99 — far beyond anything this schema's amounts
-- reach.
--
-- Postgres has a built-in assignment cast from double precision to numeric,
-- so ALTER COLUMN ... SET DATA TYPE needs no explicit USING clause here; the
-- existing seed/test values in each column (verified via `prisma migrate
-- diff` before this file was written) cast cleanly.

-- AlterTable
ALTER TABLE "invoice_items" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "invoice_plan_lines" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "invoice_plans" ALTER COLUMN "periodicAmount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "subTotal" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "taxAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "grossAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "tdsDeducted" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "netAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "totalTds" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "purchase_order_items" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "netValue" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "rfq_bid_unit_prices" ALTER COLUMN "price" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "rfq_bids" ALTER COLUMN "freight" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "rfq_items" ALTER COLUMN "targetPrice" SET DATA TYPE DECIMAL(14,2);
