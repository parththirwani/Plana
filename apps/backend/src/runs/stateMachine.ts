// Run writes lock the database row and commit their audit events in the same transaction.
import { readTask } from "./taskContext";
import { randomUUID } from "crypto";
import { prisma, type Prisma } from "@repo/db/db";
import {
    toAgentEngine,
    mergeRuntimeReceipts,
    toRunUpdateData,
    toRunExecutionMode,
    toJsonInput,
    type AgentRunRow,
    type RunCommitPatch,
} from "./dbTypes";
import {
    appendRunEventsInTransaction,
    type RunEventDraft,
    type RunEventHint,
} from "./eventLog";
import { RunError } from "./errors";
import {
    canTransitionRun,
    isRunStatus,
    legalRunTargets,
    isTerminalRunStatus,
    type RunStatus,
} from "./status";

export type RunDb = Prisma.TransactionClient;

export const LOCK_RUN_ROW_SQL = `
SELECT "id", "issueId", "organizationId", "status", "activeIssueId",
       "planVersion", "baseCommit", "owner", "leaseExpiresAt", "fencingToken"
  FROM "AgentRun"
 WHERE "id" = $1
   FOR UPDATE
`;

export const LOCK_ISSUE_SLOT_SQL = `
SELECT "id", "status" FROM "AgentRun" WHERE "activeIssueId" = $1 FOR UPDATE
`;

export const LOCK_ISSUE_ADMISSION_SQL = `
SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) IS NULL
`;

export type LockedRunRow = {
    id: string;
    issueId: string;
    organizationId: string;
    status: RunStatus;
    activeIssueId: string | null;
    planVersion: number;
    baseCommit: string | null;
    owner: string | null;
    leaseExpiresAt: Date | string | null;
    fencingToken: number;
};

export const isoOf = (value: Date | string | null): string | null =>
    value === null
        ? null
        : value instanceof Date
          ? value.toISOString()
          : String(value);

const parseLockedRunRow = (row: unknown, runId: string): LockedRunRow => {
    const raw = (row ?? {}) as Record<string, unknown>;
    const status = raw.status;
    if (!isRunStatus(status)) {
        throw new RunError(
            "INTERNAL",
            `Run ${runId} carries an unknown status: ${String(status)}`,
            { runId, status: status ?? null },
        );
    }
    return {
        id: String(raw.id ?? runId),
        issueId: String(raw.issueId ?? ""),
        organizationId: String(raw.organizationId ?? ""),
        status,
        activeIssueId: (raw.activeIssueId as string | null) ?? null,
        planVersion: Number(raw.planVersion ?? 0),
        baseCommit: (raw.baseCommit as string | null) ?? null,
        owner: (raw.owner as string | null) ?? null,
        leaseExpiresAt: (raw.leaseExpiresAt as Date | string | null) ?? null,
        fencingToken: Number(raw.fencingToken ?? 0),
    };
};

export const lockRunRow = async (
    db: RunDb,
    runId: string,
): Promise<LockedRunRow> => {
    const rows = await db.$queryRawUnsafe<unknown[]>(LOCK_RUN_ROW_SQL, runId);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new RunError("NOT_FOUND", "Run not found", { runId });
    return parseLockedRunRow(row, runId);
};

export const lockIssueSlot = async (
    db: RunDb,
    issueId: string,
): Promise<{ id: string; status: string } | null> => {
    await db.$queryRawUnsafe(LOCK_ISSUE_ADMISSION_SQL, issueId);
    const rows = await db.$queryRawUnsafe<unknown[]>(
        LOCK_ISSUE_SLOT_SQL,
        issueId,
    );
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
        Record<string, unknown> | undefined;
    return row ? { id: String(row.id), status: String(row.status) } : null;
};

export type RunOwnership = {
    machineId: string;
    fencingToken: number;
    jobId?: string;
    jobOwner?: string;
    jobFencingToken?: number;
};

export const ownsRunLease = (
    run: Pick<LockedRunRow, "owner" | "fencingToken" | "leaseExpiresAt">,
    claim: RunOwnership,
    nowMs: number,
): boolean =>
    run.owner === claim.machineId &&
    run.fencingToken === claim.fencingToken &&
    isoOf(run.leaseExpiresAt) !== null &&
    Date.parse(isoOf(run.leaseExpiresAt)!) > nowMs;

