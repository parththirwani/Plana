import { randomUUID } from "crypto";
import { prisma } from "@repo/db/db";
import { appendRunEvent } from "./eventLog";
import { RunError } from "./errors";
import { withRunSection } from "./sections";
import {
    canTransitionRun,
    isRunStatus,
    isTerminalRunStatus,
    legalRunTargets,
    type RunStatus,
} from "./status";

// Run repository (CP3): the only place AgentRun rows are created/mutated.
//
// Responsibilities kept here:
//   * one ACTIVE run per issue, enforced in the repository (on top of the
//     unique activeIssueId index in CP1) and released exactly when the run
//     reaches a terminal status;
//   * create is idempotent on (organizationId, idempotencyKey);
//   * every status change goes through the explicit transition table, happens
//     inside the run's critical section (read -> validate -> write), and is
//     recorded as a durable RunEvent;
//   * terminal states are final, so a late result from a zombie worker can
//     never revive or overwrite a cancelled/failed/completed run.
//
// Nothing in this module talks to a queue, an engine or HTTP — CP4 handlers and
// the CP5 worker build on top of it.

export type AgentRunRecord = {
    id: string;
    issueId: string;
    organizationId: string;
    createdBy: string;
    engine: string;
    model: string;
    options: Record<string, unknown>;
    executionMode: string;
    repository: string;
    baseCommit: string | null;
    branchName: string;
    status: RunStatus;
    activeIssueId: string | null;
    planVersion: number;
    idempotencyKey: string;
    createdAt: string;
    updatedAt: string;
};

