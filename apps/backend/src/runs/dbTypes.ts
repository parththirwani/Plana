// Honest database-boundary types for the run domain (CP-J).
//
// WHY THIS MODULE EXISTS
// The run data layer previously laundered AgentRun rows through `run: any`,
// which hid real Prisma type errors (string vs enum, Record<string, unknown>
// vs Json, string vs RunStatus). Everything database-shaped is pinned here:
//
//   * `AgentRunRow` / `RunEventRow` / `RunApprovalRow` — the row contracts the
//     repository deals in. They are structurally satisfied by the generated
//     Prisma model types (Date timestamps, Json columns) AND by the in-memory
//     test store (ISO-string timestamps), so `Date | string` is the honest
//     boundary — no `any` anywhere.
//   * enum mirrors (`AGENT_ENGINES`, `RUN_EXECUTION_MODES`) with compile-time
//     parity sentinels against the generated `$Enums` unions, so the runtime
//     guards work without value-importing the mocked `@repo/db/db` module, and
//     any drift against the schema fails the build.
//   * `toJsonInput` — a total, type-preserving normalisation of domain values
//     into `Prisma.InputJsonValue` (no blind `as` casts on Json columns).

import type { $Enums, Prisma } from "@repo/db/db";
import { RunError } from "./errors";
import { RUN_STATUSES, isRunStatus, type RunStatus } from "./status";

export type AgentEngine = $Enums.AgentEngine;
export type RunExecutionMode = $Enums.RunExecutionMode;
export type PrismaRunStatus = $Enums.RunStatus;
/** Canonical run-status alias across the run layer (one spelling, one union). */
export type RunStatusValue = $Enums.RunStatus;
export type ApprovalDecisionValue = $Enums.ApprovalDecision;
export type JsonInput = Prisma.InputJsonValue;
export type JsonValue = Prisma.JsonValue;

// ---------------------------------------------------------------------------
// Enum mirrors + parity sentinels
// ---------------------------------------------------------------------------

export const AGENT_ENGINES = [
    "CODEX",
    "CLAUDE_CODE",
    "OPENCODE",
    "PI",
] as const;

export const RUN_EXECUTION_MODES = ["IMPLEMENT", "PLAN_AND_APPROVE"] as const;

type SameUnion<A, B> = [A] extends [B]
    ? [B] extends [A]
        ? true
        : false
    : false;

// These assignments fail compilation the moment the mirrors drift from the
// generated Prisma enums (schema is the single source of truth).
export const AGENT_ENGINES_MIRROR_IS_EXACT: SameUnion<
    AgentEngine,
    (typeof AGENT_ENGINES)[number]
> = true;
export const RUN_EXECUTION_MODES_MIRROR_IS_EXACT: SameUnion<
    RunExecutionMode,
    (typeof RUN_EXECUTION_MODES)[number]
> = true;
// status.ts mirrors RUN_STATUSES by hand; pin it against the generated enum.
export const RUN_STATUSES_MIRROR_IS_EXACT: SameUnion<PrismaRunStatus, RunStatus> =
    true;
// also pin the raw tuple so removing/adding a status trips the build
export const RUN_STATUS_TUPLE_MIRROR_IS_EXACT: SameUnion<
    PrismaRunStatus,
    (typeof RUN_STATUSES)[number]
> = true;

// ---------------------------------------------------------------------------
// Row contracts (generated Prisma rows satisfy these structurally)
// ---------------------------------------------------------------------------

export type AgentRunRow = {
    id: string;
    issueId: string;
    organizationId: string;
    createdBy: string;
    engine: AgentEngine;
    model: string;
    options: JsonValue;
    executionMode: RunExecutionMode;
    repository: string;
    baseCommit: string | null;
    branchName: string;
    status: PrismaRunStatus;
    activeIssueId: string | null;
    /// Instant the worker first started executing (CP-D resume detection).
    attemptedAt: Date | string | null;
    planVersion: number;
    owner: string | null;
    leaseExpiresAt: Date | string | null;
    fencingToken: number;
    idempotencyKey: string;
    createdAt: Date | string;
    updatedAt: Date | string;
};

export type RunEventRow = {
    id: string;
    runId: string;
    sequence: number;
    type: string;
    data: JsonValue;
    createdAt: Date | string;
};

export type RunApprovalRow = {
    id: string;
    runId: string;
    planVersion: number;
    decision: ApprovalDecisionValue;
    baseCommit: string;
    decidedBy: string;
    decidedAt: Date | string;
};

// ---------------------------------------------------------------------------
// Boundary guards + Json normalisation
// ---------------------------------------------------------------------------

const mirrorGuard =
    <T extends string>(mirror: readonly T[]) =>
    (value: unknown): value is T =>
        (mirror as readonly unknown[]).includes(value);

