-- CreateTable
CREATE TABLE "sap_sync_cursors" (
    "clientId" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "vendorCode" TEXT NOT NULL,
    "watermark" TIMESTAMP(3),
    "fingerprint" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "quietTicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sap_sync_cursors_pkey" PRIMARY KEY ("clientId","feed","vendorCode")
);

-- CreateIndex
CREATE INDEX "sap_sync_cursors_clientId_feed_idx" ON "sap_sync_cursors"("clientId", "feed");
