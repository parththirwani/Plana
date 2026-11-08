process.env.AGENT_EXECUTION_MODE = "fake";
import {
    describe,
    test,
    expect,
    beforeAll,
    afterAll,
    beforeEach,
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
    MockOrgAgentConfig,
} from "../test-utils/prismaMock";
import { startTestServer, makeHttp } from "../test-utils/http";
import { createMemoryJobStore } from "../jobs/memoryJobStore";
import type { JobStore } from "../jobs/types";

mock.module("@repo/db/db", () => ({ prisma: prismaMock.prisma }));
mock.module("bcryptjs", () => ({
    default: {
        hash: async () => "hashed-password",
        compare: async (plain: string, hashed: string) => plain === hashed,
    },
    hash: async () => "hashed-password",
    compare: async (plain: string, hashed: string) => plain === hashed,
}));

process.env.JWT_SECRET = "test-secret";

// CP4 evidence — run actions over HTTP: plan approval (exact plan version +
// base commit, idempotent replay, stale rejection), cancel (terminal finality,
// active-slot release, queued-job teardown), resume (coalescing durable
// re-enqueue, terminal refusal), run messages, and the MODERATOR+ permission
// matrix. Handlers must only mutate state + enqueue; nothing runs inline.

const prisma = prismaMock.prisma;
const json = async (res: Response): Promise<any> => (await res.json()) as any;

let server: any;
let http: ReturnType<typeof makeHttp>;
let jobStore: JobStore;

const setJobStore = (await import("../jobs/jobStore")).setJobStore;
const { setRunEventPublisher } = await import("../runs/realtime");

const makeUser = (id: string, email: string): MockUser => ({
    id,
    email,
    password: "password123",
    name: null,
    avatarUrl: null,
    onboardingCompleted: false,
});

const orgAgentConfig: MockOrgAgentConfig = {
    id: "oac_1",
    organizationId: "org_1",
    allowedRepositories: ["acme/web"],
    defaultEngine: "CODEX",
    defaultModel: "gpt-5",
    defaultExecutionMode: "PLAN_AND_APPROVE",
    runBudgetUsd: 5,
    dailyOrgBudgetUsd: 25,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
};

const makeIssue = (id: string): MockIssue =>
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
    }) as MockIssue;

const seedData = () =>
    prismaMock.reset({
        users: [
            makeUser("alice", "alice@example.com"), // ADMIN
            makeUser("bob", "bob@example.com"), // MODERATOR
            makeUser("carol", "carol@example.com"), // MEMBER
            makeUser("dave", "dave@example.com"), // other-org ADMIN
        ],
        organizations: [
            { id: "org_1", name: "Acme", slug: "acme", description: null, orgImage: null,
            } as MockOrg,
            { id: "org_2", name: "Other", slug: "other", description: null, orgImage: null,
            } as MockOrg,
        ],
        memberships: [
            { id: "mem_1", userId: "alice", organizationId: "org_1", role: "ADMIN",
            } as MockMembership,
            { id: "mem_2", userId: "bob", organizationId: "org_1", role: "MODERATOR",
            } as MockMembership,
            { id: "mem_3", userId: "carol", organizationId: "org_1", role: "MEMBER",
            } as MockMembership,
            { id: "mem_4", userId: "dave", organizationId: "org_2", role: "ADMIN",
            } as MockMembership,
        ],
        boards: [
            { id: "brd_1", title: "Board", description: null, organizationId: "org_1", defaultRepository: "acme/web",
            } as MockBoard,
            { id: "brd_2", title: "Other", description: null, organizationId: "org_2", defaultRepository: "other/repo",
            } as MockBoard,
        ],
        sections: [
            { id: "sec_1", title: "Todo", order: 0, boardId: "brd_1",
            } as MockSection,
            { id: "sec_2", title: "Todo", order: 0, boardId: "brd_2",
            } as MockSection,
        ],
        issues: [
            makeIssue("iss_1"),
            makeIssue("iss_2"),
            makeIssue("iss_3"),
            makeIssue("iss_4"),
            makeIssue("iss_5"),
            { ...makeIssue("iss_9"), sectionId: "sec_2" } as MockIssue,
        ],
        orgAgentConfigs: [orgAgentConfig],
    });

