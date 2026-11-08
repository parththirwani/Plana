// Run repository: the only place AgentRun rows are created or mutated.
//
// This module is a THIN, typed facade over the transactional state machine in
// `stateMachine.ts`. It used to own that logic itself, guarded by the
// process-local `AsyncMutex` in `sections.ts`, and the review demonstrated two
// defects that fall straight out of that shape:
//
//   1. a launch persisted the run and THEN appended its first event and enqueued
//      the worker's job as separate statements, so a failure in between left a
//      STRANDED active run holding the per-issue slot forever;
//   2. a status change was `read -> validate -> UPDATE status = ...` with no
//      condition on the value that was read, so two processes that both read
//      IMPLEMENTING could both write — and a late engine result could move a run
//      that had already been CANCELLED back into an executing state.
//
// Everything authoritative now lives in Postgres, in ONE transaction per
// operation: `SELECT … FOR UPDATE` on the run row (or on the issue's active-run
// row, for launches) IS the critical section, so the guarantees hold across
// processes by construction rather than by convention. `withRunSection` survives
// only as an in-process fairness optimization — it is no longer what makes
// anything correct, and no guarantee may be stated in terms of it.

import { randomUUID } from "crypto";
import { prisma, type Prisma } from "@repo/db/db";
import {
    jsonRecord,
    toRunUpdateData,
    type AgentEngine,
    type AgentRunRow,
    type RunCommitPatch,
    type RunExecutionMode,
} from "./dbTypes";
import {
    appendRunEventsInTransaction,
    publishRunEventHints,
    type RunEventDraft,
    type RunEventHint,
} from "./eventLog";
import { RunError } from "./errors";
import { withRunSection } from "./sections";
import {
    assertRunOwnership,
    claimRunLease,
    guardedTransition,
    launchRun,
    lockRunRow,
    renewRunLease,
    type GuardedTransitionResult,
    type RunOwnership,
} from "./stateMachine";
import { isRunStatus, type RunStatus } from "./status";

// The lease/claim primitives are re-exported so the worker imports its
// concurrency vocabulary from ONE module (the repository) and cannot bypass the
// state machine by reaching for a lower-level helper.
export {
    appendRunEventsInTransaction,
    assertRunOwnership,
    claimRunLease,
    lockRunRow,
    renewRunLease,
};
export type { GuardedTransitionResult, RunOwnership } from "./stateMachine";
export type { RunEventDb, RunEventDraft, RunEventHint } from "./eventLog";

/** Public API projection of an AgentRun row: the typed unions of the row,
 *  minus worker-internal columns (owner / lease / fencing token). */
export type AgentRunRecord = {
    id: string;
    issueId: string;
    organizationId: string;
    createdBy: string;
    engine: AgentEngine;
    model: string;
    options: Record<string, unknown>;
    executionMode: RunExecutionMode;
    repository: string;
    baseCommit: string | null;
    branchName: string;
    status: RunStatus;
    planVersion: number;
    idempotencyKey: string;
    createdAt: Date | string;
    updatedAt: Date | string;
};

export const shapeRun = (run: AgentRunRow): AgentRunRecord => ({
    id: run.id,
    issueId: run.issueId,
    organizationId: run.organizationId,
    createdBy: run.createdBy,
    engine: run.engine,
    model: run.model,
    options: jsonRecord(run.options),
    executionMode: run.executionMode,
    repository: run.repository,
    baseCommit: run.baseCommit ?? null,
    branchName: run.branchName,
    status: run.status,
    planVersion: run.planVersion,
    idempotencyKey: run.idempotencyKey,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
});

export const runBranchName = (issueId: string, runId: string) =>
    `plana/${issueId}/${runId}`;

