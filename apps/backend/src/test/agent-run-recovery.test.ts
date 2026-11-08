process.env.AGENT_EXECUTION_MODE = "fake";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { prismaMock } from "../test-utils/prismaMock";
import { createMemoryJobStore } from "../jobs/memoryJobStore";
import { setJobStore } from "../jobs/jobStore";
import { createFakeOnlyRegistry } from "../adapters/registry";
import { listEngineSpecs } from "../adapters/capabilities";
mock.module("@repo/db/db", () => ({ prisma: prismaMock.prisma }));
const { createRun, getRunById, transitionRun } =
    await import("../runs/runRepository");
const { setRunEventPublisher } = await import("../runs/realtime");
const { recordApproval } = await import("../runs/approvals");
const { recordRunMessage, requestRunCancellation, scheduleRunResume } =
    await import("../runs/commands");
const { createRunWorker } = await import("../worker/runWorker");
const { fakeChecks, fakePublisher } = await import("../worker/services");
const { replayRunEvents, appendRunEvent } = await import("../runs/eventLog");
const { readRuntime } = await import("../worker/runtime");
const prisma = prismaMock.prisma;
let store: ReturnType<typeof createMemoryJobStore>;
let sequence = 0;
beforeEach(() => {
    process.env.AGENT_EXECUTION_MODE = "fake";
    prismaMock.reset({
        boards: [
            { id: "b", title: "Board", organizationId: "o", description: null },
        ],
        sections: [{ id: "s", boardId: "b", title: "Todo", order: 0 }],
        issues: [
            {
                id: "i",
                sectionId: "s",
                title: "Fix missing authorization",
                description: "Reject another organization's access",
                priority: "HIGH",
                order: 0,
                dueDate: null,
                assigneeIds: [],
            },
        ],
    });
    store = createMemoryJobStore(prisma as any);
    setJobStore(store);
    setRunEventPublisher(async () => {});
});
const launch = async (mode: "IMPLEMENT" | "PLAN_AND_APPROVE" = "IMPLEMENT") => {
    const id = `recovery-${++sequence}`;
    const { run } = await createRun({
        id,
        issueId: "i",
        organizationId: "o",
        createdBy: "moderator",
        engine: "CODEX",
        model: "gpt-5",
        repository: "acme/web",
        executionMode: mode,
        idempotencyKey: id,
        onEnqueue: async (tx) => {
            await store.enqueue(
                {
                    type: "agent.run.execute",
                    runId: id,
                    payload: { reason: "created" },
                },
                tx,
            );
        },
    });
    return run;
};
const row = async (id: string) => (await getRunById(id))!;
const events = (id: string) =>
    prisma.runEvent.findMany({
        where: { runId: id },
        orderBy: { sequence: "asc" },
    });
const approve = (id: string, version = 1) =>
    recordApproval({
        runId: id,
        planVersion: version,
        decision: "APPROVED",
        decidedBy: "moderator",
    });
const unblockJobs = async (id: string) => {
    for (const j of await store.listByRun(id))
        if (j.status === "QUEUED")
            await prisma.agentJob.update({
                where: { id: j.id },
                data: { availableAt: new Date(0).toISOString() },
            });
};

