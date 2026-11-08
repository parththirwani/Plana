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

// CP4 evidence — agent-run HTTP API: capabilities, create, list/get/events,
// permissions, idempotency and the "unsupported -> 400 with reason, never
// substituted" rule. Everything here must only PERSIST + ENQUEUE; no engine,
// sandbox or GitHub call may happen inside a request (asserted via the job
// store + still-QUEUED run status).

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
    allowedRepositories: ["acme/web", "acme/api"],
    defaultEngine: "CODEX",
    defaultModel: "gpt-5",
    defaultExecutionMode: "IMPLEMENT",
    runBudgetUsd: 5,
    dailyOrgBudgetUsd: 25,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
};

const seedData = () =>
    prismaMock.reset({
        users: [
            makeUser("alice", "alice@example.com"), // org_1 ADMIN
            makeUser("bob", "bob@example.com"), // org_1 MODERATOR
            makeUser("carol", "carol@example.com"), // org_1 MEMBER
            makeUser("dave", "dave@example.com"), // org_2 ADMIN (other org)
            makeUser("erin", "erin@example.com"), // no membership
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
            { id: "iss_1", title: "Run host", description: null, order: 0, priority: "NONE", dueDate: null, sectionId: "sec_1", assigneeIds: [], repository: null,
            } as MockIssue,
            { id: "iss_2", title: "Api repo host", description: null, order: 0, priority: "NONE", dueDate: null, sectionId: "sec_1", assigneeIds: [], repository: "acme/api",
            } as MockIssue,
            { id: "iss_3", title: "Perms host", description: null, order: 0, priority: "NONE", dueDate: null, sectionId: "sec_1", assigneeIds: [], repository: null,
            } as MockIssue,
            { id: "iss_4", title: "Admin host", description: null, order: 0, priority: "NONE", dueDate: null, sectionId: "sec_1", assigneeIds: [], repository: null,
            } as MockIssue,
            { id: "iss_9", title: "Foreign", description: null, order: 0, priority: "NONE", dueDate: null, sectionId: "sec_2", assigneeIds: [], repository: null,
            } as MockIssue,
        ],
        orgAgentConfigs: [structuredClone(orgAgentConfig)],
    });

let keySeq = 0;
const baseBody = (overrides: Record<string, unknown> = {}) => ({
    engine: "CODEX",
    model: "gpt-5",
    idempotencyKey: `api-key-${++keySeq}`,
    ...overrides,
});

const createRunHttp = (
    issueId: string,
    body: Record<string, unknown>,
    cookie: string | null,
) => http.post(`/api/v1/issues/${issueId}/agent-runs`, body, cookie);

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
    // Agent realtime hints are asserted in CP3; keep the default publisher out
    // of the picture (no pg pool here) without changing other suites' seams.
    setRunEventPublisher(async () => {});
    for (const email of [
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
        "dave@example.com",
        "erin@example.com",
    ]) {
        tokens[email] = await http.login(email);
    }
});