export type CreateRunInput = {
    id?: string;
    issueId: string;
    organizationId: string;
    createdBy: string;
    engine: string;
    model: string;
    options?: Record<string, unknown>;
    executionMode?: string;
    repository: string;
    baseCommit?: string | null;
    idempotencyKey: string;
    /**
     * Durable companion work that must commit or roll back WITH the run.
     * CP-A/CP5 enqueue the worker's job here: the callback runs INSIDE the
     * launch transaction, and throwing (or returning false) aborts the whole
     * launch. That is the structural guarantee that there is never an
     * interleaving where a queued run exists without its queued job — the
     * enqueue is not a step that happens after creation, it is part of it.
     */
    onEnqueue?: (db: Prisma.TransactionClient) => Promise<void | boolean>;
};

export type CreateRunResult = {
    run: AgentRunRow;
    created: boolean;
    /** Set when the caller's key replayed an existing run. */
    replayed?: boolean;
};

export const getActiveRunForIssue = async (issueId: string) =>
    prisma.agentRun.findUnique({ where: { activeIssueId: issueId } });

export const getRunById = async (runId: string) =>
    prisma.agentRun.findUnique({ where: { id: runId } });

export const requireRun = async (runId: string) => {
    const run = await getRunById(runId);
    if (!run) {
        throw new RunError("NOT_FOUND", "Run not found", { runId });
    }
    return run;
};

export const listRunsForIssue = async (issueId: string) =>
    prisma.agentRun.findMany({
        where: { issueId },
        orderBy: { createdAt: "desc" },
    });

/**
 * Create (or replay) a queued run — ONE Postgres transaction.
 *
 * The run row, its durable `run.created` event and the caller's `onEnqueue`
 * work commit together, serialized against other launches of the same issue by
 * a `SELECT … FOR UPDATE` on the issue's active-run row. The unique index on
 * `activeIssueId` stays the cross-process backstop, translated back into the
 * same typed ACTIVE_RUN_EXISTS error.
 *
 * What this replaces: a read-then-insert guarded by a process-local mutex, with
 * the event append and the enqueue as separate statements afterwards. That
 * could strand an ACTIVE run when a later step failed, and could admit two
 * concurrent launches in two processes. Both are now structurally impossible:
 * there is nothing *between* the statements for a failure to land in, and the
 * lock belongs to the database rather than to this process.
 */
export const createRun = async (
    input: CreateRunInput
): Promise<CreateRunResult> => {
    if (!input.issueId || !input.organizationId || !input.createdBy) {
        throw new RunError(
            "INVALID_INPUT",
            "issueId, organizationId and createdBy are required"
        );
    }
    if (!input.idempotencyKey) {
        throw new RunError(
            "INVALID_INPUT",
            "An idempotency key is required to create a run"
        );
    }
    const id = input.id ?? `run_${randomUUID()}`;
    // Same-issue launches queue here. This is NOT the guarantee — the FOR UPDATE
    // plus the unique indexes inside are what make it correct across processes —
    // but queueing locally means one process's retries do not pile up as
    // guaranteed-but-costy unique-violation retries.
    return withRunSection(`issue:${input.issueId}`, async () => {
    const result = await launchRun({
        id,
        issueId: input.issueId,
        organizationId: input.organizationId,
        createdBy: input.createdBy,
        engine: input.engine,
        model: input.model,
        options: input.options,
        executionMode: input.executionMode,
        repository: input.repository,
        baseCommit: input.baseCommit,
        branchName: runBranchName(input.issueId, id),
        idempotencyKey: input.idempotencyKey,
        ...(input.onEnqueue ? { steps: [input.onEnqueue] } : {}),
    });
        // Committed: only now may the persisted event be hinted at. A rolled-back
        // launch publishes nothing, because nothing was persisted.
        await publishRunEventHints(result.hints);
        return result.replayed
            ? { run: result.run, created: false, replayed: true }
            : { run: result.run, created: true };
    });
};

