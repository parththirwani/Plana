import { z } from "zod";

// Zod request schemas for the agent-run HTTP API (CP4). Convention mirrors
// src/schema/issue.ts: routers call `.safeParse` and answer 400 with
// "Fields not according to schema" when parsing fails. Engine/model/option
// *semantics* are NOT validated here (that is the capability contract in
// src/adapters/capabilities.ts, which answers with an explicit disabled
// reason); these schemas only pin the request shape.

export const AGENT_ENGINES = ["CODEX", "CLAUDE_CODE", "OPENCODE", "PI"] as const;
export const EXECUTION_MODES = ["IMPLEMENT", "PLAN_AND_APPROVE"] as const;

const optionValue = z.union([z.string().max(120), z.number(), z.boolean()]);

export const createAgentRun = z.object({
    engine: z.enum(AGENT_ENGINES),
    model: z.string().trim().min(1, "model is required").max(120),
    options: z.record(z.string().min(1).max(60), optionValue).optional(),
    executionMode: z.enum(EXECUTION_MODES).optional(),
    repository: z.string().trim().min(1).max(200).optional(),
    idempotencyKey: z
        .string()
        .trim()
        .min(1, "idempotencyKey is required")
        .max(200),
});

export const approveAgentRun = z.object({
    planVersion: z.number().int().min(0),
    decision: z.enum(["APPROVED", "REJECTED"]),
    baseCommit: z.string().trim().min(1).max(128).optional(),
});

export const sendRunMessage = z.object({
    text: z.string().trim().min(1, "text is required").max(4000),
});

export const cancelAgentRun = z.object({
    reason: z.string().trim().max(500).optional(),
});

export type CreateAgentRunBody = z.infer<typeof createAgentRun>;
export type ApproveAgentRunBody = z.infer<typeof approveAgentRun>;
