// The run state machine: every run mutation is ONE Postgres transaction.
//
// WHY THIS MODULE EXISTS (review findings #1, #2, #3, #4)
// Before this module, "create a run", "move a run to its next status" and
// "enqueue the worker's job" were separate round-trips guarded by a
// process-local `AsyncMutex`. The review demonstrated four defects that fall
// straight out of that shape:
//
//   1. a launch could persist the run and then fail while appending its first
//      event or enqueueing its job, leaving a STRANDED active run that holds
//      the per-issue slot forever;
//   2. a status change was `read -> validate -> UPDATE status = ...` with no
//      condition on the value that was read, so two processes that both read
//      IMPLEMENTING could both write — and a late result could move a run that
//      had already been CANCELLED back into an executing state;
//   3. ownership was a column nothing checked, so a worker whose lease had
//      expired kept mutating the run and recording publication;
//   4. the guard was an in-memory mutex: correct inside one process,
//      meaningless across the two or three processes a real deployment runs.
//
// THE MODEL THIS ENFORCES
//   * Postgres holds the authoritative state. The row lock IS the critical
//     section, so the guarantees hold across processes by construction rather
//     than by convention;
//   * every transition is a single interactive `$transaction` that locks the
//     run row (`FOR UPDATE`), asserts `status == expectedFrom`, asserts the
//     legal-transition table, asserts the acting worker still owns a live lease
//     at a known fencing token, applies the guarded update and appends the
//     durable event — or nothing at all happens;
//   * terminal states are final: a transition out of a terminal status can
//     never match the status guard, so a late engine result cannot revive a
//     cancelled / failed / completed run;
//   * `AgentRun.activeIssueId` (unique) is the one-active-run-per-issue
//     invariant and doubles as the admission ticket: a launch locks that row
//     `FOR UPDATE` before it decides, so concurrent launches serialize on the
//     ISSUE instead of racing. The unique index stays the last line of defence.
//
// Raw SQL is confined to the two row-lock statements below (Prisma has no
// `FOR UPDATE`). The locks deliberately select the MINIMAL column set the
// guards need and exclude `updated_at`: reading a column the same transaction
// is about to write has produced driver-level serialization failures here.

import { randomUUID } from "crypto";
import { prisma, type Prisma } from "@repo/db/db";
import {
    toAgentEngine,
    toRunUpdateData,
    toRunExecutionMode,
    toJsonInput,
    type AgentRunRow,
    type RunCommitPatch,
} from "./dbTypes";
import {
    appendRunEventsInTransaction,
    publishRunEventHints,
    type RunEventDraft,
    type RunEventHint,
} from "./eventLog";
import { RunError } from "./errors";
import {
    canTransitionRun,
    isRunStatus,
    legalRunTargets,
    type RunStatus,
} from "./status";

/** Database handle: the global client or an interactive transaction. */
export type RunDb = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Row locks
// ---------------------------------------------------------------------------

/** Lock + read the run row the guards must decide on. */
export const LOCK_RUN_ROW_SQL = `
SELECT "id", "issueId", "organizationId", "status", "activeIssueId",
       "planVersion", "baseCommit", "owner", "leaseExpiresAt", "fencingToken"
  FROM "AgentRun"
 WHERE "id" = $1
   FOR UPDATE
`;

/** Lock the ACTIVE run of an ISSUE, when there is one. */
export const LOCK_ISSUE_SLOT_SQL = `
SELECT "id", "status" FROM "AgentRun" WHERE "activeIssueId" = $1 FOR UPDATE
`;

/** Admission control needs something to lock even when nobody is home.
 *
 *  Locking the holder row only serializes launches while an issue IS occupied.
 *  When it is free, two processes both read "no holder", both decide to admit,
 *  and the loser is discovered afterwards by the unique index on `activeIssueId`
 *  — correct, but it turns a routine concurrent launch into an aborted
 *  transaction. A transaction-scoped advisory key derived from the issue id gives
 *  the decision something to lock in the free case too: the second launch blocks
 *  until the first COMMITs (then replays or refuses with the typed error) or
 *  ROLLBACKs (then admits). Because it is an *xact* lock it cannot outlive a
 *  crashed process, so an issue can never be stranded by a dead worker. The
 *  unique index stays as the backstop — hashing picks a lock key, and a collision
 *  only costs two issues sharing a queue, never a double admission.
 *
 *  The `IS NULL` wrapper is load-bearing, not stylistic: `pg_advisory_xact_lock`
 *  returns `void`, and the pg driver adapter refuses to deserialize a `void`
 *  column (`UnsupportedNativeDataType`), so the statement has to yield something
 *  typed. Comparing to NULL is the cheapest way to discard a value whose only
 *  purpose was to take the lock. Postgres caught this; no mock did. */
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