export type TransitionInput = {
    runId: string;
    to: RunStatus;
    /** Merged into the run.status.changed event payload. */
    data?: Record<string, unknown>;
    /** Audit id of the human/machine that asked for the change. */
    actorId?: string | null;
    /**
     * THE LOST-UPDATE GUARD — required, not optional. The status the caller read
     * when it decided on this transition; a mutation that cannot name the state
     * it believes it is moving FROM is not allowed to move a run at all. If the
     * row says otherwise the transition is REJECTED (typed ILLEGAL_TRANSITION
     * with `raced: true`), never silently applied on top of whatever won.
     */
    expectedFrom: RunStatus;
    /** Non-status columns persisted in the SAME statement (plan version, pinned
     *  base commit, first-attempt stamp, CP-F publication bookkeeping). */
    commit?: RunCommitPatch;
    /** The acting worker. When present, ownership (a live lease AND the exact
     *  fencing token) is asserted INSIDE the same transaction as the write, so
     *  a zombie whose lease expired cannot mutate or publish. */
    claim?: RunOwnership;
    /** Extra durable events appended after run.status.changed, same tx. */
    extraEvents?: readonly RunEventDraft[];
    /** In-transaction follow-up work (CP-F: artifact reference + publisher
     *  ack). Aborts the whole transition when it throws or returns false. */
    steps?: readonly ((db: Prisma.TransactionClient) => Promise<void | boolean>)[];
};

/**
 * Move a run to `to`, in ONE Postgres transaction, through the state machine:
 * lock the run row (`FOR UPDATE`) → assert `expectedFrom` against the status it
 * actually read → assert the legal-transition table and terminal finality →
 * assert the acting worker still owns a live lease at its fencing token → apply
 * the guarded update (`WHERE status = from`, so the statement itself re-states
 * the guard) → append the durable event(s) → commit. Realtime hints are emitted
 * only AFTER the commit, so a rollback can never leak a hint for an event that
 * does not exist.
 *
 * That is what makes "a late engine result revives a CANCELLED run" impossible
 * rather than merely unlikely: the stale write matches zero rows, and its
 * ownership assertion fails before that anyway.
 */
export const transitionRun = async (
    input: TransitionInput
): Promise<AgentRunRow> => {
    if (!isRunStatus(input.to)) {
        throw new RunError("INVALID_INPUT", `Unknown run status: ${input.to}`, {
            to: input.to,
        });
    }
    const result = await guardedTransition({
        runId: input.runId,
        expectedFrom: input.expectedFrom,
        to: input.to,
        ...(input.data ? { data: input.data } : {}),
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.claim ? { claim: input.claim } : {}),
        ...(input.extraEvents ? { extraEvents: input.extraEvents } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
        actorId: input.actorId ?? null,
    });
    await publishRunEventHints(result.hints);
    return result.run;
};

/**
 * Cancel a run. The caller MUST name the status it read (`expectedFrom`) and,
 * when the cancel comes from a claimed worker, its ownership claim: a cancel
 * that races an in-flight completion loses cleanly — the guard rejects the loser
 * — instead of both writes landing. Reaching a terminal status releases the
 * per-issue active slot in the SAME transaction, so a follow-up launch can start
 * immediately.
 */
export const cancelRun = async (input: {
    runId: string;
    actorId?: string | null;
    reason?: string;
    expectedFrom: RunStatus;
    claim?: RunOwnership;
}) =>
    transitionRun({
        runId: input.runId,
        to: "CANCELLED",
        expectedFrom: input.expectedFrom,
        actorId: input.actorId ?? null,
        ...(input.claim ? { claim: input.claim } : {}),
        data: { reason: input.reason ?? "cancelled by request" },
    });

export const failRun = async (input: {
    runId: string;
    actorId?: string | null;
    error: string;
    expectedFrom: RunStatus;
    claim?: RunOwnership;
    /** Attempt accounting and diagnostics recorded with the failure. */
    data?: Record<string, unknown>;
}) =>
    transitionRun({
        runId: input.runId,
        to: "FAILED",
        expectedFrom: input.expectedFrom,
        actorId: input.actorId ?? null,
        ...(input.claim ? { claim: input.claim } : {}),
        data: { error: input.error, ...(input.data ?? {}) },
    });

