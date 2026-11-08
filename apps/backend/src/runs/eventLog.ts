import { prisma } from "@repo/db/db";
import { toJsonInput } from "./dbTypes";
import {
    DEFAULT_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE_SIZE,
    shapeRunEvent,
    type AgentRealtimeEvent,
    type EventPage,
    type RunEventRecord,
    type RunEventType,
} from "./events";
import { isRunEventType } from "./events";
import { RunError } from "./errors";
import { getRunEventPublisher } from "./realtime";
import { withRunEventSection } from "./sections";

const MAX_SEQUENCE_ATTEMPTS = 8;

const isUniqueViolation = (error: unknown) =>
    (error as { code?: string } | null)?.code === "P2002";

/**
 * Append-only event log for agent runs (CP3).
 *
 * Ordering guarantees:
 *  1. Every append allocates `sequence = max(existing) + 1` inside the run's
 *     event critical section, and the unique index on (runId, sequence) is the
 *     backstop: if a concurrent writer (another worker process in production,
 *     an interleaved await here) wins the number first, the insert raises a
 *     unique violation and we retry with the next number. Sequences are
 *     therefore strictly monotonic with no gaps and no duplicates.
 *  2. The event row is persisted BEFORE any realtime notification is emitted
 *     (`notify` runs after `create` resolves), so a client that receives the
 *     hint can always read the event it points at. Notifications are hints,
 *     never the source of truth — replay is what closes reconnect gaps.
 *
 * Locking: appendRunEvent takes ONLY the per-run event section. Callers that
 * also hold the per-run repository section (see src/runs/sections.ts) may call
 * it directly; the strict order run -> event makes deadlock impossible.
 */
export type AppendRunEventInput = {
    runId: string;
    type: RunEventType;
    data?: Record<string, unknown>;
    /** Denormalised hints so the realtime path can skip re-reading the run. */
    issueId?: string | null;
    status?: string | null;
    /** Suppress the realtime hint (bulk backfill / test seeding). */
    silent?: boolean;
};

const STATE_CHANGED_EVENT_TYPES: readonly string[] = [
    "run.created",
    "run.status.changed",
    "run.approval.requested",
    "run.approval.decided",
    "run.publication.intent",
];

const realtimeEventsFor = (
    type: string
): { event: AgentRealtimeEvent; payload?: Record<string, unknown> }[] => {
    const stateChanged = STATE_CHANGED_EVENT_TYPES.includes(type);
    return stateChanged
        ? [
              { event: "agent.run.updated" },
              { event: "agent.event.available" },
          ]
        : [{ event: "agent.event.available" }];
};

const notify = async (
    input: AppendRunEventInput,
    event: RunEventRecord
): Promise<void> => {
    if (input.silent) return;
    const notifier = getRunEventPublisher();
    for (const hint of realtimeEventsFor(event.type)) {
        try {
            await notifier({
                runId: event.runId,
                issueId: input.issueId ?? null,
                sequence: event.sequence,
                status: input.status ?? null,
                event: hint.event,
            });
        } catch (error) {
            // Never let a realtime hiccup undo a durable append.
            console.error("Agent realtime notify failed:", error);
        }
    }
};

const allocateAndPersist = async (
    input: AppendRunEventInput
): Promise<RunEventRecord> => {
    if (!isRunEventType(input.type)) {
        throw new RunError("INVALID_INPUT", `Unknown run event type: ${input.type}`);
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt += 1) {
        const [latest] = await prisma.runEvent.findMany({
            where: { runId: input.runId },
            orderBy: { sequence: "desc" },
            take: 1,
        });
        const sequence = (latest?.sequence ?? 0) + 1;
        try {
            const created = await prisma.runEvent.create({
                data: {
                    runId: input.runId,
                    sequence,
                    type: input.type,
                    data: toJsonInput(input.data ?? {}),
                },
            });
            return shapeRunEvent(created);
        } catch (error) {
            // Lost the race for this sequence number: retry with the next one.
            // Any other error (missing run FK, ...) propagates unchanged.
            if (!isUniqueViolation(error)) throw error;
            lastError = error;
        }
    }
    throw new RunError(
        "INTERNAL",
        `Could not allocate a monotonic run event sequence for ${input.runId}`,
        { cause: (lastError as { code?: string } | null)?.code ?? "UNKNOWN" }
    );
};

export const appendRunEvent = async (
    input: AppendRunEventInput
): Promise<RunEventRecord> => {
    const event = await withRunEventSection(input.runId, () =>
        allocateAndPersist(input)
    );
    // Persisted first, notified second — the event is always readable when the
    // hint reaches a client.
    await notify(input, event);
    return event;
};

const clampLimit = (limit?: number) => {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        return DEFAULT_EVENT_PAGE_SIZE;
    }
    return Math.min(Math.floor(limit), MAX_EVENT_PAGE_SIZE);
};

export const readRunEvents = async (input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
}): Promise<EventPage> => {
    const afterSequence = Math.max(0, Math.floor(input.afterSequence ?? 0));
    const limit = clampLimit(input.limit);
    const [rows, [latest]] = await Promise.all([
        prisma.runEvent.findMany({
            where: { runId: input.runId, sequence: { gt: afterSequence } },
            orderBy: { sequence: "asc" },
            take: limit,
        }),
        prisma.runEvent.findMany({
            where: { runId: input.runId },
            orderBy: { sequence: "desc" },
            take: 1,
        }),
    ]);
    const events = rows.map(shapeRunEvent);
    const latestSequence = latest?.sequence ?? afterSequence;
    const nextSequence = events.length
        ? events[events.length - 1]!.sequence
        : afterSequence;
    return {
        events,
        nextSequence,
        latestSequence,
        hasMore: latestSequence > nextSequence,
    };
};

