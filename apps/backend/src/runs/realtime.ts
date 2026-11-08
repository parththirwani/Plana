import { prisma } from "@repo/db/db";
import { notifyAgentEvent } from "../lib/notify";
import { boardForIssue } from "../routers/issue";
import type { AgentRealtimeEvent } from "./events";

// Realtime seam for agent events (CP3/CP6).
//
// Agent runs must NOT reuse notifyBoard's actor handling: notifyBoard resolves
// the actor through the user-actor loader and DROPS the event when it returns
// null, and the handoff forbids a password bot / real user row as the agent
// actor. Agent events therefore go through lib/notify.ts `notifyAgentEvent`,
// which stamps the fixed SYSTEM actor and reuses the same injectable pg pool.
//
// The publisher is injectable (mirroring setNotifyPool / setJobStore) so tests
// can assert ordering — notably that the event row is durable before the hint
// is emitted — without a database or a websocket.

export type AgentEventHint = {
    runId: string;
    issueId: string | null;
    sequence: number;
    status: string | null;
    event: AgentRealtimeEvent;
};

export type RunEventPublisher = (hint: AgentEventHint) => Promise<void>;

const boardIdForRun = async (hint: AgentEventHint): Promise<string | null> => {
    let issueId = hint.issueId;
    if (!issueId) {
        const run = await prisma.agentRun.findUnique({ where: { id: hint.runId } });
        issueId = (run as any)?.issueId ?? null;
    }
    if (!issueId) return null;
    const issue = await prisma.issue.findUnique({ where: { id: issueId } });
    if (!issue) return null;
    const board = await boardForIssue(issue as any);
    return board?.id ?? null;
};

/**
 * Default publisher: resolve the run's board and publish a compact hint on the
 * existing `board_events` channel with the SYSTEM actor. Hints carry only ids +
 * the event sequence; clients fetch the durable events, which is what makes
 * replay after a reconnect exact even if a hint is lost.
 */
export const publishAgentEventHint: RunEventPublisher = async (hint) => {
    const boardId = await boardIdForRun(hint);
    if (!boardId) return;
    await notifyAgentEvent(boardId, hint.event, {
        runId: hint.runId,
        issueId: hint.issueId ?? null,
        sequence: hint.sequence,
        status: hint.status,
    });
};

let publisher: RunEventPublisher | null = null;

export const setRunEventPublisher = (
    next: RunEventPublisher | null
): RunEventPublisher | null => {
    const previous = publisher;
    publisher = next;
    return previous;
};

export const getRunEventPublisher = (): RunEventPublisher =>
    publisher ?? publishAgentEventHint;
