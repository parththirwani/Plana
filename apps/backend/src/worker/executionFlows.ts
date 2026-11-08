import { assertPublicationArtifact } from "./artifactPolicy";
import { prisma } from "@repo/db/db";
import {
    type EngineAdapter,
    type EngineEvent,
    type Sandbox,
} from "../adapters/contract";
import type { SandboxFactory } from "../adapters/contract";
import type { EngineAdapterRegistry } from "../adapters/registry";
import { toJsonInput, jsonRecord, type AgentRunRow } from "../runs/dbTypes";
import { appendRunEvent } from "../runs/eventLog";
import {
    assertRunOwnership,
    getRunById,
    mutateRun,
    transitionRun,
    type RunOwnership,
} from "../runs/runRepository";
import {
    currentTaskFingerprint,
    readTask,
    taskFingerprint,
} from "../runs/taskContext";
import { isTerminalRunStatus, type RunStatus } from "../runs/status";
import { RunError } from "../runs/errors";
import type { JobStore, JobRecord } from "../jobs/types";
import {
    completionSchema,
    readRuntime,
    saveRuntime,
    recordInputReceipt,
    type RunRuntime,
} from "./runtime";
import type { Checks, Publisher } from "./services";

export type WorkerDeps = {
    store: JobStore;
    registry: EngineAdapterRegistry;
    sandboxes: SandboxFactory;
    owner: string;
    now: () => string;
    checks: Checks;
    publisher: Publisher;
    afterEvent?: (info: {
        runId: string;
        jobId: string;
        event: EngineEvent;
    }) => Promise<void> | void;
};

export type RunSessionRef = {
    runId: string;
    adapter: EngineAdapter;
    sessionId: string;
    sandbox: Sandbox;
};

export type WorkerContext = {
    deps: WorkerDeps;
    sessions: Map<string, RunSessionRef>;
    ownership: RunOwnership;
    signal: AbortSignal;
    onHeartbeat?: () => Promise<void>;
    appliedInputs: Set<string>;
    withInputs: import("../lib/serialLock").SerialLock;
};

export type JobClaim = { jobId: string; fencingToken: number };

export const abortable = <T>(
    signal: AbortSignal,
    work: Promise<T>,
): Promise<T> => {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Aborted"));
        signal.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    });
};
const fresh = async (ctx: WorkerContext, id: string) => {
    ctx.signal.throwIfAborted();
    const run = await getRunById(id);
    if (!run) throw new RunError("NOT_FOUND", "Run not found");
    if (isTerminalRunStatus(run.status))
        throw new RunError("TERMINAL_STATE", `Run is ${run.status}`);
    return run;
};
const emit = (
    ctx: WorkerContext,
    run: AgentRunRow,
    type: Parameters<typeof appendRunEvent>[0]["type"],
    data: Record<string, unknown>,
) =>
    appendRunEvent({
        runId: run.id,
        issueId: run.issueId,
        status: run.status,
        type,
        data,
        claim: ctx.ownership,
    });
const move = (
    ctx: WorkerContext,
    run: AgentRunRow,
    to: RunStatus,
    runtime?: RunRuntime,
    extraEvents?: Parameters<typeof transitionRun>[0]["extraEvents"],
) => {
    if (["VALIDATING", "REVIEWING", "PUBLISHING"].includes(to))
        ctx.onHeartbeat = undefined;
    return transitionRun({
        runId: run.id,
        expectedFrom: run.status,
        to,
        claim: ctx.ownership,
        data: { via: "worker" },
        ...(runtime ? { commit: { runtime: toJsonInput(runtime) } } : {}),
        ...(extraEvents ? { extraEvents } : {}),
    });
};