let keySeq = 0;
const body = (overrides: Record<string, unknown> = {}) => ({
    engine: "CODEX",
    model: "gpt-5",
    executionMode: "PLAN_AND_APPROVE",
    idempotencyKey: `act-key-${++keySeq}`,
    ...overrides,
});

const launch = async (issueId: string, overrides: Record<string, unknown> = {},
) => {
    const res = await http.post(
        `/api/v1/issues/${issueId}/agent-runs`,
        body(overrides),
        tok("bob@example.com"),
    );
    expect(res.status).toBe(201);
    return (await json(res)).run as any;
};

/**
 * Emulate what the CP5 worker persists after provisioning a sandbox and
 * producing plan v2 against base commit "base-9" (row-level seeding only —
 * there is no engine here, and none may be invoked by HTTP handlers).
 */
const advanceToAwaitingApproval = async (runId: string) => {
    await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "AWAITING_APPROVAL", planVersion: 2, baseCommit: "base-9",
        },
    });
    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    const { currentTaskFingerprint } = await import("../runs/taskContext");
    await prisma.agentRun.update({
        where: { id: runId },
        data: {
            planContextHash: await currentTaskFingerprint(
                prisma as any,
                row as any,
            ),
        },
    });
    return prisma.agentRun.findUnique({ where: { id: runId } }) as any;
};

const approveHttp = (
    runId: string,
    body_: Record<string, unknown>,
    cookie: string | null,
) => http.post(`/api/v1/agent-runs/${runId}/approvals`, body_, cookie);

const eventsFor = async (runId: string) =>
    (
        await prisma.runEvent.findMany({
            where: { runId },
            orderBy: { sequence: "asc" },
        })
    ) as any[];

const tokens: Record<string, string> = {};
const tok = (email: string): string => tokens[email] as string;

beforeAll(async () => {
    const started = await startTestServer();
    server = started.server;
    http = makeHttp(started.baseUrl);
});

afterAll(() => {
    server.close();
    setJobStore(null);
    setRunEventPublisher(null);
});

beforeEach(async () => {
    seedData();
    jobStore = createMemoryJobStore(prismaMock.prisma as any);
    setJobStore(jobStore);
    setRunEventPublisher(async () => {});
    for (const email of [
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
        "dave@example.com",
    ]) {
        tokens[email] = await http.login(email);
    }
});

