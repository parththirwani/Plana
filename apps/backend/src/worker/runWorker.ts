import { randomUUID } from "crypto";
import type { SandboxFactory } from "../adapters/fakeSandbox";
import { createFakeSandboxFactory } from "../adapters/fakeSandbox";
import type { EngineAdapterRegistry } from "../adapters/registry";
import { createFakeOnlyRegistry } from "../adapters/registry";
import { getJobStore } from "../jobs/jobStore";
import type { JobStore } from "../jobs/types";
import { claimRunLease, getRunById } from "../runs/runRepository";
import { prisma } from "@repo/db/db";
import { DEFAULT_LEASE_MS } from "../jobs/types";
import type { AgentRunRow } from "../runs/dbTypes";
import { isTerminalRunStatus } from "../runs/status";
import {
    dispatchExecute,
    dispatchMessage,
    type WorkerContext,
    type WorkerDeps,
} from "./executionFlows";

// Durable agent-run worker (CP5).
//
// The worker claims the SAME durable job types the HTTP layer enqueues
// (agent.run.execute / agent.run.message, see src/routers/agentRun.ts and
// src/runs/approvals.ts) from the injectable JobStore and drives the run
// lifecycle through the run repository. It performs NO HTTP, NO database
// polling and NO inline engine work outside the adapter contract.
//
// Safety properties enforced here (each covered by src/test/
// agent-run-worker.test.ts):
//   * a terminal run is NEVER touched — a claimed job for a
//     cancelled/failed/completed run completes as a no-op, so a late result
//     can neither revive the run nor publish through it;
//   * every engine step re-reads the run row, so a cancel landing mid-stream
//     stops the engine and blocks the publication intent;
//   * job completion is fencing-guarded: if the lease was reclaimed while we
//     worked, the outcome is reported with +lost-lease and the store rejects
//     the completion.

export const AGENT_JOB_TYPES = ["agent.run.execute", "agent.run.message"] as const;

export type WorkerOutcome = {
    jobId: string;
    jobType: string;
    runId: string | null;
    status: string;
    error?: string;
};

export type RunWorkerOptions = {
    store?: JobStore;
    registry?: EngineAdapterRegistry;
    sandboxes?: SandboxFactory;
    owner?: string;
    now?: () => string;
    afterEvent?: WorkerDeps["afterEvent"];
    /** Run-lease lifetime for one attempt. Long streams must renew it (see
     *  `renewRunLease`); a short value makes reclaim-after-stall cheap. */
    leaseMs?: number;
};

export const createRunWorker = (options: RunWorkerOptions = {}) => {
    const deps: WorkerDeps = {
        store: options.store ?? getJobStore(),
        // Fakes ONLY in this container (see adapters/registry.ts): the worker
        // cannot reach a real provider even by accident, and tests additionally
        // assert global fetch is untouched.
        registry: options.registry ?? createFakeOnlyRegistry(),
        sandboxes: options.sandboxes ?? createFakeSandboxFactory(),
        owner: options.owner ?? `agent-worker-${randomUUID().slice(0, 8)}`,
        now: options.now ?? (() => new Date().toISOString()),
        ...(options.afterEvent ? { afterEvent: options.afterEvent } : {}),
    };
    const ctx: WorkerContext = { deps, sessions: new Map() };
    /**
     * ACQUIRE THE RUN LEASE for one attempt.
     *
     * The queue claim only proves this worker holds the JOB; the run needs its
     * own single-writer lease, or every guarded transition would carry a fencing
     * token the row has never heard of. `claimRunLease` stamps
     * `owner`/`lease_expires_at` and raises `fencing_token` monotonically — it
     * changes NO status — so a reclaim by another live process fences this worker
     * out at its very next guarded write. That is the mechanism that stops a
     * zombie from moving a cancelled run or publishing through it: the queue's job
     * lease alone was never enough, because it says nothing about who may write
     * THIS run.
     */
    const bindOwnership = async (run: AgentRunRow) => {
        ctx.ownership = await claimRunLease(prisma, {
            runId: run.id,
            machineId: deps.owner,
            leaseTtlMillis: options.leaseMs ?? DEFAULT_LEASE_MS,
            expectedStatus: run.status,
        });
    };

    /** Claim and fully process one job; null when the queue is empty. */
    const runOnce = async (): Promise<WorkerOutcome | null> => {
        const claim = await deps.store.claimNext(deps.owner, deps.now(), {
            types: [...AGENT_JOB_TYPES],
        });
        if (!claim) return null;
        const { job, fencingToken } = claim;
        const base: Omit<WorkerOutcome, "status"> = {
            jobId: job.id,
            jobType: job.type,
            runId: job.runId,
        };

        let status: string;
        let error: string | undefined;
        try {
            if (!job.runId) {
                status = "ignored-no-run";
            } else {
                const run = await getRunById(job.runId);
                if (!run) {
                    status = "ignored-missing-run";
                } else if (isTerminalRunStatus(run.status)) {
                    // Terminal finality at the worker level: never mutate a
                    // finished run, never publish through it. The job itself
                    // completes as a no-op.
                    status = `ignored-terminal-run:${run.status}`;
                } else {
                    // Own the run BEFORE the first write; a live owner elsewhere
                    // raises STALE_CLAIM and the job is retried (never guessed).
                    await bindOwnership(run);
                    if (job.type === "agent.run.message") {
                        status = await dispatchMessage(ctx, run, job);
                    } else {
                        status = await dispatchExecute(ctx, run, job, {
                            jobId: job.id,
                            fencingToken,
                        });
                    }
                }
            }
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            console.error(`[agent-worker] job ${job.id} failed:`, error);
            const failed = await deps.store.fail(
                job.id,
                deps.owner,
                fencingToken,
                deps.now(),
                error
            );
            const outcomeStatus = failed ? "job-failed" : "job-failed-lost-lease";
            return { ...base, status: outcomeStatus, error };
        }

        const done = await deps.store.complete(
            job.id,
            deps.owner,
            fencingToken,
            deps.now()
        );
        if (!done) status = `${status}+lost-lease`;
        return { ...base, status, ...(error ? { error } : {}) };
    };

    const drain = async (max = 100): Promise<WorkerOutcome[]> => {
        const outcomes: WorkerOutcome[] = [];
        for (let i = 0; i < max; i += 1) {
            const outcome = await runOnce();
            if (!outcome) break;
            outcomes.push(outcome);
        }
        return outcomes;
    };

    return {
        owner: deps.owner,
        deps,
        ctx,
        runOnce,
        drain,
    };
};

export type RunWorker = ReturnType<typeof createRunWorker>;
