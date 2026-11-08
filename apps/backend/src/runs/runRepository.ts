// Run writes lock the database row and commit their audit events in the same transaction.
import { randomUUID } from "crypto";
import { prisma, type Prisma } from "@repo/db/db";
import {
    jsonRecord,
    mergeRuntimeReceipts,
    toJsonInput,
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
export {
    appendRunEventsInTransaction,
    assertRunOwnership,
    claimRunLease,
    lockRunRow,
    renewRunLease,
};
export type { GuardedTransitionResult, RunOwnership } from "./stateMachine";
export type { RunEventDb, RunEventDraft, RunEventHint } from "./eventLog";

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

    onEnqueue?: (db: Prisma.TransactionClient) => Promise<void | boolean>;
};

export type CreateRunResult = {
    run: AgentRunRow;
    created: boolean;

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

export const createRun = async (
    input: CreateRunInput,
): Promise<CreateRunResult> => {
    if (!input.issueId || !input.organizationId || !input.createdBy) {
        throw new RunError(
            "INVALID_INPUT",
            "issueId, organizationId and createdBy are required",
        );
    }
    if (!input.idempotencyKey) {
        throw new RunError(
            "INVALID_INPUT",
            "An idempotency key is required to create a run",
        );
    }
    const id = input.id ?? `run_${randomUUID()}`;
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
        await publishRunEventHints(result.hints);
        return result.replayed
            ? { run: result.run, created: false, replayed: true }
            : { run: result.run, created: true };
    });
};

export type TransitionInput = {
    runId: string;
    to: RunStatus;

    data?: Record<string, unknown>;

    actorId?: string | null;

    expectedFrom: RunStatus;

    commit?: RunCommitPatch;

    claim?: RunOwnership;

    extraEvents?: readonly RunEventDraft[];

    steps?: readonly ((
        db: Prisma.TransactionClient,
    ) => Promise<void | boolean>)[];
};

export const transitionRun = async (
    input: TransitionInput,
): Promise<AgentRunRow> => {
    if (!isRunStatus(input.to)) {
        throw new RunError("INVALID_INPUT", `Unknown run status: ${input.to}`, {
            to: input.to,
        });
    }
    let commit = input.commit;
    if (input.to === "BLOCKED" || input.to === "LIMIT_REACHED") {
        const run = await requireRun(input.runId);
        commit = {
            ...commit,
            runtime: toJsonInput({
                ...jsonRecord(run.runtime),
                pausedFrom: input.expectedFrom,
                ...jsonRecord(commit?.runtime),
            }),
        };
    }
    const result = await guardedTransition({
        runId: input.runId,
        expectedFrom: input.expectedFrom,
        to: input.to,
        ...(input.data ? { data: input.data } : {}),
        ...(commit ? { commit } : {}),
        ...(input.claim ? { claim: input.claim } : {}),
        ...(input.extraEvents ? { extraEvents: input.extraEvents } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
        actorId: input.actorId ?? null,
    });
    await publishRunEventHints(result.hints);
    return result.run;
};

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

export type RunMutationInput = {
    runId: string;
    planVersion?: number;
    baseCommit?: string | null;
    branchName?: string;
    attemptedAt?: Date | null;
    runtime?: import("./dbTypes").JsonInput;
    planContextHash?: string | null;

    claim?: RunOwnership;

    event?: RunEventDraft;
};

export const mutateRun = async (
    input: RunMutationInput,
): Promise<AgentRunRow> => {
    const { runId, event, claim, ...patch } = input;
    const result = await prisma.$transaction(async (tx) => {
        const locked = claim
            ? await assertRunOwnership(tx, runId, claim)
            : await lockRunRow(tx, runId);
        const updated = await tx.agentRun.update({
            where: { id: runId },
            data: toRunUpdateData(locked.status, {
                ...patch,
                ...(patch.runtime === undefined
                    ? {}
                    : {
                          runtime: mergeRuntimeReceipts(
                              (
                                  await tx.agentRun.findUniqueOrThrow({
                                      where: { id: runId },
                                  })
                              ).runtime,
                              patch.runtime,
                          ),
                      }),
            }),
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

export const setRunPlanVersion = async (
    runId: string,
    planVersion: number,
    claim?: RunOwnership,
): Promise<AgentRunRow> => {
    const run = await requireRun(runId);
    if (run.planVersion === planVersion) return run;
    return mutateRun({
        runId,
        planVersion,
        ...(claim ? { claim } : {}),
    });
};

export const pinRunBaseCommit = async (
    runId: string,
    baseCommit: string,
    claim?: RunOwnership,
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
