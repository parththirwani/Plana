import { toJsonInput } from "../runs/dbTypes";
import { createSerialLock } from "../lib/serialLock";
import { EngineError } from "../adapters/contract";
import { randomUUID } from "crypto";
import { prisma } from "@repo/db/db";
import { getJobStore } from "../jobs/jobStore";
import type { JobStore } from "../jobs/types";
import { DEFAULT_LEASE_MS } from "../jobs/types";
import {
    createFakeOnlyRegistry,
    type EngineAdapterRegistry,
} from "../adapters/registry";
import { createFakeSandboxFactory } from "../adapters/fakeSandbox";
import type { SandboxFactory } from "../adapters/contract";
import {
    claimRunLease,
    getRunById,
    renewRunLease,
    transitionRun,
} from "../runs/runRepository";
import { RunError } from "../runs/errors";
import { isTerminalRunStatus } from "../runs/status";
import { readRuntime, saveRuntime } from "./runtime";
import {
    fakeChecks,
    fakePublisher,
    type Checks,
    type Publisher,
} from "./services";
import {
    cleanupRun,
    dispatchExecute,
    dispatchMessage,
    type WorkerDeps,
    type WorkerContext,
} from "./executionFlows";

export const AGENT_JOB_TYPES = [
    "agent.run.execute",
    "agent.run.message",
    "agent.run.cleanup",
] as const;

export type WorkerOutcome = {
    jobId: string;
    jobType: string;
    runId: string | null;
    status: string;
    error?: string;
};

export type RunWorkerOptions = {
    signal?: AbortSignal;
    store?: JobStore;
    registry?: EngineAdapterRegistry;
    sandboxes?: SandboxFactory;
    checks?: Checks;
    publisher?: Publisher;
    owner?: string;
    now?: () => string;
    afterEvent?: WorkerDeps["afterEvent"];
    leaseMs?: number;
};

