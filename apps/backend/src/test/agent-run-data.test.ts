process.env.AGENT_EXECUTION_MODE = "fake";
import { describe, test, expect, beforeEach } from "bun:test";
import { prismaMock } from "../test-utils/prismaMock";
import type {
    MockUser,
    MockOrg,
    MockMembership,
    MockBoard,
    MockSection,
    MockIssue,
    MockAgentRun,
} from "../test-utils/prismaMock";

const prisma = prismaMock.prisma;

const makeUser = (
    id: string,
    email: string,
    overrides: Partial<MockUser> = {},
): MockUser => ({
    id,
    email,
    password: "password123",
    name: null,
    avatarUrl: null,
    onboardingCompleted: false,
    ...overrides,
});

const makeOrg = (id: string, name: string, slug: string): MockOrg => ({
    id,
    name,
    slug,
    description: null,
    orgImage: null,
});

const makeMembership = (
    id: string,
    userId: string,
    organizationId: string,
    role: string,
): MockMembership => ({ id, userId, organizationId, role });

const makeBoard = (
    id: string,
    title: string,
    organizationId = "org_1",
    defaultRepository: string | null = null,
): MockBoard => ({ id, title, description: null, organizationId, defaultRepository,
});

const makeSection = (
    id: string,
    title: string,
    order: number,
    boardId = "brd_1",
): MockSection => ({ id, title, order, boardId });

const makeIssue = (
    id: string,
    title: string,
    sectionId: string,
    order: number,
): MockIssue => ({
    id,
    title,
    description: null,
    order,
    priority: "NONE",
    dueDate: null,
    sectionId,
    assigneeIds: [],
});

const seed = () =>
    prismaMock.reset({
        users: [
            makeUser("alice", "alice@example.com"),
            makeUser("bob", "bob@example.com"),
        ],
        organizations: [
            makeOrg("org_1", "Acme", "acme"),
            makeOrg("org_2", "Other", "other"),
        ],
        memberships: [
            makeMembership("mem_alice", "alice", "org_1", "ADMIN"),
            makeMembership("mem_bob", "bob", "org_1", "MODERATOR"),
        ],
        boards: [makeBoard("brd_1", "Board", "org_1", "acme/webapp")],
        sections: [makeSection("sec_1", "Todo", 0)],
        issues: [makeIssue("iss_1", "Card one", "sec_1", 0)],
    });

const runData = (overrides: Partial<MockAgentRun> = {}) => ({
    issueId: "iss_1",
    organizationId: "org_1",
    createdBy: "alice",
    engine: "CODEX",
    model: "gpt-5-codex",
    options: { reasoning: "high" },
    executionMode: "IMPLEMENT",
    repository: "acme/webapp",
    baseCommit: "abc123",
    branchName: "plana/iss_1/pending",
    status: "QUEUED",
    activeIssueId: "iss_1",
    idempotencyKey: "key-1",
    ...overrides,
});

const expectP2002 = async (op: Promise<unknown>) => {
    try {
        await op;
        throw new Error("expected unique constraint violation");
    } catch (error: any) {
        expect(error?.code).toBe("P2002");
    }
};

