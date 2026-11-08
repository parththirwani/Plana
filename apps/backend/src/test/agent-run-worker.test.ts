import {
    describe,
    test,
    expect,
    beforeEach,
    beforeAll,
    afterAll,
    mock,
} from "bun:test";
import { prismaMock } from "../test-utils/prismaMock";
import type { MockBoard, MockIssue, MockSection } from "../test-utils/prismaMock";
import { createMemoryJobStore } from "../jobs/memoryJobStore";
import { setJobStore } from "../jobs/jobStore";
import { DEFAULT_REPO_FILES } from "../adapters/fakeSandbox";

// CP5 EVIDENCE — the durable worker drives run lifecycles through the
// adapter contracts and the run repository, and NOTHING ELSE.
//
// The scenario list is the CP5 evidence contract:
//   (a) PLAN_AND_APPROVE yields NO tracked-file change before approval and
//       only the EXACT approved plan version resumes implementation;
//   (b) a stale approval (base commit moved between approval and claim)
//       implements NOTHING — the plan is regenerated and re-approval is
//       required before anything runs;
//   (c) a late engine result cannot publish a cancelled run — the cancel is
//       observed mid-stream, the fake engine is stopped and NO publication
//       intent is ever recorded;
//   (d) cancelling releases the active-run slot so a new run can start for
//       the same issue;
//   (e) no real network/provider call is possible: the fake-only registry is
//       asserted and global fetch is trapped and proven untouched.
// Plus: unsupported engines fail honestly (never substituted) and a zombie
// lease holder is fenced out BEFORE writing the publication intent.
//
// Publication is only ever an INTENT event (githubContacted: false) — the
// GitHub publisher itself is out of scope for this container (ledger).

mock.module("@repo/db/db", () => ({ prisma: prismaMock.prisma }));

const { createRun, cancelRun, getRunById } = await import("../runs/runRepository");
const { appendRunEvent } = await import("../runs/eventLog");
const { recordApproval } = await import("../runs/approvals");
const { setRunEventPublisher } = await import("../runs/realtime");
const { createRunWorker } = await import("../worker/runWorker");

const prisma = prismaMock.prisma;

const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

type Outcome = { jobId: string; jobType: string; runId: string | null; status: string } | null;

const INITIAL_TRACKED = Object.keys(DEFAULT_REPO_FILES).sort();
const rowOf = async (runId: string) => (await getRunById(runId))!;
const eventsFor = async (runId: string): Promise<any[]> =>
    (await prisma.runEvent.findMany({ where: { runId }, orderBy: { sequence: "asc" } })) as any[];
const statusChain = (events: any[]) =>
    events.filter((e) => e.type === "run.status.changed").map((e) => e.data.to);

let store: ReturnType<typeof createMemoryJobStore>;
let keySeq = 0;

const launch = async (issueId: string, overrides: Record<string, unknown> = {}) => {
    // Mirrors exactly what POST /issues/:id/agent-runs enqueues (CP4).
    const created = await createRun({
        issueId,
        organizationId: "org_1",
        createdBy: "mod-user",
        engine: "CODEX",
        model: "gpt-5",
        executionMode: "IMPLEMENT",
        repository: "acme/web",
        idempotencyKey: `wrk-key-${++keySeq}`,
        ...overrides,
    });
    if (created.created) {
        await store.enqueue({
            type: "agent.run.execute",
            runId: created.run.id,
            idempotencyKey: `run:${created.run.id}:start`,
            payload: { reason: "created", executionMode: created.run.executionMode },
        });
    }
    return created.run as any;
};

beforeAll(() => {
    (globalThis as any).fetch = async (input: unknown) => {
        fetchCalls.push(String(input));
        throw new Error("NETWORK CALL DURING WORKER TESTS — the worker must never touch the network");
    };
});

afterAll(() => {
    globalThis.fetch = originalFetch;
});