describe("agent run API — capabilities + reads", () => {
    test("capabilities list every engine with explicit unavailable reasons and the org allow-list", async () => {
        const res = await http.get(
            "/api/v1/issues/iss_1/agent-runs/capabilities",
            tok("carol@example.com"),
        );
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(typeof body.message).toBe("string");
        const byId = Object.fromEntries(body.engines.map((e: any) => [e.id, e]),
        );
        expect(Object.keys(byId).sort()).toEqual([
            "CLAUDE_CODE",
            "CODEX",
            "OPENCODE",
            "PI",
        ]);
        expect(byId.PI.available).toBe(true);
        expect(byId.PI.models.some((m: any) => m.available)).toBe(true);
        const codexModels = Object.fromEntries(
            byId.CODEX.models.map((m: any) => [m.id, m]),
        );
        expect(codexModels["gpt-5"].available).toBe(true);
        expect(codexModels["gpt-4.1"].available).toBe(false);
        expect(codexModels["gpt-4.1"].reason.length).toBeGreaterThan(10);
        expect(byId.OPENCODE.executionModes.PLAN_AND_APPROVE.available).toBe(
            true,
        );
        expect(body.allowedRepositories).toEqual(["acme/web", "acme/api"]);
        expect(body.repositories).toEqual({
            boardDefault: "acme/web",
            issueOverride: null,
        });
        expect(body.defaults.engine).toBe("CODEX");
    });

    test("capability/list/read endpoints require auth and org membership", async () => {
        const anon = await http.get(
            "/api/v1/issues/iss_1/agent-runs/capabilities",
            null,
        );
        expect(anon.status).toBe(401);

        const erin = await http.get(
            "/api/v1/issues/iss_1/agent-runs",
            tok("erin@example.com"),
        );
        expect(erin.status).toBe(403);

        // cross-org member cannot even enumerate another org's runs
        const dave = await http.get(
            "/api/v1/issues/iss_1/agent-runs",
            tok("dave@example.com"),
        );
        expect(dave.status).toBe(403);

        const missing = await http.get(
            "/api/v1/issues/iss_zzz/agent-runs",
            tok("carol@example.com"),
        );
        expect(missing.status).toBe(404);
    });

    test("members read run state and paginated event pages by cursor", async () => {
        const created = await createRunHttp(
            "iss_1",
            baseBody(),
            tok("bob@example.com"),
        );
        expect(created.status).toBe(201);
        const { run } = await json(created);

        const list = await http.get(
            "/api/v1/issues/iss_1/agent-runs",
            tok("carol@example.com"),
        );
        expect(list.status).toBe(200);
        const listBody = await json(list);
        expect(listBody.runs.map((r: any) => r.id)).toEqual([run.id]);

        const state = await http.get(
            `/api/v1/agent-runs/${run.id}`,
            tok("carol@example.com"),
        );
        expect(state.status).toBe(200);
        expect((await json(state)).run.status).toBe("QUEUED");

        const page1 = await http.get(
            `/api/v1/agent-runs/${run.id}/events?afterSequence=0&limit=1`,
            tok("carol@example.com"),
        );
        expect(page1.status).toBe(200);
        const p1 = await json(page1);
        expect(p1.events).toHaveLength(1);
        expect(p1.events[0].type).toBe("run.created");
        expect(p1.nextSequence).toBe(1);
        expect(p1.hasMore).toBe(false);

        const page2 = await http.get(
            `/api/v1/agent-runs/${run.id}/events?afterSequence=1`,
            tok("carol@example.com"),
        );
        const p2 = await json(page2);
        expect(p2.events).toEqual([]);
        expect(p2.nextSequence).toBe(1);
        expect(p2.latestSequence).toBe(1);

        const forbidden = await http.get(
            `/api/v1/agent-runs/${run.id}`,
            tok("dave@example.com"),
        );
        expect(forbidden.status).toBe(403);
        const missingRun = await http.get(
            "/api/v1/agent-runs/run_zzz",
            tok("carol@example.com"),
        );
        expect(missingRun.status).toBe(404);
    });
});