describe("durable recovery and enforcement regressions", () => {
    test("a different worker restores and implements an approved plan", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        const a = createRunWorker({ store });
        expect((await a.runOnce())?.status).toBe("awaiting-approval");
        await approve(run.id);
        const b = createRunWorker({ store });
        expect((await b.runOnce())?.status).toBe("completed");
        expect((await row(run.id)).status).toBe("COMPLETED");
        const runtime = readRuntime(await row(run.id));
        expect(runtime.ack?.headCommit).toBe(runtime.completed?.headCommit);
        expect(runtime.cleaned).toBe(true);
    });
    test("messages restore a paused session on another worker and remain paused", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        await createRunWorker({ store }).runOnce();
        const message = await recordRunMessage(
            run.id,
            "moderator",
            "Also cover the cross-org case",
        );
        const b = createRunWorker({ store });
        expect((await b.runOnce())?.status).toBe("message-delivered");
        const runtime = readRuntime(await row(run.id));
        expect(runtime.deliveredInputs).toContain(message.messageId);
        expect(b.deps.sandboxes.byRun(run.id)?.state).toBe("PAUSED");
        await approve(run.id);
        expect((await b.runOnce())?.status).toBe("completed");
    });
    test("transient start failure retries the durable intermediate stage", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        const start = adapter.start.bind(adapter);
        let calls = 0;
        adapter.start = async (request) => {
            if (++calls === 1) throw new Error("temporary provisioning outage");
            return start(request);
        };
        const worker = createRunWorker({ store, registry });
        expect((await worker.runOnce())?.status).toBe("job-failed");
        expect((await row(run.id)).status).toBe("PROVISIONING");
        await unblockJobs(run.id);
        expect((await worker.runOnce())?.status).toBe("completed");
        expect(calls).toBe(2);
    });
    test("failed validation, review rejection and empty streams never create intent", async () => {
        for (const failure of ["engine", "empty", "validation", "review"]) {
            prismaMock.reset({
                issues: [
                    {
                        id: "i",
                        sectionId: "s",
                        title: "task",
                        description: null,
                        priority: "NONE",
                        order: 0,
                        dueDate: null,
                        assigneeIds: [],
                    },
                ],
            });
            store = createMemoryJobStore(prisma as any);
            setJobStore(store);
            const run = await launch();
            const registry = createFakeOnlyRegistry();
            if (failure === "engine")
                registry.require("CODEX").streamEvents = () => ({
                    async *[Symbol.asyncIterator]() {
                        yield { type: "validation", data: { ok: false } };
                        yield {
                            type: "completed",
                            data: {
                                baseCommit: "base",
                                headCommit: "head",
                                changedFiles: [],
                            },
                        };
                    },
                });
            if (failure === "empty")
                registry.require("CODEX").streamEvents = () => ({
                    async *[Symbol.asyncIterator]() {},
                });
            const checks = { ...fakeChecks };
            if (failure === "validation")
                checks.validate = async () => ({
                    ok: false,
                    command: "tests",
                    output: "regression failed",
                    source: "worker",
                    mode: "fake",
                });
            if (failure === "review")
                checks.review = async () => ({
                    ok: false,
                    command: "review",
                    output: "authorization hole",
                    source: "worker",
                    mode: "fake",
                });
            const worker = createRunWorker({ store, registry, checks });
            expect((await worker.runOnce())?.status, failure).toBe(
                "job-failed",
            );
            expect((await row(run.id)).status).toBe("BLOCKED");
            expect(
                (await events(run.id)).some(
                    (e) => e.type === "run.publication.intent",
                ),
            ).toBe(false);
        }
    });
    test("publication keeps the artifact and machine until publisher acknowledgement", async () => {
        const run = await launch();
        const worker = createRunWorker({
            store,
            publisher: { publish: async () => null },
        });
        expect((await worker.runOnce())?.status).toBe("awaiting-publication");
        let persisted = await row(run.id);
        expect(persisted.status).toBe("PUBLISHING");
        expect(persisted.activeIssueId).toBe("i");
        expect(readRuntime(persisted).artifact?.files).toBeDefined();
        expect(readRuntime(persisted).ack).toBeUndefined();
        expect(worker.deps.sandboxes.byRun(run.id)?.state).toBe("RUNNING");
        await unblockJobs(run.id);
        const replacement = createRunWorker({
            store,
            publisher: fakePublisher,
        });
        expect((await replacement.runOnce())?.status).toBe("completed");
        persisted = await row(run.id);
        expect(readRuntime(persisted).ack).toBeDefined();
        expect(
            (await events(run.id)).filter(
                (e) => e.type === "run.publication.intent",
            ),
        ).toHaveLength(1);
    });
    test("idle paused cancellation is cleaned up by a different worker", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        await createRunWorker({ store }).runOnce();
        await requestRunCancellation(run.id, "moderator");
        const replacement = createRunWorker({ store });
        expect((await replacement.runOnce())?.status).toBe("cleaned");
        expect(readRuntime(await row(run.id)).cleaned).toBe(true);
        expect(replacement.deps.sandboxes.byRun(run.id)?.state).toBe("KILLED");
        expect(replacement.deps.sandboxes.createdCount).toBe(0);
    });
    test("changed requirements reject approval and regenerate the exact context", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        const a = createRunWorker({ store });
        await a.runOnce();
        await prisma.issue.update({
            where: { id: "i" },
            data: { description: "New acceptance criteria" },
        });
        await expect(approve(run.id)).rejects.toMatchObject({
            code: "STALE_APPROVAL",
        });
        expect((await row(run.id)).status).toBe("PLANNING");
        const b = createRunWorker({ store });
        expect((await b.runOnce())?.status).toBe("awaiting-approval");
        expect((await row(run.id)).planVersion).toBe(2);
        await approve(run.id, 2);
        expect((await b.runOnce())?.status).toBe("completed");
    });
    test("identical concurrent approvals have one durable effect, including replay after completion", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        const worker = createRunWorker({ store });
        await worker.runOnce();
        const decisions = await Promise.all(
            Array.from({ length: 8 }, () => approve(run.id)),
        );
        expect(decisions.filter((d) => !d.replayed)).toHaveLength(1);
        expect(
            (await events(run.id)).filter(
                (e) => e.type === "run.approval.decided",
            ),
        ).toHaveLength(1);
        expect((await worker.runOnce())?.status).toBe("completed");
        expect((await approve(run.id)).replayed).toBe(true);
    });
    test("blocked and limited runs retain their slot and resume the same execution", async () => {
        for (const status of ["BLOCKED", "LIMIT_REACHED"] as const) {
            const run = await launch();
            await transitionRun({
                runId: run.id,
                expectedFrom: "QUEUED",
                to: status,
            });
            expect((await row(run.id)).activeIssueId).toBe("i");
            await scheduleRunResume(run.id, "moderator");
            expect((await row(run.id)).status).toBe("QUEUED");
            expect((await createRunWorker({ store }).runOnce())?.status).toBe(
                "completed",
            );
            await createRunWorker({ store }).drain();
        }
    });
    test("a later manual resume never replays a completed resume job", async () => {
        const run = await launch("PLAN_AND_APPROVE");
        await createRunWorker({ store }).runOnce();
        const a = await scheduleRunResume(run.id, "moderator");
        await createRunWorker({ store }).runOnce();
        const b = await scheduleRunResume(run.id, "moderator");
        expect(a.jobId).not.toBe(b.jobId);
        const c = await scheduleRunResume(run.id, "moderator");
        expect(c.jobId).toBe(b.jobId);
        expect(c.coalesced).toBe(true);
    });
    test("truncated replay advances only through events actually returned", async () => {
        const run = await launch();
        for (let i = 0; i < 6; i++)
            await appendRunEvent({
                runId: run.id,
                type: "run.message",
                silent: true,
            });
        const a = await replayRunEvents(run.id, 0, {
            pageSize: 5,
            maxEvents: 2,
        });
        expect(a.events.map((e) => e.sequence)).toEqual([1, 2]);
        expect(a.nextSequence).toBe(2);
        const b = await replayRunEvents(run.id, a.nextSequence, {
            pageSize: 5,
            maxEvents: 2,
        });
        expect(b.events.map((e) => e.sequence)).toEqual([3, 4]);
        const zero = await replayRunEvents(run.id, 0, {
            pageSize: 5,
            maxEvents: 0,
        });
        expect(zero.nextSequence).toBe(0);
    });
    test("production capabilities and worker fail closed without explicit implementations", () => {
        delete process.env.AGENT_EXECUTION_MODE;
        try {
            expect(listEngineSpecs().every((e) => !e.available)).toBe(true);
            expect(() => createRunWorker({ store })).toThrow("disabled");
        } finally {
            process.env.AGENT_EXECUTION_MODE = "fake";
        }
    });
});