export const shapeRun = (run: any) => ({
    id: run.id,
    issueId: run.issueId,
    organizationId: run.organizationId,
    createdBy: run.createdBy,
    engine: run.engine,
    model: run.model,
    options: run.options ?? {},
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
};

export type CreateRunResult = {
    run: any;
    created: boolean;
    /** Set when the caller's key replayed an existing run. */
    replayed?: boolean;
};

const findRunByIdempotencyKey = (organizationId: string, key: string) =>
    prisma.agentRun.findUnique({
        where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
    });

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
 * Create (or replay) a queued run for an issue.
 *
 * The whole check-then-insert runs under the issue's critical section so two
 * concurrent launches cannot both observe "no active run"; the unique
 * activeIssueId index is the cross-process backstop and is translated back into
 * the same ACTIVE_RUN_EXISTS error.
 */
export const createRun = async (
    input: CreateRunInput
): Promise<CreateRunResult> => {
    if (!input.issueId || !input.organizationId || !input.createdBy) {
        throw new RunError("INVALID_INPUT", "issueId, organizationId and createdBy are required");
    }
    if (!input.idempotencyKey) {
        throw new RunError("INVALID_INPUT", "An idempotency key is required to create a run");
    }

    return withRunSection(`issue:${input.issueId}`, async () => {
        const replay = await findRunByIdempotencyKey(
            input.organizationId,
            input.idempotencyKey
        );
        if (replay) return { run: replay, created: false, replayed: true };

        const active = await getActiveRunForIssue(input.issueId);
        if (active) {
            throw new RunError(
                "ACTIVE_RUN_EXISTS",
                "This issue already has an active agent run",
                { runId: active.id, status: active.status }
            );
        }

        const id = input.id ?? `run_${randomUUID()}`;
        try {
            const run = await prisma.agentRun.create({
                data: {
                    id,
                    issueId: input.issueId,
                    organizationId: input.organizationId,
                    createdBy: input.createdBy,
                    engine: input.engine,
                    model: input.model,
                    options: input.options ?? {},
                    executionMode: input.executionMode ?? "IMPLEMENT",
                    repository: input.repository,
                    baseCommit: input.baseCommit ?? null,
                    branchName: runBranchName(input.issueId, id),
                    status: "QUEUED",
                    activeIssueId: input.issueId,
                    planVersion: 0,
                    idempotencyKey: input.idempotencyKey,
                },
            });
            await appendRunEvent({
                runId: run.id,
                type: "run.created",
                issueId: run.issueId,
                status: run.status,
                data: {
                    engine: run.engine,
                    model: run.model,
                    options: run.options ?? {},
                    executionMode: run.executionMode,
                    repository: run.repository,
                    baseCommit: run.baseCommit ?? null,
                    branchName: run.branchName,
                    status: run.status,
                },
            });
            return { run, created: true };
        } catch (error: any) {
            if (error?.code === "P2002") {
                const target = (error?.meta?.target as string[]) ?? [];
                if (target.includes("activeIssueId")) {
                    const winner = await getActiveRunForIssue(input.issueId);
                    throw new RunError(
                        "ACTIVE_RUN_EXISTS",
                        "This issue already has an active agent run",
                        {
                            runId: winner?.id ?? null,
                            status: winner?.status ?? null,
                            raced: true,
                        }
                    );
                }
                if (target.includes("idempotencyKey")) {
                    const existing = await findRunByIdempotencyKey(
                        input.organizationId,
                        input.idempotencyKey
                    );
                    if (existing) return { run: existing, created: false, replayed: true };
                }
            }
            throw error;
        }
    });
};

export type TransitionInput = {
    runId: string;
    to: RunStatus;
    /** Merged into the run.status.changed event payload. */
    data?: Record<string, unknown>;
    /** Optional audit id of the human/machine that asked for the change. */
    actorId?: string | null;
};

/**
 * Move a run to `to` if — and only if — the explicit transition table allows
 * it, then record the durable `run.status.changed` event.
 *
 * Terminal states are final: any attempt to move a COMPLETED / BLOCKED /
 * LIMIT_REACHED / FAILED / CANCELLED run is rejected with TERMINAL_STATE, which
 * is what stops a late engine result from reviving a cancelled run. Reaching a
 * terminal status releases the per-issue active slot in the same critical
 * section, so a follow-up launch can immediately start.
 */
export const transitionRun = async (input: TransitionInput) =>
    withRunSection(`run:${input.runId}`, async () => {
        const run = await requireRun(input.runId);
        const from = run.status as RunStatus;
        if (!isRunStatus(input.to)) {
            throw new RunError("INVALID_INPUT", `Unknown run status: ${input.to}`, {
                to: input.to,
            });
        }
        if (isTerminalRunStatus(from)) {
            throw new RunError(
                "TERMINAL_STATE",
                `Run is ${from}; terminal states cannot be changed`,
                { from, to: input.to }
            );
        }
        if (!canTransitionRun(from, input.to)) {
            throw new RunError(
                "ILLEGAL_TRANSITION",
                `Illegal run transition ${from} -> ${input.to}`,
                { from, to: input.to, allowed: legalRunTargets(from) }
            );
        }

        const terminal = isTerminalRunStatus(input.to);
        const updated = await prisma.agentRun.update({
            where: { id: input.runId },
            data: terminal
                ? { status: input.to, activeIssueId: null }
                : { status: input.to },
        });

        await appendRunEvent({
            runId: input.runId,
            type: "run.status.changed",
            issueId: updated.issueId,
            status: updated.status,
            data: {
                from,
                to: input.to,
                activeSlotReleased: terminal,
                actorId: input.actorId ?? null,
                ...(input.data ?? {}),
            },
        });
        return updated;
    });

export const cancelRun = async (input: {
    runId: string;
    actorId?: string | null;
    reason?: string;
}) =>
    transitionRun({
        runId: input.runId,
        to: "CANCELLED",
        actorId: input.actorId ?? null,
        data: { reason: input.reason ?? "cancelled by request" },
    });

export const failRun = async (input: {
    runId: string;
    actorId?: string | null;
    error: string;
}) =>
    transitionRun({
        runId: input.runId,
        to: "FAILED",
        actorId: input.actorId ?? null,
        data: { error: input.error },
    });

// Non-status bookkeeping writers (worker/CP5). Deliberately unable to touch
// `status` / `activeIssueId`: lifecycle stays owned by transitionRun.

/** Record the plan version an approval gate currently points at. */
export const setRunPlanVersion = async (runId: string, planVersion: number) => {
    const run = await requireRun(runId);
    if (run.planVersion === planVersion) return run;
    return prisma.agentRun.update({ where: { id: runId }, data: { planVersion } });
};

/** Pin the base commit observed at provision time (null -> first write). */
export const pinRunBaseCommit = async (runId: string, baseCommit: string) => {
    const run = await requireRun(runId);
    if (run.baseCommit !== null && run.baseCommit !== undefined) return run;
    return prisma.agentRun.update({ where: { id: runId }, data: { baseCommit } });
};

