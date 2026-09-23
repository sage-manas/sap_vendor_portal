-- A supplier-proposed invoicing-plan change, awaiting the buying
-- organisation's approval. See the InvoicePlan.pendingChange comment in
-- schema.prisma for the shape and why it is stored raw.
ALTER TABLE "invoice_plans" ADD COLUMN "pendingChange" JSONB;