beforeEach(() => {
    prismaMock.reset({
        boards: [
            { id: "brd_1", title: "Board", description: null, organizationId: "org_1", defaultRepository: "acme/web" } as MockBoard,
        ],
        sections: [{ id: "sec_1", title: "Todo", order: 0, boardId: "brd_1" } as MockSection],
        issues: ["iss_1", "iss_3", "iss_4", "iss_5", "iss_6", "iss_7", "iss_8"].map(
            (id) =>
                ({
                    id,
                    title: `Issue ${id}`,
                    description: null,
                    order: 0,
                    priority: "NONE",
                    dueDate: null,
                    sectionId: "sec_1",
                    assigneeIds: [],
                    repository: "acme/web",
                }) as MockIssue
        ),
    });
    store = createMemoryJobStore();
    setJobStore(store);
    setRunEventPublisher(async () => {});
    fetchCalls.length = 0;
    keySeq = 0;
});

describe("worker: IMPLEMENT pipeline end-to-end with a fake adapter", () => {
    test("claims the queued job, transitions the full chain, and records ONLY a publication INTENT", async () => {
        const run = await launch("iss_1");
        const worker = createRunWorker({ store });

        const outcome: Outcome = await worker.runOnce();
        expect(outcome!.status).toBe("completed");

        const row = await rowOf(run.id);
        expect(row.status).toBe("COMPLETED");
        expect(row.activeIssueId).toBeNull();
        expect(row.baseCommit).toBe(`base-of-${run.id}`);

        const events = await eventsFor(run.id);
        expect(events[0]!.type).toBe("run.created");
        expect(statusChain(events)).toEqual([
            "PROVISIONING",
            "IMPLEMENTING",
            "VALIDATING",
            "REVIEWING",
            "PUBLISHING",
            "COMPLETED",
        ]);
        // The sandbox exists BEFORE any engine output.
        const lifecycleIdx = events.findIndex((e) => e.type === "run.sandbox.lifecycle");
        const firstOutputIdx = events.findIndex((e) => e.type === "run.engine.output");
        expect(lifecycleIdx).toBeGreaterThan(0);
        expect(lifecycleIdx).toBeLessThan(firstOutputIdx);

        // Publication = durable INTENT only; GitHub is NEVER contacted here.
        const intent = events.find((e) => e.type === "run.publication.intent");
        expect(intent.data.kind).toBe("INTENT");
        expect(intent.data.githubContacted).toBe(false);
        expect(intent.data.publication).toBe("intent-only");
        expect(intent.data.branch).toBe(run.branchName);
        expect(intent.data.headCommit).toBe(`head-of-base-of-${run.id}`);
        expect(intent.data.changedFiles).toEqual([
            `src/issue-${run.id}.ts`,
            `tests/issue-${run.id}.test.ts`,
        ]);

        const job = await store.get(outcome!.jobId);
        expect(job!.status).toBe("COMPLETED");

        // Sandbox cleaned up after completion; machine state observable.
        const sandbox = worker.deps.sandboxes.byRun(run.id)!;
        expect(sandbox.state).toBe("KILLED");

        // (e) no network was touched, and only fake adapters are reachable.
        expect(fetchCalls).toHaveLength(0);
        expect(worker.deps.registry.describe()).toEqual([
            "CLAUDE_CODE=fake:CLAUDE_CODE",
            "CODEX=fake:CODEX",
            "OPENCODE=fake:OPENCODE",
        ]);
        expect(await worker.runOnce()).toBeNull();
    });
});