describe("agent run API — create + permissions + capabilities enforcement", () => {
    test("create persists the requested engine/model/options verbatim and only enqueues durable work", async () => {
        const res = await createRunHttp(
            "iss_1",
            baseBody({
                options: { reasoningEffort: "high" },
                executionMode: "PLAN_AND_APPROVE",
                repository: "acme/web",
            }),
            tok("bob@example.com"),
        );
        expect(res.status).toBe(201);
        const body = await json(res);
        const run = body.run;
        expect(run.status).toBe("QUEUED");
        expect(run.engine).toBe("CODEX");
        expect(run.model).toBe("gpt-5");
        expect(run.options).toEqual({ reasoningEffort: "high" });
        expect(run.executionMode).toBe("PLAN_AND_APPROVE");
        expect(run.repository).toBe("acme/web");
        expect(run.branchName).toBe(`plana/iss_1/${run.id}`);
        expect(run.planVersion).toBe(0);
        expect(run.createdBy).toBe("bob");
        expect(body.queued.status).toBe("QUEUED");

        // Nothing ran inline: exactly one QUEUED job, one durable event, the
        // run is still QUEUED in the database.
        const jobs = await jobStore.listByRun(run.id);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.type).toBe("agent.run.execute");
        expect(jobs[0]!.status).toBe("QUEUED");
        const events = await eventsFor(run.id);
        expect(events.map((e) => e.type)).toEqual(["run.created"]);
        const stored: any = await prisma.agentRun.findUnique({
            where: { id: run.id },
        });
        expect(stored.status).toBe("QUEUED");
    });

    test("malformed bodies and missing idempotency keys are rejected with 400 without creating runs", async () => {
        const cases: Record<string, unknown>[] = [
            { engine: "CODEX", model: "gpt-5" },
            { engine: "GEMINI", model: "x", idempotencyKey: "k" },
            { engine: "CODEX", model: "", idempotencyKey: "k" },
            {
                engine: "CODEX",
                model: "gpt-5",
                idempotencyKey: "k",
                executionMode: "YOLO",
            },
            {
                engine: "CODEX",
                model: "gpt-5",
                idempotencyKey: "k",
                options: { reasoningEffort: { nested: true } },
            },
        ];
        for (const body of cases) {
            const res = await createRunHttp(
                "iss_1",
                { model: "gpt-5", ...body } as any,
                tok("bob@example.com"),
            );
            expect(res.status).toBe(400);
            expect((await json(res)).message).toBe(
                "Fields not according to schema",
            );
        }
        expect(
            (await prisma.agentRun.findMany({ where: { issueId: "iss_1" },
            })) as any[],
        ).toHaveLength(0);
    });

    test("duplicate idempotency key replays the same run and does not double-enqueue", async () => {
        const body = baseBody({ idempotencyKey: "same-key" });
        const first = await createRunHttp("iss_1", body, tok("bob@example.com"),
        );
        expect(first.status).toBe(201);
        const { run } = await json(first);

        const second = await createRunHttp("iss_1", body, tok("bob@example.com"),
        );
        expect(second.status).toBe(200);
        const replay = await json(second);
        expect(replay.replayed).toBe(true);
        expect(replay.run.id).toBe(run.id);

        const runs = (await prisma.agentRun.findMany({
            where: { issueId: "iss_1" },
        })) as any[];
        expect(runs).toHaveLength(1);
        expect(await jobStore.listByRun(run.id)).toHaveLength(1);
    });

    test("a second active run for the same issue is a 409 with the existing run", async () => {
        const first = await createRunHttp("iss_1", baseBody(), tok("bob@example.com"),
        );
        expect(first.status).toBe(201);
        const { run } = await json(first);

        const second = await createRunHttp("iss_1", baseBody(), tok("alice@example.com"),
        );
        expect(second.status).toBe(409);
        const body = await json(second);
        expect(body.code).toBe("ACTIVE_RUN_EXISTS");
        expect(body.runId).toBe(run.id);
        expect(body.status).toBe("QUEUED");
    });

    test("unsupported engine/model/option/mode/repository answer 400 with a reason and are NEVER substituted", async () => {
        const attempts: Array<{
            body: Record<string, unknown>;
            field: string;
            reasonPart: string;
        }> = [
            {
                body: { engine: "PI", model: "pi-unavailable" },
                field: "model",
                reasonPart: "excluded",
            },
            {
                body: { engine: "CODEX", model: "gpt-4.1" },
                field: "model",
                reasonPart: "excluded",
            },
            {
                body: { engine: "CODEX", model: "nope-model" },
                field: "model",
                reasonPart: "does not support model",
            },
            {
                body: {
                    engine: "CODEX",
                    model: "gpt-5",
                    options: { reasoningEffort: "max" },
                },
                field: "options.reasoningEffort",
                reasonPart: "reasoning effort",
            },
            {
                body: {
                    engine: "CODEX",
                    model: "gpt-5",
                    options: { bogusOption: "x" },
                },
                field: "options.bogusOption",
                reasonPart: "does not support option",
            },
            {
                body: {
                    engine: "CLAUDE_CODE",
                    model: "claude-sonnet-4",
                    options: { thinking: "ultrathink" },
                },
                field: "options.thinking",
                reasonPart: "budget tier",
            },
            {
                body: {
                    engine: "OPENCODE",
                    model: "opencode-linear",
                    options: { thinking: "on" },
                },
                field: "options.thinking",
                reasonPart: "does not support option",
            },
            {
                body: { engine: "CODEX", model: "gpt-5", repository: "evil/repo",
                },
                field: "repository",
                reasonPart: "allowed repositories",
            },
        ];

        for (const attempt of attempts) {
            const res = await createRunHttp(
                "iss_1",
                baseBody(attempt.body),
                tok("bob@example.com"),
            );
            expect(res.status).toBe(400);
            const body = await json(res);
            expect(body.code).toBe("UNSUPPORTED_CAPABILITY");
            expect(body.field).toBe(attempt.field);
            expect(String(body.message).toLowerCase()).toContain(
                attempt.reasonPart.toLowerCase(),
            );
        }

        // the decisive rule: no fallback run exists on any engine/model
        const runs = (await prisma.agentRun.findMany({
            where: { issueId: "iss_1" },
        })) as any[];
        expect(runs).toHaveLength(0);
        expect((await prisma.agentRun.findMany({ where: {} })) as any[],
        ).toHaveLength(
            0
        );
    });

    test("repository resolution falls back to the issue override then the board default; orgs without config allow nothing", async () => {
        // explicit body wins over the board default
        const viaBody = await createRunHttp(
            "iss_1",
            baseBody({ repository: "acme/api" }),
            tok("bob@example.com"),
        );
        expect(viaBody.status).toBe(201);
        expect((await json(viaBody)).run.repository).toBe("acme/api");

        // no body.repository -> issue.repository override beats board default
        const viaIssue = await createRunHttp(
            "iss_2",
            baseBody(),
            tok("bob@example.com"),
        );
        expect(viaIssue.status).toBe(201);
        expect((await json(viaIssue)).run.repository).toBe("acme/api");

        // org_2 has no OrganizationAgentConfig -> every repository is refused
        const noConfig = await createRunHttp(
            "iss_9",
            baseBody({ repository: "other/repo" }),
            tok("dave@example.com"),
        );
        expect(noConfig.status).toBe(400);
        const body = await json(noConfig);
        expect(body.code).toBe("UNSUPPORTED_CAPABILITY");
        expect(body.field).toBe("repository");
        expect(body.message).toContain("no agent configuration");
    });

    test("permission matrix: member cannot launch, moderator and admin can, non-members and strangers cannot", async () => {
        const asMember = await createRunHttp("iss_1", baseBody(), tok("carol@example.com"),
        );
        expect(asMember.status).toBe(403);

        const asErin = await createRunHttp("iss_1", baseBody(), tok("erin@example.com"),
        );
        expect(asErin.status).toBe(403);

        const asStranger = await createRunHttp("iss_1", baseBody(), tok("dave@example.com"),
        );
        expect(asStranger.status).toBe(403);

        const anon = await createRunHttp("iss_1", baseBody(), null);
        expect(anon.status).toBe(401);

        const asModerator = await createRunHttp("iss_3", baseBody(), tok("bob@example.com"),
        );
        expect(asModerator.status).toBe(201);

        const asAdmin = await createRunHttp("iss_4", baseBody(), tok("alice@example.com"),
        );
        expect(asAdmin.status).toBe(201);
    });
});