// ---------------------------------------------------------------------------
// Durable non-status mutations (CP-D resume stamp, CP-F commit bookkeeping)
// ---------------------------------------------------------------------------

/**
 * Persist run bookkeeping WITHOUT touching its status, in one transaction that
 * first asserts ownership when a worker is acting. The lifecycle columns
 * (`status`, `activeIssueId`) are deliberately unreachable through this path:
 * they only move via `transitionRun`, whose guard is what makes concurrent
 * mutation safe.
 */
export type RunMutationInput = {
    runId: string;
    planVersion?: number;
    baseCommit?: string | null;
    branchName?: string;
    attemptedAt?: Date | null;
    /** The acting worker: ownership (live lease + fencing token) is asserted in
     *  the SAME transaction as the write, so a worker that lost its lease cannot
     *  stamp a run it no longer owns. */
    claim?: RunOwnership;
    /** Durable event appended in the same transaction. */
    event?: RunEventDraft;
};

export const mutateRun = async (
    input: RunMutationInput
): Promise<AgentRunRow> => {
    const { runId, event, claim, ...patch } = input;
    const result = await prisma.$transaction(async (tx) => {
        const locked = claim
            ? await assertRunOwnership(tx, runId, claim)
            : await lockRunRow(tx, runId);
        const updated = await tx.agentRun.update({
            where: { id: runId },
            data: toRunUpdateData(locked.status, patch),
        });
        const hints = event
            ? await appendRunEventsInTransaction(tx, {
                  runId,
                  issueId: updated.issueId,
                  status: updated.status,
                  drafts: [event],
              })
            : [];
        return { updated, hints };
    });
    await publishRunEventHints(result.hints);
    return result.updated;
};

/**
 * Record that an execution attempt actually started (CP-D). Idempotent: a second
 * claim of the same run never moves the original stamp, so
 * `status != QUEUED && attemptedAt == null` keeps meaning exactly one thing —
 * "the claim died before it durably recorded its start", which is precisely the
 * state a retry must RESUME rather than replay.
 */
export const markRunAttemptStarted = async (input: {
    runId: string;
    claim?: RunOwnership;
    at?: Date;
}): Promise<AgentRunRow> => {
    const at = input.at ?? new Date();
    const run = await requireRun(input.runId);
    if (run.attemptedAt !== null && run.attemptedAt !== undefined) return run;
    return mutateRun({
        runId: input.runId,
        ...(input.claim ? { claim: input.claim } : {}),
        attemptedAt: at,
        event: { type: "run.attempt.started", data: { at: at.toISOString() } },
    });
};

/** Pin the plan version an approval gate points at (guarded + audited). */
export const setRunPlanVersion = async (
    runId: string,
    planVersion: number,
    claim?: RunOwnership
): Promise<AgentRunRow> => {
    const run = await requireRun(runId);
    if (run.planVersion === planVersion) return run;
    // No event here on purpose: the planning step in
    // `worker/executionFlows.ts` already appends the durable `run.plan.updated`
    // event with the plan payload, and the version is readable from it. Emitting
    // here too would double-book the audit trail for one plan generation.
    return mutateRun({
        runId,
        planVersion,
        ...(claim ? { claim } : {}),
    });
};

/** Pin the base commit observed at provision time (first write wins). */
export const pinRunBaseCommit = async (
    runId: string,
    baseCommit: string,
    claim?: RunOwnership
): Promise<AgentRunRow> => {
    const run = await requireRun(runId);
    if (run.baseCommit !== null && run.baseCommit !== undefined) return run;
    return mutateRun({
        runId,
        baseCommit,
        ...(claim ? { claim } : {}),
        event: { type: "run.base.pinned", data: { baseCommit } },
    });
};
