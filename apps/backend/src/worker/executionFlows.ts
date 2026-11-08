import { EngineError, type EngineAdapter, type EngineEvent, type Sandbox } from "../adapters/contract";
import type { SandboxFactory } from "../adapters/fakeSandbox";
import type { EngineAdapterRegistry } from "../adapters/registry";
import { appendRunEvent } from "../runs/eventLog";
import {
    failRun,
    getRunById,
    pinRunBaseCommit,
    setRunPlanVersion,
    transitionRun,
} from "../runs/runRepository";
import { isTerminalRunStatus } from "../runs/status";
import type { JobStore, JobRecord } from "../jobs/types";

// Worker execution flows (CP5). All provider/sandbox interaction happens
// through the injected contracts — the worker never talks to a queue backend,
// an engine binary, a sandbox API or GitHub directly. Publication is recorded
// as a durable INTENT event consumed later by the publisher service (out of
// scope in this container; the sandbox provably never holds write creds).

export type WorkerDeps = {
    store: JobStore;
    registry: EngineAdapterRegistry;
    sandboxes: SandboxFactory;
    owner: string;
    now: () => string;
    /** Test/observability hook fired after each engine event is persisted —
     *  BEFORE the worker re-reads the run status (which is how a cancel
     *  landing mid-stream is observed). */
    afterEvent?: (info: { runId: string; jobId: string; event: EngineEvent }) => Promise<void> | void;
};

export type RunSessionRef = {
    runId: string;
    adapter: EngineAdapter;
    sessionId: string;
    sandbox: Sandbox;
    completedData?: Record<string, unknown>;
};

export type WorkerContext = {
    deps: WorkerDeps;
    sessions: Map<string, RunSessionRef>;
};

export type JobClaim = { jobId: string; fencingToken: number };

const emit = (
    run: any,
    type: Parameters<typeof appendRunEvent>[0]["type"],
    data: Record<string, unknown>
) =>
    appendRunEvent({
        runId: run.id,
        issueId: run.issueId,
        status: run.status,
        type,
        data,
    });

const transition = async (run: any, to: any, data: Record<string, unknown> = {}) => {
    const updated = await transitionRun({
        runId: run.id,
        to,
        data: { via: "worker", ...data },
    });
    return updated;
};

const leaseStillOurs = async (deps: WorkerDeps, claim: JobClaim): Promise<boolean> => {
    const job = await deps.store.get(claim.jobId);
    return (
        !!job &&
        job.status === "RUNNING" &&
        job.lockedBy === deps.owner &&
        job.fencingToken === claim.fencingToken
    );
};

const ensureSandbox = async (ctx: WorkerContext, run: any): Promise<{ sandbox: Sandbox; recreated: boolean }> => {
    const baseCommit = (run.baseCommit as string | null) ?? `base-of-${run.id}`;
    const { sandbox, recreated } = await ctx.deps.sandboxes.connectOrRecreate(run.id, {
        repository: run.repository,
        baseCommit,
    });
    if (run.baseCommit === null || run.baseCommit === undefined) {
        await pinRunBaseCommit(run.id, sandbox.baseCommit);
    }
    return { sandbox, recreated };
};

const startSession = async (
    ctx: WorkerContext,
    run: any,
    sandbox: Sandbox
): Promise<RunSessionRef> => {
    const adapter = ctx.deps.registry.require(run.engine);
    const { sessionId } = await adapter.start({
        runId: run.id,
        repository: run.repository,
        baseCommit: sandbox.baseCommit,
        executionMode: run.executionMode,
        model: run.model,
        options: (run.options ?? {}) as Record<string, unknown>,
        instructions: `Implement issue ${run.issueId} on branch ${run.branchName}.`,
        sandbox,
    });
    const ref: RunSessionRef = { runId: run.id, adapter, sessionId, sandbox };
    ctx.sessions.set(run.id, ref);
    return ref;
};

type StreamOutcome =
    | { cancelled: false }
    | { cancelled: true; reason: string; runStatus?: string };

/** Persist every engine event BEFORE moving on; after each event re-read the
 *  run so a cancellation that lands mid-stream is observed and enforced:
 *  engine stopped, sandbox cleaned, and NO publication intent recorded. */
