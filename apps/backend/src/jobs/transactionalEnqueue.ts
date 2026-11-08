import type { Prisma } from "@repo/db/db";
import { toJsonInput, jsonRecord } from "../runs/dbTypes";
import type { EnqueueInput, EnqueueResult, JobRecord } from "./types";

export const jobRecord = (row: Prisma.AgentJobGetPayload<{}>): JobRecord => ({
    id: row.id,
    type: row.type,
    runId: row.runId,
    status: row.status,
    payload: jsonRecord(row.payload),
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    fencingToken: row.fencingToken,
    lockedBy: row.lockedBy,
    lastError: row.lastError,
    availableAt: new Date(row.availableAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    lockedAt: row.lockedAt ? new Date(row.lockedAt).toISOString() : null,
    leaseExpiresAt: row.leaseExpiresAt
        ? new Date(row.leaseExpiresAt).toISOString()
        : null,
});

// The caller holds its run/admission lock, including the job idempotency key's
// namespace. This delegate belongs to that SAME transaction, never another pool.
export const enqueueInTransaction = async (
    tx: Prisma.TransactionClient,
    input: EnqueueInput,
): Promise<EnqueueResult> => {
    if (input.idempotencyKey) {
        const existing = await tx.agentJob.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return { job: jobRecord(existing), created: false };
    }
    const row = await tx.agentJob.create({
        data: {
            type: input.type,
            runId: input.runId ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            payload: toJsonInput(input.payload ?? {}),
            maxAttempts: input.maxAttempts ?? 5,
            availableAt: input.availableAt
                ? new Date(input.availableAt)
                : new Date(),
        },
    });
    return { job: jobRecord(row), created: true };
};
