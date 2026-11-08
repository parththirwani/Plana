import {
    describe,
    test,
    expect,
    beforeEach,
    afterEach,
    mock,
} from "bun:test";
import { prismaMock } from "../test-utils/prismaMock";
import type {
    MockUser,
    MockOrg,
    MockMembership,
    MockBoard,
    MockSection,
    MockIssue,
} from "../test-utils/prismaMock";

mock.module("@repo/db/db", () => ({ prisma: prismaMock.prisma }));

process.env.JWT_SECRET = "test-secret";

// Restored after every test so the pg-pool guard in lib/notify behaves exactly
// as it did before this file ran (other suites assert on it too).
const urlAtLoad = process.env.DATABASE_URL;

const prisma = prismaMock.prisma;

const {
    createRun,
    transitionRun,
    cancelRun,
    requireRun,
    getActiveRunForIssue,
    listRunsForIssue,
    runBranchName,
} = await import("../runs/runRepository");
const {
    appendRunEvent,
    readRunEvents,
    replayRunEvents,
    latestRunEventSequence,
} = await import("../runs/eventLog");
const { setRunEventPublisher } = await import("../runs/realtime");
const { RunError } = await import("../runs/errors");
const {
    canTransitionRun,
    isTerminalRunStatus,
    legalRunTargets,
    RUN_STATUSES,
} = await import("../runs/status");
const {
    setNotifyPool,
    setNotifyActorLoader,
    notifyBoard,
    AGENT_SYSTEM_ACTOR_ID,
} = await import("../lib/notify");

const makeUser = (id: string, email: string): MockUser => ({
    id,
    email,
    password: "password123",
    name: null,
    avatarUrl: null,
    onboardingCompleted: false,
});

const seed = () =>
    prismaMock.reset({
        users: [makeUser("alice", "alice@example.com")],
        organizations: [
            { id: "org_1", name: "Acme", slug: "acme", description: null, orgImage: null } as MockOrg,
        ],
        memberships: [
            { id: "mem_1", userId: "alice", organizationId: "org_1", role: "ADMIN" } as MockMembership,
        ],
        boards: [
            {
                id: "brd_1",
                title: "Board",
                description: null,
                organizationId: "org_1",
                defaultRepository: "acme/web",
            } as MockBoard,
        ],
        sections: [{ id: "sec_1", title: "Todo", order: 0, boardId: "brd_1" } as MockSection],
        issues: [
            {
                id: "iss_1",
                title: "Ship runs",
                description: null,
                order: 0,
                priority: "NONE",
                dueDate: null,
                sectionId: "sec_1",
                assigneeIds: [],
            } as MockIssue,
        ],
    });

let keySeq = 0;
const launch = (overrides: Record<string, unknown> = {}) =>
    createRun({
        issueId: "iss_1",
        organizationId: "org_1",
        createdBy: "alice",
        engine: "CODEX",
        model: "gpt-5",
        repository: "acme/web",
        executionMode: "IMPLEMENT",
        idempotencyKey: `launch-${++keySeq}`,
        ...overrides,
    } as any);

const eventsFor = async (runId: string) =>
    (
        await prisma.runEvent.findMany({
            where: { runId },
            orderBy: { sequence: "asc" },
        })
    ) as any[];

const statusEvents = (events: any[]) =>
    events.filter((e) => e.type === "run.status.changed");

/** Legal walk from QUEUED to any status, used to set up transition tests. */
const PATH_TO: Record<string, string[]> = {
    PROVISIONING: ["PROVISIONING"],
    PLANNING: ["PLANNING"],
    AWAITING_APPROVAL: ["PLANNING", "AWAITING_APPROVAL"],
    IMPLEMENTING: ["PROVISIONING", "IMPLEMENTING"],
    VALIDATING: ["PROVISIONING", "IMPLEMENTING", "VALIDATING"],
    REVIEWING: [
        "PROVISIONING",
        "IMPLEMENTING",
        "VALIDATING",
        "REVIEWING",
    ],
    PUBLISHING: [
        "PROVISIONING",
        "IMPLEMENTING",
        "VALIDATING",
        "REVIEWING",
        "PUBLISHING",
    ],
    COMPLETED: [
        "PROVISIONING",
        "IMPLEMENTING",
        "VALIDATING",
        "REVIEWING",
        "PUBLISHING",
        "COMPLETED",
    ],
    BLOCKED: ["BLOCKED"],
    LIMIT_REACHED: ["LIMIT_REACHED"],
    FAILED: ["FAILED"],
    CANCELLED: ["CANCELLED"],
};

