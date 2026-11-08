import type { SessionState } from "./recovery";
// Engine + sandbox adapter contracts (CP5).
//
// docs/plans/cloud-agents-architecture.md: "All four implement the same
// internal adapter contract: capabilities, start, send input, resume, cancel,
// stream events, export session, and report usage." This file is that
// contract, transport-free so fakes (and later the real E2B/Codex/Claude/
// OpenCode/Pi integrations) can implement it identically.
//
// Hard rules the contract encodes:
//   * capability rejections are ERRORS with an explicit reason — the adapter
//     layer shares the single capability catalog (capabilities.ts), so a
//     selection rejected over HTTP is rejected identically here. There is no
//     code path that swaps engine/model/option behind the caller's back
//     ("Never switch engines silently");
//   * the engine only ever receives the Sandbox handle (read-only repo access
//     during planning); GitHub write credentials never exist here —
//     publication is a separate INTENT record consumed by the publisher
//     service (out of scope for this container, UNVERIFIED ledger);
//   * exports/usages are sanitized structures: the session export carries no
//     credentials by construction.

import type {
    AgentEngineId,
    EngineSpec,
    RunExecutionModeId,
} from "./capabilities";

// ------------------------------------------------------------------ errors --

export type EngineErrorCode =
    | "UNSUPPORTED_CAPABILITY"
    | "SESSION_NOT_FOUND"
    | "SESSION_NOT_RUNNING"
    | "SESSION_CANCELLED"
    | "STALE_APPROVAL";

export class EngineError extends Error {
    readonly code: EngineErrorCode;
    readonly details: Record<string, unknown>;

    constructor(
        code: EngineErrorCode,
        message: string,
        details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "EngineError";
        this.code = code;
        this.details = details;
    }
}

export type SandboxErrorCode =
    | "NOT_PROVISIONED"
    | "ALREADY_PROVISIONED"
    | "NOT_RUNNING"
    | "NOT_PAUSED"
    | "KILLED";

export class SandboxError extends Error {
    readonly code: SandboxErrorCode;

    constructor(code: SandboxErrorCode, message: string) {
        super(message);
        this.name = "SandboxError";
        this.code = code;
    }
}

// ---------------------------------------------------------------- sandbox --

export type SandboxState = "NEW" | "RUNNING" | "PAUSED" | "KILLED";

export type FakeCheckpoint = {
    id: string;
    at: string;
    reason: string;
    /** Full workspace snapshot — untracked/binary artifacts included. */
    files: Record<string, string>;
    tracked: string[];
    headCommit: string | null;
};

export type ExecResult = { ok: boolean; stdout: string };

/**
 * Sandbox contract: one task/run per machine. The engine receives ONLY this
 * handle — never DB or GitHub credentials.
 */
export interface Sandbox {
    readonly runId: string;
    readonly repository: string;
    readonly baseCommit: string;
    readonly state: SandboxState;
    readonly headCommit: string | null;
    /** Provision = checkout at baseCommit. Legal once, on a NEW sandbox. */
    provision(): Promise<void>;
    /** Pause keeps the workspace (E2B pause semantics). */
    pause(): Promise<void>;
    resume(): Promise<void>;
    kill(): Promise<void>;
    /**
     * External checkpoint for disaster recovery. Includes untracked files —
     * excludes credentials by construction (none ever exist here).
     */
    checkpoint(reason: string): Promise<FakeCheckpoint>;
    writeTrackedFile(path: string, content: string): Promise<boolean>;
    writeArtifact(path: string, content: string): Promise<boolean>;
    readTrackedFile(path: string): Promise<string | null>;
    trackedPaths(): Promise<string[]>;
    exec(command: string): Promise<ExecResult>;
    snapshotFiles(): Record<string, string>;
}

// ----------------------------------------------------------------- engine --

export type EngineEvent = {
    type:
        | "status"
        | "output"
        | "plan"
        | "file_change"
        | "validation"
        | "completed"
        | "cancelled";
    text?: string;
    data?: Record<string, unknown>;
};

export type EngineStartRequest = {
    runId: string;
    repository: string;
    baseCommit: string;
    executionMode: RunExecutionModeId;
    model: string;
    options: Record<string, unknown>;
    instructions: string;
    /** The engine's ONLY machine access — read-only until implementation. */
    sandbox: Sandbox;
};

export type EnginePauseResult = {
    planVersion: number;
    plan: string;
    checkpointId: string;
};

export type EngineResumeInput = {
    /** Resume happens ONLY against the exact approved plan version and base
     *  commit; anything else is a STALE_APPROVAL error. */
    approvedPlanVersion: number;
    approvedBaseCommit: string;
};

export type EngineUsageReport = {
    sessionId: string;
    engine: AgentEngineId;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
};

/** Sanitized session export: credentials CANNOT be present by construction. */
export type EngineSessionExport = {
    sessionId: string;
    runId: string;
    engine: AgentEngineId;
    model: string;
    executionMode: RunExecutionModeId;
    repository: string;
    baseCommit: string;
    planVersion: number;
    phase: string;
    usage: EngineUsageReport;
    secretRedactions: string[];
    state?: SessionState;
};

/**
 * EngineAdapter contract (docs: capabilities, start, send input, resume,
 * cancel, stream events, export session, report usage).
 */
export interface EngineAdapter {
    /** Stable implementation id, e.g. "fake:CODEX". */
    readonly id: string;
    readonly engineId: AgentEngineId;

    /** The single capability catalog — same source the HTTP layer validates. */
    capabilities(): EngineSpec;

    start(request: EngineStartRequest): Promise<{ sessionId: string }>;

    /** Ordered event stream of the CURRENT phase; stops after cancel. */
    streamEvents(sessionId: string): AsyncIterable<EngineEvent>;

    /** Persist a plan, checkpoint the workspace and pause (no approval yet —
     *  nothing tracked-file-changing has happened at this point). */
    pauseForApproval(sessionId: string): Promise<EnginePauseResult>;

    /** Re-inspect against a new base commit / rejection and produce a NEW
     *  plan version; approval of the stale plan can never resume work. */
    regeneratePlan(
        sessionId: string,
        input: { baseCommit?: string; reason: string },
    ): Promise<{ planVersion: number; plan: string }>;

    resume(
        sessionId: string,
        approved: EngineResumeInput,
    ): Promise<{ sessionId: string }>;

    sendInput(sessionId: string, text: string,
        messageId?: string,
    ): Promise<{ delivered: true }>;

    cancel(sessionId: string): Promise<{ stopped: boolean }>;

    restoreSession(
        exported: EngineSessionExport,
        sandbox: Sandbox,
    ): Promise<{ sessionId: string }>;

    exportSession(sessionId: string): Promise<EngineSessionExport>;

    reportUsage(sessionId: string): Promise<EngineUsageReport>;
}

export type SandboxSpec = {
    repository: string;
    baseCommit: string;
    headCommit?: string;
    initialFiles?: Record<string, string>;
    tracked?: string[];
};
export interface SandboxFactory {
    /** Idempotent teardown by run id. Never provisions a replacement machine. */
    destroy(runId:string):Promise<void>;
    connectOrRecreate(
        runId: string,
        spec: SandboxSpec,
    ): Promise<{ sandbox: Sandbox; recreated: boolean }>;
    create(runId: string, spec: SandboxSpec): Sandbox;
    byRun(runId: string): Sandbox | undefined;
    readonly createdCount: number;
}
