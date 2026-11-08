import type { EngineEvent } from "./contract";
export type SessionState = {
    options: Record<string, unknown>;
    phase:
        | "planning"
        | "awaiting_approval"
        | "implementing"
        | "done"
        | "cancelled";
    plan: string;
    events: EngineEvent[];
    streamStart: number;
    inputs: string[];
    cancelCalls: number;
    resumeCalls: number;
    startedAt: string;
    branchName: string | null;
    headCommit: string | null;
    changedFiles: string[];
    deliveredInputs?: string[];
};
