import { z } from "zod";
import { RUN_STATUSES } from "../runs/status";
import { jsonRecord, toJsonInput, type AgentRunRow } from "../runs/dbTypes";
import { mutateRun } from "../runs/runRepository";
import type { RunOwnership } from "../runs/stateMachine";

const event = z.object({
    type: z.enum([
        "status",
        "output",
        "plan",
        "file_change",
        "validation",
        "completed",
        "cancelled",
    ]),
    text: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
});
const checkpoint = z.object({
    id: z.string(),
    at: z.string(),
    reason: z.string(),
    files: z.record(z.string(), z.string()),
    tracked: z.array(z.string()),
    headCommit: z.string().nullable(),
});
const usage = z.object({
    sessionId: z.string(),
    engine: z.enum(["CODEX", "CLAUDE_CODE", "OPENCODE", "PI"]),
    model: z.string(),
    calls: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
});
const session = z.object({
    sessionId: z.string(),
    runId: z.string(),
    engine: z.enum(["CODEX", "CLAUDE_CODE", "OPENCODE", "PI"]),
    model: z.string(),
    executionMode: z.enum(["IMPLEMENT", "PLAN_AND_APPROVE"]),
    repository: z.string(),
    baseCommit: z.string(),
    planVersion: z.number(),
    phase: z.string(),
    usage,
    secretRedactions: z.array(z.string()),
    state: z
        .object({
            options: z.record(z.string(), z.unknown()),
            phase: z.enum([
                "planning",
                "awaiting_approval",
                "implementing",
                "done",
                "cancelled",
            ]),
            plan: z.string(),
            events: z.array(event),
            streamStart: z.number(),
            inputs: z.array(z.string()),
            cancelCalls: z.number(),
            resumeCalls: z.number(),
            startedAt: z.string(),
            branchName: z.string().nullable(),
            headCommit: z.string().nullable(),
            changedFiles: z.array(z.string()),
            deliveredInputs: z.array(z.string()).optional(),
        })
        .optional(),
});
export const completionSchema = z.object({
    baseCommit: z.string().min(1),
    headCommit: z.string().min(1),
    changedFiles: z.array(z.string()),
});
export const checkSchema = z.object({
    ok: z.boolean(),
    command: z.string(),
    output: z.string(),
    source: z.literal("worker"),
    mode: z.enum(["fake", "real"]),
});
export const runtimeSchema = z.object({
    version: z.literal(1).default(1),
    planningContext: z.string().optional(),
    session: session.optional(),
    checkpoint: checkpoint.optional(),
    completed: completionSchema.optional(),
    validation: checkSchema.optional(),
    review: checkSchema.optional(),
    engineValidationFailed: z.boolean().default(false),
    artifact: checkpoint.optional(),
    ack: z
        .object({ id: z.string(), headCommit: z.string(), branch: z.string() })
        .optional(),
    deliveredInputs: z.array(z.string()).default([]),
    handledFailures: z.array(z.string()).default([]),
    pausedFrom: z.enum(RUN_STATUSES).optional(),
    cleaned: z.boolean().default(false),
});
export type RunRuntime = z.infer<typeof runtimeSchema>;
export type CheckEvidence = z.infer<typeof checkSchema>;
export type PublicationAck = NonNullable<RunRuntime["ack"]>;
export const readRuntime = (run: AgentRunRow): RunRuntime =>
    runtimeSchema.parse(jsonRecord(run.runtime));
export const saveRuntime = async (
    runId: string,
    runtime: RunRuntime,
    claim: RunOwnership,
) => mutateRun({ runId, runtime: toJsonInput(runtime), claim });

// A quiet engine can receive input from the heartbeat. Update only its inbox
// receipt, preserving the stream cursor/checkpoint committed by the main flow.
export const recordInputReceipt = async (
    runId: string,
    id: string,
    data: Record<string, unknown>,
    claim: RunOwnership,
) => {
    const { prisma } = await import("@repo/db/db");
    const { assertRunOwnership, appendRunEventsInTransaction } =
        await import("../runs/runRepository");
    const { publishRunEventHints } = await import("../runs/eventLog");
    const result = await prisma.$transaction(async (tx) => {
        await assertRunOwnership(tx, runId, claim);
        const run = await tx.agentRun.findUniqueOrThrow({
            where: { id: runId },
        });
        if (["CANCELLED", "COMPLETED", "FAILED"].includes(run.status))
            throw new Error("Input receipt after termination");
        const runtime = readRuntime(run);
        const outputs = await tx.runEvent.findMany({
            where: { runId, type: "run.engine.output" },
        });
        if (outputs.some((event) => jsonRecord(event.data).messageId === id))
            return [];
        if (!runtime.deliveredInputs.includes(id))
            runtime.deliveredInputs.push(id);
        await tx.agentRun.update({
            where: { id: runId },
            data: { runtime: toJsonInput(runtime) },
        });
        return appendRunEventsInTransaction(tx, {
            runId,
            issueId: run.issueId,
            status: run.status,
            drafts: [{ type: "run.engine.output", data }],
        });
    });
    await publishRunEventHints(result);
};