const snapshot = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
    ref: RunSessionRef,
) => {
    runtime.session = await abortable(
        ctx.signal,
        ref.adapter.exportSession(ref.sessionId),
    );
    runtime.checkpoint = await abortable(
        ctx.signal,
        ref.sandbox.checkpoint("durable-stage"),
    );
    await saveRuntime(run.id, runtime, ctx.ownership);
};
const ensureSession = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
): Promise<RunSessionRef> => {
    // Durable export and checkpoint are authoritative. An empty process cache
    // is expected after a restart and must not turn required work into a no-op.

    const { sandbox, recreated } = await abortable(
        ctx.signal,
        ctx.deps.sandboxes.connectOrRecreate(run.id, {
            repository: run.repository,
            baseCommit: run.baseCommit ?? `base-of-${run.id}`,
            ...(runtime.checkpoint
                ? {
                      initialFiles: runtime.checkpoint.files,
                      tracked: runtime.checkpoint.tracked,
                      headCommit: runtime.checkpoint.headCommit ?? undefined,
                  }
                : {}),
        }),
    );
    if (!run.baseCommit) {
        run = await mutateRun({
            runId: run.id,
            baseCommit: sandbox.baseCommit,
            claim: ctx.ownership,
        });
    }
    const adapter = ctx.deps.registry.require(run.engine);
    let sessionId: string;
    if (runtime.session) {
        ({ sessionId } = await abortable(
            ctx.signal,
            adapter.restoreSession(runtime.session, sandbox),
        ));
    } else {
        const task = await readTask(prisma, run.issueId);
        runtime.planningContext = taskFingerprint(
            task,
            run.repository,
            run.baseCommit,
        );
        ({ sessionId } = await abortable(
            ctx.signal,
            adapter.start({
                runId: run.id,
                repository: run.repository,
                baseCommit: sandbox.baseCommit,
                executionMode: run.executionMode,
                model: run.model,
                options: jsonRecord(run.options),
                instructions: JSON.stringify({
                    originalTask: run.taskSnapshot,
                    currentTask: task,
                    branch: run.branchName,
                }),
                sandbox,
            }),
        ));
    }
    const ref = { runId: run.id, adapter, sessionId, sandbox };
    ctx.sessions.set(run.id, ref);
    await snapshot(ctx, run, runtime, ref);
    ctx.onHeartbeat = () => deliverMessages(ctx, run, runtime, ref, true);
    await emit(ctx, run, "run.sandbox.lifecycle", {
        phase: runtime.session && recreated ? "recreated" : "provisioned",
        sessionId,
    });
    return ref;
};

const deliverMessages = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
    ref: RunSessionRef,
    receiptOnly = false,
) =>
    ctx.withInputs(async () => {
        const events = await prisma.runEvent.findMany({
            where: { runId: run.id, type: "run.message" },
            orderBy: { sequence: "asc" },
        });
        for (const event of events) {
            const data = jsonRecord(event.data);
            if (data.kind !== "user-message") continue;
            const id = String(data.messageId ?? `event:${event.sequence}`);
            if (ctx.appliedInputs.has(id)) continue;
            await abortable(
                ctx.signal,
                ref.adapter.sendInput(
                    ref.sessionId,
                    String(data.text ?? ""),
                    id,
                ),
            );
            ctx.appliedInputs.add(id);
            if (!runtime.deliveredInputs.includes(id))
                runtime.deliveredInputs.push(id);
            await recordInputReceipt(
                run.id,
                id,
                {
                    kind: "message-delivery",
                    messageId: id,
                    text: data.text,
                    delivered: true,
                    sessionId: ref.sessionId,
                    eventSequence: event.sequence,
                },
                ctx.ownership,
            );
            if (!receiptOnly) await snapshot(ctx, run, runtime, ref);
        }
    });