describe("agent run API — plan approvals", () => {
    test("approving the exact plan version + base commit resumes implementing via a durable job only", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);

        const res = await approveHttp(
            run.id,
            { planVersion: 2, decision: "APPROVED", baseCommit: "base-9" },
            tok("bob@example.com"),
        );
        expect(res.status).toBe(201);
        const body = await json(res);
        expect(body.approval.decision).toBe("APPROVED");
        expect(body.approval.planVersion).toBe(2);
        expect(body.approval.baseCommit).toBe("base-9");
        expect(body.approval.decidedBy).toBe("bob");
        expect(body.run.status).toBe("IMPLEMENTING");

        const events = await eventsFor(run.id);
        expect(events.map((e) => e.type)).toEqual([
            "run.created",
            "run.approval.decided",
            "run.status.changed",
        ]);
        expect(events[2]!.data.to).toBe("IMPLEMENTING");

        const jobs = await jobStore.listByRun(run.id);
        const execute = jobs.find((j) => j.idempotencyKey === `run:${run.id}:execute:v2`,
        );
        expect(execute).toBeDefined();
        expect(execute!.status).toBe("QUEUED");
        expect(execute!.payload).toEqual({
            reason: "approved",
            planVersion: 2,
            baseCommit: "base-9",
            decision: "APPROVED",
        });
    });

    test("approval is idempotent: the same decision replays without new events or jobs", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);
        const payload = { planVersion: 2, decision: "APPROVED", baseCommit: "base-9",
        };

        const first = await approveHttp(run.id, payload, tok("bob@example.com"),
        );
        expect(first.status).toBe(201);
        const approvalId = (await json(first)).approval.id;
        const eventsAfterFirst = await eventsFor(run.id);

        const second = await approveHttp(run.id, payload, tok("bob@example.com"),
        );
        expect(second.status).toBe(200);
        const replay = await json(second);
        expect(replay.replayed).toBe(true);
        expect(replay.approval.id).toBe(approvalId);
        expect(replay.run.status).toBe("IMPLEMENTING");

        expect(await eventsFor(run.id)).toEqual(eventsAfterFirst);
        expect(
            (await prisma.runApproval.findMany({ where: { runId: run.id },
            })) as any[],
        ).toHaveLength(1);
        const jobs = await jobStore.listByRun(run.id);
        expect(jobs.filter((j) => j.idempotencyKey === `run:${run.id}:execute:v2`),
        ).toHaveLength(1);
    });

    test("stale approvals are rejected: moved plan version, changed base commit, conflicting decision", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);

        const wrongVersion = await approveHttp(
            run.id,
            { planVersion: 1, decision: "APPROVED" },
            tok("bob@example.com"),
        );
        expect(wrongVersion.status).toBe(409);
        const staleVersion = await json(wrongVersion);
        expect(staleVersion.code).toBe("STALE_APPROVAL");
        expect(staleVersion.current).toBe(2);

        const wrongBase = await approveHttp(
            run.id,
            { planVersion: 2, decision: "APPROVED", baseCommit: "old-base" },
            tok("bob@example.com"),
        );
        expect(wrongBase.status).toBe(409);
        const staleBase = await json(wrongBase);
        expect(staleBase.code).toBe("STALE_APPROVAL");
        expect(staleBase.currentBaseCommit).toBe("base-9");

        // requirements moved on: the worker regenerated the plan (v3)
        await prisma.agentRun.update({
            where: { id: run.id },
            data: { planVersion: 3 },
        });
        const nowStale = await approveHttp(
            run.id,
            { planVersion: 2, decision: "APPROVED", baseCommit: "base-9" },
            tok("bob@example.com"),
        );
        expect(nowStale.status).toBe(409);
        expect((await json(nowStale)).code).toBe("STALE_APPROVAL");
    });

    test("approvals need AWAITING_APPROVAL, reject conflicting decisions and respect terminal finality", async () => {
        const queuedRun = await launch("iss_2");
        const tooEarly = await approveHttp(
            queuedRun.id,
            { planVersion: 0, decision: "APPROVED" },
            tok("bob@example.com"),
        );
        expect(tooEarly.status).toBe(409);
        expect((await json(tooEarly)).code).toBe("ILLEGAL_TRANSITION");

        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);
        await approveHttp(
            run.id,
            { planVersion: 2, decision: "APPROVED", baseCommit: "base-9" },
            tok("bob@example.com"),
        );
        const conflict = await approveHttp(
            run.id,
            { planVersion: 2, decision: "REJECTED" },
            tok("alice@example.com"),
        );
        expect(conflict.status).toBe(409);
        expect((await json(conflict)).code).toBe("STALE_APPROVAL");

        const cancelRes = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            { reason: "done" },
            tok("bob@example.com"),
        );
        expect(cancelRes.status).toBe(200);
        const afterTerminal = await approveHttp(
            run.id,
            { planVersion: 2, decision: "REJECTED" },
            tok("bob@example.com"),
        );
        expect(afterTerminal.status).toBe(409);
        expect((await json(afterTerminal)).code).toBe("STALE_APPROVAL");
    });

    test("rejection sends the run back to planning with a replan job", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);

        const res = await approveHttp(
            run.id,
            { planVersion: 2, decision: "REJECTED", baseCommit: "base-9" },
            tok("alice@example.com"),
        );
        expect(res.status).toBe(201);
        const body = await json(res);
        expect(body.run.status).toBe("PLANNING");

        const jobs = await jobStore.listByRun(run.id);
        const replan = jobs.find(
            (j) => j.idempotencyKey === `run:${run.id}:execute:v2:replan`,
        );
        expect(replan).toBeDefined();
        expect(replan!.payload.reason).toBe("replan-requested");
    });
});