/** Parse one locked row. An unrecognised status is a hard error: the machine
 *  refuses to reason about a run it cannot classify. */
const parseLockedRunRow = (row: unknown, runId: string): LockedRunRow => {
    const raw = (row ?? {}) as Record<string, unknown>;
    const status = raw.status;
    if (!isRunStatus(status)) {
        throw new RunError(
            "INTERNAL",
            `Run ${runId} carries an unknown status: ${String(status)}`,
            { runId, status: status ?? null }
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

/** Lock (i.e. serialize on) a run row. NOT_FOUND when it does not exist. */
export const lockRunRow = async (
    db: RunDb,
    runId: string
): Promise<LockedRunRow> => {
    const rows = await db.$queryRawUnsafe<unknown[]>(LOCK_RUN_ROW_SQL, runId);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) throw new RunError("NOT_FOUND", "Run not found", { runId });
    return parseLockedRunRow(row, runId);
};

/** Serialize admission for one ISSUE, then report who holds it.
 *
 *  The advisory key is taken first (it also covers the "issue is free" case),
 *  then the holder row is locked so its status cannot change under the decision.
 *  Returns the holder when the slot is taken.
 */
export const lockIssueSlot = async (
    db: RunDb,
    issueId: string
): Promise<{ id: string; status: string } | null> => {
    await db.$queryRawUnsafe(LOCK_ISSUE_ADMISSION_SQL, issueId);
    const rows = await db.$queryRawUnsafe<unknown[]>(LOCK_ISSUE_SLOT_SQL, issueId);
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
        | Record<string, unknown>
        | undefined;
    return row ? { id: String(row.id), status: String(row.status) } : null;
};

// ---------------------------------------------------------------------------
// Ownership: executing lease + fencing token
// ---------------------------------------------------------------------------

export type RunOwnership = {
    machineId: string;
    fencingToken: number;
};

/** True when `claim` still owns the run: same machine, same fencing token and
 *  an unexpired lease. Asserted immediately before EVERY run mutation. */
export const ownsRunLease = (
    run: Pick<LockedRunRow, "owner" | "fencingToken" | "leaseExpiresAt">,
    claim: RunOwnership,
    nowMs: number
): boolean =>
    run.owner === claim.machineId &&
    run.fencingToken === claim.fencingToken &&
    isoOf(run.leaseExpiresAt) !== null &&
    Date.parse(isoOf(run.leaseExpiresAt)!) > nowMs;

const assertOwnership = (
    run: LockedRunRow,
    claim: RunOwnership | undefined,
    nowMs: number
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
        }
    );
};

/**
 * Acquire (or reclaim) the run's executing lease. The ONLY place a fencing
 * token is incremented, and it is atomic: the UPDATE's WHERE re-checks exactly
 * what this caller believed to be true, so a worker that was cancelled or
 * reclaimed underneath gets zero rows and STALE_CLAIM without writing.
 */
export type ClaimRunLeaseInput = {
    runId: string;
    machineId: string;
    leaseTtlMillis: number;
    /** The status the caller believes the run is in (its own optimistic guard). */
    expectedStatus: RunStatus;
    now?: Date;
};

export const claimRunLease = async (
    db: RunDb,
    input: ClaimRunLeaseInput
): Promise<RunOwnership> => {
    const now = input.now ?? new Date();
    const updated = await db.agentRun.updateMany({
        where: {
            id: input.runId,
            status: input.expectedStatus,
            OR: [
                { owner: input.machineId },
                { owner: null },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lt: now.toISOString() } },
            ],
        },
        data: {
            owner: input.machineId,
            leaseExpiresAt: new Date(
                now.getTime() + input.leaseTtlMillis
            ).toISOString(),
            // `increment` keeps the token strictly monotonic table-wide, so a
            // token handed to an old owner is never reused by a new one.
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
            }
        );
    }
    const run = await db.agentRun.findUniqueOrThrow({
        where: { id: input.runId },
        select: { fencingToken: true },
    });
    return { machineId: input.machineId, fencingToken: run.fencingToken };
};

/**
 * Extend the executing lease and audit it. Returns false when this caller no
 * longer owns the run — the worker MUST treat false as "stop mutating" and
 * abandon the in-flight step on a run somebody else now owns.
 */
export type RenewRunLeaseInput = {
    runId: string;
    claim: RunOwnership;
    leaseTtlMillis: number;
    reason?: string;
    now?: Date;
};