export const isAgentEngine = mirrorGuard(AGENT_ENGINES);
export const isRunExecutionMode = mirrorGuard(RUN_EXECUTION_MODES);

/** Domain strings (zod input, job payloads) cross into the DB only through
 *  these — an unknown value is a typed 400, never a silent Prisma runtime
 *  error and never a laundered `as` cast. */
export const toAgentEngine = (value: string): AgentEngine => {
    if (!isAgentEngine(value)) {
        throw new RunError("INVALID_INPUT", `Unknown engine: ${value}`, {
            engine: value,
            allowed: [...AGENT_ENGINES],
        });
    }
    return value;
};

export const toRunExecutionMode = (value: string): RunExecutionMode => {
    if (!isRunExecutionMode(value)) {
        throw new RunError(
            "INVALID_INPUT",
            `Unknown execution mode: ${value}`,
            { executionMode: value, allowed: [...RUN_EXECUTION_MODES] }
        );
    }
    return value;
};

/** Total normalisation of any domain value into a Prisma Json input. Every
 *  branch is type-narrowed; nothing is cast blindly. Dates become ISO
 *  strings, non-finite numbers become their string form, undefined object
 *  entries are dropped — matching JSON.stringify semantics. A top-level
 *  null/undefined becomes `{}`: every Json column written through here
 *  (agent_run.options, run_event.data) is a non-nullable object column;
 *  JSON nulls INSIDE objects are preserved. */
export const toJsonInput = (value: unknown): JsonInput => {
    const node = jsonValueOf(value);
    return node === null ? {} : node;
};

/** A Json *document node*: null is legal INSIDE objects/arrays (JSON null);
 *  only the column VALUE itself must be non-null — both Json columns written
 *  through this helper (agent_run.options, run_event.data) are non-nullable. */
type JsonInputNode = JsonInput | null;

const jsonValueOf = (value: unknown): JsonInputNode => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(jsonValueOf);
    if (typeof value === "object") {
        const out: Record<string, JsonInputNode> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined) out[key] = jsonValueOf(entry);
        }
        return out;
    }
    return String(value);
};

/** Read side of the Json boundary: a Json column value viewed as a plain
 *  record ({} for null/arrays/non-objects) — no `as` casts on reads. */
export const jsonRecord = (value: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, entry] of Object.entries(value)) out[key] = entry;
    }
    return out;
};

// ---------------------------------------------------------------------------
// Write boundary: domain patch -> Prisma AgentRun update data
// ---------------------------------------------------------------------------

/** The non-status columns a guarded transition may persist alongside the
 *  status (plan version, pinned base commit, first-attempt stamp, publication
 *  bookkeeping — CP-F). Declared explicitly so the write boundary stays typed:
 *  `status` / `activeIssueId` are owned by the transition guard alone and
 *  cannot be smuggled through a patch object. */
export type RunCommitPatch = {
    planVersion?: number;
    baseCommit?: string | null;
    branchName?: string;
    attemptedAt?: Date | null;
};

/** Prisma `AgentRun` update data with the honest Json boundary: `options` is a
 *  `Prisma.InputJsonValue` column, so a domain `Record<string, unknown>` must
 *  go through `toJsonInput` instead of being cast. */
export type RunUpdateData = {
    status: PrismaRunStatus;
    activeIssueId?: string | null;
    planVersion?: number;
    baseCommit?: string | null;
    branchName?: string;
    attemptedAt?: Date | null;
};

/** Total mapping from a domain transition patch to Prisma update data. The
 *  status guard is mandatory — a mutation that does not say which status it
 *  wrote is not a state-machine transition. */
export const toRunUpdateData = (
    status: RunStatusValue,
    patch: RunCommitPatch & { activeIssueId?: string | null } = {}
): RunUpdateData => {
    const data: RunUpdateData = { status };
    if ("activeIssueId" in patch) data.activeIssueId = patch.activeIssueId ?? null;
    if (patch.planVersion !== undefined) data.planVersion = patch.planVersion;
    if (patch.baseCommit !== undefined) data.baseCommit = patch.baseCommit;
    if (patch.branchName !== undefined) data.branchName = patch.branchName;
    if (patch.attemptedAt !== undefined) data.attemptedAt = patch.attemptedAt;
    return data;
};

/** Read boundary for the generated enum: a status string from raw SQL or a
 *  seeded mock either matches the generated union or the state machine refuses
 *  to reason about it (there is no `as RunStatusValue` anywhere in this layer). */
export const toRunStatusValue = (value: unknown): RunStatusValue => {
    if (!isRunStatus(value)) {
        throw new RunError("INVALID_INPUT", `Unknown run status: ${String(value)}`, {
            status: value,
        });
    }
    return value;
};
