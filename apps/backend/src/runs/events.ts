// Append-only run event vocabulary (CP3).
//
// RunEvent rows are the durable, replayable record of everything that happened
// during a run. Realtime notifications (agent.run.updated /
// agent.event.available) are *hints* that only carry ids + the sequence number;
// clients always fetch the persisted events, which is what makes replay after a
// reconnect exact (docs/plans/cloud-agents-architecture.md, "Realtime").

import { jsonRecord, type RunEventRow } from "./dbTypes";

export const RUN_EVENT_TYPES = [
    "run.created",
    "run.status.changed",
    "run.plan.updated",
    "run.approval.requested",
    "run.approval.decided",
    "run.message",
    "run.engine.output",
    "run.sandbox.lifecycle",
    "run.publication.intent",
    "run.attempt.started",
    "run.plan.updated",
    "run.base.pinned",
    "run.error",
    "run.publication.acknowledged",
    "run.cleanup.completed",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const isRunEventType = (type: unknown): type is RunEventType =>
    typeof type === "string" &&
    (RUN_EVENT_TYPES as readonly string[]).includes(type);

// Board realtime channels reuse the existing `board_events` notification
// channel; these are the two new event names agent runs emit.
export const AGENT_REALTIME_EVENTS = [
    "agent.run.updated",
    "agent.event.available",
] as const;

export type AgentRealtimeEvent = (typeof AGENT_REALTIME_EVENTS)[number];

export type RunEventRecord = {
    id: string;
    runId: string;
    sequence: number;
    type: RunEventType | string;
    data: Record<string, unknown>;
    createdAt: Date | string;
};

export type EventPage = {
    events: RunEventRecord[];
    /** Highest sequence returned (== afterSequence when the page is empty). */
    nextSequence: number;
    /** Highest sequence that exists for the run at read time. */
    latestSequence: number;
    hasMore: boolean;
};

export const DEFAULT_EVENT_PAGE_SIZE = 50;
export const MAX_EVENT_PAGE_SIZE = 200;

export const shapeRunEvent = (event: RunEventRow): RunEventRecord => ({
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    data: jsonRecord(event.data),
    createdAt: event.createdAt,
});