const driveTo = async (runId: string, target: string) => {
    for (const step of PATH_TO[target] ?? []) {
        await transitionRun({ runId, to: step as any });
    }
};

describe("run lifecycle state machine (CP3)", () => {
    let published: { event: string; sequence: number; persistedAtEmit: number }[];
    let recorder: ((hint: any) => Promise<void>) | null;

    beforeEach(() => {
        seed();
        published = [];
        recorder = async (hint: any) => {
            const rows = await prisma.runEvent.findMany({ where: { runId: hint.runId } });
            published.push({
                event: hint.event,
                sequence: hint.sequence,
                persistedAtEmit: (rows as any[]).filter(
                    (r) => r.sequence === hint.sequence
                ).length,
            });
        };
        setRunEventPublisher(recorder);
    });

    afterEach(() => {
        setRunEventPublisher(null);
        setNotifyPool(null);
        setNotifyActorLoader(null);
        if (urlAtLoad === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = urlAtLoad;
    });

    test("createRun queues a run, opens the per-issue active slot and logs a durable run.created event", async () => {
        const { run, created } = await launch();
        expect(created).toBe(true);
        expect(run.status).toBe("QUEUED");
        expect(run.activeIssueId).toBe("iss_1");
        expect(run.branchName).toBe(runBranchName("iss_1", run.id));
        expect(run.branchName).toBe(`plana/iss_1/${run.id}`);
        expect(run.planVersion).toBe(0);

        const active = await getActiveRunForIssue("iss_1");
        expect(active?.id).toBe(run.id);
        expect((await listRunsForIssue("iss_1")).length).toBe(1);

        const events = await eventsFor(run.id);
        expect(events.length).toBe(1);
        expect(events[0]).toMatchObject({
            sequence: 1,
            type: "run.created",
            runId: run.id,
        });
        expect(events[0].data).toMatchObject({
            engine: "CODEX",
            repository: "acme/web",
            executionMode: "IMPLEMENT",
        });
        expect(published.map((p) => p.event)).toEqual([
            "agent.run.updated",
            "agent.event.available",
        ]);
    });

    test("a second ACTIVE run for the same issue is rejected at the repository layer", async () => {
        const first = await launch();
        let error: any = null;
        try {
            await launch();
        } catch (e) {
            error = e;
        }
        expect(error?.code).toBe("ACTIVE_RUN_EXISTS");
        expect(error?.details?.runId).toBe(first.run.id);
        expect((await prisma.agentRun.findMany({ where: { issueId: "iss_1" } })).length).toBe(1);
    });

    test("create is idempotent on (organizationId, idempotencyKey) even when launched concurrently", async () => {
        const key = "same-key";
        const [a, b] = await Promise.all([
            launch({ idempotencyKey: key }),
            launch({ idempotencyKey: key }),
        ]);
        expect(a.run.id).toBe(b.run.id);
        expect([a.created, b.created].filter(Boolean).length).toBe(1);
        expect((await prisma.agentRun.findMany({ where: { issueId: "iss_1" } })).length).toBe(1);
        expect(await eventsFor(a.run.id)).toHaveLength(1);
    });

    test("every legal lifecycle transition is recorded and only terminal states release the active slot", async () => {
        const { run } = await launch();
        const chain = [
            "PROVISIONING",
            "PLANNING",
            "AWAITING_APPROVAL",
            "IMPLEMENTING",
            "VALIDATING",
            "REVIEWING",
            "PUBLISHING",
        ];
        for (const status of chain) {
            const updated = await transitionRun({ runId: run.id, to: status as any });
            expect(updated.status).toBe(status);
            expect(updated.activeIssueId).toBe("iss_1");
            expect((await getActiveRunForIssue("iss_1"))?.id).toBe(run.id);
        }
        const completed = await transitionRun({ runId: run.id, to: "COMPLETED" });
        expect(completed.status).toBe("COMPLETED");
        expect(completed.activeIssueId).toBeNull();
        expect(await getActiveRunForIssue("iss_1")).toBeNull();

        const events = await eventsFor(run.id);
        expect(events.map((e) => e.sequence)).toEqual(
            Array.from({ length: events.length }, (_, i) => i + 1)
        );
        expect(events.length).toBe(1 + chain.length + 1);
        expect(statusEvents(events).map((e) => [e.data.from, e.data.to])).toEqual([
            ["QUEUED", "PROVISIONING"],
            ["PROVISIONING", "PLANNING"],
            ["PLANNING", "AWAITING_APPROVAL"],
            ["AWAITING_APPROVAL", "IMPLEMENTING"],
            ["IMPLEMENTING", "VALIDATING"],
            ["VALIDATING", "REVIEWING"],
            ["REVIEWING", "PUBLISHING"],
            ["PUBLISHING", "COMPLETED"],
        ]);
        expect(statusEvents(events).map((e) => e.data.activeSlotReleased)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            true,
        ]);
    });

    test("illegal transitions are rejected and leave the run untouched", async () => {
        const { run } = await launch();
        const before = await eventsFor(run.id);

        for (const to of ["COMPLETED", "PUBLISHING", "VALIDATING", "REVIEWING"]) {
            let error: any = null;
            try {
                await transitionRun({ runId: run.id, to: to as any });
            } catch (e) {
                error = e;
            }
            expect(error?.code, `QUEUED -> ${to} must be rejected`).toBe(
                "ILLEGAL_TRANSITION"
            );
            expect(error?.details?.from).toBe("QUEUED");
            expect(error?.details?.allowed).toEqual([...legalRunTargets("QUEUED" as any)]);
            expect(canTransitionRun("QUEUED", to)).toBe(false);
        }

        const run1 = await prisma.agentRun.findUnique({ where: { id: run.id } });
        expect(run1!.status).toBe("QUEUED");
        expect(await eventsFor(run.id)).toHaveLength(before.length);

        // Mid-lifecycle skip: PLANNING -> PUBLISHING is not a legal edge.
        await transitionRun({ runId: run.id, to: "PLANNING" });
        let error: any = null;
        try {
            await transitionRun({ runId: run.id, to: "PUBLISHING" });
        } catch (e) {
            error = e;
        }
        expect(error?.code).toBe("ILLEGAL_TRANSITION");
        expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))!.status).toBe(
            "PLANNING"
        );
    });

    test("terminal states are final: a late engine result cannot revive a cancelled run", async () => {
        const { run } = await launch();
        await cancelRun({ runId: run.id, actorId: "alice", reason: "user stopped it" });

        for (const to of ["IMPLEMENTING", "COMPLETED", "VALIDATING", "CANCELLED"]) {
            let error: any = null;
            try {
                await transitionRun({ runId: run.id, to: to as any });
            } catch (e) {
                error = e;
            }
            expect(error?.code, `late ${to} after CANCELLED`).toBe("TERMINAL_STATE");
        }

        const run1 = await prisma.agentRun.findUnique({ where: { id: run.id } });
        expect(run1!.status).toBe("CANCELLED");
        expect(run1!.activeIssueId).toBeNull();

        // The late result itself is still recorded (append-only history), but it
        // changes nothing about the run's state.
        const late = await appendRunEvent({
            runId: run.id,
            type: "run.engine.output",
            data: { note: "late result from a zombie worker" },
        });
        expect(late.type).toBe("run.engine.output");
        expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))!.status).toBe(
            "CANCELLED"
        );
        expect(isTerminalRunStatus("CANCELLED")).toBe(true);
    });

    test("each terminal status releases the slot so the next run can start immediately", async () => {
        for (const status of ["COMPLETED", "BLOCKED", "LIMIT_REACHED", "FAILED", "CANCELLED"]) {
            seed();
            const { run } = await launch();
            await driveTo(run.id, status);
            const run1 = await prisma.agentRun.findUnique({ where: { id: run.id } });
            expect(run1!.status).toBe(status);
            expect(run1!.activeIssueId, `${status} must release the slot`).toBeNull();
            expect(await getActiveRunForIssue("iss_1")).toBeNull();
            const next = await launch();
            expect(next.created).toBe(true);
            expect(next.run.id).not.toBe(run.id);
            expect(isTerminalRunStatus(status)).toBe(true);
        }
        expect(RUN_STATUSES.filter((s: string) => isTerminalRunStatus(s)).length).toBe(5);
    });

    test("transitioning an unknown run or an unknown status fails loudly", async () => {
        let missing: any = null;
        try {
            await transitionRun({ runId: "run_nope", to: "PROVISIONING" });
        } catch (e) {
            missing = e;
        }
        expect(missing?.code).toBe("NOT_FOUND");
        expect(missing).toBeInstanceOf(RunError);

        const { run } = await launch();
        let bad: any = null;
        try {
            await transitionRun({ runId: run.id, to: "NOT_A_STATUS" as any });
        } catch (e) {
            bad = e;
        }
        expect(bad?.code).toBe("INVALID_INPUT");
        expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))!.status).toBe(
            "QUEUED"
        );
        expect(await eventsFor(run.id)).toHaveLength(1);
    });

    test("concurrent appends produce a per-run monotonic sequence with no gaps or duplicates", async () => {
        const { run } = await launch();
        const writes = 25;
        await Promise.all(
            Array.from({ length: writes }, (_unused, i) =>
                appendRunEvent({
                    runId: run.id,
                    type: "run.engine.output",
                    data: { line: i },
                })
            )
        );
        const events = await eventsFor(run.id);
        expect(events.length).toBe(1 + writes);
        expect(events.map((e: any) => e.sequence)).toEqual(
            Array.from({ length: 1 + writes }, (_u, i) => i + 1)
        );
        expect(new Set(events.map((e: any) => e.sequence)).size).toBe(1 + writes);
        expect(await latestRunEventSequence(run.id)).toBe(1 + writes);
    });

    test("event reads are paginated with an afterSequence cursor and report hasMore/latest", async () => {
        const { run } = await launch();
        for (let i = 0; i < 12; i += 1) {
            await appendRunEvent({ runId: run.id, type: "run.engine.output", data: { i } });
        }
        // 13 events total (run.created + 12).
        const first = await readRunEvents({ runId: run.id, afterSequence: 0, limit: 5 });
        expect(first.events.map((e: any) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
        expect(first.nextSequence).toBe(5);
        expect(first.latestSequence).toBe(13);
        expect(first.hasMore).toBe(true);

        const second = await readRunEvents({ runId: run.id, afterSequence: 5, limit: 5 });
        expect(second.events.map((e: any) => e.sequence)).toEqual([6, 7, 8, 9, 10]);
        expect(second.hasMore).toBe(true);

        const third = await readRunEvents({ runId: run.id, afterSequence: 10, limit: 5 });
        expect(third.events.map((e: any) => e.sequence)).toEqual([11, 12, 13]);
        expect(third.hasMore).toBe(false);
        expect(third.latestSequence).toBe(13);

        const empty = await readRunEvents({ runId: run.id, afterSequence: 13, limit: 5 });
        expect(empty.events).toEqual([]);
        expect(empty.nextSequence).toBe(13);
        expect(empty.hasMore).toBe(false);

        const capped = await readRunEvents({ runId: run.id, afterSequence: 0, limit: 10_000 });
        // limit is clamped to MAX_EVENT_PAGE_SIZE, which still covers the run.
        expect(capped.events.length).toBe(13);
        expect(capped.latestSequence).toBe(13);
    });

    test("replaying from the last seen sequence reconstructs exactly the missed events", async () => {
        const { run } = await launch();
        for (let i = 0; i < 5; i += 1) {
            await appendRunEvent({ runId: run.id, type: "run.engine.output", data: { i } });
        }
        // The client consumes 1..6 then drops its socket.
        const seen = await readRunEvents({ runId: run.id, afterSequence: 0, limit: 6 });
        expect(seen.events.at(-1)!.sequence).toBe(6);

        // Everything that happens while offline, written concurrently.
        await Promise.all(
            Array.from({ length: 7 }, (_u, i) =>
                appendRunEvent({ runId: run.id, type: "run.engine.output", data: { late: i } })
            )
        );

        const replay = await replayRunEvents(run.id, 6, { pageSize: 3 });
        expect(replay.truncated).toBe(false);
        expect(replay.events.map((e: any) => e.sequence)).toEqual([7, 8, 9, 10, 11, 12, 13]);
        expect(replay.nextSequence).toBe(13);

        const live = await readRunEvents({ runId: run.id, afterSequence: 0, limit: 200 });
        const merged = [...seen.events, ...replay.events].map((e: any) => e.sequence);
        expect(new Set(merged).size).toBe(merged.length);
        expect(merged.sort((a: number, b: number) => a - b)).toEqual(
            live.events.map((e: any) => e.sequence)
        );

        const capped = await replayRunEvents(run.id, 0, { maxEvents: 4 });
        expect(capped.events.map((e: any) => e.sequence)).toEqual([1, 2, 3, 4]);
        expect(capped.truncated).toBe(true);
    });

    test("the event row is durable before the realtime hint is emitted", async () => {
        const { run } = await launch();
        await transitionRun({ runId: run.id, to: "IMPLEMENTING" });
        await Promise.all(
            Array.from({ length: 6 }, (_u, i) =>
                appendRunEvent({ runId: run.id, type: "run.engine.output", data: { i } })
            )
        );
        expect(published.length).toBeGreaterThan(0);
        // Every hint observed the already-persisted event it points at.
        expect(published.every((p) => p.persistedAtEmit === 1)).toBe(true);
        const statusHints = published.filter((p) => p.event === "agent.run.updated");
        const availableHints = published.filter((p) => p.event === "agent.event.available");
        // run.created and run.status.changed are state changes -> both hints;
        // the six engine-output events only announce a new event.
        expect(statusHints.map((p) => p.sequence)).toEqual([1, 2]);
        // Hint fan-out for concurrently appended events may interleave; the
        // durable sequence numbers they point at are what matter.
        expect(availableHints.map((p) => p.sequence).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect(published.length).toBe(10);
        expect(published.map((p) => p.sequence).sort((a, b) => a - b)).toEqual([
            1, 1, 2, 2, 3, 4, 5, 6, 7, 8,
        ]);
    });

    test("a broken realtime publisher cannot undo a durable append", async () => {
        const { run } = await launch();
        const errors: unknown[] = [];
        const realError = console.error;
        console.error = (...args: unknown[]) => {
            errors.push(args[0]);
        };
        setRunEventPublisher(async () => {
            throw new Error("websocket down");
        });
        let event: any = null;
        try {
            event = await appendRunEvent({
                runId: run.id,
                type: "run.engine.output",
                data: { note: "still durable" },
            });
        } finally {
            console.error = realError;
        }
        expect(event.sequence).toBe(2);
        expect(errors.length).toBe(1);
        const events = await eventsFor(run.id);
        expect(events.map((e: any) => e.sequence)).toEqual([1, 2]);
    });

    test("agent hints publish with the SYSTEM actor while the human path keeps dropping unknown actors", async () => {
        const notifications: { channel: string; payload: any }[] = [];
        const previousUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = previousUrl ?? "postgres://fake:5432/db";
        setNotifyPool({
            query: async (_text: string, params: unknown[]) => {
                notifications.push({
                    channel: params[0] as string,
                    payload: JSON.parse(params[1] as string),
                });
            },
        });
        // The SYSTEM actor has no User row: the human loader resolves nothing.
        setNotifyActorLoader(async () => null);

        // Existing human behaviour is untouched — it still drops the event.
        await notifyBoard("brd_1", "issue.updated", "ghost", { issue: { id: "iss_1" } });
        expect(notifications).toHaveLength(0);

        // Use the DEFAULT publisher (no test seam) to exercise the real path.
        setRunEventPublisher(null);
        const { run } = await launch();
        await transitionRun({ runId: run.id, to: "IMPLEMENTING" });

        expect(notifications.length).toBe(4); // 2 hints for run.created, 2 for the status change
        expect([...new Set(notifications.map((n) => n.channel))]).toEqual(["board_events"]);
        expect(notifications.every((n) => n.payload.actor.id === "system:plana-agent")).toBe(true);
        expect(notifications.map((n) => n.payload.event)).toEqual([
            "agent.run.updated",
            "agent.event.available",
            "agent.run.updated",
            "agent.event.available",
        ]);
        expect(notifications[0]!.payload).toMatchObject({
            boardId: "brd_1",
            data: { runId: run.id, issueId: "iss_1", sequence: 1, status: "QUEUED" },
        });
        expect(notifications[3]!.payload.data).toMatchObject({ sequence: 2, status: "IMPLEMENTING" });
    });
});