export const renewRunLease = async (
    db: RunDb,
    input: RenewRunLeaseInput
): Promise<boolean> => {
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(
        now.getTime() + input.leaseTtlMillis
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

/** Lock the run and assert `claim` still owns it. Call this immediately before
 *  EVERY mutation of the run, not once per job. */
export const assertRunOwnership = async (
    db: RunDb,
    runId: string,
    claim?: RunOwnership
): Promise<LockedRunRow> => {
    const run = await lockRunRow(db, runId);
    assertOwnership(run, claim, Date.now());
    return run;
};

// ---------------------------------------------------------------------------
// Guarded transition primitive
// ---------------------------------------------------------------------------

/** Non-status columns a transition may persist in the SAME statement (plan
 *  version, pinned base commit, first-attempt stamp, publication bookkeeping —
 *  CP-F). `status` / `activeIssueId` are owned by the guard alone and cannot be
 *  smuggled through a patch: they are mapped by `toRunUpdateData`, which has no
 *  slot for anything but the status the guard just validated. */
export type RunTransitionCommit = RunCommitPatch;

export type GuardedTransitionInput = {
    runId: string;
    /** The status the caller read. A mismatch means the row moved underneath:
     *  the transition is REJECTED, never silently applied on top. */
    expectedFrom: RunStatus;
    to: RunStatus;
    data?: Record<string, unknown>;
    commit?: RunTransitionCommit;
    /** Acting worker. When present, ownership (lease + fencing token) is
     *  asserted inside the same transaction as the write. */
    claim?: RunOwnership;
    /** Extra durable event appended after `run.status.changed`, same tx. */
    extraEvents?: readonly RunEventDraft[];
    actorId?: string | null;
    /** Runs inside the transaction, after the guarded write, before commit. */
    steps?: readonly ((db: Prisma.TransactionClient) => Promise<void | boolean>)[];
};

export type GuardedTransitionResult = {
    /** The row as it reads AFTER the guarded write — full row, not the
     *  minimal lock projection, so callers never re-read (and never race). */
    run: AgentRunRow;
    from: RunStatus;
    to: RunStatus;
    activeSlotReleased: boolean;
    hints: RunEventHint[];
};

const isUniqueViolation = (error: unknown) =>
    (error as { code?: string } | null)?.code === "P2002";

/**
 * The one guarded transition primitive. Everything that moves a run's status
 * funnels through here, inside ONE transaction:
 *
 *   lock run (FOR UPDATE)            -> serializes every decision per run
 *   status == expectedFrom           -> lost updates become REJECT, not overwrite
 *   legal-transition table         -> terminal states are final, no revive
 *   lease + fencing token still ours -> a zombie worker cannot write
 *   UPDATE … WHERE status = from     -> the guard is re-checked a third time
 *                                        by the statement itself
 *   append durable event(s)          -> status change and its audit trail are
 *                                        inseparable
 *
 * Realtime hints are returned, never published here: the caller emits them only
 * after COMMIT, so a rollback cannot leak a hint for an event that does not
 * exist.
 */
export const guardedTransition = async (
    input: GuardedTransitionInput
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
                }
            );
        }
        if (!canTransitionRun(from, input.to)) {
            throw new RunError(
                isTerminalStatus(from)
                    ? "TERMINAL_STATE"
                    : "ILLEGAL_TRANSITION",
                `Illegal run transition ${from} -> ${input.to}`,
                { from, to: input.to, allowed: legalRunTargets(from) }
            );
        }

        const released = !isActiveStatus(input.to);
        const updated = await tx.agentRun.updateMany({
            // The WHERE re-states the guard a third time: even a bug in the
            // code above cannot move a row whose status is not `from`.
            where: { id: input.runId, status: from },
            data: toRunUpdateData(input.to, {
                ...(input.commit ?? {}),
                ...(released ? { activeIssueId: null } : {}),
            }),
        });
        if (updated.count !== 1) {
            throw new RunError(
                "ILLEGAL_TRANSITION",
                `Run ${input.runId} changed while this transition was committing`,
                { runId: input.runId, from, to: input.to, raced: true }
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
                    { runId: input.runId, from, to: input.to }
                );
            }
        }

        const row = await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } });
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

/** Statuses that still occupy the per-issue active slot. Anything else must
 *  have released it in the same transaction that wrote it. */
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
    "QUEUED",
    "PROVISIONING",
    "PLANNING",
    "AWAITING_APPROVAL",
    "IMPLEMENTING",
    "VALIDATING",
    "REVIEWING",
    "PUBLISHING",
];

