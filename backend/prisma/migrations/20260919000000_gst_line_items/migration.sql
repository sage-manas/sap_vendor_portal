-- Issue #66: GST was modelled as one header taxCode and one taxAmount, with
-- no CGST/SGST/IGST split, no HSN/SAC per line and no place of supply — for
-- an India-focused portal that otherwise models GSTIN/PAN/CIN/MSME/TDS
-- section/TAN/fiscal quarters in real detail. Tax moves to InvoiceItem,
-- where a real GST return is filed from; Invoice gains placeOfSupply and
-- reverseCharge; Client gains the buyer's own gstin/state, needed to derive
-- placeOfSupply and tell intra-state (CGST+SGST) apart from inter-state
-- (IGST) at all.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN "gstin" TEXT,
ADD COLUMN "state" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "placeOfSupply" TEXT,
ADD COLUMN "reverseCharge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN "hsnCode" TEXT,
ADD COLUMN "gstRate" DECIMAL(5,2),
ADD COLUMN "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "cessAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;