describe("live attempt supervision", () => {
    test("heartbeat renews run and queue leases across slow engine output", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        const original = adapter.streamEvents.bind(adapter);
        adapter.streamEvents = (id) => ({
            async *[Symbol.asyncIterator]() {
                for await (const event of original(id)) {
                    await new Promise((r) => setTimeout(r, 50));
                    yield event;
                }
            },
        });
        const worker = createRunWorker({ store, registry, leaseMs: 180 });
        expect((await worker.runOnce())?.status).toBe("completed");
        expect(
            await prisma.runLeaseRenewal.count({ where: { runId: run.id } }),
        ).toBeGreaterThan(1);
        expect(
            (await store.listByRun(run.id)).find(
                (j) => j.type === "agent.run.execute",
            )?.attempts,
        ).toBe(1);
    });
    test("cancellation interrupts an engine that never yields output", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        let entered!: () => void;
        const ready = new Promise<void>((r) => (entered = r));
        registry.require("CODEX").streamEvents = () => ({
            [Symbol.asyncIterator]() {
                return {
                    next: () => {
                        entered();
                        return new Promise<
                            IteratorResult<
                                import("../adapters/contract").EngineEvent
                            >
                        >(() => {});
                    },
                    return: async () => ({ done: true, value: undefined }),
                };
            },
        });
        const worker = createRunWorker({ store, registry, leaseMs: 150 });
        const running = worker.runOnce();
        await ready;
        await requestRunCancellation(run.id, "moderator");
        expect((await running)?.status).toBe("cancelled-observed:CANCELLED");
        expect(readRuntime(await row(run.id)).cleaned).toBe(true);
        expect(worker.deps.sandboxes.byRun(run.id)?.state).toBe("KILLED");
    });
    test("ownership stolen before intent fences every publication write", async () => {
        const run = await launch();
        let published = false;
        const checks = {
            ...fakeChecks,
            review: async (...args: Parameters<typeof fakeChecks.review>) => {
                const { claimRunLease } = await import("../runs/stateMachine");
                await claimRunLease(prisma as any, {
                    runId: run.id,
                    machineId: "replacement",
                    expectedStatus: "REVIEWING",
                    leaseTtlMillis: 60000,
                    now: new Date(Date.now() + 120000),
                });
                return fakeChecks.review(...args);
            },
        };
        const worker = createRunWorker({
            store,
            checks,
            publisher: {
                publish: async () => {
                    published = true;
                    throw new Error("must not publish");
                },
            },
        });
        expect((await worker.runOnce())?.error).toContain("no longer owns");
        expect(
            (await events(run.id)).some(
                (e) => e.type === "run.publication.intent",
            ),
        ).toBe(false);
        expect(published).toBe(false);
    });
    test("publisher rechecks authority after intent and cannot acknowledge cancellation", async () => {
        const run = await launch();
        let externalEffect = false;
        const worker = createRunWorker({
            store,
            publisher: {
                publish: async ({ authorize }) => {
                    await requestRunCancellation(run.id, "moderator");
                    await authorize();
                    externalEffect = true;
                    return null;
                },
            },
        });
        expect((await worker.runOnce())?.status).toBe(
            "cancelled-observed:CANCELLED",
        );
        expect(externalEffect).toBe(false);
        expect(readRuntime(await row(run.id)).ack).toBeUndefined();
    });
    test("exhausted crash reclaims stop and reconcile the run into a resumable blocker", async () => {
        const run = await launch();
        const [job] = await store.listByRun(run.id);
        await prisma.agentJob.update({
            where: { id: job!.id },
            data: { maxAttempts: 2 },
        });
        const first = await store.claimNext(
            "crashed-a",
            new Date().toISOString(),
            {
                leaseMs: 50,
            },
        );
        const second = await store.claimNext(
            "crashed-b",
            new Date(Date.now() + 100).toISOString(),
            { leaseMs: 50 },
        );
        expect(first?.job.attempts).toBe(1);
        expect(second?.job.attempts).toBe(2);
        expect(
            await store.claimNext(
                "third",
                new Date(Date.now() + 200).toISOString(),
            ),
        ).toBeNull();
        expect((await store.get(job!.id))?.status).toBe("FAILED");
        await createRunWorker({ store }).runOnce();
        expect((await row(run.id)).status).toBe("BLOCKED");
        await scheduleRunResume(run.id, "moderator");
        expect((await createRunWorker({ store }).runOnce())?.status).toBe(
            "completed",
        );
    });
});

