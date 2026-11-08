// Typed run-layer errors (CP3). The HTTP layer (CP4) maps these onto the
// README status codes (400/401/403/404/409) instead of inferring intent from
// string messages, so the run modules stay transport-agnostic and testable.

export const RUN_ERROR_CODES = [
    "INVALID_INPUT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "ILLEGAL_TRANSITION",
    "TERMINAL_STATE",
    "ACTIVE_RUN_EXISTS",
    "STALE_APPROVAL",
    "STALE_CLAIM",
    "UNSUPPORTED_CAPABILITY",
    "INTERNAL",
] as const;

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

export class RunError extends Error {
    readonly code: RunErrorCode;
    readonly details: Record<string, unknown>;

    constructor(
        code: RunErrorCode,
        message: string,
        details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = "RunError";
        this.code = code;
        this.details = details;
    }
}

export const isRunError = (error: unknown): error is RunError =>
    error instanceof RunError ||
    (!!error &&
        typeof error === "object" &&
        (error as any).name === "RunError" &&
        typeof (error as any).code === "string");

export const runErrorFrom = (error: unknown): RunError | null =>
    isRunError(error) ? (error as RunError) : null;