describe("agent run API — cancel, resume, messages, action permissions", () => {
    test("cancel stops the run, tears down queued jobs and releases the active slot", async () => {
        const run = await launch("iss_1");
        const queued = (await jobStore.listByRun(run.id))[0]!;
        expect(queued.status).toBe("QUEUED");

        const res = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            { reason: "not needed" },
            tok("bob@example.com"),
        );
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.run.status).toBe("CANCELLED");
        expect(body.cancelledJobIds).toEqual([queued.id]);
        expect((await jobStore.get(queued.id))!.status).toBe("CANCELLED");

        const events = await eventsFor(run.id);
        expect(events[events.length - 1]!.type).toBe("run.status.changed");
        expect(events[events.length - 1]!.data.reason).toBe("not needed");

        // slot released: a fresh launch on the same issue succeeds
        const second = await launch("iss_1");
        expect(second.id).not.toBe(run.id);

        const again = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            {},
            tok("bob@example.com"),
        );
        expect(again.status).toBe(200);
        expect((await json(again)).run.status).toBe("CANCELLED");
    });

    test("resume coalesces while durable work exists, re-enqueues once it is gone and refuses terminal runs", async () => {
        const run = await launch("iss_2");

        const coalesced = await http.post(
            `/api/v1/agent-runs/${run.id}/resume`,
            {},
            tok("bob@example.com"),
        );
        expect(coalesced.status).toBe(200);
        const cBody = await json(coalesced);
        expect(cBody.coalesced).toBe(true);
        expect(await jobStore.listByRun(run.id)).toHaveLength(1);

        // worker runs the job to completion; nothing active remains
        const claimed = await jobStore.claimNext("worker-1", new Date().toISOString(),
        );
        expect(claimed).not.toBeNull();
        await jobStore.complete(
            claimed!.job.id,
            "worker-1",
            claimed!.fencingToken,
            new Date().toISOString(),
        );

        const requeued = await http.post(
            `/api/v1/agent-runs/${run.id}/resume`,
            {},
            tok("alice@example.com"),
        );
        expect(requeued.status).toBe(200);
        const rBody = await json(requeued);
        expect(rBody.coalesced).toBe(false);
        const jobs = await jobStore.listByRun(run.id);
        expect(jobs).toHaveLength(2);
        expect(jobs[1]!.status).toBe("QUEUED");
        expect(jobs[1]!.idempotencyKey).toStartWith(`run:${run.id}:resume:`);

        const events = await eventsFor(run.id);
        expect(events[events.length - 1]!.type).toBe("run.message");
        expect(events[events.length - 1]!.data.kind).toBe("resume-requested");

        // terminal runs stay dead: resume cannot revive them
        const cancelled = await launch("iss_3");
        await http.post(
            `/api/v1/agent-runs/${cancelled.id}/cancel`,
            {},
            tok("bob@example.com"),
        );
        const revive = await http.post(
            `/api/v1/agent-runs/${cancelled.id}/resume`,
            {},
            tok("bob@example.com"),
        );
        expect(revive.status).toBe(409);
        expect((await json(revive)).code).toBe("TERMINAL_STATE");
    });

    test("run messages append a durable event and enqueue delivery work; empty text is rejected", async () => {
        const run = await launch("iss_1");
        const res = await http.post(
            `/api/v1/agent-runs/${run.id}/messages`,
            { text: "focus on the flaky test" },
            tok("bob@example.com"),
        );
        expect(res.status).toBe(201);
        const body = await json(res);
        expect(body.event.type).toBe("run.message");
        expect(body.event.data.text).toBe("focus on the flaky test");
        expect(body.event.data.authorId).toBe("bob");

        const jobs = await jobStore.listByRun(run.id);
        const messageJob = jobs.find((j) => j.type === "agent.run.message");
        expect(messageJob).toBeDefined();
        expect(messageJob!.payload.eventSequence).toBe(body.event.sequence);

        const empty = await http.post(
            `/api/v1/agent-runs/${run.id}/messages`,
            { text: "   " },
            tok("bob@example.com"),
        );
        expect(empty.status).toBe(400);

        await http.post(`/api/v1/agent-runs/${run.id}/cancel`, {}, tok("bob@example.com"),
        );
        const late = await http.post(
            `/api/v1/agent-runs/${run.id}/messages`,
            { text: "still there?" },
            tok("bob@example.com"),
        );
        expect(late.status).toBe(409);
        expect((await json(late)).code).toBe("TERMINAL_STATE");
    });

    test("permission matrix: members read but only moderators/admins may approve, cancel, resume or message", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);
        const member = tok("carol@example.com");

        const approve = await approveHttp(
            run.id,
            { planVersion: 2, decision: "APPROVED", baseCommit: "base-9" },
            member,
        );
        expect(approve.status).toBe(403);
        const cancel = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            {},
            member,
        );
        expect(cancel.status).toBe(403);
        const resume = await http.post(
            `/api/v1/agent-runs/${run.id}/resume`,
            {},
            member,
        );
        expect(resume.status).toBe(403);
        const message = await http.post(
            `/api/v1/agent-runs/${run.id}/messages`,
            { text: "hi" },
            member,
        );
        expect(message.status).toBe(403);

        // reads stay open to the member
        const read = await http.get(`/api/v1/agent-runs/${run.id}`, member);
        expect(read.status).toBe(200);

        // cross-org admin and anonymous callers are refused everywhere
        const foreign = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            {},
            tok("dave@example.com"),
        );
        expect(foreign.status).toBe(403);
        const anon = await http.post(`/api/v1/agent-runs/${run.id}/cancel`, {}, null,
        );
        expect(anon.status).toBe(401);

        // ADMIN can operate the run as well
        const adminCancel = await http.post(
            `/api/v1/agent-runs/${run.id}/cancel`,
            { reason: "admin stop" },
            tok("alice@example.com"),
        );
        expect(adminCancel.status).toBe(200);
    });
});

