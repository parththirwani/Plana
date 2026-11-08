// Run lifecycle status machine (CP1 enum + CP3 legal-transition table).
//
// The enum values mirror `enum RunStatus` in packages/db/prisma/schema.prisma
// and the migration; keep the three in sync when changing this list.
//
// Transition policy (deliberately explicit and narrow — anything not listed is
// rejected):
//   * forward progress follows the lifecycle in docs/plans/...architecture.md;
//   * every non-terminal state may fall out to BLOCKED / LIMIT_REACHED / FAILED
//     / CANCELLED (a user cancel or a budget/limit trip must always win);
//   * PROVISIONING -> VALIDATING and QUEUED -> IMPLEMENTING exist for lease
//     reclaim: a worker that re-acquires an expired lease resumes from the
//     persisted step rather than replaying provisioning/planning;
//   * AWAITING_APPROVAL -> PLANNING is the re-plan path (stale base commit or
//     changed requirements force plan regeneration);
//   * PUBLISHING may only end in COMPLETED / FAILED / LIMIT_REACHED / BLOCKED:
//     the publication INTENT is already durable at that point, so cancelling
//     mid-publication is not honoured (CP5 makes cancellation prevent
//     publication *before* the intent is recorded);
//   * terminal states are final: a late engine result can never revive a
//     cancelled/failed/completed run.

export const RUN_STATUSES = [
    "QUEUED",
    "PROVISIONING",
    "PLANNING",
    "AWAITING_APPROVAL",
    "IMPLEMENTING",
    "VALIDATING",
    "REVIEWING",
    "PUBLISHING",
    "COMPLETED",
    "BLOCKED",
    "LIMIT_REACHED",
    "FAILED",
    "CANCELLED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = [
    "COMPLETED",
    "BLOCKED",
    "LIMIT_REACHED",
    "FAILED",
    "CANCELLED",
] as const satisfies readonly RunStatus[];

export const isTerminalRunStatus = (status: string): status is RunStatus =>
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

export const isRunStatus = (status: unknown): status is RunStatus =>
    typeof status === "string" &&
    (RUN_STATUSES as readonly string[]).includes(status);

export const LEGAL_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> =
    {
        QUEUED: [
            "PROVISIONING",
            "PLANNING",
            "IMPLEMENTING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        PROVISIONING: [
            "PLANNING",
            "IMPLEMENTING",
            "VALIDATING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        PLANNING: [
            "AWAITING_APPROVAL",
            "IMPLEMENTING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        AWAITING_APPROVAL: [
            "PLANNING",
            "IMPLEMENTING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        IMPLEMENTING: [
            "VALIDATING",
            "AWAITING_APPROVAL",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        VALIDATING: [
            "REVIEWING",
            "IMPLEMENTING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        REVIEWING: [
            "PUBLISHING",
            "IMPLEMENTING",
            "BLOCKED",
            "LIMIT_REACHED",
            "FAILED",
            "CANCELLED",
        ],
        PUBLISHING: ["COMPLETED", "BLOCKED", "LIMIT_REACHED", "FAILED"],
        COMPLETED: [],
        BLOCKED: [],
        LIMIT_REACHED: [],
        FAILED: [],
        CANCELLED: [],
    };

export const legalRunTargets = (from: RunStatus): readonly RunStatus[] =>
    LEGAL_RUN_TRANSITIONS[from] ?? [];

export const canTransitionRun = (from: unknown, to: unknown): boolean => {
    if (!isRunStatus(from) || !isRunStatus(to)) return false;
    return legalRunTargets(from).includes(to);
};