describe("worker (a): PLAN_AND_APPROVE changes nothing before approval; exact plan version gates resume", () => {
    test("gate holds: no tracked change pre-approval, wrong-version approval 409s, exact approval implements", async () => {
        const run = await launch("iss_3", { executionMode: "PLAN_AND_APPROVE" });
        const worker = createRunWorker({ store });

        const gate: Outcome = await worker.runOnce();
        expect(gate!.status).toBe("awaiting-approval");
        const gateRow = await rowOf(run.id);
        expect(gateRow.status).toBe("AWAITING_APPROVAL");
        expect(gateRow.planVersion).toBe(1);

        const sandbox = worker.deps.sandboxes.byRun(run.id)!;
        expect(sandbox.state).toBe("PAUSED");
        // NO tracked-file change before approval.
        expect(await sandbox.trackedPaths()).toEqual(INITIAL_TRACKED);
        expect(Object.keys(sandbox.snapshotFiles()).sort()).toEqual(INITIAL_TRACKED);

        // Approving a version that does not exist fails cleanly (no side
        // effects) — the gate stays shut.
        await expect(
            recordApproval({ runId: run.id, planVersion: 2, decision: "APPROVED", decidedBy: "alice" })
        ).rejects.toThrow(/stale/i);
        expect((await rowOf(run.id)).status).toBe("AWAITING_APPROVAL");

        // EXACT plan version (base commit defaults to the row's current one).
        const rec = await recordApproval({
            runId: run.id,
            planVersion: 1,
            decision: "APPROVED",
            decidedBy: "alice",
        });
        expect(rec.run.status).toBe("IMPLEMENTING");

        const done: Outcome = await worker.runOnce();
        expect(done!.status).toBe("completed");
        const row = await rowOf(run.id);
        expect(row.status).toBe("COMPLETED");
        expect(row.activeIssueId).toBeNull();

        const files = Object.keys(worker.deps.sandboxes.byRun(run.id)!.snapshotFiles());
        expect(files).toContain(`src/issue-${run.id}.ts`); // tracked changes only AFTER approval

        const events = await eventsFor(run.id);
        expect(
            events.some((e) => e.type === "run.sandbox.lifecycle" && e.data.phase === "paused-awaiting-approval")
        ).toBe(true);
        const requestedIdx = events.findIndex((e) => e.type === "run.approval.requested");
        const reconnectedIdx = events.findIndex(
            (e) => e.type === "run.sandbox.lifecycle" && e.data.phase === "reconnected"
        );
        expect(reconnectedIdx).toBeGreaterThan(-1);
        expect(reconnectedIdx).toBeGreaterThan(requestedIdx);
        expect((await store.get(done!.jobId))!.status).toBe("COMPLETED");
        expect(fetchCalls).toHaveLength(0);
    });
});

describe("worker (b): a stale approval (base moved after approval) implements nothing and forces regeneration + re-approval", () => {
    test("stale-at-claim is fenced, plan v2 is regenerated against the NEW base, only re-approval completes", async () => {
        const run = await launch("iss_4", { executionMode: "PLAN_AND_APPROVE" });
        const worker = createRunWorker({ store });
        expect((await worker.runOnce())!.status).toBe("awaiting-approval");

        // Approve v1 while it is still current...
        await recordApproval({ runId: run.id, planVersion: 1, decision: "APPROVED", decidedBy: "alice" });
        // ...then the repository base moves BEFORE the worker claims the job.
        await prisma.agentRun.update({
            where: { id: run.id },
            data: { baseCommit: "base-moved-7" },
        });

        const stale: Outcome = await worker.runOnce();
        expect(stale!.status).toBe("stale-replan-awaiting-approval");

        const row = await rowOf(run.id);
        expect(row.status).toBe("AWAITING_APPROVAL");
        expect(row.planVersion).toBe(2);
        expect(row.baseCommit).toBe("base-moved-7");

        const events = await eventsFor(run.id);
        const error = events.find((e) => e.type === "run.error");
        expect(error.data.code).toBe("STALE_APPROVAL");
        expect(error.data.approvedBaseCommit).toBe(`base-of-${run.id}`);
        expect(error.data.currentBaseCommit).toBe("base-moved-7");
        expect(statusChain(events)).toEqual([
            "PROVISIONING",
            "PLANNING",
            "AWAITING_APPROVAL",
            "IMPLEMENTING",
            "AWAITING_APPROVAL",
            "PLANNING",
            "AWAITING_APPROVAL",
        ]);
        const plans = events.filter((e) => e.type === "run.plan.updated");
        expect(plans.length).toBe(2);
        expect(plans[1]!.data.planVersion).toBe(2);
        expect(plans[1]!.data.reason).toBe("stale-approval-regeneration");
        expect(plans[1]!.data.plan).toContain("base-moved-7");

        // NOTHING was implemented for the stale approval.
        const sandbox = worker.deps.sandboxes.byRun(run.id)!;
        expect(Object.keys(sandbox.snapshotFiles()).sort()).toEqual(INITIAL_TRACKED);

        // Only re-approval of the REGENERATED plan completes — and it builds
        // on the CURRENT base, not the stale one.
        await recordApproval({ runId: run.id, planVersion: 2, decision: "APPROVED", decidedBy: "alice" });
        const done: Outcome = await worker.runOnce();
        expect(done!.status).toBe("completed");
        expect((await rowOf(run.id)).status).toBe("COMPLETED");
        const intent = (await eventsFor(run.id)).find((e) => e.type === "run.publication.intent");
        expect(intent.data.baseCommit).toBe("base-moved-7");
        expect(intent.data.headCommit).toBe("head-of-base-moved-7");
    });
});