const assertOwnership = (
    run: LockedRunRow,
    claim: RunOwnership | undefined,
    nowMs: number,
): void => {
    if (!claim) return;
    if (ownsRunLease(run, claim, nowMs)) return;
    throw new RunError(
        "STALE_CLAIM",
        `Worker ${claim.machineId} no longer owns run ${run.id}`,
        {
            runId: run.id,
            machineId: claim.machineId,
            runFencingToken: run.fencingToken,
            claimFencingToken: claim.fencingToken,
            leaseExpiresAt: isoOf(run.leaseExpiresAt),
        },
    );
};

export type ClaimRunLeaseInput = {
    runId: string;
    machineId: string;
    leaseTtlMillis: number;

    expectedStatus: RunStatus;
    now?: Date;
};

export const claimRunLease = async (
    db: RunDb,
    input: ClaimRunLeaseInput,
): Promise<RunOwnership> => {
    const now = input.now ?? new Date();
    const updated = await db.agentRun.updateMany({
        where: {
            id: input.runId,
            status: input.expectedStatus,
            OR: [
                { owner: null },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lt: now.toISOString() } },
            ],
        },
        data: {
            owner: input.machineId,
            leaseExpiresAt: new Date(
                now.getTime() + input.leaseTtlMillis,
            ).toISOString(),
            fencingToken: { increment: 1 },
        },
    });
    if (updated.count !== 1) {
        throw new RunError(
            "STALE_CLAIM",
            `Could not acquire the execution lease for run ${input.runId}`,
            {
                runId: input.runId,
                machineId: input.machineId,
                expectedStatus: input.expectedStatus,
            },
        );
    }
    const run = await db.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { fencingToken: true },
    });
    return { machineId: input.machineId, fencingToken: run.fencingToken };
};

export type RenewRunLeaseInput = {
    runId: string;
    claim: RunOwnership;
    leaseTtlMillis: number;
    reason?: string;
    now?: Date;
};

export const renewRunLease = async (
    db: RunDb,
    input: RenewRunLeaseInput,
): Promise<boolean> => {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(
        now.getTime() + input.leaseTtlMillis,
    ).toISOString();
    const updated = await db.agentRun.updateMany({
        where: {
            id: input.runId,
            owner: input.claim.machineId,
            fencingToken: input.claim.fencingToken,
            leaseExpiresAt: { gte: now.toISOString() },
        },
        data: { leaseExpiresAt },
    });
    if (updated.count !== 1) return false;
    await db.runLeaseRenewal.create({
        data: {
            runId: input.runId,
            machineId: input.claim.machineId,
            fencingToken: input.claim.fencingToken,
            leaseExpiresAt,
            reason: input.reason ?? "lease renewal",
        },
    });
    return true;
};

export const assertRunOwnership = async (
    db: RunDb,
    runId: string,
    claim?: RunOwnership,
): Promise<LockedRunRow> => {
    const run = await lockRunRow(db, runId);
    assertOwnership(run, claim, Date.now());
    if (claim?.jobId) {
        const [job] = await db.$queryRawUnsafe<
            Array<{
                status: string;
                lockedBy: string | null;
                fencingToken: number;
                leaseExpiresAt: Date | null;
            }>
        >(
            `SELECT "status","lockedBy","fencingToken","leaseExpiresAt" FROM "AgentJob" WHERE "id" = $1 FOR UPDATE`,
            claim.jobId,
        );
        if (
            !job ||
            job.status !== "RUNNING" ||
            job.lockedBy !== claim.jobOwner ||
            job.fencingToken !== claim.jobFencingToken ||
            !job.leaseExpiresAt ||
            new Date(job.leaseExpiresAt).getTime() <= Date.now()
        )
            throw new RunError("STALE_CLAIM", "Queue ownership lost", {
                jobId: claim.jobId,
            });
    }
    return run;
};

export type RunTransitionCommit = RunCommitPatch;

