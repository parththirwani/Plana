import type { Prisma } from "@repo/db/db";
// Durable job queue contract (CP2).
//
// The queue is the scheduling backbone for agent runs: HTTP handlers only ever
// enqueue jobs transactionally; workers claim them with FOR UPDATE SKIP LOCKED
// semantics, hold expiring leases, and fence every mutation with a strictly
// increasing per-job fencing token so a zombie worker can never mutate or
// publish work it no longer owns.
//
// Two implementations of this contract exist:
//   - MemoryJobStore  (jobs/memoryJobStore.ts)  — the same semantics in memory;
//     this is what the test-suite (and dev without a DB) drives.
//   - PostgresJobStore (jobs/postgresJobStore.ts) — FOR UPDATE SKIP LOCKED +
//     leases + fencing against the "AgentJob" table. The SQL is pinned by
//     shape tests and the real-PostgreSQL foundation integration suite.

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type JobRecord = {
    id: string;
    type: string;
    runId: string | null;
    payload: Record<string, unknown>;
    status: JobStatus;
    idempotencyKey: string | null;
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    lockedBy: string | null;
    lockedAt: string | null;
    leaseExpiresAt: string | null;
    fencingToken: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
};

export type EnqueueInput = {
    type: string;
    runId?: string | null;
    payload?: Record<string, unknown>;
    idempotencyKey?: string | null;
    availableAt?: string;
    maxAttempts?: number;
};

export type EnqueueResult = { job: JobRecord; created: boolean };

export type ClaimOptions = {
    types?: string[];
    leaseMs?: number;
};

export type ClaimedJob = { job: JobRecord; fencingToken: number };

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

// All timestamps are ISO strings; every mutating method takes an explicit
// `now` so the semantics are deterministic and testable without wall clocks.
export interface JobStore {
    close?(): Promise<void>;
    /** Idempotent on idempotencyKey: a duplicate enqueue is a no-op that
     *  returns the existing job with created=false. */
    enqueue(input: EnqueueInput,
        tx?: Prisma.TransactionClient,
    ): Promise<EnqueueResult>;
    /** Atomically claim the earliest-available QUEUED job (or one whose lease
     *  has expired), assigning a strictly-increasing fencing token. */
    claimNext(
        owner: string,
        now: string,
        opts?: ClaimOptions,
    ): Promise<ClaimedJob | null>;
    /** Extend the lease. Returns null (no-op) unless owner+fencing still match
     *  a RUNNING job — a stale token can never extend anything. */
    renewLease(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
        leaseMs?: number,
    ): Promise<JobRecord | null>;
    /** Mark the job COMPLETED. Guarded by owner+fencing; null = lost lease. */
    complete(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
    ): Promise<JobRecord | null>;
    /** Record a failure. Retries (status back to QUEUED at retryAt) while
     *  attempts < maxAttempts, otherwise terminal FAILED. Guarded by
     *  owner+fencing. */
    fail(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
        error: string,
        retryAt?: string,
    ): Promise<JobRecord | null>;
    /** Cancel a job that has not started. Only QUEUED jobs are cancelled;
     *  RUNNING jobs must be driven to fail()/complete() by their fenced owner
     *  (run-level cancellation is a CP5 concern). Returns null when the job is
     *  not in QUEUED. */
    cancelQueued(jobId: string, now: string): Promise<JobRecord | null>;
    defer(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
        retryAt: string,
    ): Promise<JobRecord | null>;
    listFailed(): Promise<JobRecord[]>;
    get(jobId: string): Promise<JobRecord | null>;
    findByIdempotencyKey(idempotencyKey: string): Promise<JobRecord | null>;
    listByRun(runId: string): Promise<JobRecord[]>;
}