describe("worker (c)+(d): a late result cannot publish a cancelled run; cancel releases the slot", () => {
    test("cancel landing mid-stream stops the engine, records NO intent, releases the slot for a new run", async () => {
        const run = await launch("iss_5");
        let cancelledOnce = false;
        const worker = createRunWorker({
            store,
            // Hook fires AFTER each engine event is persisted and BEFORE the
            // worker re-reads the run — exactly when a real cancel can land.
            afterEvent: async ({ runId }) => {
                if (!cancelledOnce) {
                    cancelledOnce = true;
                    await cancelRun({ runId, actorId: "alice", reason: "owner cancelled mid-flight" });
                }
            },
        });

        const outcome: Outcome = await worker.runOnce();
        expect(outcome!.status).toBe("cancelled-observed:CANCELLED");

        const row = await rowOf(run.id);
        expect(row.status).toBe("CANCELLED");
        expect(row.activeIssueId).toBeNull(); // (d) slot released

        const events = await eventsFor(run.id);
        // (c) the late result published NOTHING.
        expect(events.some((e) => e.type === "run.publication.intent")).toBe(false);
        expect(statusChain(events)).toEqual(["PROVISIONING", "IMPLEMENTING", "CANCELLED"]);

        // The job itself closes (work abandoned) and the fake engine stopped.
        expect((await store.get(outcome!.jobId))!.status).toBe("COMPLETED");
        const firstOutput = events.find((e) => e.type === "run.engine.output");
        const codex = worker.deps.registry.get("CODEX") as any;
        expect(codex.sessionPhase(firstOutput.data.sessionId)).toBe("cancelled");
        expect(worker.deps.sandboxes.byRun(run.id)!.state).toBe("KILLED");

        // (d) a NEW run for the SAME issue can start immediately and completes.
        const run2 = await launch("iss_5");
        expect(run2.id).not.toBe(run.id);
        const outcome2: Outcome = await worker.runOnce();
        expect(outcome2!.status).toBe("completed");
        expect((await rowOf(run2.id)).status).toBe("COMPLETED");
        expect((await eventsFor(run2.id)).some((e) => e.type === "run.publication.intent")).toBe(true);
        expect((await eventsFor(run.id)).some((e) => e.type === "run.publication.intent")).toBe(false);
    });
});

describe("worker: unsupported engines fail honestly, never substituted", () => {
    test("PI run (possible only by direct row insert — the API rejects it) ends FAILED with the catalog reason", async () => {
        const run = await launch("iss_6", { engine: "PI", model: "pi-1" });
        const worker = createRunWorker({ store });

        const outcome: Outcome = await worker.runOnce();
        expect(outcome!.status).toBe("failed-unsupported-engine");

        const row = await rowOf(run.id);
        expect(row.status).toBe("FAILED");
        expect(row.activeIssueId).toBeNull();
        // Substituted with NOTHING: the row still names the requested engine.
        expect(row.engine).toBe("PI");
        expect(row.model).toBe("pi-1");

        const events = await eventsFor(run.id);
        const error = events.find((e) => e.type === "run.error");
        expect(error.data.code).toBe("UNSUPPORTED_CAPABILITY");
        expect(error.data.substituted).toBe(false);
        expect(String(error.data.detail)).toContain("has not shipped");
        expect(statusChain(events)).toEqual(["FAILED"]);
        expect((await store.get(outcome!.jobId))!.status).toBe("COMPLETED");
    });
});