describe("transactional HTTP launch failures", () => {
    test("enqueue failure rolls back run, event and slot; retry creates real work", async () => {
        const original = jobStore.enqueue.bind(jobStore);
        jobStore.enqueue = async () => {
            throw new Error("injected enqueue failure");
        };
        const body = baseBody();
        const before = await prisma.runEvent.findMany({ where: {} });
        const first = await createRunHttp(
            "iss_1",
            body,
            tok("bob@example.com"),
        );
        expect(first.status).toBe(500);
        expect(
            await prisma.agentRun.findMany({ where: { issueId: "iss_1" } }),
        ).toHaveLength(0);
        expect(await prisma.runEvent.findMany({ where: {} })).toEqual(before);
        jobStore.enqueue = original;
        const retry = await createRunHttp(
            "iss_1",
            body,
            tok("bob@example.com"),
        );
        expect(retry.status).toBe(201);
        expect(
            await jobStore.listByRun((await json(retry)).run.id),
        ).toHaveLength(1);
    });
});

describe("agent policy configuration", () => {
    test("only an admin changes policy; permitted repositories can be selected without SQL", async () => {
        const path = "/api/v1/organizations/org_1/agent-config";
        const policy = {
            allowedRepositories: ["acme/new"],
            defaultEngine: "PI",
            defaultModel: "pi-1",
        };
        expect(
            (await http.put(path, policy, tok("bob@example.com"))).status,
        ).toBe(403);
        expect(
            (await http.put(path, policy, tok("dave@example.com"))).status,
        ).toBe(403);
        expect(
            (await http.put(path, policy, tok("alice@example.com"))).status,
        ).toBe(200);
        expect(
            (
                await http.patch(
                    "/api/v1/boards/brd_1/agent-repository",
                    { repository: "evil/repo" },
                    tok("bob@example.com"),
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await http.patch(
                    "/api/v1/boards/brd_1/agent-repository",
                    { repository: "acme/new" },
                    tok("bob@example.com"),
                )
            ).status,
        ).toBe(200);
        const response = await createRunHttp(
            "iss_1",
            baseBody({ engine: "PI", model: "pi-1" }),
            tok("bob@example.com"),
        );
        expect(response.status).toBe(201);
        expect((await json(response)).run.repository).toBe("acme/new");
    });
});


describe("team agent settings read and defaults", () => {
  const path = "/api/v1/organizations/org_1/agent-config";
  test("all team roles can read policy, outsiders and signed-out users cannot", async () => {
    for (const email of [
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]) {
      const response = await http.get(path, tok(email));
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.config.allowedRepositories).toEqual(["acme/web", "acme/api"]);
      expect(body.engines.map((e: { id: string }) => e.id)).toEqual([
        "CODEX",
        "CLAUDE_CODE",
        "OPENCODE",
        "PI",
      ]);
      expect(body.simulation).toBe(true);
    }
    for (const email of ["dave@example.com", "erin@example.com"])
      expect((await http.get(path, tok(email))).status).toBe(403);
    expect((await http.get(path, null)).status).toBe(401);
  });
  test("members cannot change policy even if they construct the request directly", async () => {
    expect(
      (
        await http.put(
          path,
          { allowedRepositories: ["evil/repo"] },
          tok("carol@example.com"),
        )
      ).status,
    ).toBe(403);
  });
  test("rejects mismatched, unavailable, and partially changed default models without saving", async () => {
    for (const change of [
      { defaultEngine: "PI", defaultModel: "gpt-5" },
      { defaultEngine: "CODEX", defaultModel: "gpt-4.1" },
      { defaultEngine: "PI" },
      { defaultEngine: null },
    ]) {
      expect(
        (
          await http.put(
            path,
            { allowedRepositories: ["acme/web"], ...change },
            tok("alice@example.com"),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await json(await http.get(path, tok("alice@example.com")))).config
        .defaultModel,
    ).toBe("gpt-5");
  });
  test("admin defaults persist for the team and populate issue capabilities", async () => {
    const config = {
      allowedRepositories: ["acme/web"],
      defaultEngine: "CLAUDE_CODE",
      defaultModel: "claude-sonnet-4",
      defaultExecutionMode: "PLAN_AND_APPROVE",
    };
    expect(
      (await http.put(path, config, tok("alice@example.com"))).status,
    ).toBe(200);
    const capabilities = await json(
      await http.get(
        "/api/v1/issues/iss_1/agent-runs/capabilities",
        tok("carol@example.com"),
      ),
    );
    expect(capabilities.defaults.engine).toBe("CLAUDE_CODE");
    expect(capabilities.defaults.model).toBe("claude-sonnet-4");
    expect(capabilities.defaults.executionMode).toBe("PLAN_AND_APPROVE");
    expect(capabilities.allowedRepositories).toEqual(["acme/web"]);
  });
  test("clearing both defaults lets teammates explicitly choose their own harness", async () => {
    expect(
      (
        await http.put(
          path,
          { allowedRepositories: [], defaultEngine: null, defaultModel: null },
          tok("alice@example.com"),
        )
      ).status,
    ).toBe(200);
    const body = await json(await http.get(path, tok("carol@example.com")));
    expect(body.config.defaultEngine).toBeNull();
    expect(body.config.defaultModel).toBeNull();
    expect(body.config.allowedRepositories).toEqual([]);
  });
});
