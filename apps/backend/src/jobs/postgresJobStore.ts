import {
    DEFAULT_LEASE_MS,
    DEFAULT_MAX_ATTEMPTS,
    type ClaimOptions,
    type ClaimedJob,
    type EnqueueInput,
    type EnqueueResult,
    type JobRecord,
    type JobStore,
} from "./types";

// Postgres-backed durable job repository over the "AgentJob" table.
//
// This is the production implementation of the JobStore contract. It cannot
// be exercised in this container (no Postgres), so its database-specific
// behavior is pinned by SQL-shape unit tests (src/test/agent-job-queue.test.ts)
// and must be validated against a live DB before release (owner checklist).
//
// The client interface matches `pg.Pool`/`pg.Client` so the store can also be
// bound to a transaction client (`store.withClient(txClient)`) to make a
// run-creation + job-enqueue atomic — HTTP handlers never run work inline.

export type JobSqlClient = {
    query: (
        sql: string,
        values?: unknown[]
    ) => Promise<{ rows: unknown[] }>;
};

export const ENQUEUE_SQL = `
INSERT INTO "AgentJob" (
    "id", "type", "runId", "payload", "status", "idempotencyKey",
    "attempts", "maxAttempts", "availableAt", "fencingToken",
    "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text, $1, $2, $3::jsonb, 'QUEUED', $4,
    0, $5, $6, 0, $7::timestamptz, $7::timestamptz
)
ON CONFLICT ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL DO NOTHING
RETURNING *;
`;

export const SELECT_BY_IDEMPOTENCY_SQL = `
SELECT * FROM "AgentJob" WHERE "idempotencyKey" = $1;
`;

// Claim = one atomic statement. The CTE SELECT takes the row lock with
// FOR UPDATE SKIP LOCKED so concurrent workers never hand out the same job;
// expired leases are eligible for reclaim; the fencing token strictly
// increases on every (re)claim so a zombie owner is fenced out downstream.
export const CLAIM_NEXT_SQL = `
WITH next AS (
    SELECT "id" FROM "AgentJob"
    WHERE (
            ("status" = 'QUEUED' AND "availableAt" <= $2::timestamptz)
            OR ("status" = 'RUNNING' AND "leaseExpiresAt" <= $2::timestamptz)
        )
        AND ($4::text[] IS NULL OR "type" = ANY($4::text[]))
    ORDER BY "availableAt" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE "AgentJob" j
SET "status" = 'RUNNING',
    "attempts" = j."attempts" + 1,
    "lockedBy" = $1,
    "lockedAt" = $2::timestamptz,
    "leaseExpiresAt" = $3::timestamptz,
    "fencingToken" = j."fencingToken" + 1,
    "updatedAt" = $2::timestamptz
FROM next
WHERE j."id" = next."id"
RETURNING j.*;
`;

export const RENEW_LEASE_SQL = `
UPDATE "AgentJob"
SET "leaseExpiresAt" = $4::timestamptz, "updatedAt" = $4::timestamptz
WHERE "id" = $1 AND "status" = 'RUNNING'
  AND "lockedBy" = $2 AND "fencingToken" = $3
RETURNING *;
`;

export const COMPLETE_SQL = `
UPDATE "AgentJob"
SET "status" = 'COMPLETED', "leaseExpiresAt" = NULL, "lastError" = NULL,
    "updatedAt" = $4::timestamptz
WHERE "id" = $1 AND "status" = 'RUNNING'
  AND "lockedBy" = $2 AND "fencingToken" = $3
RETURNING *;
`;

// attempts is incremented at claim time, so attempts >= maxAttempts means the
// last allowed try just failed -> terminal FAILED. Retried jobs re-enter the
// queue at retryAt (caller-provided backoff) and release the lease.
export const FAIL_SQL = `
UPDATE "AgentJob"
SET "status" = CASE WHEN "attempts" < "maxAttempts" THEN 'QUEUED' ELSE 'FAILED' END,
    "availableAt" = CASE
        WHEN "attempts" < "maxAttempts" THEN $6::timestamptz ELSE "availableAt"
    END,
    "lockedBy" = CASE
        WHEN "attempts" < "maxAttempts" THEN NULL ELSE "lockedBy"
    END,
    "lockedAt" = CASE
        WHEN "attempts" < "maxAttempts" THEN NULL ELSE "lockedAt"
    END,
    "leaseExpiresAt" = NULL,
    "lastError" = $4,
    "updatedAt" = $5::timestamptz
WHERE "id" = $1 AND "status" = 'RUNNING'
  AND "lockedBy" = $2 AND "fencingToken" = $3
RETURNING *;
`;