const streamSession = async (
    ctx: WorkerContext,
    run: any,
    jobId: string,
    ref: RunSessionRef
): Promise<StreamOutcome> => {
    for await (const event of ref.adapter.streamEvents(ref.sessionId)) {
        await emit(run, "run.engine.output", {
            kind: event.type,
            sessionId: ref.sessionId,
            ...(event.text !== undefined ? { text: event.text } : {}),
            ...(event.data ?? {}),
        });
        if (event.type === "completed") {
            ref.completedData = event.data ?? {};
        }
        if (event.type === "cancelled") {
            return { cancelled: true, reason: String((event.data as any)?.reason ?? "engine-stopped") };
        }
        await ctx.deps.afterEvent?.({ runId: run.id, jobId, event });
        const fresh = await getRunById(run.id);
        if (fresh && isTerminalRunStatus(fresh.status)) {
            await ref.adapter.cancel(ref.sessionId);
            await ref.sandbox.kill();
            ctx.sessions.delete(run.id);
            return {
                cancelled: true,
                reason: "late-engine-result-blocked-by-run-state",
                runStatus: fresh.status,
            };
        }
    }
    return { cancelled: false };
};

/** VALIDATING -> REVIEWING -> PUBLISHING -> durable INTENT -> COMPLETED.
 *  Two guards run before the intent is written:
 *    * the run must still be non-terminal (cancel prevents publication);
 *    * the job lease/fencing token must still belong to this worker (a
 *      zombied previous owner can never publish). */
const publishTail = async (
    ctx: WorkerContext,
    run: any,
    claim: JobClaim,
    ref: RunSessionRef
): Promise<string> => {
    let current = await transition(run, "VALIDATING", { stage: "validation" });
    current = await transition(current, "REVIEWING", { stage: "review" });

    const fresh = await getRunById(run.id);
    if (!fresh || isTerminalRunStatus(fresh.status)) {
        await ref.adapter.cancel(ref.sessionId);
        return `ignored-terminal-late:${fresh?.status ?? "missing"}`;
    }
    if (!(await leaseStillOurs(ctx.deps, claim))) {
        // Lease was reclaimed elsewhere: stop the engine, publish NOTHING.
        await ref.adapter.cancel(ref.sessionId);
        return "aborted-lost-lease";
    }

    current = await transition(fresh, "PUBLISHING", { stage: "publish" });
    const completed = (ref.completedData ?? {}) as Record<string, unknown>;
    await emit(current, "run.publication.intent", {
        kind: "INTENT",
        branch: current.branchName,
        baseCommit: completed.baseCommit ?? current.baseCommit,
        headCommit: completed.headCommit ?? null,
        changedFiles: completed.changedFiles ?? [],
        // The worker NEVER talks to GitHub: this event is the durable intent
        // the publisher service consumes later (out of scope in this
        // container — UNVERIFIED ledger).
        githubContacted: false,
        publication: "intent-only",
    });
    await transition(current, "COMPLETED", { stage: "completed" });
    await ref.sandbox.kill();
    return "completed";
};

const pauseForApproval = async (
    ctx: WorkerContext,
    run: any,
    ref: RunSessionRef,
    reason: string
): Promise<string> => {
    const pause = await ref.adapter.pauseForApproval(ref.sessionId);
    await setRunPlanVersion(run.id, pause.planVersion);
    const updated = await transition(run, "AWAITING_APPROVAL", {
        stage: "plan-ready",
        planVersion: pause.planVersion,
    });
    await emit(updated, "run.plan.updated", {
        planVersion: pause.planVersion,
        plan: pause.plan,
        baseCommit: updated.baseCommit,
        checkpointId: pause.checkpointId,
        reason,
    });
    await emit(updated, "run.approval.requested", {
        planVersion: pause.planVersion,
        baseCommit: updated.baseCommit,
    });
    await ref.sandbox.pause();
    await emit(updated, "run.sandbox.lifecycle", {
        phase: "paused-awaiting-approval",
        checkpointId: pause.checkpointId,
    });
    return "awaiting-approval";
};

