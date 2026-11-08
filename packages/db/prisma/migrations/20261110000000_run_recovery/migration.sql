ALTER TABLE "AgentRun"
    ADD COLUMN "taskSnapshot" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "runtime" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "planContextHash" TEXT;
ALTER TABLE "RunApproval" ADD COLUMN "contextHash" TEXT NOT NULL DEFAULT '';