describe("agent run data layer (CP1)", () => {
    beforeEach(seed);

    test("creates an AgentRun with the full column set and reads it back", async () => {
        const run = await prisma.agentRun.create({ data: runData() });
        expect(run.status).toBe("QUEUED");
        expect(run.executionMode).toBe("IMPLEMENT");
        expect(run.planVersion).toBe(0);
        expect(run.fencingToken).toBe(0);
        expect(run.owner).toBeNull();
        expect(run.leaseExpiresAt).toBeNull();
        expect(run.activeIssueId).toBe("iss_1");

        const branchName = `plana/${run.issueId}/${run.id}`;
        const updated = await prisma.agentRun.update({
            where: { id: run.id },
            data: { branchName },
        });
        expect(updated.branchName).toBe(`plana/iss_1/${run.id}`);

        const found = await prisma.agentRun.findUnique({
            where: { id: run.id },
        });
        expect(found?.engine).toBe("CODEX");
        expect(found?.model).toBe("gpt-5-codex");
        expect(found?.options).toEqual({ reasoning: "high" });
        expect(found?.repository).toBe("acme/webapp");
        expect(found?.baseCommit).toBe("abc123");
        expect(found?.idempotencyKey).toBe("key-1");
        expect(found?.createdAt).toBeDefined();
        expect(found?.updatedAt).toBeDefined();

        const active = await prisma.agentRun.findUnique({
            where: { activeIssueId: "iss_1" },
        });
        expect(active?.id).toBe(run.id);
    });

    test("appends RunEvents with a per-run monotonic sequence and reads them back", async () => {
        const run = await prisma.agentRun.create({ data: runData() });
        for (const [sequence, type] of [
            [1, "run.queued"],
            [2, "sandbox.provisioned"],
            [3, "engine.started"],
        ] as const) {
            await prisma.runEvent.create({
                data: { runId: run.id, sequence, type, data: { at: sequence } },
            });
        }

        const all = await prisma.runEvent.findMany({
            where: { runId: run.id },
            orderBy: { sequence: "asc" },
        });
        expect(all.map((e: any) => e.sequence)).toEqual([1, 2, 3]);
        expect(all[1].type).toBe("sandbox.provisioned");

        const replay = await prisma.runEvent.findMany({
            where: { runId: run.id, sequence: { gt: 1 } },
            orderBy: { sequence: "asc" },
            take: 10,
        });
        expect(replay.map((e: any) => e.sequence)).toEqual([2, 3]);

        const page = await prisma.runEvent.findMany({
            where: { runId: run.id, sequence: { gt: 1 } },
            orderBy: { sequence: "asc" },
            take: 1,
        });
        expect(page.map((e: any) => e.sequence)).toEqual([2]);

        await expectP2002(
            prisma.runEvent.create({
                data: {
                    runId: run.id,
                    sequence: 2,
                    type: "duplicate",
                    data: {},
                },
            }),
        );

        const otherRun = await prisma.agentRun.create({
            data: runData({
                issueId: "iss_2",
                activeIssueId: null,
                idempotencyKey: "key-2",
            }),
        });
        await prisma.runEvent.create({
            data: { runId: otherRun.id, sequence: 1, type: "run.queued", data: {},
            },
        });
        const runOneEvents = await prisma.runEvent.findMany({
            where: { runId: run.id },
        });
        expect(runOneEvents).toHaveLength(3);
    });

    test("rejects a second active run for the same issue and allows one after release", async () => {
        await prisma.agentRun.create({ data: runData() });
        await expectP2002(
            prisma.agentRun.create({
                data: runData({ idempotencyKey: "key-2" }),
            }),
        );

        const first = await prisma.agentRun.findFirst({
            where: { issueId: "iss_1" },
        });
        await prisma.agentRun.update({
            where: { id: first!.id },
            data: { status: "COMPLETED", activeIssueId: null },
        });

        const second = await prisma.agentRun.create({
            data: runData({
                idempotencyKey: "key-2",
                engine: "CLAUDE_CODE",
                model: "claude-opus",
            }),
        });
        expect(second.status).toBe("QUEUED");
        expect(second.activeIssueId).toBe("iss_1");

        const actives = await prisma.agentRun.count({
            where: { activeIssueId: "iss_1" },
        });
        expect(actives).toBe(1);
    });

    test("enforces one run per (organization, idempotencyKey)", async () => {
        await prisma.agentRun.create({ data: runData() });
        await expectP2002(prisma.agentRun.create({ data: runData() }));

        const otherOrg = await prisma.agentRun.create({
            data: runData({
                organizationId: "org_2",
                issueId: "iss_other",
                activeIssueId: null,
                idempotencyKey: "key-1",
            }),
        });
        expect(otherOrg.organizationId).toBe("org_2");

        const byKey = await prisma.agentRun.findUnique({
            where: { organizationId_idempotencyKey: { organizationId: "org_1", idempotencyKey: "key-1",
                },
            },
        });
        expect(byKey?.organizationId).toBe("org_1");
    });

    test("records RunApprovals with one decision per plan version", async () => {
        const run = await prisma.agentRun.create({ data: runData() });
        const approval = await prisma.runApproval.create({
            data: {
                runId: run.id,
                planVersion: 1,
                decision: "APPROVED",
                baseCommit: "abc123",
                decidedBy: "bob",
            },
        });
        expect(approval.decision).toBe("APPROVED");
        expect(approval.baseCommit).toBe("abc123");
        expect(approval.decidedBy).toBe("bob");
        expect(approval.decidedAt).toBeDefined();

        await expectP2002(
            prisma.runApproval.create({
                data: {
                    runId: run.id,
                    planVersion: 1,
                    decision: "REJECTED",
                    baseCommit: "def456",
                    decidedBy: "alice",
                },
            }),
        );

        const found = await prisma.runApproval.findUnique({
            where: { runId_planVersion: { runId: run.id, planVersion: 1 } },
        });
        expect(found?.decision).toBe("APPROVED");

        await prisma.runApproval.create({
            data: {
                runId: run.id,
                planVersion: 2,
                decision: "APPROVED",
                baseCommit: "def456",
                decidedBy: "alice",
            },
        });
        const approvals = await prisma.runApproval.findMany({
            where: { runId: run.id },
            orderBy: { planVersion: "asc" },
        });
        expect(approvals.map((a: any) => a.planVersion)).toEqual([1, 2]);
    });

    test("stores org-level agent config with allowed repositories and defaults", async () => {
        const created = await prisma.organizationAgentConfig.create({
            data: {
                organizationId: "org_1",
                allowedRepositories: ["acme/webapp", "acme/api"],
                defaultEngine: "OPENCODE",
                defaultModel: "gpt-5",
                defaultExecutionMode: "PLAN_AND_APPROVE",
            },
        });
        expect(created.allowedRepositories).toEqual(["acme/webapp", "acme/api",
        ]);
        expect(created.defaultEngine).toBe("OPENCODE");
        expect(created.defaultExecutionMode).toBe("PLAN_AND_APPROVE");
        expect(created.runBudgetUsd).toBe(5);
        expect(created.dailyOrgBudgetUsd).toBe(25);

        await expectP2002(
            prisma.organizationAgentConfig.create({
                data: { organizationId: "org_1", allowedRepositories: [] },
            }),
        );

        const upserted = await prisma.organizationAgentConfig.upsert({
            where: { organizationId: "org_1" },
            create: {},
            update: { defaultEngine: "PI", runBudgetUsd: 9.5 },
        });
        expect(upserted.defaultEngine).toBe("PI");
        expect(upserted.runBudgetUsd).toBe(9.5);
        expect(upserted.allowedRepositories).toEqual(["acme/webapp", "acme/api",
        ]);
    });

    test("boards carry a default repository and issues an optional override", async () => {
        const board = await prisma.board.findUnique({ where: { id: "brd_1" } });
        expect(board?.defaultRepository).toBe("acme/webapp");

        await prisma.board.update({
            where: { id: "brd_1" },
            data: { defaultRepository: "acme/webapp-v2" },
        });
        const updated = await prisma.board.findUnique({ where: { id: "brd_1" },
        });
        expect(updated?.defaultRepository).toBe("acme/webapp-v2");

        const issue = await prisma.issue.create({
            data: {
                title: "with override",
                sectionId: "sec_1",
                repository: "acme/api",
            },
        });
        expect(issue.repository).toBe("acme/api");

        const plain = await prisma.issue.create({
            data: { title: "no override", sectionId: "sec_1" },
        });
        expect(plain.repository).toBeNull();
    });

    test("deleting an issue or organization removes its runs, events and approvals", async () => {
        const run = await prisma.agentRun.create({ data: runData() });
        await prisma.runEvent.create({
            data: { runId: run.id, sequence: 1, type: "run.queued", data: {} },
        });
        await prisma.runApproval.create({
            data: {
                runId: run.id,
                planVersion: 1,
                decision: "APPROVED",
                baseCommit: "abc123",
                decidedBy: "bob",
            },
        });

        await prisma.issue.delete({ where: { id: "iss_1" } });
        expect(await prisma.agentRun.count({ where: {} })).toBe(0);
        expect(await prisma.runEvent.count({ where: {} })).toBe(0);
        expect(await prisma.runApproval.count({ where: {} })).toBe(0);

        const orgRun = await prisma.agentRun.create({
            data: runData({ organizationId: "org_2", issueId: "iss_x", activeIssueId: null,
            }),
        });
        await prisma.organizationAgentConfig.create({
            data: { organizationId: "org_2", allowedRepositories: [] },
        });
        expect(orgRun.organizationId).toBe("org_2");

        await prisma.organization.delete({ where: { id: "org_2" } });
        expect(await prisma.agentRun.count({ where: {} })).toBe(0);
        expect(
            await prisma.organizationAgentConfig.findUnique({
                where: { organizationId: "org_2" },
            }),
        ).toBeNull();
    });
});