describe("quiet-session inbox", () => {
    test("a persisted message reaches a quiet engine through the heartbeat", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        let entered!: () => void, delivered!: () => void;
        const ready = new Promise<void>((resolve) => (entered = resolve));
        const input = new Promise<void>((resolve) => (delivered = resolve));
        const originalStream = adapter.streamEvents.bind(adapter),
            originalInput = adapter.sendInput.bind(adapter);
        adapter.streamEvents = (id) => ({
            async *[Symbol.asyncIterator]() {
                entered();
                await input;
                for await (const event of originalStream(id)) yield event;
            },
        });
        adapter.sendInput = async (...args) => {
            const receipt = await originalInput(...args);
            delivered();
            return receipt;
        };
        const worker = createRunWorker({ store, registry, leaseMs: 150 });
        const running = worker.runOnce();
        await ready;
        const message = await recordRunMessage(
            run.id,
            "moderator",
            "Cover the silent-engine case",
        );
        expect((await running)?.status).toBe("completed");
        const runtime = readRuntime(await row(run.id));
        expect(runtime.deliveredInputs).toContain(message.messageId);
        expect(runtime.session?.state?.inputs).toContain(
            "Cover the silent-engine case",
        );
        expect(
            (await events(run.id)).filter(
                (e) =>
                    e.type === "run.engine.output" &&
                    (e.data as { messageId?: string }).messageId ===
                        message.messageId,
            ),
        ).toHaveLength(1);
    });
});

