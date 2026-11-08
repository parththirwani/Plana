import type { Prisma } from "@repo/db/db";
import {toJsonInput} from "../runs/dbTypes";
import { enqueueInTransaction, jobRecord } from "./transactionalEnqueue";
import { createSerialLock } from "../lib/serialLock";
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

const ms = (iso: string) => Date.parse(iso);
const iso = (millis: number) => new Date(millis).toISOString();
const nowIso = () => new Date().toISOString();

const clone = (job: JobRecord): JobRecord => ({
    ...job,
    payload: structuredClone(job.payload),
});

// Sections (claim/renew/complete/fail/cancel) run as one critical section via
// the shared FIFO lock, mirroring how the Postgres store's single statements +
// FOR UPDATE SKIP LOCKED serialize concurrent workers. Callers may interleave
// `await`s freely; exactly one section mutates state at a time, in FIFO call
// order — so two concurrent claimNext calls can never win the same job.

export const createMemoryJobStore = (
    persistence?: Prisma.TransactionClient,
): JobStore => {
    let jobs: JobRecord[] = [];
    let idSeq = 0;
    const lock = createSerialLock();
    const load = async () => {
        if (persistence)
            jobs = (await persistence.agentJob.findMany({ where: {} })).map(
                jobRecord,
            );
    };
    const save = async (job: JobRecord) => {
        if (!persistence) return;
        const { id, createdAt, updatedAt, ...data } = job;
        await persistence.agentJob.update({
            where: { id },
            data: { ...data, payload: toJsonInput(data.payload) },
        });
    };

    const byId = (id: string) => jobs.find((j) => j.id === id) ?? null;

    // Lease/fencing guards identical in spirit to the Postgres WHERE clauses:
    // only the current RUNNING owner with the current token may mutate.
    const guarded = (
        jobId: string,
        owner: string,
        fencingToken: number,
        now: string,
    ): JobRecord | null => {
        const job = byId(jobId);
        if (!job) return null;
        if (
            job.status !== "RUNNING" ||
            job.lockedBy !== owner ||
            job.fencingToken !== fencingToken ||
            !job.leaseExpiresAt ||
            ms(job.leaseExpiresAt) <= ms(now)
        ) {
            return null;
        }
        return job;
    };

    const store: JobStore = {
        enqueue: (input: EnqueueInput,
            tx?: Prisma.TransactionClient,
        ): Promise<EnqueueResult> =>
            lock(async () => {
                if (tx || persistence)
                    return enqueueInTransaction((tx ?? persistence)!, input);
                // Simulated round-trip boundary: a naive
                // check-then-insert without the lock would race here.
                await Promise.resolve();
                if (input.idempotencyKey != null) {
                    const existing = jobs.find(
                        (j) => j.idempotencyKey === input.idempotencyKey,
                    );
                    if (existing) {
                        return { job: clone(existing), created: false };
                    }
                }
                const createdAt = nowIso();
                const job: JobRecord = {
                    id: `job_${++idSeq}`,
                    type: input.type,
                    runId: input.runId ?? null,
                    payload: structuredClone(input.payload ?? {}),
                    status: "QUEUED",
                    idempotencyKey: input.idempotencyKey ?? null,
                    attempts: 0,
                    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
                    availableAt: input.availableAt ?? createdAt,
                    lockedBy: null,
                    lockedAt: null,
                    leaseExpiresAt: null,
                    fencingToken: 0,
                    lastError: null,
                    createdAt,
                    updatedAt: createdAt,
                };
                jobs.push(job);
                return { job: clone(job), created: true };
            }),

        claimNext: (
            owner: string,
            now: string,
            opts: ClaimOptions = {},
        ): Promise<ClaimedJob | null> =>
            lock(async () => {
                // Two simulated round-trips (SELECT candidate ... FOR UPDATE,
                // then UPDATE ... RETURNING); other claimants wait behind the
                // SKIP LOCKED-equivalent critical section.
                await Promise.resolve();
                await Promise.resolve();
                await load();
                const nowMs = ms(now);
                for (const job of jobs) {
                    if (
                        job.status === "RUNNING" &&
                        job.leaseExpiresAt &&
                        ms(job.leaseExpiresAt) <= nowMs &&
                        job.attempts >= job.maxAttempts
                    ) {
                        job.status = "FAILED";
                        job.leaseExpiresAt = null;
                        job.lastError = "Lease expired after maximum attempts";
                        await save(job);
                    }
                }
                const types = opts.types;
                const candidates = jobs
                    .filter(
                        (j) =>
                            (j.status === "QUEUED" &&
                                ms(j.availableAt) <= nowMs) ||
                            (j.status === "RUNNING" &&
                                j.leaseExpiresAt !== null &&
                                ms(j.leaseExpiresAt) <= nowMs),
                    )
                    .filter((j) =>
                            j.attempts < j.maxAttempts &&
                            (!types || types.includes(j.type)),
                    )
                    .sort(
                        (a, b) =>
                            ms(a.availableAt) - ms(b.availableAt) ||
                            a.id.localeCompare(b.id),
                    );
                const job = candidates[0];
                if (!job) return null;
                const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
                job.status = "RUNNING";
                job.attempts += 1;
                job.lockedBy = owner;
                job.lockedAt = now;
                job.leaseExpiresAt = iso(ms(now) + leaseMs);
                job.fencingToken += 1;
                job.updatedAt = now;
                await save(job);
                return { job: clone(job), fencingToken: job.fencingToken };
            }),

        renewLease: (
            jobId: string,
            owner: string,
            fencingToken: number,
            now: string,
            leaseMs = DEFAULT_LEASE_MS,
        ): Promise<JobRecord | null> =>
            lock(async () => {
                await load();
                const job = guarded(jobId, owner, fencingToken, now);
                if (!job) return null;
                job.leaseExpiresAt = iso(ms(now) + leaseMs);
                job.updatedAt = now;
                await save(job);
                return clone(job);
            }),

        complete: (
            jobId: string,
            owner: string,
            fencingToken: number,
            now: string,
        ): Promise<JobRecord | null> =>
            lock(async () => {
                await load();
                const job = guarded(jobId, owner, fencingToken, now);
                if (!job) return null;
                job.status = "COMPLETED";
                job.leaseExpiresAt = null;
                job.lastError = null;
                job.updatedAt = now;
                await save(job);
                return clone(job);
            }),

        fail: (
            jobId: string,
            owner: string,
            fencingToken: number,
            now: string,
            error: string,
            retryAt?: string,
        ): Promise<JobRecord | null> =>
            lock(async () => {
                await load();
                const job = guarded(jobId, owner, fencingToken, now);
                if (!job) return null;
                job.lastError = error;
                job.leaseExpiresAt = null;
                job.updatedAt = now;
                if (job.attempts < job.maxAttempts) {
                    job.status = "QUEUED";
                    job.lockedBy = null;
                    job.lockedAt = null;
                    job.availableAt = retryAt ?? now;
                } else {
                    job.status = "FAILED";
                }
                await save(job);
                return clone(job);
            }),

        cancelQueued: (jobId: string, now: string): Promise<JobRecord | null> =>
            lock(async () => {
                await load();
                const job = byId(jobId);
                if (!job || job.status !== "QUEUED") return null;
                job.status = "CANCELLED";
                job.updatedAt = now;
                await save(job);
                return clone(job);
            }),

        defer: (jobId, owner, token, now, retryAt) =>
            lock(async () => {
                await load();
                const job = guarded(jobId, owner, token, now);
                if (!job) return null;
                Object.assign(job, {
                    status: "QUEUED",
                    attempts: Math.max(0, job.attempts - 1),
                    lockedBy: null,
                    lockedAt: null,
                    leaseExpiresAt: null,
                    availableAt: retryAt,
                    updatedAt: now,
                });
                await save(job);
                return clone(job);
            }),
        listFailed: async () => {
            await load();
            return jobs.filter((j) => j.status === "FAILED").map(clone);
        },

        get: async (jobId: string) => {
            await load();
            const job = byId(jobId);
            return job ? clone(job) : null;
        },

        findByIdempotencyKey: async (idempotencyKey: string) => {
            await load();
            const job = jobs.find((j) => j.idempotencyKey === idempotencyKey);
            return job ? clone(job) : null;
        },

        listByRun: async (runId: string) => {
            await load();
            return jobs
                .filter((j) => j.runId === runId)
                .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
                .map(clone);
        },
    };

    return store;
};