export type GuardedTransitionInput = {
    runId: string;

    expectedFrom: RunStatus;
    to: RunStatus;
    data?: Record<string, unknown>;
    commit?: RunTransitionCommit;

    claim?: RunOwnership;

    extraEvents?: readonly RunEventDraft[];
    actorId?: string | null;

    steps?: readonly ((
        db: Prisma.TransactionClient,
    ) => Promise<void | boolean>)[];
};

export type GuardedTransitionResult = {
    run: AgentRunRow;
    from: RunStatus;
    to: RunStatus;
    activeSlotReleased: boolean;
    hints: RunEventHint[];
};

const isUniqueViolation = (error: unknown) =>
    (error as { code?: string } | null)?.code === "P2002";

export const guardedTransition = async (
    input: GuardedTransitionInput,
): Promise<GuardedTransitionResult> => {
    const result = await prisma.$transaction(async (tx) => {
        const locked = await assertRunOwnership(tx, input.runId, input.claim);
        const from = locked.status;

        if (from !== input.expectedFrom) {
            throw new RunError(
                "ILLEGAL_TRANSITION",
                `Run ${input.runId} is ${from}, not ${input.expectedFrom}`,
                {
                    runId: input.runId,
                    expectedFrom: input.expectedFrom,
                    actualStatus: from,
                    raced: true,
                },
            );
        }
        if (!canTransitionRun(from, input.to)) {
            throw new RunError(
                isTerminalStatus(from)
                    ? "TERMINAL_STATE"
                    : "ILLEGAL_TRANSITION",
                `Illegal run transition ${from} -> ${input.to}`,
                { from, to: input.to, allowed: legalRunTargets(from) },
            );
        }

        const released = !isActiveStatus(input.to);
        const runtimePatch =
            input.commit?.runtime === undefined
                ? {}
                : {
                      runtime: mergeRuntimeReceipts(
                          (
                              await tx.agentRun.findUniqueOrThrow({
                                  where: { id: input.runId },
                              })
                          ).runtime,
                          input.commit.runtime,
                      ),
                  };
        const updated = await tx.agentRun.updateMany({
            where: { id: input.runId, status: from },
            data: toRunUpdateData(input.to, {
                ...(input.commit ?? {}),
                ...runtimePatch,
                ...(released ? { activeIssueId: null } : {}),
            }),
        });
        if (updated.count !== 1) {
            throw new RunError(
                "ILLEGAL_TRANSITION",
                `Run ${input.runId} changed while this transition was committing`,
                { runId: input.runId, from, to: input.to, raced: true },
            );
        }

        const hints = await appendRunEventsInTransaction(tx, {
            runId: input.runId,
            issueId: locked.issueId,
            status: input.to,
            drafts: [
                {
                    type: "run.status.changed",
                    data: {
                        from,
                        to: input.to,
                        activeSlotReleased: released,
                        actorId: input.actorId ?? null,
                        fencingToken: locked.fencingToken,
                        ...(input.data ?? {}),
                    },
                },
                ...(input.extraEvents ?? []),
            ],
        });

        for (const step of input.steps ?? []) {
            if ((await step(tx)) === false) {
                throw new RunError(
                    "INTERNAL",
                    `Run transition step aborted for run ${input.runId}`,
                    { runId: input.runId, from, to: input.to },
                );
            }
        }

        const row = await tx.agentRun.findUniqueOrThrow({
            where: { id: input.runId },
        });
        return {
            run: row,
            from,
            to: input.to,
            activeSlotReleased: released,
            hints,
        } satisfies GuardedTransitionResult;
    });
    return result;
};

export const isActiveStatus = (status: RunStatus): boolean =>
    !isTerminalRunStatus(status);

export const isTerminalStatus = (status: RunStatus): boolean =>
    isTerminalRunStatus(status);

export type LaunchRunInput = {
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
    branchName: string;
    idempotencyKey: string;

    event?: Record<string, unknown>;

    steps?: readonly ((
        db: Prisma.TransactionClient,
    ) => Promise<void | boolean>)[];
};

export type LaunchRunResult = {
    run: AgentRunRow;
    created: boolean;

    replayed?: boolean;

    hints: RunEventHint[];
};