/**
 * Rebuild everything a client missed after a reconnect: every event with
 * sequence > afterSequence, in order, walked page by page. Bounded by
 * `maxEvents` so a pathological backlog cannot pin a request.
 */
export const replayRunEvents = async (
    runId: string,
    afterSequence: number,
    options: { pageSize?: number; maxEvents?: number } = {}
): Promise<{ events: RunEventRecord[]; nextSequence: number; truncated: boolean }> => {
    const pageSize = clampLimit(options.pageSize ?? options.maxEvents);
    const maxEvents = Math.max(0, options.maxEvents ?? Number.MAX_SAFE_INTEGER);
    const events: RunEventRecord[] = [];
    let cursor = Math.max(0, Math.floor(afterSequence));
    let truncated = false;
    for (;;) {
        const page = await readRunEvents({
            runId,
            afterSequence: cursor,
            limit: pageSize,
        });
        for (const event of page.events) {
            if (events.length >= maxEvents) {
                truncated = true;
                break;
            }
            events.push(event);
        }
        cursor = page.nextSequence;
        if (truncated || !page.hasMore || page.events.length === 0) break;
    }
    return { events, nextSequence: cursor, truncated };
};

export const latestRunEventSequence = async (runId: string): Promise<number> => {
    const [latest] = await prisma.runEvent.findMany({
        where: { runId },
        orderBy: { sequence: "desc" },
        take: 1,
    });
    return latest?.sequence ?? 0;
};

// ---------------------------------------------------------------------------
// In-transaction appends (CP-A)
// ---------------------------------------------------------------------------
//
// `appendRunEvent` allocates its sequence with a read + insert-and-retry loop,
// which is correct standalone but cannot join a run-state transaction. The
// helpers below append INSIDE a caller's transaction: the caller has already
// locked the run row (`SELECT ... FOR UPDATE` in src/runs/stateMachine.ts), so
// allocating `max(sequence) + n` here is race-free — any concurrent writer is
// blocked on that same row lock until this transaction commits, and the unique
// index on (runId, sequence) stays the last line of defence rather than the
// primary guard.
//
// Realtime hints are deliberately NOT emitted from inside the transaction:
// `appendRunEventsInTransaction` RETURNS hints and the transaction owner
// publishes them after COMMIT, so a rollback can never leak a hint for an event
// that does not exist.

import type { Prisma } from "@repo/db/db";

/** Transaction-scoped database handle: the global client or an interactive
 *  transaction — both expose the same model delegates. */
export type RunEventDb = Prisma.TransactionClient;

export type RunEventDraft = {
    type: RunEventType;
    data?: Record<string, unknown>;
};

/** A durable event that has been persisted (or will be, when the enclosing
 *  transaction commits) plus everything the realtime hint needs. */
export type RunEventHint = AppendRunEventInput & { sequence: number };

/** Highest allocated sequence for a run (0 when it has no events yet). */
export const lastRunEventSequence = async (
    db: RunEventDb,
    runId: string
): Promise<number> => {
    const [latest] = await db.runEvent.findMany({
        where: { runId },
        orderBy: { sequence: "desc" },
        take: 1,
    });
    return latest?.sequence ?? 0;
};

/**
 * Append `drafts` to the run's log INSIDE the caller's transaction with
 * contiguous sequences, and return the realtime hints to publish after commit.
 * The caller must already hold the run's row lock (see stateMachine.ts): that
 * is what makes the sequence allocation atomic, not the unique index.
 */
export const appendRunEventsInTransaction = async (
    db: RunEventDb,
    input: {
        runId: string;
        issueId?: string | null;
        status?: string | null;
        drafts: readonly RunEventDraft[];
    }
): Promise<RunEventHint[]> => {
    if (input.drafts.length === 0) return [];
    for (const draft of input.drafts) {
        if (!isRunEventType(draft.type)) {
            throw new RunError("INVALID_INPUT", `Unknown run event type: ${draft.type}`, {
                type: draft.type,
            });
        }
    }
    const base = await lastRunEventSequence(db, input.runId);
    const rows = input.drafts.map((draft, index) => ({
        runId: input.runId,
        sequence: base + index + 1,
        type: draft.type,
        data: toJsonInput(draft.data ?? {}),
    }));
    // One statement for the whole batch: the allocated sequences are either all
    // persisted or (on rollback) none of them are.
    await db.runEvent.createMany({ data: rows });
    return rows.map((row, index) => ({
        runId: row.runId,
        type: row.type,
        data: input.drafts[index]?.data,
        issueId: input.issueId ?? null,
        status: input.status ?? null,
        sequence: row.sequence,
    }));
};

/**
 * Publish the realtime hints for events a transaction has just COMMITTED.
 * Never call this inside the transaction — a client must not be able to see a
 * hint for an event that was rolled back.
 */
export const publishRunEventHints = async (hints: readonly RunEventHint[]) => {
    for (const hint of hints) {
        if (hint.silent) continue;
        const notifier = getRunEventPublisher();
        for (const target of realtimeEventsFor(hint.type)) {
            try {
                await notifier({
                    runId: hint.runId,
                    issueId: hint.issueId ?? null,
                    sequence: hint.sequence,
                    status: hint.status ?? null,
                    event: target.event,
                });
            } catch (error) {
                // Never let a realtime hiccup undo a durable append.
                console.error("Agent realtime notify failed:", error);
            }
        }
    }
};
