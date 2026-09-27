-- AlterTable: track consecutive failures for exponential backoff
ALTER TABLE "RecurringPaymentSchedule" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: immutable audit trail for system configuration changes
CREATE TABLE "AdminConfigAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorIp" TEXT,
    "userAgent" TEXT,
    "configVersion" INTEGER,
    "previousVersion" INTEGER,
    "changedKeys" TEXT,
    "diff" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminConfigAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminConfigAuditLog_action_idx" ON "AdminConfigAuditLog"("action");

-- CreateIndex
CREATE INDEX "AdminConfigAuditLog_actorId_idx" ON "AdminConfigAuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AdminConfigAuditLog_configVersion_idx" ON "AdminConfigAuditLog"("configVersion");

-- CreateIndex
CREATE INDEX "AdminConfigAuditLog_createdAt_idx" ON "AdminConfigAuditLog"("createdAt");