describe("worker: zombie fencing — a reclaimed lease cannot publish", () => {
    test("worker A loses the lease before PUBLISHING: no intent, guarded completion", async () => {
        const run = await launch("iss_8");
        let hijacked = false;
        const workerA = createRunWorker({
            store,
            owner: "worker-A",
            afterEvent: async ({ jobId }) => {
                if (!hijacked) {
                    hijacked = true;
                    // Lease expires and another worker takes over (fencing 2).
                    const future = new Date(Date.now() + 10 * 60_000).toISOString();
                    const stolen = await store.claimNext("worker-B", future, {
                        types: ["agent.run.execute"],
                    });
                    expect(stolen!.job.id).toBe(jobId);
                    expect(stolen!.fencingToken).toBe(2);
                }
            },
        });

        const outcome: Outcome = await workerA.runOnce();
        expect(outcome!.status.startsWith("aborted-lost-lease")).toBe(true);
        expect(outcome!.status.endsWith("+lost-lease")).toBe(true);

        const row = await rowOf(run.id);
        expect(row.status).toBe("REVIEWING"); // stopped BEFORE PUBLISHING
        const events = await eventsFor(run.id);
        expect(events.some((e) => e.type === "run.publication.intent")).toBe(false);

        const job = await store.get(outcome!.jobId);
        expect(job!.lockedBy).toBe("worker-B"); // zombie completion was rejected
        expect(job!.status).toBe("RUNNING");
        expect(job!.fencingToken).toBe(2);
    });
});

describe("worker: run messages route through the adapter contract", () => {
    test("a follow-up message is delivered to the open session and recorded durably", async () => {
        const run = await launch("iss_7", { executionMode: "PLAN_AND_APPROVE" });
        const worker = createRunWorker({ store });
        expect((await worker.runOnce())!.status).toBe("awaiting-approval");

        const row = await rowOf(run.id);
        const messageEvent = await appendRunEvent({
            runId: run.id,
            type: "run.message",
            issueId: run.issueId,
            status: row.status,
            data: { kind: "user-message", authorId: "alice", text: "also update the docs" },
        });
        await store.enqueue({
            type: "agent.run.message",
            runId: run.id,
            payload: { eventSequence: messageEvent.sequence, text: "also update the docs" },
        });

        const outcome: Outcome = await worker.runOnce();
        expect(outcome!.jobType).toBe("agent.run.message");
        expect(outcome!.status).toBe("message-delivered");

        const events = await eventsFor(run.id);
        const delivery = events
            .filter((e) => e.type === "run.engine.output")
            .find((e) => e.data.kind === "message-delivery");
        expect(delivery.data.delivered).toBe(true);
        expect(delivery.data.text).toBe("also update the docs");
        expect(delivery.data.eventSequence).toBe(messageEvent.sequence);
        expect(delivery.data.sessionId).toBeTruthy();
    });
});

describe("worker: no-network guarantee + idle queue", () => {
    test("global fetch was never invoked by any worker flow and an empty queue claims nothing", async () => {
        // Re-run a full lifecycle with the fetch trap armed, then assert.
        const run = await launch("iss_1", { executionMode: "PLAN_AND_APPROVE" });
        const worker = createRunWorker({ store });
        await worker.runOnce();
        await recordApproval({ runId: run.id, planVersion: 1, decision: "APPROVED", decidedBy: "alice" });
        await worker.runOnce();
        expect((await rowOf(run.id)).status).toBe("COMPLETED");

        expect(fetchCalls).toHaveLength(0); // (e) nothing touched the network
        expect(await worker.runOnce()).toBeNull(); // idle queue claims nothing
    });
});
