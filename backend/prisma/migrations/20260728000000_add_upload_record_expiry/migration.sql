-- AlterTable: add isTemporary flag to support TTL expiry scheduler
ALTER TABLE "UploadRecord" ADD COLUMN "isTemporary" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex: composite index for efficient expiry queries
CREATE INDEX "UploadRecord_isTemporary_status_createdAt_idx" ON "UploadRecord"("isTemporary", "status", "createdAt");