describe("transactional HTTP approval failures", () => {
    test("enqueue failure rolls back the decision, event and transition; retry succeeds once", async () => {
        const run = await launch("iss_1");
        await advanceToAwaitingApproval(run.id);
        const before = await eventsFor(run.id);
        const enqueue = jobStore.enqueue.bind(jobStore);
        jobStore.enqueue = async () => {
            throw new Error("injected approval enqueue failure");
        };
        const body = {
            planVersion: 2,
            decision: "APPROVED",
            baseCommit: "base-9",
        };
        expect(
            (await approveHttp(run.id, body, tok("bob@example.com"))).status,
        ).toBe(500);
        expect(
            (await prisma.agentRun.findUnique({ where: { id: run.id } }))!
                .status,
        ).toBe("AWAITING_APPROVAL");
        expect(
            await prisma.runApproval.findMany({ where: { runId: run.id } }),
        ).toHaveLength(0);
        expect(await eventsFor(run.id)).toEqual(before);
        jobStore.enqueue = enqueue;
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                approveHttp(run.id, body, tok("bob@example.com")),
            ),
        );
        expect(results.map((r) => r.status).sort()).toEqual([
            200, 200, 200, 200, 200, 201,
        ]);
        expect(
            (await eventsFor(run.id)).filter(
                (e) => e.type === "run.approval.decided",
            ),
        ).toHaveLength(1);
    });
});
