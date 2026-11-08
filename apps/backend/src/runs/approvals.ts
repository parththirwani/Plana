import { prisma } from "@repo/db/db";
import { getJobStore } from "../jobs/jobStore";
import { appendRunEvent } from "./eventLog";
import { RunError } from "./errors";
import { requireRun, transitionRun } from "./runRepository";
import { isTerminalRunStatus } from "./status";
import type { AgentRunRow, RunApprovalRow } from "./dbTypes";
import type { JobRecord } from "../jobs/types";

// Plan-approval service (CP4). An approval is only valid for the EXACT plan
// version the plan was rendered at; if the plan version moved on or the base
// commit changed since the plan was produced, the approval is STALE and must
// be rejected (409) — the reviewer has to look at the current plan. Recording
// an approval never executes anything inline: it moves the run state machine
// and enqueues durable work for the worker (CP5) to resume against the exact
// approved planVersion + baseCommit.

export type ApprovalDecision = "APPROVED" | "REJECTED";

export type RecordApprovalInput = {
    runId: string;
    planVersion: number;
    decision: ApprovalDecision;
    decidedBy: string;
    /** Reviewer's view of the base commit the plan was made against. */
    baseCommit?: string;
};

export type RecordApprovalResult = {
    approval: RunApprovalRow;
    run: AgentRunRow;
    job: JobRecord | null;
    /** True when this call replayed an identical earlier decision. */
    replayed: boolean;
};

export const listApprovalsForRun = async (runId: string) =>
    prisma.runApproval.findMany({ where: { runId } });

const findApproval = (runId: string, planVersion: number) =>
    prisma.runApproval.findUnique({
        where: { runId_planVersion: { runId, planVersion } },
    });

export const recordApproval = async (
    input: RecordApprovalInput
): Promise<RecordApprovalResult> => {
    const run = await requireRun(input.runId);

    if (isTerminalRunStatus(run.status)) {
        throw new RunError(
            "TERMINAL_STATE",
            `Run is ${run.status}; approvals cannot change a finished run`,
            { status: run.status }
        );
    }

    const existing = await findApproval(run.id, input.planVersion);
    if (existing && existing.decision !== input.decision) {
        throw new RunError(
            "STALE_APPROVAL",
            `Plan version ${input.planVersion} was already decided ${existing.decision}`,
            { planVersion: input.planVersion, existingDecision: existing.decision }
        );
    }
    if (
        existing &&
        (run.status !== "AWAITING_APPROVAL" || run.planVersion !== input.planVersion)
    ) {
        // The decision is already recorded and its effects have been applied
        // (or the plan moved on): an identical repeat call is a pure replay.
        return { approval: existing, run, job: null, replayed: true };
    }

    if (run.status !== "AWAITING_APPROVAL") {
        throw new RunError(
            "ILLEGAL_TRANSITION",
            `Run is ${run.status}; approvals are only decided while AWAITING_APPROVAL`,
            { status: run.status }
        );
    }
    if (run.planVersion !== input.planVersion) {
        throw new RunError(
            "STALE_APPROVAL",
            `Plan version ${input.planVersion} is stale; the current plan version is ${run.planVersion}`,
            { requested: input.planVersion, current: run.planVersion }
        );
    }
    if (
        input.baseCommit !== undefined &&
        run.baseCommit !== null &&
        input.baseCommit !== run.baseCommit
    ) {
        throw new RunError(
            "STALE_APPROVAL",
            "The repository base commit changed since this plan was produced; regenerate the plan and approve the current one",
            { requestedBaseCommit: input.baseCommit, currentBaseCommit: run.baseCommit }
        );
    }

    const baseCommit = run.baseCommit ?? input.baseCommit ?? "";
    let approval = existing;
    if (!approval) {
        try {
            approval = await prisma.runApproval.create({
                data: {
                    runId: run.id,
                    planVersion: input.planVersion,
                    decision: input.decision,
                    decidedBy: input.decidedBy,
                    baseCommit,
                },
            });
        } catch (error: any) {
            if (error?.code === "P2002") {
                const raced = await findApproval(run.id, input.planVersion);
                if (raced) {
                    if (raced.decision !== input.decision) {
                        throw new RunError(
                            "STALE_APPROVAL",
                            `Plan version ${input.planVersion} was already decided ${raced.decision}`,
                            { planVersion: input.planVersion }
                        );
                    }
                    approval = raced;
                }
            }
            if (!approval) throw error;
        }
    }
    if (!approval) {
        throw new RunError("INTERNAL", "Approval could not be recorded", {
            runId: run.id,
            planVersion: input.planVersion,
        });
    }

    await appendRunEvent({
        runId: run.id,
        type: "run.approval.decided",
        issueId: run.issueId,
        status: run.status,
        data: {
            planVersion: input.planVersion,
            decision: input.decision,
            decidedBy: input.decidedBy,
            baseCommit,
        },
    });

    // APPROVED  -> resume implementation against the exact plan version +
    //              base commit (the worker re-checks both on claim).
    // REJECTED  -> back to PLANNING: a fresh plan must be produced and
    //              approved before anything is implemented.
    const updated =
        run.status === "AWAITING_APPROVAL"
            ? await transitionRun({
                  runId: run.id,
                  to: input.decision === "APPROVED" ? "IMPLEMENTING" : "PLANNING",
                  // The status THIS handler read above: if a worker or another
                  // approval moved the run in between, the decision is rejected
                  // instead of stomping the newer state.
                  expectedFrom: run.status,
                  actorId: input.decidedBy,
                  data: {
                      via: "approval",
                      decision: input.decision,
                      planVersion: input.planVersion,
                      baseCommit,
                  },
              })
            : run;

    const jobKey =
        input.decision === "APPROVED"
            ? `run:${run.id}:execute:v${input.planVersion}`
            : `run:${run.id}:execute:v${input.planVersion}:replan`;
    const { job } = await getJobStore().enqueue({
        type: "agent.run.execute",
        runId: run.id,
        idempotencyKey: jobKey,
        payload: {
            reason: input.decision === "APPROVED" ? "approved" : "replan-requested",
            planVersion: input.planVersion,
            baseCommit,
            decision: input.decision,
        },
    });

    return { approval, run: updated, job, replayed: Boolean(existing) };
};
