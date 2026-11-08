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
    "FAILED",
    "CANCELLED",
] as const;

export const isTerminalRunStatus = (status: string): boolean =>
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

export const isRunStatus = (value: unknown): value is RunStatus =>
    typeof value === "string" &&
    (RUN_STATUSES as readonly string[]).includes(value);
const exits: readonly RunStatus[] = [
    "BLOCKED",
    "LIMIT_REACHED",
    "FAILED",
    "CANCELLED",
];

export const LEGAL_RUN_TRANSITIONS: Readonly<
    Record<RunStatus, readonly RunStatus[]>
> = {
    QUEUED: ["PROVISIONING", "PLANNING", "IMPLEMENTING", ...exits],
    PROVISIONING: ["PLANNING", "IMPLEMENTING", "VALIDATING", ...exits],
    PLANNING: ["AWAITING_APPROVAL", "IMPLEMENTING", ...exits],
    AWAITING_APPROVAL: ["PLANNING", "IMPLEMENTING", ...exits],
    IMPLEMENTING: ["VALIDATING", "AWAITING_APPROVAL", "PLANNING", ...exits],
    VALIDATING: ["REVIEWING", "IMPLEMENTING", ...exits],
    REVIEWING: ["PUBLISHING", "IMPLEMENTING", ...exits],
    PUBLISHING: ["COMPLETED", ...exits],
    BLOCKED: [
        "QUEUED",
        "PROVISIONING",
        "PLANNING",
        "AWAITING_APPROVAL",
        "IMPLEMENTING",
        "VALIDATING",
        "REVIEWING",
        "PUBLISHING",
        "LIMIT_REACHED",
        "FAILED",
        "CANCELLED",
    ],
    LIMIT_REACHED: [
        "QUEUED",
        "PROVISIONING",
        "PLANNING",
        "AWAITING_APPROVAL",
        "IMPLEMENTING",
        "VALIDATING",
        "REVIEWING",
        "PUBLISHING",
        "BLOCKED",
        "FAILED",
        "CANCELLED",
    ],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
};

export const legalRunTargets = (from: RunStatus): readonly RunStatus[] =>
    LEGAL_RUN_TRANSITIONS[from] ?? [];

export const canTransitionRun = (from: unknown, to: unknown): boolean =>
    isRunStatus(from) && isRunStatus(to) && legalRunTargets(from).includes(to);
