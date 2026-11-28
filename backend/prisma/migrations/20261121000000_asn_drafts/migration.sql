-- A shipment notice the supplier has started and not submitted. It has no ASN number.
-- CreateTable
CREATE TABLE "asn_drafts" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "poId" TEXT,
    "step" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asn_drafts_pkey" PRIMARY KEY ("pk")
);

-- CreateIndex
CREATE INDEX "asn_drafts_clientId_vendorId_idx" ON "asn_drafts"("clientId", "vendorId");
