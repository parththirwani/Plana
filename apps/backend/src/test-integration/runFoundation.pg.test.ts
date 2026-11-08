import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
} from "bun:test";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import { prisma } from "@repo/db/db";
import { createPostgresJobStore } from "../jobs/postgresJobStore";
import { setJobStore } from "../jobs/jobStore";
import { createRun, cancelRun, getRunById } from "../runs/runRepository";
import { recordApproval } from "../runs/approvals";
import { requestRunCancellation, recordRunMessage } from "../runs/commands";
import { setRunEventPublisher } from "../runs/realtime";
import { readRuntime } from "../worker/runtime";
import { createRunWorker } from "../worker/runWorker";
import { createFakeOnlyRegistry } from "../adapters/registry";
import { fakeChecks } from "../worker/services";
const url = process.env.PLANA_PG_TEST_URL ?? "";
const suite = url ? describe : describe.skip;
const organizations: string[] = [];
const users: string[] = [];
const jobIds: string[] = [];
const childPath = new URL("./fixtures/run-process.ts", import.meta.url)
    .pathname;
const child = (mode: string, arg = "") =>
    Bun.spawn(["bun", childPath, mode, arg], {
        env: { ...process.env, AGENT_EXECUTION_MODE: "fake" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
const result = async (process: ReturnType<typeof child>) => {
    const text = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    if (await process.exited) throw new Error(stderr || text);
    const line = text.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`Child produced no result: ${text}`);
    return JSON.parse(line.slice(7));
};
suite("Phase 1 actual HTTP, queue and process boundaries", () => {
    let pool: Pool;
    let store: ReturnType<typeof createPostgresJobStore>;
    let appServer: import("node:http").Server;
    let base: string;
    beforeAll(async () => {
        if (
            url !== process.env.DATABASE_URL ||
            !new URL(url).pathname.includes("_test")
        )
            throw new Error(
                "Use the same disposable *_test DATABASE_URL and PLANA_PG_TEST_URL",
            );
        const [db] = await prisma.$queryRawUnsafe<Array<{ database: string }>>(
            "SELECT current_database() AS database",
        );
        if (db?.database !== decodeURIComponent(new URL(url).pathname.slice(1)))
            throw new Error("Wrong database");
        process.env.NODE_ENV = "test";
        process.env.JWT_SECRET = "disposable-integration-secret";
        process.env.AGENT_EXECUTION_MODE = "fake";
        pool = new Pool({ connectionString: url });
        store = createPostgresJobStore(pool);
        setJobStore(store);
        setRunEventPublisher(async () => {});
        const { app } = await import("../../index");
        appServer = app.listen(0);
        await new Promise<void>((resolve) =>
            appServer.once("listening", resolve),
        );
        base = `http://127.0.0.1:${(appServer.address() as import("node:net").AddressInfo).port}`;
    });
    afterEach(async () => {
        if (!pool) return;
        setRunEventPublisher(async () => {});
        await prisma.organization.deleteMany({
            where: { id: { in: organizations.splice(0) } },
        });
        await prisma.user.deleteMany({
            where: { id: { in: users.splice(0) } },
        });
        await prisma.agentJob.deleteMany({
            where: { id: { in: jobIds.splice(0) } },
        });
    });
    afterAll(async () => {
        if (appServer)
            await new Promise<void>((resolve) =>
                appServer.close(() => resolve()),
            );
        if (pool) await pool.end();
        await prisma.$disconnect();
    });
    const seed = async () => {
        const tag = crypto.randomUUID();
        const organization = await prisma.organization.create({
            data: { name: "Integration", slug: tag },
        });
        organizations.push(organization.id);
        const user = await prisma.user.create({
            data: { email: `${tag}@example.test`, password: "unused" },
        });
        users.push(user.id);
        await prisma.membership.create({
            data: {
                organizationId: organization.id,
                userId: user.id,
                role: "ADMIN",
            },
        });
        await prisma.organizationAgentConfig.create({
            data: {
                organizationId: organization.id,
                allowedRepositories: ["acme/web"],
            },
        });
        const board = await prisma.board.create({
            data: {
                title: "Board",
                organizationId: organization.id,
                defaultRepository: "acme/web",
            },
        });
        const section = await prisma.section.create({
            data: { title: "Todo", boardId: board.id },
        });
        const issue = await prisma.issue.create({
            data: {
                title: "Reject cross-organization access",
                description: "Verify existing permissions",
                sectionId: section.id,
            },
        });
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            process.env.JWT_SECRET!,
        );
        return { organization, user, issue, token, tag };
    };
    const post = (path: string, body: unknown, token: string) =>
        fetch(base + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: `token=${token}`,
            },
            body: JSON.stringify(body),
        });
    const launch = async (
        mode: "IMPLEMENT" | "PLAN_AND_APPROVE" = "IMPLEMENT",
    ) => {
        const seedData = await seed();
        const id = `pg-${crypto.randomUUID()}`;
        const { run } = await createRun({
            id,
            issueId: seedData.issue.id,
            organizationId: seedData.organization.id,
            createdBy: seedData.user.id,
            engine: "CODEX",
            model: "gpt-5",
            repository: "acme/web",
            executionMode: mode,
            idempotencyKey: id,
            onEnqueue: async (tx) => {
                await store.enqueue(
                    {
                        runId: id,
                        type: "agent.run.execute",
                        idempotencyKey: `start:${id}`,
                        payload: { reason: "created" },
                    },
                    tx,
                );
            },
        });
        return { ...seedData, run };
    };
    test("actual HTTP launch enqueue failure rolls back everything and retry succeeds", async () => {
        const s = await seed();
        const enqueue = store.enqueue.bind(store);
        const input = {
            engine: "CODEX",
            model: "gpt-5",
            idempotencyKey: s.tag,
        };
        try {
            store.enqueue = async () => {
                throw new Error("injected queue outage");
            };
            expect(
                (
                    await post(
                        `/api/v1/issues/${s.issue.id}/agent-runs`,
                        input,
                        s.token,
                    )
                ).status,
            ).toBe(500);
            expect(
                await prisma.agentRun.count({ where: { issueId: s.issue.id } }),
            ).toBe(0);
        } finally {
            store.enqueue = enqueue;
        }
        const response = await post(
            `/api/v1/issues/${s.issue.id}/agent-runs`,
            input,
            s.token,
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as { run: { id: string } };
        expect(
            await prisma.runEvent.count({ where: { runId: body.run.id } }),
        ).toBe(1);
        expect(await store.listByRun(body.run.id)).toHaveLength(1);
    });
    test("actual HTTP approval rollback and concurrent idempotency", async () => {
        const s = await launch("PLAN_AND_APPROVE");
        expect((await createRunWorker({ store }).runOnce())?.status).toBe(
            "awaiting-approval",
        );
        const enqueue = store.enqueue.bind(store);
        const path = `/api/v1/agent-runs/${s.run.id}/approvals`;
        const input = { planVersion: 1, decision: "APPROVED" };
        const count = await prisma.runEvent.count({
            where: { runId: s.run.id },
        });
        try {
            store.enqueue = async () => {
                throw new Error("injected queue outage");
            };
            expect((await post(path, input, s.token)).status).toBe(500);
        } finally {
            store.enqueue = enqueue;
        }
        expect((await getRunById(s.run.id))?.status).toBe("AWAITING_APPROVAL");
        expect(
            await prisma.runApproval.count({ where: { runId: s.run.id } }),
        ).toBe(0);
        expect(
            await prisma.runEvent.count({ where: { runId: s.run.id } }),
        ).toBe(count);
        const responses = await Promise.all(
            Array.from({ length: 6 }, () => post(path, input, s.token)),
        );
        expect(responses.map((r) => r.status).sort()).toEqual([
            200, 200, 200, 200, 200, 201,
        ]);
        expect(
            await prisma.runApproval.count({ where: { runId: s.run.id } }),
        ).toBe(1);
        expect(
            await prisma.runEvent.count({
                where: { runId: s.run.id, type: "run.approval.decided" },
            }),
        ).toBe(1);
    });
    test("real queue fail, retry, renewal, stale fencing and crash exhaustion", async () => {
        const type = `queue-${crypto.randomUUID()}`;
        const { job } = await store.enqueue({ type, maxAttempts: 2 });
        jobIds.push(job.id);
        const now = Date.now();
        const first = await store.claimNext("a", new Date(now).toISOString(), {
            types: [type],
            leaseMs: 1000,
        });
        expect(first?.job.id).toBe(job.id);
        expect(
            (
                await store.fail(
                    job.id,
                    "a",
                    first!.fencingToken,
                    new Date(now + 1).toISOString(),
                    "temporary",
                    new Date(now + 100).toISOString(),
                )
            )?.status,
        ).toBe("QUEUED");
        expect(
            await store.claimNext("b", new Date(now + 20).toISOString(), {
                types: [type],
            }),
        ).toBeNull();
        const second = await store.claimNext(
            "b",
            new Date(now + 101).toISOString(),
            { types: [type], leaseMs: 100 },
        );
        expect(second?.job.attempts).toBe(2);
        expect(
            await store.complete(
                job.id,
                "a",
                first!.fencingToken,
                new Date(now + 102).toISOString(),
            ),
        ).toBeNull();
        expect(
            await store.renewLease(
                job.id,
                "b",
                second!.fencingToken,
                new Date(now + 150).toISOString(),
                200,
            ),
        ).not.toBeNull();
        expect(
            await store.claimNext("c", new Date(now + 351).toISOString(), {
                types: [type],
            }),
        ).toBeNull();
        expect((await store.get(job.id))?.status).toBe("FAILED");
        expect((await store.get(job.id))?.attempts).toBe(2);
    });
    test("two processes serialize a concurrent launch and enqueue once", async () => {
        const s = await seed();
        const id = `launch-${s.tag}`;
        const input = JSON.stringify({
            id,
            issueId: s.issue.id,
            organizationId: s.organization.id,
            createdBy: s.user.id,
            engine: "CODEX",
            model: "gpt-5",
            repository: "acme/web",
            idempotencyKey: s.tag,
        });
        const results = await Promise.all([
            result(child("launch", input)),
            result(child("launch", input)),
        ]);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(results[0].id).toBe(results[1].id);
        expect(
            await prisma.agentRun.count({ where: { issueId: s.issue.id } }),
        ).toBe(1);
        expect(await store.listByRun(id)).toHaveLength(1);
        expect(await prisma.runEvent.count({ where: { runId: id } })).toBe(1);
    });
    test("a stale process cannot revive a cancelled run", async () => {
        const s = await launch();
        const stale = child("transition", s.run.id);
        const reader = stale.stdout.getReader();
        let output = "";
        while (!output.includes("READY")) {
            const item = await reader.read();
            if (item.done) throw new Error("child exited before reading");
            output += new TextDecoder().decode(item.value);
        }
        await cancelRun({ runId: s.run.id, expectedFrom: "QUEUED" });
        stale.stdin.write("continue\n");
        stale.stdin.end();
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            output += new TextDecoder().decode(item.value);
        }
        expect(await stale.exited).toBe(0);
        expect(output).toContain('"code":"ILLEGAL_TRANSITION"');
        expect((await getRunById(s.run.id))?.status).toBe("CANCELLED");
    });
    test("new worker processes restore plan, message delivery, approval and publication", async () => {
        const s = await launch("PLAN_AND_APPROVE");
        expect((await result(child("worker"))).status).toBe(
            "awaiting-approval",
        );
        const message = await recordRunMessage(
            s.run.id,
            s.user.id,
            "Add a regression for the denied request",
        );
        expect((await result(child("worker"))).status).toBe(
            "message-delivered",
        );
        expect(
            readRuntime((await getRunById(s.run.id))!).deliveredInputs,
        ).toContain(message.messageId);
        await recordApproval({
            runId: s.run.id,
            planVersion: 1,
            decision: "APPROVED",
            decidedBy: s.user.id,
        });
        expect((await result(child("worker"))).status).toBe("completed");
        const runtime = readRuntime((await getRunById(s.run.id))!);
        expect(runtime.ack?.headCommit).toBe(runtime.completed?.headCommit);
        expect(runtime.cleaned).toBe(true);
    });
    test("SIGKILL after provisioning is recovered by a replacement process", async () => {
        const s = await launch();
        const crashed = child("crash");
        const reader = crashed.stdout.getReader();
        let output = "";
        while (!output.includes("STARTED")) {
            const item = await reader.read();
            if (item.done) throw new Error("child did not start");
            output += new TextDecoder().decode(item.value);
        }
        crashed.kill("SIGKILL");
        await crashed.exited;
        const [job] = await store.listByRun(s.run.id);
        await prisma.agentJob.update({
            where: { id: job!.id },
            data: { leaseExpiresAt: new Date(0) },
        });
        await prisma.agentRun.update({
            where: { id: s.run.id },
            data: { leaseExpiresAt: new Date(0) },
        });
        expect((await result(child("worker"))).status).toBe("completed");
        expect((await store.get(job!.id))?.attempts).toBe(2);
        const transitions = await prisma.runEvent.findMany({
            where: { runId: s.run.id, type: "run.status.changed" },
        });
        expect(
            transitions.filter(
                (e) => (e.data as { to?: string }).to === "PROVISIONING",
            ),
        ).toHaveLength(1);
    });
    test("slow work renews both leases against PostgreSQL", async () => {
        const s = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        const original = adapter.streamEvents.bind(adapter);
        adapter.streamEvents = (id) => ({
            async *[Symbol.asyncIterator]() {
                for await (const event of original(id)) {
                    await new Promise((r) => setTimeout(r, 80));
                    yield event;
                }
            },
        });
        expect(
            (await createRunWorker({ store, registry, leaseMs: 400 }).runOnce())
                ?.status,
        ).toBe("completed");
        expect(
            await prisma.runLeaseRenewal.count({ where: { runId: s.run.id } }),
        ).toBeGreaterThan(1);
    });
    test("a reclaimed run is fenced before publication intent on real PostgreSQL", async () => {
        const s = await launch();
        let external = false;
        const checks = {
            ...fakeChecks,
            review: async (...args: Parameters<typeof fakeChecks.review>) => {
                const { claimRunLease } = await import("../runs/stateMachine");
                await prisma.$transaction((tx) =>
                    claimRunLease(tx, {
                        runId: s.run.id,
                        machineId: "replacement",
                        expectedStatus: "REVIEWING",
                        leaseTtlMillis: 60000,
                        now: new Date(Date.now() + 120000),
                    }),
                );
                return fakeChecks.review(...args);
            },
        };
        await createRunWorker({
            store,
            checks,
            publisher: {
                publish: async () => {
                    external = true;
                    return null;
                },
            },
        }).runOnce();
        expect(
            await prisma.runEvent.count({
                where: { runId: s.run.id, type: "run.publication.intent" },
            }),
        ).toBe(0);
        expect(external).toBe(false);
    });
    test("heartbeat inbox delivery preserves both stream state and one durable receipt", async () => {
        const s = await launch();
        const registry = createFakeOnlyRegistry();
        const adapter = registry.require("CODEX");
        let entered!: () => void, deliver!: () => void;
        const ready = new Promise<void>((r) => (entered = r)),
            received = new Promise<void>((r) => (deliver = r));
        const stream = adapter.streamEvents.bind(adapter),
            send = adapter.sendInput.bind(adapter);
        adapter.streamEvents = (id) => ({
            async *[Symbol.asyncIterator]() {
                entered();
                await received;
                for await (const event of stream(id)) yield event;
            },
        });
        adapter.sendInput = async (...args) => {
            const value = await send(...args);
            deliver();
            return value;
        };
        const worker = createRunWorker({ store, registry, leaseMs: 500 });
        const running = worker.runOnce();
        await ready;
        const response = await post(
            `/api/v1/agent-runs/${s.run.id}/messages`,
            { text: "Cover the quiet session" },
            s.token,
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as { messageId: string };
        expect((await running)?.status).toBe("completed");
        const runtime = readRuntime((await getRunById(s.run.id))!);
        expect(runtime.deliveredInputs).toContain(body.messageId);
        expect(runtime.session?.state?.inputs).toContain(
            "Cover the quiet session",
        );
        expect(
            await prisma.runEvent.count({
                where: {
                    runId: s.run.id,
                    type: "run.engine.output",
                    data: { path: ["messageId"], equals: body.messageId },
                },
            }),
        ).toBe(1);
    });
    test("the worker entrypoint reports readiness and shuts down cleanly", async () => {
        const process = Bun.spawn(
            ["bun", new URL("../worker/main.ts", import.meta.url).pathname],
            {
                env: { ...Bun.env, AGENT_EXECUTION_MODE: "fake" },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const reader = process.stdout.getReader();
        let output = "";
        while (!output.includes('"status":"ready"')) {
            const chunk = await reader.read();
            if (chunk.done)
                throw new Error(await new Response(process.stderr).text());
            output += new TextDecoder().decode(chunk.value);
        }
        process.kill("SIGTERM");
        expect(await process.exited).toBe(0);
    });
    test("exhausted durable jobs become a blocker that can resume once", async () => {
        const s = await launch();
        const [job] = await store.listByRun(s.run.id);
        await prisma.agentJob.update({
            where: { id: job!.id },
            data: { maxAttempts: 1 },
        });
        await store.claimNext("crashed", new Date().toISOString());
        await prisma.agentJob.update({
            where: { id: job!.id },
            data: { leaseExpiresAt: new Date(0) },
        });
        const worker = createRunWorker({ store });
        expect(await worker.runOnce()).toBeNull();
        const blocked = (await getRunById(s.run.id))!;
        expect(blocked.status).toBe("BLOCKED");
        expect(readRuntime(blocked).handledFailures).toContain(job!.id);
        expect(
            (await post(`/api/v1/agent-runs/${s.run.id}/resume`, {}, s.token))
                .status,
        ).toBe(200);
        expect((await worker.runOnce())?.status).toBe("completed");
    });
    test("two separate approval processes record exactly one decision and execution job", async () => {
        const s = await launch("PLAN_AND_APPROVE");
        expect((await result(child("worker"))).status).toBe(
            "awaiting-approval",
        );
        const input = JSON.stringify({
            runId: s.run.id,
            planVersion: 1,
            decision: "APPROVED",
            decidedBy: s.user.id,
        });
        const decisions = await Promise.all([
            result(child("approve", input)),
            result(child("approve", input)),
        ]);
        expect(decisions.filter((d) => !d.replayed)).toHaveLength(1);
        expect(
            await prisma.runApproval.count({ where: { runId: s.run.id } }),
        ).toBe(1);
        expect(
            (await store.listByRun(s.run.id)).filter(
                (j) => j.idempotencyKey === `run:${s.run.id}:execute:v1`,
            ),
        ).toHaveLength(1);
    });
    test("a replacement process cleans an idle cancelled approval sandbox", async () => {
        const s = await launch("PLAN_AND_APPROVE");
        expect((await result(child("worker"))).status).toBe(
            "awaiting-approval",
        );
        await requestRunCancellation(s.run.id, s.user.id);
        expect((await result(child("worker"))).status).toBe("cleaned");
        const final = (await getRunById(s.run.id))!;
        expect(final.status).toBe("CANCELLED");
        expect(final.activeIssueId).toBeNull();
        expect(readRuntime(final).cleaned).toBe(true);
    });
});
