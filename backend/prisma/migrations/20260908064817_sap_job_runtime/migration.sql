-- CreateTable
CREATE TABLE "sap_jobs" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 240,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sap_jobs_pkey" PRIMARY KEY ("pk")
);

-- CreateTable
CREATE TABLE "sap_schedules" (
    "pk" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sap_schedules_pkey" PRIMARY KEY ("pk")
);

-- CreateIndex
CREATE UNIQUE INDEX "sap_jobs_dedupeKey_key" ON "sap_jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "sap_jobs_status_runAt_idx" ON "sap_jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "sap_jobs_clientId_kind_status_idx" ON "sap_jobs"("clientId", "kind", "status");

-- CreateIndex
CREATE INDEX "sap_jobs_status_lockedAt_idx" ON "sap_jobs"("status", "lockedAt");

-- CreateIndex
CREATE INDEX "sap_schedules_enabled_nextRunAt_idx" ON "sap_schedules"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "sap_schedules_clientId_kind_key" ON "sap_schedules"("clientId", "kind");