const stream = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
    ref: RunSessionRef,
    jobId: string,
) => {
    const iterator = ref.adapter
        .streamEvents(ref.sessionId)
        [Symbol.asyncIterator]();
    try {
        for (;;) {
            const item = await abortable(ctx.signal, iterator.next());
            if (item.done) break;
            const event = item.value;
            await fresh(ctx, run.id);
            if (event.type === "cancelled")
                throw new RunError(
                    "INVALID_INPUT",
                    "Engine stopped before completion",
                );
            if (event.type === "validation" && event.data?.ok !== true)
                runtime.engineValidationFailed = true;
            if (event.type === "completed") {
                const completed = completionSchema.safeParse(event.data);
                if (!completed.success)
                    throw new RunError(
                        "INVALID_INPUT",
                        "Engine completion is missing valid base/head/files",
                    );
                runtime.completed = completed.data;
            }
            // Session cursor/checkpoint and its output event commit together.
            runtime.session = await ref.adapter.exportSession(ref.sessionId);
            runtime.checkpoint = await ref.sandbox.checkpoint("engine-event");
            await mutateRun({
                runId: run.id,
                claim: ctx.ownership,
                runtime: toJsonInput(runtime),
                event: {
                    type: "run.engine.output",
                    data: {
                        kind: event.type,
                        sessionId: ref.sessionId,
                        text: event.text,
                        ...event.data,
                    },
                },
            });
            await ctx.deps.afterEvent?.({ runId: run.id, jobId, event });
            await fresh(ctx, run.id);
            await deliverMessages(ctx, run, runtime, ref);
        }
    } finally {
        // Do not wait forever on return() from a provider that ignores abort.
        if (ctx.signal.aborted) void iterator.return?.().catch(() => {});
    }
};

const plan = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
    ref: RunSessionRef,
    replan: boolean,
    jobId: string,
) => {
    if (ref.sandbox.state === "PAUSED") await ref.sandbox.resume();
    if (replan) {
        const task = await readTask(prisma, run.issueId);
        runtime.planningContext = taskFingerprint(
            task,
            run.repository,
            run.baseCommit,
        );
        await ref.adapter.sendInput(
            ref.sessionId,
            JSON.stringify({ task, baseCommit: run.baseCommit }),
        );
        await abortable(
            ctx.signal,
            ref.adapter.regeneratePlan(ref.sessionId, {
                baseCommit: run.baseCommit ?? undefined,
                reason: "task-or-plan-changed",
            }),
        );
        delete runtime.completed;
        delete runtime.validation;
        delete runtime.review;
        delete runtime.artifact;
        delete runtime.ack;
        runtime.engineValidationFailed = false;
    }
    await stream(ctx, run, runtime, ref, jobId);
    const result = await abortable(
        ctx.signal,
        ref.adapter.pauseForApproval(ref.sessionId),
    );
    runtime.session = await ref.adapter.exportSession(ref.sessionId);
    runtime.checkpoint = await ref.sandbox.checkpoint("awaiting-approval");
    const context =
        runtime.planningContext ?? (await currentTaskFingerprint(prisma, run));
    run = await transitionRun({
        runId: run.id,
        expectedFrom: run.status,
        to: "AWAITING_APPROVAL",
        claim: ctx.ownership,
        commit: {
            planVersion: result.planVersion,
            planContextHash: context,
            runtime: toJsonInput(runtime),
        },
        extraEvents: [
            {
                type: "run.plan.updated",
                data: {
                    planVersion: result.planVersion,
                    plan: result.plan,
                    baseCommit: run.baseCommit,
                    contextHash: context,
                    reason: replan ? "stale-approval-regeneration" : "initial",
                },
            },
            {
                type: "run.approval.requested",
                data: {
                    planVersion: result.planVersion,
                    baseCommit: run.baseCommit,
                },
            },
        ],
    });
    await ref.sandbox.pause();
    await emit(ctx, run, "run.sandbox.lifecycle", {
        phase: "paused-awaiting-approval",
    });
    return "awaiting-approval";
};

export const cleanupRun = async (ctx: WorkerContext, run: AgentRunRow) => {
    const runtime = readRuntime(run);
    if (runtime.cleaned) return "cleaned";
    const cached = ctx.sessions.get(run.id);
    await prisma.$transaction(async (tx) => {
        const owned = await assertRunOwnership(tx, run.id, ctx.ownership);
        if (!isTerminalRunStatus(owned.status))
            throw new RunError(
                "ILLEGAL_TRANSITION",
                "Cleanup requires a finished run",
            );
    });
    if (cached) void cached.adapter.cancel(cached.sessionId).catch(() => {});
    // Cleanup must never reconnect-or-recreate: absence is already clean.
    await ctx.deps.sandboxes.destroy(run.id);
    runtime.cleaned = true;
    await mutateRun({
        runId: run.id,
        claim: ctx.ownership,
        runtime: toJsonInput(runtime),
        event: { type: "run.cleanup.completed", data: {} },
    });
    ctx.sessions.delete(run.id);
    return "cleaned";
};