const activeRunExists = (runId: string | null, status: string | null) =>
    new RunError(
        "ACTIVE_RUN_EXISTS",
        "This issue already has an active agent run",
        { runId, status },
    );

const uniqueTarget = (error: unknown): string => {
    const target = (error as { meta?: { target?: unknown } } | null)?.meta
        ?.target;
    return Array.isArray(target) ? target.join(",") : String(target ?? "");
};

export const launchRun = async (
    input: LaunchRunInput,
): Promise<LaunchRunResult> => {
    try {
        const result = await prisma.$transaction(
            async (tx): Promise<LaunchRunResult> => {
                const replay = await tx.agentRun.findUnique({
                    where: {
                        organizationId_idempotencyKey: {
                            organizationId: input.organizationId,
                            idempotencyKey: input.idempotencyKey,
                        },
                    },
                });
                if (replay)
                    return {
                        run: replay,
                        created: false,
                        replayed: true,
                        hints: [],
                    };
                const holder = await lockIssueSlot(tx, input.issueId);
                const raced = await tx.agentRun.findUnique({
                    where: {
                        organizationId_idempotencyKey: {
                            organizationId: input.organizationId,
                            idempotencyKey: input.idempotencyKey,
                        },
                    },
                });
                if (raced)
                    return {
                        run: raced,
                        created: false,
                        replayed: true,
                        hints: [],
                    };
                if (
                    holder &&
                    isRunStatus(holder.status) &&
                    isActiveStatus(holder.status)
                ) {
                    throw activeRunExists(holder.id, holder.status);
                }

                const id = input.id ?? `run_${randomUUID()}`;
                const created = await tx.agentRun.create({
                    data: {
                        id,
                        issueId: input.issueId,
                        organizationId: input.organizationId,
                        createdBy: input.createdBy,
                        engine: toAgentEngine(input.engine),
                        model: input.model,
                        taskSnapshot: toJsonInput(
                            await readTask(tx, input.issueId),
                        ),
                        options: toJsonInput(input.options ?? {}),
                        executionMode: toRunExecutionMode(
                            input.executionMode ?? "IMPLEMENT",
                        ),
                        repository: input.repository,
                        baseCommit: input.baseCommit ?? null,
                        branchName: input.branchName,
                        status: "QUEUED",
                        activeIssueId: input.issueId,
                        planVersion: 0,
                        idempotencyKey: input.idempotencyKey,
                    },
                });

                const hints = await appendRunEventsInTransaction(tx, {
                    runId: created.id,
                    issueId: created.issueId,
                    status: created.status,
                    drafts: [
                        {
                            type: "run.created",
                            data: {
                                engine: created.engine,
                                model: created.model,
                                options: created.options ?? {},
                                executionMode: created.executionMode,
                                repository: created.repository,
                                baseCommit: created.baseCommit ?? null,
                                branchName: created.branchName,
                                status: created.status,
                                ...(input.event ?? {}),
                            },
                        },
                    ],
                });

                for (const step of input.steps ?? []) {
                    if ((await step(tx)) === false) {
                        throw new RunError(
                            "INTERNAL",
                            `Run launch step aborted for issue ${input.issueId}`,
                            { issueId: input.issueId },
                        );
                    }
                }

                return { run: created, created: true, hints };
            },
            { isolationLevel: "ReadCommitted" },
        );
        return result;
    } catch (error) {
        if (isUniqueViolation(error)) {
            const target = uniqueTarget(error);
            if (target.includes("activeIssueId")) {
                const winner = await prisma.agentRun.findUnique({
                    where: { activeIssueId: input.issueId },
                    select: { id: true, status: true },
                });
                throw activeRunExists(
                    winner?.id ?? null,
                    winner?.status ?? null,
                );
            }
            if (target.includes("idempotencyKey")) {
                const existing = await prisma.agentRun.findUnique({
                    where: {
                        organizationId_idempotencyKey: {
                            organizationId: input.organizationId,
                            idempotencyKey: input.idempotencyKey,
                        },
                    },
                });
                if (existing)
                    return {
                        run: existing,
                        created: false,
                        replayed: true,
                        hints: [],
                    };
            }
        }
        throw error;
    }
};
