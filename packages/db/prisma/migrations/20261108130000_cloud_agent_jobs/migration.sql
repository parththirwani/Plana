-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AgentJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "runId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentJob_idempotencyKey_key" ON "AgentJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentJob_status_availableAt_idx" ON "AgentJob"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AgentJob_runId_idx" ON "AgentJob"("runId");

-- AddForeignKey
ALTER TABLE "AgentJob" ADD CONSTRAINT "AgentJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