const freshFlow = async (
    ctx: WorkerContext,
    run: any,
    jobId: string,
    claim: JobClaim
): Promise<string> => {
    try {
        // Fail fast and HONESTLY when the requested engine has no adapter:
        // nothing is ever substituted. This happens before any state moves.
        ctx.deps.registry.require(run.engine);
    } catch (error) {
        if (error instanceof EngineError && error.code === "UNSUPPORTED_CAPABILITY") {
            await emit(run, "run.error", {
                code: "UNSUPPORTED_CAPABILITY",
                engine: run.engine,
                detail: error.message,
                substituted: false,
            });
            await failRun({ runId: run.id, error: `engine '${run.engine}' unavailable: ${error.message}` });
            return "failed-unsupported-engine";
        }
        throw error;
    }

    let current = await transition(run, "PROVISIONING", { stage: "provision" });
    const { sandbox, recreated } = await ensureSandbox(ctx, current);
    await emit(current, "run.sandbox.lifecycle", {
        phase: recreated ? "recreated" : "provisioned",
        repository: current.repository,
        baseCommit: sandbox.baseCommit,
    });

    const ref = await startSession(ctx, current, sandbox);
    const mode = current.executionMode;

    if (mode === "PLAN_AND_APPROVE") {
        current = await transition(current, "PLANNING", { stage: "plan" });
        const streamed = await streamSession(ctx, current, jobId, ref);
        if (streamed.cancelled) return streamedOutcome(streamed);
        return pauseForApproval(ctx, current, ref, "initial");
    }

    current = await transition(current, "IMPLEMENTING", { stage: "implement" });
    const streamed = await streamSession(ctx, current, jobId, ref);
    if (streamed.cancelled) return streamedOutcome(streamed);
    return publishTail(ctx, current, claim, ref);
};

const streamedOutcome = (streamed: { reason: string; runStatus?: string }): string =>
    streamed.runStatus
        ? `cancelled-observed:${streamed.runStatus}`
        : `aborted-engine:${streamed.reason}`;

const resumeApprovedFlow = async (
    ctx: WorkerContext,
    run: any,
    jobId: string,
    claim: JobClaim,
    approved: { planVersion: number; baseCommit: string }
): Promise<string> => {
    const ref = ctx.sessions.get(run.id);
    if (!ref) return "ignored-no-resumable-session";

    // The run ROW is the source of truth: if the plan version or base commit
    // moved after the approval was recorded, resume is refused BEFORE any
    // engine work and the plan is regenerated for re-approval.
    const currentRun = await getRunById(run.id);
    if (!currentRun) return "ignored-missing-run";
    const rowPlanVersion = currentRun.planVersion as number;
    const rowBaseCommit = String(currentRun.baseCommit ?? "");
    if (
        approved.planVersion !== rowPlanVersion ||
        approved.baseCommit !== rowBaseCommit
    ) {
        return staleReplanFlow(ctx, currentRun, jobId, {
            reason: "run-row-moved-since-approval",
            approvedPlanVersion: approved.planVersion,
            approvedBaseCommit: approved.baseCommit,
            currentPlanVersion: rowPlanVersion,
            currentBaseCommit: rowBaseCommit,
        });
    }

    // connectOrRecreate resumes the PAUSED machine (or recreates it from the
    // last checkpoint if lost) BEFORE the engine writes anything.
    const { sandbox, recreated } = await ensureSandbox(ctx, currentRun);
    ref.sandbox = sandbox;
    await emit(currentRun, "run.sandbox.lifecycle", {
        phase: recreated ? "recreated" : "reconnected",
        resumedFor: `plan-v${approved.planVersion}`,
    });

    try {
        await ref.adapter.resume(ref.sessionId, {
            approvedPlanVersion: approved.planVersion,
            approvedBaseCommit: approved.baseCommit,
        });
    } catch (error) {
        if (error instanceof EngineError && error.code === "STALE_APPROVAL") {
            return staleReplanFlow(ctx, currentRun, jobId, error.details);
        }
        throw error;
    }

    const streamed = await streamSession(ctx, currentRun, jobId, ref);
    if (streamed.cancelled) return streamedOutcome(streamed);
    return publishTail(ctx, currentRun, claim, ref);
};

/** Approval raced with a base-commit/plan change: NOTHING is implemented.
 *  Record the durable error, step back to PLANNING, regenerate the plan
 *  against the CURRENT base and request approval again. */
