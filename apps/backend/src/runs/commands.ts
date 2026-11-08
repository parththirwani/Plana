import { randomUUID } from "crypto";
import { prisma, type Prisma } from "@repo/db/db";
import { getJobStore } from "../jobs/jobStore";
import type { JobRecord } from "../jobs/types";
import {
    appendRunEventsInTransaction,
    publishRunEventHints,
    type RunEventDraft,
    lastRunEventSequence,
} from "./eventLog";
import { lockRunRow } from "./stateMachine";
import { withRunSection } from "./sections";
import { isTerminalRunStatus, isRunStatus } from "./status";
import { currentTaskFingerprint } from "./taskContext";
import { shapeRunEvent } from "./events";
import { RunError } from "./errors";
import { jsonRecord, type AgentRunRow } from "./dbTypes";

// State, audit events and queue rows use the same transaction and run lock.
export const runCommand = async <T>(
    runId: string,
    fn: (
        tx: Prisma.TransactionClient,
        run: AgentRunRow,
        events: RunEventDraft[],
    ) => Promise<T>,
) =>
    withRunSection(`run:${runId}`, async () => {
        const result = await prisma.$transaction(async (tx) => {
            await lockRunRow(tx, runId);
            const run = await tx.agentRun.findUniqueOrThrow({
                where: { id: runId },
            });
            const events: RunEventDraft[] = [];
            const value = await fn(tx, run, events);
            const updated = await tx.agentRun.findUniqueOrThrow({
                where: { id: runId },
            });
            const hints = await appendRunEventsInTransaction(tx, {
                runId,
                issueId: run.issueId,
                status: updated.status,
                drafts: events,
            });
            return { value, hints };
        });
        await publishRunEventHints(result.hints);
        return result.value;
    });

export const scheduleRunResume = (runId: string, actorId: string) =>
    runCommand(runId, async (tx, run, events) => {
        if (isTerminalRunStatus(run.status))
            throw new RunError(
                "TERMINAL_STATE",
                "Finished runs cannot be resumed",
            );
        const jobs = await tx.agentJob.findMany({ where: { runId } });
        const active = jobs.find(
            (j) =>
                j.type === "agent.run.execute" &&
                (j.status === "QUEUED" || j.status === "RUNNING"),
        );
        const runtime = jsonRecord(run.runtime);
        if (run.status === "BLOCKED" || run.status === "LIMIT_REACHED") {
            const previous = runtime.pausedFrom;
            const to =
                isRunStatus(previous) &&
                !isTerminalRunStatus(previous) &&
                !["BLOCKED", "LIMIT_REACHED"].includes(previous)
                    ? previous
                    : "QUEUED";
            events.push({
                type: "run.status.changed",
                data: { from: run.status, to, actorId },
            });
            run = await tx.agentRun.update({
                where: { id: run.id },
                data: { status: to },
            });
        }
        if (active) return { run, jobId: active.id, coalesced: true };
        const { job } = await getJobStore().enqueue(
            {
                type: "agent.run.execute",
                runId,
                idempotencyKey: `run:${runId}:resume:${randomUUID()}`,
                payload: { reason: "manual-resume" },
            },
            tx,
        );
        events.push({
            type: "run.message",
            data: { kind: "resume-requested", actorId, jobId: job.id },
        });
        return { run, jobId: job.id, coalesced: false };
    });

export const recordRunMessage = (
    runId: string,
    authorId: string,
    text: string,
) =>
    runCommand(runId, async (tx, run, events) => {
        if (isTerminalRunStatus(run.status))
            throw new RunError(
                "TERMINAL_STATE",
                "Finished runs cannot receive messages",
            );
        if (["VALIDATING", "REVIEWING", "PUBLISHING"].includes(run.status))
            throw new RunError(
                "ILLEGAL_TRANSITION",
                "Run is finalizing; cancel it before changing the task",
            );
        const messageId = randomUUID();
        const eventSequence = (await lastRunEventSequence(tx, runId)) + 1;
        events.push({
            type: "run.message",
            data: { kind: "user-message", authorId, text, messageId },
        });
        const { job } = await getJobStore().enqueue(
            {
                type: "agent.run.message",
                runId,
                idempotencyKey: `message:${messageId}`,
                payload: { messageId, text, eventSequence },
            },
            tx,
        );
        return { jobId: job.id, messageId, eventSequence };
    }).then(async (result) => {
        const row = await prisma.runEvent.findFirst({
            where: { runId, sequence: result.eventSequence },
        });
        if (!row) throw new RunError("INTERNAL", "Committed message missing");
        return { ...result, event: shapeRunEvent(row) };
    });