const publish = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    runtime: RunRuntime,
) => {
    if (
        !runtime.completed ||
        !runtime.artifact ||
        !runtime.validation?.ok ||
        !runtime.review?.ok
    )
        throw new RunError(
            "INVALID_INPUT",
            "Publication requires artifact, completion, validation and review evidence",
        );
    assertPublicationArtifact(run, runtime);
    const authorize = async () => {
        await prisma.$transaction(async (tx) => {
            const locked = await assertRunOwnership(tx, run.id, ctx.ownership);
            if (locked.status !== "PUBLISHING")
                throw new RunError(
                    "TERMINAL_STATE",
                    "Publication no longer authorized",
                );
        });
    };
    await authorize();
    const ack = await abortable(
        ctx.signal,
        ctx.deps.publisher.publish({
            run,
            artifact: runtime.artifact,
            headCommit: runtime.completed.headCommit,
            authorize,
            signal: ctx.signal,
        }),
    );
    if (!ack) return "awaiting-publication";
    if (
        ack.branch !== run.branchName ||
        ack.headCommit !== runtime.completed.headCommit
    )
        throw new RunError(
            "INVALID_INPUT",
            "Publisher acknowledgement does not match intent",
        );
    runtime.ack = ack;
    run = await transitionRun({
        runId: run.id,
        expectedFrom: "PUBLISHING",
        to: "COMPLETED",
        claim: ctx.ownership,
        commit: { runtime: toJsonInput(runtime) },
        extraEvents: [{ type: "run.publication.acknowledged", data: ack }],
        steps: [
            async (tx) => {
                await ctx.deps.store.enqueue(
                    {
                        type: "agent.run.cleanup",
                        runId: run.id,
                        idempotencyKey: `run:${run.id}:cleanup`,
                    },
                    tx,
                );
            },
        ],
    });
    await cleanupRun(ctx, run);
    return "completed";
};