const staleReplanFlow = async (
    ctx: WorkerContext,
    run: any,
    jobId: string,
    details: Record<string, unknown>
): Promise<string> => {
    const ref = ctx.sessions.get(run.id);
    if (!ref) return "ignored-no-resumable-session";

    await emit(run, "run.error", {
        code: "STALE_APPROVAL",
        action: "plan-regeneration-required",
        ...details,
    });
    let current = await transition(run, "AWAITING_APPROVAL", {
        stage: "approval-stale",
        reason: "base-commit-or-plan-changed-since-approval",
    });
    current = await transition(current, "PLANNING", { stage: "re-plan" });

    const { sandbox } = await ensureSandbox(ctx, current);
    ref.sandbox = sandbox;

    await ref.adapter.regeneratePlan(ref.sessionId, {
        baseCommit: current.baseCommit ?? undefined,
        reason: "stale-approval-at-claim",
    });
    const streamed = await streamSession(ctx, current, jobId, ref);
    if (streamed.cancelled) return streamedOutcome(streamed);
    await pauseForApproval(ctx, current, ref, "stale-approval-regeneration");
    return "stale-replan-awaiting-approval";
};

/** REJECTED approval (or manual replan): regenerate, re-request approval. */
const replanFlow = async (
    ctx: WorkerContext,
    run: any,
    jobId: string,
    reason: string
): Promise<string> => {
    const ref = ctx.sessions.get(run.id);
    if (!ref) return "ignored-no-resumable-session";
    const { sandbox } = await ensureSandbox(ctx, run);
    ref.sandbox = sandbox;
    await ref.adapter.regeneratePlan(ref.sessionId, { reason });
    const streamed = await streamSession(ctx, run, jobId, ref);
    if (streamed.cancelled) return streamedOutcome(streamed);
    // run.status is already PLANNING here (approval REJECTED moved it) — the
    // pause transition PLANNING -> AWAITING_APPROVAL is legal.
    return pauseForApproval(ctx, run, ref, reason);
};

export const dispatchExecute = async (
    ctx: WorkerContext,
    run: any,
    job: JobRecord,
    claim: JobClaim
): Promise<string> => {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const reason = String(payload.reason ?? "created");
    switch (reason) {
        case "created":
            if (run.status !== "QUEUED") return `ignored-status-for-created:${run.status}`;
            return freshFlow(ctx, run, job.id, claim);
        case "approved":
            if (run.status !== "IMPLEMENTING") return `ignored-status-for-approved:${run.status}`;
            return resumeApprovedFlow(ctx, run, job.id, claim, {
                planVersion: Number(payload.planVersion ?? run.planVersion),
                baseCommit: String(payload.baseCommit ?? run.baseCommit ?? ""),
            });
        case "replan-requested":
            if (run.status !== "PLANNING") return `ignored-status-for-replan:${run.status}`;
            return replanFlow(ctx, run, job.id, "approval-rejected");
        case "manual-resume":
            switch (run.status) {
                case "QUEUED":
                    return freshFlow(ctx, run, job.id, claim);
                case "PLANNING":
                    return replanFlow(ctx, run, job.id, "manual-resume");
                case "IMPLEMENTING":
                    // Manual resume continues against the CURRENT truth on the
                    // run row, not a (possibly stale) queued payload.
                    return resumeApprovedFlow(ctx, run, job.id, claim, {
                        planVersion: run.planVersion,
                        baseCommit: String(run.baseCommit ?? ""),
                    });
                case "AWAITING_APPROVAL":
                    return "coalesced-awaiting-approval";
                default:
                    return `ignored-status-for-resume:${run.status}`;
            }
        default:
            return `ignored-unhandled-reason:${reason}`;
    }
};

export const dispatchMessage = async (
    ctx: WorkerContext,
    run: any,
    job: JobRecord
): Promise<string> => {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const ref = ctx.sessions.get(run.id);
    let delivered = false;
    if (ref) {
        try {
            await ref.adapter.sendInput(ref.sessionId, String(payload.text ?? ""));
            delivered = true;
        } catch {
            delivered = false;
        }
    }
    await emit(run, "run.engine.output", {
        kind: "message-delivery",
        eventSequence: payload.eventSequence ?? null,
        text: payload.text ?? "",
        delivered,
        sessionId: ref?.sessionId ?? null,
    });
    return delivered ? "message-delivered" : "message-not-delivered";
};
