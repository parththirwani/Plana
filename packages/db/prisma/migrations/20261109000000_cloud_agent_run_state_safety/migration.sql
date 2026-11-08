-- Run-level state safety (CP-A / CP-B / CP-D).
--
-- What the run state machine needs in ORDER for a transition to be atomic and
-- cross-process safe, as database state rather than worker discipline:
--
--   * the first-attempt stamp (`attempted_at`), so a retry can tell "a claim
--     died mid-flight" from "this run was never started" and RESUME the
--     persisted step instead of replaying provisioning;
--   * a claim/reclaim scan index, so finding runs whose executing lease has
--     expired is not a table scan on the hot path;
--   * an append-only renewal trail, so ownership history is reconstructible
--     from the database alone.
--
-- Admission control ("at most one active run per issue") deliberately adds NO
-- table: the unique index on "AgentRun"."activeIssueId" that already exists is
-- the arbiter, and `pg_advisory_xact_lock(hashtextextended(issueId, 0))` in the
-- launch transaction is what serializes the decision. An advisory lock needs no
-- schema, is released by COMMIT/ROLLBACK, and cannot outlive a crashed process —
-- a table would have been a second source of truth to keep in step with the
-- first one.

-- AlterTable: when did a worker first start executing this run? A retry uses
-- `status != QUEUED AND attempted_at IS NULL` to recognise a run whose claim
-- died before it durably recorded its start (and must therefore RESUME the
-- persisted step rather than replay provisioning).
ALTER TABLE "AgentRun" ADD COLUMN     "attempted_at" TIMESTAMP(3);

-- Claim/reclaim scans: find runs whose executing lease has expired.
CREATE INDEX "AgentRun_status_leaseExpiresAt_idx" ON "AgentRun"("status", "leaseExpiresAt");

-- CreateTable: audit trail of accepted run-lease renewals. Each accepted
-- renewal writes one row in the SAME transaction that bumps
-- "AgentRun"."fencing_token", so ownership history is reconstructible from the
-- database alone (and a zombie's rejected renewal is provable by absence).
CREATE TABLE "run_lease_renewals" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "fencing_token" INTEGER NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_lease_renewals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_lease_renewals_run_id_created_at_idx" ON "run_lease_renewals"("run_id", "created_at");

-- AddForeignKey
ALTER TABLE "run_lease_renewals" ADD CONSTRAINT "run_lease_renewals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