export const dispatchExecute = async (
    ctx: WorkerContext,
    initial: AgentRunRow,
    job: JobRecord,
    _claim: JobClaim,
): Promise<string> => {
    let run = initial;
    let runtime = readRuntime(run);
    if (run.status === "BLOCKED" || run.status === "LIMIT_REACHED")
        return "paused";
    if (run.status === "AWAITING_APPROVAL") return "awaiting-approval";
    if (run.status === "PUBLISHING") return publish(ctx, run, runtime);
    if (run.status === "QUEUED") ctx.deps.registry.require(run.engine);
    if (run.status === "QUEUED")
        run = await transitionRun({
            runId: run.id,
            expectedFrom: "QUEUED",
            to: "PROVISIONING",
            claim: ctx.ownership,
            commit: { attemptedAt: new Date() },
        });
    const ref = await ensureSession(ctx, run, runtime);
    run = await fresh(ctx, run.id);
    if (run.status === "PROVISIONING")
        run = await move(
            ctx,
            run,
            run.executionMode === "PLAN_AND_APPROVE"
                ? "PLANNING"
                : "IMPLEMENTING",
            runtime,
        );
    if (run.status === "PLANNING")
        return plan(
            ctx,
            run,
            runtime,
            ref,
            runtime.session?.phase === "awaiting_approval" ||
                job.payload.reason === "replan-requested",
            job.id,
        );
    if (run.status === "IMPLEMENTING") {
        if (run.executionMode === "PLAN_AND_APPROVE") {
            const approval = await prisma.runApproval.findUnique({
                where: {
                    runId_planVersion: {
                        runId: run.id,
                        planVersion: run.planVersion,
                    },
                },
            });
            if (
                !approval ||
                approval.decision !== "APPROVED" ||
                !run.planContextHash ||
                approval.contextHash !==
                    (await currentTaskFingerprint(prisma, run)) ||
                approval.baseCommit !== run.baseCommit
            ) {
                await emit(ctx, run, "run.error", {
                    code: "STALE_APPROVAL",
                    approvedBaseCommit: approval?.baseCommit,
                    currentBaseCommit: run.baseCommit,
                });
                run = await move(ctx, run, "PLANNING");
                await plan(ctx, run, runtime, ref, true, job.id);
                return "stale-replan-awaiting-approval";
            }
            if (runtime.session?.phase === "awaiting_approval") {
                if (ref.sandbox.state === "PAUSED") await ref.sandbox.resume();
                await emit(ctx, run, "run.sandbox.lifecycle", {
                    phase: "reconnected",
                    sessionId: ref.sessionId,
                });
                await abortable(
                    ctx.signal,
                    ref.adapter.resume(ref.sessionId, {
                        approvedPlanVersion: run.planVersion,
                        approvedBaseCommit: run.baseCommit ?? "",
                    }),
                );
                await snapshot(ctx, run, runtime, ref);
            }
        }
        if (!runtime.completed) await stream(ctx, run, runtime, ref, job.id);
        if (!runtime.completed || runtime.engineValidationFailed)
            throw new RunError(
                "INVALID_INPUT",
                "Engine output missing completion or reports failed validation",
            );
        run = await move(ctx, await fresh(ctx, run.id), "VALIDATING", runtime);
    }
    if (run.status === "VALIDATING") {
        runtime.validation = await abortable(
            ctx.signal,
            ctx.deps.checks.validate(ref.sandbox, ctx.signal),
        );
        if (!runtime.validation.ok) {
            await saveRuntime(run.id, runtime, ctx.ownership);
            throw new RunError(
                "INVALID_INPUT",
                "Independent validation failed",
            );
        }
        runtime.artifact = await ref.sandbox.checkpoint("publication-artifact");
        assertPublicationArtifact(run, runtime);
        run = await move(ctx, run, "REVIEWING", runtime);
    }
    if (run.status === "REVIEWING") {
        if (!runtime.artifact || !runtime.validation?.ok || !runtime.completed)
            throw new RunError(
                "INVALID_INPUT",
                "Review requires verified artifact",
            );
        runtime.review = await abortable(
            ctx.signal,
            ctx.deps.checks.review(ref.sandbox, runtime.artifact, ctx.signal),
        );
        if (!runtime.review.ok) {
            await saveRuntime(run.id, runtime, ctx.ownership);
            throw new RunError(
                "INVALID_INPUT",
                "Independent review rejected changes",
            );
        }
        run = await move(ctx, run, "PUBLISHING", runtime, [
            {
                type: "run.publication.intent",
                data: {
                    kind: "INTENT",
                    branch: run.branchName,
                    baseCommit: runtime.completed?.baseCommit ?? run.baseCommit,
                    headCommit: runtime.completed.headCommit,
                    changedFiles: runtime.completed.changedFiles,
                    githubContacted: false,
                    publication: "intent-only",
                    artifactId: runtime.artifact.id,
                },
            },
        ]);
    }
    return publish(ctx, run, runtime);
};

export const dispatchMessage = async (
    ctx: WorkerContext,
    run: AgentRunRow,
    job: JobRecord,
) => {
    const runtime = readRuntime(run);
    const ref = await ensureSession(ctx, run, runtime);
    await deliverMessages(ctx, run, runtime, ref);
    const id = String(
        job.payload.messageId ?? `event:${job.payload.eventSequence}`,
    );
    if (!runtime.deliveredInputs.includes(id)) {
        await ref.adapter.sendInput(
            ref.sessionId,
            String(job.payload.text ?? ""),
            id,
        );
        runtime.deliveredInputs.push(id);
        await snapshot(ctx, run, runtime, ref);
        await emit(ctx, run, "run.engine.output", {
            kind: "message-delivery",
            eventSequence: job.payload.eventSequence ?? null,
            text: job.payload.text,
            delivered: true,
            sessionId: ref.sessionId,
        });
    }
    if (run.status === "AWAITING_APPROVAL" && ref.sandbox.state === "RUNNING")
        await ref.sandbox.pause();
    return "message-delivered";
};