export const createRunWorker = (options: RunWorkerOptions = {}) => {
    if (
        process.env.AGENT_EXECUTION_MODE !== "fake" &&
        (!options.registry ||
            !options.sandboxes ||
            !options.checks ||
            !options.publisher)
    )
        throw new Error(
            "Agent execution is disabled: explicitly select fake mode or provide qualified engine, sandbox, checks and publisher implementations",
        );
    const deps: WorkerDeps = {
        store: options.store ?? getJobStore(),
        registry: options.registry ?? createFakeOnlyRegistry(),
        sandboxes: options.sandboxes ?? createFakeSandboxFactory(),
        checks: options.checks ?? fakeChecks,
        publisher: options.publisher ?? fakePublisher,
        owner: options.owner ?? `worker-${randomUUID()}`,
        now: options.now ?? (() => new Date().toISOString()),
        afterEvent: options.afterEvent,
    };
    const sessions = new Map<
        string,
        import("./executionFlows").RunSessionRef
    >();
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (leaseMs < 30) throw new Error("leaseMs must be at least 30ms");
    const intervalMs = Math.max(5, Math.min(15_000, Math.floor(leaseMs / 3)));
    const release = async (
        runId: string,
        claim: import("../runs/stateMachine").RunOwnership,
    ) => {
        await prisma.agentRun.updateMany({
            where: {
                id: runId,
                owner: claim.machineId,
                fencingToken: claim.fencingToken,
            },
            data: { owner: null, leaseExpiresAt: null },
        });
    };
    const reconcileFailures = async () => {
        for (const job of await deps.store.listFailed()) {
            if (!job.runId || job.type === "agent.run.cleanup") continue;
            const run = await getRunById(job.runId);
            if (!run || isTerminalRunStatus(run.status)) continue;
            const runtime = readRuntime(run);
            if (runtime.handledFailures.includes(job.id)) continue;
            let claim;
            try {
                claim = await prisma.$transaction((tx) =>
                    claimRunLease(tx, {
                        runId: run.id,
                        machineId: `${deps.owner}:reconcile:${randomUUID()}`,
                        expectedStatus: run.status,
                        leaseTtlMillis: leaseMs,
                    }),
                );
                runtime.handledFailures.push(job.id);
                if (
                    run.status !== "BLOCKED" &&
                    run.status !== "LIMIT_REACHED"
                ) {
                    runtime.pausedFrom = run.status;
                    await transitionRun({
                        runId: run.id,
                        expectedFrom: run.status,
                        to: "BLOCKED",
                        claim,
                        commit: { runtime: toJsonInput(runtime) },
                        data: { error: job.lastError, exhaustedJobId: job.id },
                    });
                } else await saveRuntime(run.id, runtime, claim);
            } catch (error) {
                if (!(
                    error instanceof RunError && error.code === "STALE_CLAIM"
                ))
                    throw error;
            } finally {
                if (claim) await release(run.id, claim);
            }
        }
    };
    const runOnce = async (): Promise<WorkerOutcome | null> => {
        await reconcileFailures();
        const claimed = await deps.store.claimNext(deps.owner, deps.now(), {
            types: [...AGENT_JOB_TYPES],
            leaseMs,
        });
        if (!claimed) {
            await reconcileFailures();
            return null;
        }
        const { job, fencingToken } = claimed;
        const base = {
            jobId: job.id,
            jobType: job.type,
            runId: job.runId,
        };
        const controller = new AbortController();
        const stop = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", stop, { once: true });
        if (options.signal?.aborted) stop();
        let ctx: WorkerContext | undefined;
        let timer: ReturnType<typeof setInterval> | undefined;
        let heartbeat = Promise.resolve();
        try {
            const run = job.runId ? await getRunById(job.runId) : null;
            if (
                !run ||
                (isTerminalRunStatus(run.status) &&
                    job.type !== "agent.run.cleanup")
            ) {
                const done = await deps.store.complete(
                    job.id,
                    deps.owner,
                    fencingToken,
                    deps.now(),
                );
                return {
                    ...base,
                    status: `ignored-terminal-run:${run?.status ?? "missing"}${done ? "" : "+lost-lease"}`,
                };
            }
            const ownership = await prisma.$transaction((tx) =>
                claimRunLease(tx, {
                    runId: run.id,
                    machineId: `${deps.owner}:${job.id}:${fencingToken}:${randomUUID()}`,
                    expectedStatus: run.status,
                    leaseTtlMillis: leaseMs,
                }),
            );
            Object.assign(ownership, {
                jobId: job.id,
                jobOwner: deps.owner,
                jobFencingToken: fencingToken,
            });
            ctx = {
                deps,
                sessions,
                ownership,
                signal: controller.signal,
                appliedInputs: new Set(),
                withInputs: createSerialLock(),
            };
            const current = ctx;
            timer = setInterval(() => {
                heartbeat = heartbeat
                    .then(async () => {
                        if (controller.signal.aborted) return;
                        const row = await getRunById(run.id);
                        if (
                            !row ||
                            (row.status === "CANCELLED" &&
                                job.type !== "agent.run.cleanup")
                        ) {
                            controller.abort(
                                new RunError("TERMINAL_STATE", "Run cancelled"),
                            );
                            return;
                        }
                        const renewed = await prisma.$transaction((tx) =>
                            renewRunLease(tx, {
                                runId: run.id,
                                claim: ownership,
                                leaseTtlMillis: leaseMs,
                                reason: "worker heartbeat",
                            }),
                        );
                        const queueLease = await deps.store.renewLease(
                            job.id,
                            deps.owner,
                            fencingToken,
                            deps.now(),
                            leaseMs,
                        );
                        if (!renewed || !queueLease)
                            controller.abort(
                                new RunError(
                                    "STALE_CLAIM",
                                    "Run or queue ownership lost",
                                ),
                            );
                        else await current.onHeartbeat?.();
                    })
                    .catch((error) => controller.abort(error));
            }, intervalMs);
            let status =
                job.type === "agent.run.cleanup"
                    ? await cleanupRun(current, run)
                    : job.type === "agent.run.message"
                      ? await dispatchMessage(current, run, job)
                      : await dispatchExecute(current, run, job, {
                            jobId: job.id,
                            fencingToken,
                        });
            current.onHeartbeat = undefined;
            if (timer) clearInterval(timer);
            await heartbeat;
            controller.signal.throwIfAborted();
            if (status === "awaiting-publication") {
                await deps.store.defer(
                    job.id,
                    deps.owner,
                    fencingToken,
                    deps.now(),
                    new Date(Date.now() + 1000).toISOString(),
                );
                return { ...base, status };
            }

            const done = await deps.store.complete(
                job.id,
                deps.owner,
                fencingToken,
                deps.now(),
            );
            if (!done) status += "+lost-lease";
            return { ...base, status };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (timer) clearInterval(timer);
            await heartbeat;
            const row = job.runId ? await getRunById(job.runId) : null;
            const ref = job.runId ? sessions.get(job.runId) : undefined;
            // Cancel this attempt's engine promptly even if it stopped producing
            // output. A replacement's sandbox is never killed on lease loss.
            if (
                ref &&
                (controller.signal.aborted || row?.status === "CANCELLED")
            )
                void ref.adapter.cancel(ref.sessionId).catch(() => {});
            if (row?.status === "CANCELLED" && ctx) {
                await cleanupRun(ctx, row);
                await deps.store.complete(
                    job.id,
                    deps.owner,
                    fencingToken,
                    deps.now(),
                );
                return { ...base, status: "cancelled-observed:CANCELLED" };
            }
            if (
                !ctx &&
                error instanceof RunError &&
                error.code === "STALE_CLAIM"
            ) {
                await deps.store.defer(
                    job.id,
                    deps.owner,
                    fencingToken,
                    deps.now(),
                    new Date(Date.now() + 1000).toISOString(),
                );
                return {
                    ...base,
                    status: "deferred-run-owned",
                    error: message,
                };
            }
            if (
                ctx &&
                row &&
                !isTerminalRunStatus(row.status) &&
                error instanceof EngineError &&
                error.code === "UNSUPPORTED_CAPABILITY"
            ) {
                const failedRun = await transitionRun({
                    runId: row.id,
                    expectedFrom: row.status,
                    to: "FAILED",
                    claim: ctx.ownership,
                    extraEvents: [
                        {
                            type: "run.error",
                            data: {
                                code: error.code,
                                detail: error.message,
                                substituted: false,
                            },
                        },
                    ],
                    steps: [
                        async (tx) => {
                            await deps.store.enqueue(
                                {
                                    type: "agent.run.cleanup",
                                    runId: row.id,
                                    idempotencyKey: `run:${row.id}:cleanup`,
                                },
                                tx,
                            );
                        },
                    ],
                });
                await cleanupRun(ctx, failedRun);
                await deps.store.complete(
                    job.id,
                    deps.owner,
                    fencingToken,
                    deps.now(),
                );
                return {
                    ...base,
                    status: "failed-unsupported-engine",
                    error: message,
                };
            }
            const retryHint =
                error !== null &&
                typeof error === "object" &&
                "retryAfterMs" in error
                    ? Number(error.retryAfterMs)
                    : 0;
            const delay = Math.max(
                Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1)),
                Number.isFinite(retryHint) ? Math.max(0, retryHint) : 0,
            );
            const retryAt = new Date(Date.now() + delay).toISOString();
            if (
                ctx &&
                row &&
                !isTerminalRunStatus(row.status) &&
                !(error instanceof RunError && error.code === "STALE_CLAIM")
            ) {
                if (
                    error instanceof RunError &&
                    error.code === "INVALID_INPUT"
                ) {
                    await transitionRun({
                        runId: row.id,
                        expectedFrom: row.status,
                        to: "BLOCKED",
                        claim: ctx.ownership,
                        data: { error: message },
                    });
                }
            }
            const failed = await deps.store.fail(
                job.id,
                deps.owner,
                fencingToken,
                deps.now(),
                message,
                retryAt,
            );
            return {
                ...base,
                status: failed ? "job-failed" : "job-failed-lost-lease",
                error: message,
            };
        } finally {
            if (timer) clearInterval(timer);
            await heartbeat;
            options.signal?.removeEventListener("abort", stop);
            if (ctx && job.runId) await release(job.runId, ctx.ownership);
        }
    };

    const drain = async (max = 100) => {
        const outcomes: WorkerOutcome[] = [];
        for (let i = 0; i < max; i++) {
            const result = await runOnce();
            if (!result) break;
            outcomes.push(result);
        }
        return outcomes;
    };

    return {
        owner: deps.owner,
        deps,
        ctx: { sessions },
        runOnce,
        drain,
    };
};

export type RunWorker = ReturnType<typeof createRunWorker>;