export const requestRunCancellation = (
    runId: string,
    actorId: string,
    reason?: string,
) =>
    runCommand(runId, async (tx, run, events) => {
        if (run.status !== "CANCELLED") {
            if (isTerminalRunStatus(run.status))
                throw new RunError(
                    "TERMINAL_STATE",
                    "Finished runs cannot be cancelled",
                );
            events.push({
                type: "run.status.changed",
                data: {
                    from: run.status,
                    to: "CANCELLED",
                    actorId,
                    reason: reason ?? "cancelled by request",
                    activeSlotReleased: true,
                },
            });
            run = await tx.agentRun.update({
                where: { id: runId },
                data: { status: "CANCELLED", activeIssueId: null },
            });
        }
        const jobs = await tx.agentJob.findMany({
            where: { runId, status: "QUEUED" },
        });
        const cancelled: string[] = [];
        for (const job of jobs) {
            if (job.type === "agent.run.cleanup") continue;
            await tx.agentJob.update({
                where: { id: job.id },
                data: { status: "CANCELLED" },
            });
            cancelled.push(job.id);
        }
        const allJobs = await tx.agentJob.findMany({ where: { runId } });
        if (
            !allJobs.some(
                (j) =>
                    j.type === "agent.run.cleanup" &&
                    ["QUEUED", "RUNNING"].includes(j.status),
            )
        )
            await getJobStore().enqueue(
                {
                    type: "agent.run.cleanup",
                    runId,
                    idempotencyKey: `run:${runId}:cleanup:${randomUUID()}`,
                    payload: { reason: "cancelled" },
                },
                tx,
            );
        return { run, cancelledJobIds: cancelled };
    });

export type ApprovalInput = {
    runId: string;
    planVersion: number;
    decision: "APPROVED" | "REJECTED";
    decidedBy: string;
    baseCommit?: string;
};
export const decidePlan = (input: ApprovalInput) =>
    runCommand(input.runId, async (tx, run, events) => {
        const where = {
            runId_planVersion: {
                runId: run.id,
                planVersion: input.planVersion,
            },
        };
        const existing = await tx.runApproval.findUnique({ where });
        if (existing) {
            if (
                existing.decision !== input.decision ||
                (input.baseCommit !== undefined &&
                    existing.baseCommit !== input.baseCommit)
            )
                throw new RunError(
                    "STALE_APPROVAL",
                    "Plan already has a different decision",
                );
            return {
                approval: existing,
                run,
                job: null as JobRecord | null,
                replayed: true,
            };
        }
        if (isTerminalRunStatus(run.status))
            throw new RunError(
                "TERMINAL_STATE",
                "Finished runs cannot be approved",
            );
        if (run.status !== "AWAITING_APPROVAL")
            throw new RunError(
                "ILLEGAL_TRANSITION",
                "Run must be awaiting approval",
            );
        if (run.planVersion !== input.planVersion)
            throw new RunError("STALE_APPROVAL", "Plan version is stale", {
                current: run.planVersion,
            });
        if (
            input.baseCommit !== undefined &&
            input.baseCommit !== run.baseCommit
        )
            throw new RunError(
                "STALE_APPROVAL",
                "Reviewer base commit is stale",
                {
                    currentBaseCommit: run.baseCommit,
                },
            );
        const context = await currentTaskFingerprint(tx, run);
        if (
            !run.planContextHash ||
            context !== run.planContextHash ||
            (input.baseCommit !== undefined &&
                input.baseCommit !== run.baseCommit)
        ) {
            run = await tx.agentRun.update({
                where: { id: run.id },
                data: { status: "PLANNING" },
            });
            events.push({
                type: "run.status.changed",
                data: {
                    from: "AWAITING_APPROVAL",
                    to: "PLANNING",
                    reason: "stale-task-context",
                },
            });
            await getJobStore().enqueue(
                {
                    type: "agent.run.execute",
                    runId: run.id,
                    idempotencyKey: `replan:${run.id}:${randomUUID()}`,
                    payload: { reason: "replan-requested" },
                },
                tx,
            );
            return {
                stale: true,
                approval: null,
                run,
                job: null,
                replayed: false,
            };
        }
        const approval = await tx.runApproval.create({
            data: {
                runId: run.id,
                planVersion: input.planVersion,
                decision: input.decision,
                decidedBy: input.decidedBy,
                baseCommit: run.baseCommit ?? "",
                contextHash: context,
            },
        });
        const to = input.decision === "APPROVED" ? "IMPLEMENTING" : "PLANNING";
        events.push(
            {
                type: "run.approval.decided",
                data: {
                    ...input,
                    baseCommit: run.baseCommit,
                    contextHash: context,
                },
            },
            {
                type: "run.status.changed",
                data: { from: run.status, to, via: "approval" },
            },
        );
        run = await tx.agentRun.update({
            where: { id: run.id },
            data: { status: to },
        });
        const { job } = await getJobStore().enqueue(
            {
                type: "agent.run.execute",
                runId: run.id,
                idempotencyKey: `run:${run.id}:execute:v${input.planVersion}${input.decision === "REJECTED" ? ":replan" : ""}`,
                payload: {
                    reason:
                        input.decision === "APPROVED"
                            ? "approved"
                            : "replan-requested",
                    planVersion: input.planVersion,
                    baseCommit: run.baseCommit ?? "",
                    decision: input.decision,
                },
            },
            tx,
        );
        return { approval, run, job, replayed: false };
    });
