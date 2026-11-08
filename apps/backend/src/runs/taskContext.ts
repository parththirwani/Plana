import { createHash } from "crypto";
import type { Prisma } from "@repo/db/db";
import type { AgentRunRow } from "./dbTypes";
import { RunError } from "./errors";

export const readTask = async (
    db: Prisma.TransactionClient,
    issueId: string,
) => {
    const issue = await db.issue.findUnique({ where: { id: issueId } });
    if (!issue) throw new RunError("NOT_FOUND", "Issue not found");
    return {
        title: issue.title,
        description: issue.description ?? "",
        priority: issue.priority,
        repositoryOverride: issue.repository ?? null,
    };
};
export const taskFingerprint = (
    task: unknown,
    repository: string,
    baseCommit: string | null,
) =>
    createHash("sha256")
        .update(JSON.stringify({ task, repository, baseCommit }))
        .digest("hex");
export const currentTaskFingerprint = async (
    db: Prisma.TransactionClient,
    run: AgentRunRow,
) =>
    taskFingerprint(
        await readTask(db, run.issueId),
        run.repository,
        run.baseCommit,
    );
