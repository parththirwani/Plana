import { prisma } from "@repo/db/db";
import { decidePlan, type ApprovalInput } from "./commands";
import { RunError } from "./errors";
export type ApprovalDecision = "APPROVED" | "REJECTED";

export type RecordApprovalInput = ApprovalInput;

export const listApprovalsForRun = (runId: string) =>
    prisma.runApproval.findMany({ where: { runId } });
export const recordApproval = async (input: ApprovalInput) => {
    const result = await decidePlan(input);
    if ("stale" in result)
        throw new RunError(
            "STALE_APPROVAL",
            "Task context or base changed; a new plan has been queued",
        );
    return result;
};
