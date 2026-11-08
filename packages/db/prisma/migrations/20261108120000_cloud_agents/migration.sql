-- CreateEnum
CREATE TYPE "AgentEngine" AS ENUM ('CODEX', 'CLAUDE_CODE', 'OPENCODE', 'PI');

-- CreateEnum
CREATE TYPE "RunExecutionMode" AS ENUM ('IMPLEMENT', 'PLAN_AND_APPROVE');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'PROVISIONING', 'PLANNING', 'AWAITING_APPROVAL', 'IMPLEMENTING', 'VALIDATING', 'REVIEWING', 'PUBLISHING', 'COMPLETED', 'BLOCKED', 'LIMIT_REACHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Board" ADD COLUMN     "defaultRepository" TEXT;

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "repository" TEXT;

-- CreateTable
CREATE TABLE "OrganizationAgentConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "allowedRepositories" TEXT[],
    "defaultEngine" "AgentEngine",
    "defaultModel" TEXT,
    "defaultExecutionMode" "RunExecutionMode" NOT NULL DEFAULT 'IMPLEMENT',
    "runBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "dailyOrgBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "engine" "AgentEngine" NOT NULL,
    "model" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "executionMode" "RunExecutionMode" NOT NULL DEFAULT 'IMPLEMENT',
    "repository" TEXT NOT NULL,
    "baseCommit" TEXT,
    "branchName" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "activeIssueId" TEXT,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "owner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunApproval" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationAgentConfig_organizationId_key" ON "OrganizationAgentConfig"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_activeIssueId_key" ON "AgentRun"("activeIssueId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_organizationId_idempotencyKey_key" ON "AgentRun"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRun_issueId_idx" ON "AgentRun"("issueId");

-- CreateIndex
CREATE INDEX "AgentRun_organizationId_status_idx" ON "AgentRun"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_sequence_key" ON "RunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunEvent_runId_idx" ON "RunEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunApproval_runId_planVersion_key" ON "RunApproval"("runId", "planVersion");

-- CreateIndex
CREATE INDEX "RunApproval_runId_idx" ON "RunApproval"("runId");

-- AddForeignKey
ALTER TABLE "OrganizationAgentConfig" ADD CONSTRAINT "OrganizationAgentConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunApproval" ADD CONSTRAINT "RunApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunApproval" ADD CONSTRAINT "RunApproval_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