export const CANCEL_QUEUED_SQL = `
UPDATE "AgentJob"
SET "status" = 'CANCELLED', "updatedAt" = $2::timestamptz
WHERE "id" = $1 AND "status" = 'QUEUED'
RETURNING *;
`;

export const GET_JOB_SQL = `SELECT * FROM "AgentJob" WHERE "id" = $1;`;

export const LIST_BY_RUN_SQL = `
SELECT * FROM "AgentJob" WHERE "runId" = $1 ORDER BY "createdAt" ASC;
`;

const toIso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);

const mapRow = (row: any): JobRecord => ({
    id: row.id,
    type: row.type,
    runId: row.runId ?? null,
    payload:
        typeof row.payload === "string"
            ? JSON.parse(row.payload)
            : row.payload ?? {},
    status: row.status,
    idempotencyKey: row.idempotencyKey ?? null,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    availableAt: toIso(row.availableAt),
    lockedBy: row.lockedBy ?? null,
    lockedAt: row.lockedAt == null ? null : toIso(row.lockedAt),
    leaseExpiresAt:
        row.leaseExpiresAt == null ? null : toIso(row.leaseExpiresAt),
    fencingToken: Number(row.fencingToken),
    lastError: row.lastError ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
});

const single = (rows: unknown[]): JobRecord | null =>
    rows.length ? mapRow(rows[0]) : null;

export class PostgresJobStore implements JobStore {
    constructor(private readonly client: JobSqlClient) {}

    /** Bind the same repository to a transaction client (e.g. a checked-out
     *  pg Client inside BEGIN..COMMIT) so run creation + job enqueue commit
     *  atomically. Workers never need this; HTTP handlers do. */
    withClient(client: JobSqlClient): PostgresJobStore {
        return new PostgresJobStore(client);
    }

    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
        const now = new Date().toISOString();
        const availableAt = input.availableAt ?? now;
        const inserted = await this.client.query(ENQUEUE_SQL, [
            input.type,
            input.runId ?? null,
            JSON.stringify(input.payload ?? {}),
            input.idempotencyKey ?? null,
            input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            availableAt,
            now,
        ]);
        const created = single(inserted.rows);
        if (created) return { job: created, created: true };
        if (input.idempotencyKey != null) {
            const existing = await this.client.query(
                SELECT_BY_IDEMPOTENCY_SQL,
                [input.idempotencyKey]
            );
            const job = single(existing.rows);
            if (job) return { job, created: false };
        }
        throw new Error(
            `job enqueue conflict for key ${input.idempotencyKey ?? "?"}`
        );
    }

    async claimNext(
        owner: string,
        now: string,
        opts: ClaimOptions = {}
    ): Promise<ClaimedJob | null> {
        const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
        const result = await this.client.query(CLAIM_NEXT_SQL, [
            owner,
            now,
            new Date(Date.parse(now) + leaseMs).toISOString(),
            opts.types ?? null,
        ]);
        const job = single(result.rows);
        return job ? { job, fencingToken: job.fencingToken } : null;
    }

    private async mutate(
        sql: string,
        values: unknown[]
    ): Promise<JobRecord | null> {
        const result = await this.client.query(sql, values);
        return single(result.rows);
    }

    renewLease(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
        leaseMs = DEFAULT_LEASE_MS
    ): Promise<JobRecord | null> {
        return this.mutate(RENEW_LEASE_SQL, [
            jobId,
            owner,
            fencingToken,
            new Date(Date.parse(now) + leaseMs).toISOString(),
        ]);
    }

    complete(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string
    ): Promise<JobRecord | null> {
        return this.mutate(COMPLETE_SQL, [jobId, owner, fencingToken, now]);
    }

    fail(
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
        error: string,
        retryAt?: string
    ): Promise<JobRecord | null> {
        return this.mutate(FAIL_SQL, [
            jobId,
            owner,
            fencingToken,
            error,
            now,
            retryAt ?? now,
        ]);
    }

    cancelQueued(jobId: string, now: string): Promise<JobRecord | null> {
        return this.mutate(CANCEL_QUEUED_SQL, [jobId, now]);
    }

    async get(jobId: string): Promise<JobRecord | null> {
        const result = await this.client.query(GET_JOB_SQL, [jobId]);
        return single(result.rows);
    }

    async findByIdempotencyKey(
        idempotencyKey: string
    ): Promise<JobRecord | null> {
        const result = await this.client.query(SELECT_BY_IDEMPOTENCY_SQL, [
            idempotencyKey,
        ]);
        return single(result.rows);
    }

    async listByRun(runId: string): Promise<JobRecord[]> {
        const result = await this.client.query(LIST_BY_RUN_SQL, [runId]);
        return result.rows.map((row) => mapRow(row));
    }
}

export const createPostgresJobStore = (client: JobSqlClient) =>
    new PostgresJobStore(client);