/** COMPLETED / FAILED / CANCELLED: final, nothing may follow them. */
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
];

export const isActiveStatus = (status: RunStatus): boolean =>
    ACTIVE_RUN_STATUSES.includes(status);

export const isTerminalStatus = (status: RunStatus): boolean =>
    TERMINAL_RUN_STATUSES.includes(status);

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

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
    /** Extra payload merged into the durable `run.created` event. */
    event?: Record<string, unknown>;
    /**
     * Work that must commit or roll back WITH the run, in order. CP-A enqueues
     * the worker's durable job here. A throw (or a returned `false`) aborts the
     * whole launch: there is no interleaving where the run row is visible but
     * its queued work is not, and no failed attempt can leave a run that no
     * worker will ever execute.
     */
    steps?: readonly ((db: Prisma.TransactionClient) => Promise<void | boolean>)[];
};

export type LaunchRunResult = {
    /** The generated AgentRun row (structurally the layer's AgentRunRow). */
    run: AgentRunRow;
    created: boolean;
    /** Set when the caller's idempotency key replayed an existing run. */
    replayed?: boolean;
    /** Persisted `run.created` hint(s) — publish them only AFTER this call
     *  returns, i.e. after the transaction committed. */
    hints: RunEventHint[];
};

const activeRunExists = (runId: string | null, status: string | null) =>
    new RunError(
        "ACTIVE_RUN_EXISTS",
        "This issue already has an active agent run",
        { runId, status }
    );

const uniqueTarget = (error: unknown): string => {
    const target = (error as { meta?: { target?: unknown } } | null)?.meta?.target;
    return Array.isArray(target) ? target.join(",") : String(target ?? "");
};

/**
 * Launch a run: the queue-state row, its durable first event and every
 * registered follow-up step (the worker's queued job) commit in ONE
 * transaction, serialized against other launches of the same issue by a
 * `FOR UPDATE` on the issue's active-run row.
 *
 * The failure semantics the CP-A suite drives against a real database:
 *   * a step that throws rolls the run row, the event and the slot back
 *     ATOMICALLY — no stranded active run, and a retry starts clean;
 *   * two concurrent launches serialize on the row lock, so exactly one active
 *     run exists (the unique index is the backstop, translated into the same
 *     typed error);
 *   * the same idempotency key replays the original run instead of creating a
 *     second one.
 */
export const launchRun = async (
    input: LaunchRunInput
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
                if (replay) return { run: replay, created: false, replayed: true, hints: [] };

                // Admission: serialize on the ISSUE before deciding. Without a
                // live run there is nothing to lock yet, and the unique index
                // on activeIssueId decides the race (translated below).
                const holder = await lockIssueSlot(tx, input.issueId);
                // Re-check the idempotency key AFTER the lock. A concurrent
                // launch with the same key can commit between the first check
                // and this lock; reading after the lock is what turns a retried
                // launch into a replay of the committed run instead of a
                // spurious ACTIVE_RUN_EXISTS.
                const raced = await tx.agentRun.findUnique({
                    where: {
                        organizationId_idempotencyKey: {
                            organizationId: input.organizationId,
                            idempotencyKey: input.idempotencyKey,
                        },
                    },
                });
                if (raced) return { run: raced, created: false, replayed: true, hints: [] };
                if (holder && isRunStatus(holder.status) && isActiveStatus(holder.status)) {
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
                        options: toJsonInput(input.options ?? {}),
                        executionMode: toRunExecutionMode(
                            input.executionMode ?? "IMPLEMENT"
                        ),
                        repository: input.repository,
                        baseCommit: input.baseCommit ?? null,
                        branchName: input.branchName,
                        status: "QUEUED",
                        // The slot is claimed in the same INSERT as the row:
                        // there is no window where a run exists unclaimed.
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
                            { issueId: input.issueId }
                        );
                    }
                }

                return { run: created, created: true, hints };
            },
            { isolationLevel: "ReadCommitted" }
        );
        return result;
    } catch (error) {
        // Rolled back. Translate the DB-level backstops into the same typed
        // errors the in-process path produces, so no caller (or HTTP status
        // mapping) can tell which guard caught the race.
        if (isUniqueViolation(error)) {
            const target = uniqueTarget(error);
            if (target.includes("activeIssueId")) {
                const winner = await prisma.agentRun.findUnique({
                    where: { activeIssueId: input.issueId },
                    select: { id: true, status: true },
                });
                throw activeRunExists(winner?.id ?? null, winner?.status ?? null);
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
                    return { run: existing, created: false, replayed: true, hints: [] };
            }
        }
        throw error;
    }
};