describe("publication artifact identity", () => {
    test("engine head claims cannot override the workspace artifact", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        const original = adapter.streamEvents.bind(adapter);
        adapter.streamEvents = (id) => ({
            async *[Symbol.asyncIterator]() {
                for await (const event of original(id))
                    yield event.type === "completed"
                        ? {
                              ...event,
                              data: {
                                  ...event.data,
                                  headCommit: "unrelated-head",
                              },
                          }
                        : event;
            },
        });
        expect(
            (await createRunWorker({ store, registry }).runOnce())?.status,
        ).toBe("job-failed");
        expect(
            (await events(run.id)).some(
                (e) => e.type === "run.publication.intent",
            ),
        ).toBe(false);
        expect((await row(run.id)).status).toBe("BLOCKED");
    });
    test("unsafe paths and workflow modifications are rejected outside the engine", async () => {
        const { assertPublicationArtifact } =
            await import("../worker/artifactPolicy");
        const run = await launch();
        await prisma.agentRun.update({
            where: { id: run.id },
            data: { baseCommit: "base" },
        });
        const runtime = readRuntime(await row(run.id));
        runtime.completed = {
            baseCommit: "base",
            headCommit: "head",
            changedFiles: [".github/workflows/change.yml"],
        };
        runtime.artifact = {
            id: "a",
            at: new Date().toISOString(),
            reason: "publication",
            files: { ".github/workflows/change.yml": "untrusted" },
            tracked: [".github/workflows/change.yml"],
            headCommit: "head",
        };
        expect(() =>
            assertPublicationArtifact({ ...run, baseCommit: "base" }, runtime),
        ).toThrow("outside");
        runtime.completed.changedFiles = [];
        runtime.artifact.files = { "../escape": "bad" };
        expect(() =>
            assertPublicationArtifact({ ...run, baseCommit: "base" }, runtime),
        ).toThrow("Unsafe");
    });
});

describe("infrastructure backoff", () => {
    test("provider retry hints are persisted without spinning or waiting inline", async () => {
        const run = await launch();
        const registry = createFakeOnlyRegistry();
        registry.require("CODEX").start = async () => {
            throw Object.assign(new Error("provider throttled"), {
                retryAfterMs: 5000,
            });
        };
        const before = Date.now();
        expect(
            (await createRunWorker({ store, registry }).runOnce())?.status,
        ).toBe("job-failed");
        const [job] = await store.listByRun(run.id);
        expect(Date.parse(job!.availableAt)).toBeGreaterThanOrEqual(
            before + 5000,
        );
        expect(job?.status).toBe("QUEUED");
    });
});
