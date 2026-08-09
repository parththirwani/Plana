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
} from "../test-utils/prismaMock";
import { startTestServer, makeHttp } from "../test-utils/http";

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

let server: any;
let http: ReturnType<typeof makeHttp>;

beforeAll(async () => {
    const started = await startTestServer();
    server = started.server;
    http = makeHttp(started.baseUrl);
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    prismaMock.reset();
});

const makeUser = (
    id: string,
    email: string,
    overrides: Partial<MockUser> = {}
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
    role: string
): MockMembership => ({ id, userId, organizationId, role });

const makeBoard = (
    id: string,
    title: string,
    organizationId = "org_1"
): MockBoard => ({ id, title, description: null, organizationId });

const makeSection = (
    id: string,
    title: string,
    order: number,
    boardId = "brd_1"
): MockSection => ({ id, title, order, boardId });

const makeIssue = (
    id: string,
    title: string,
    sectionId: string,
    order: number
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
            makeUser("carol", "carol@example.com"),
            makeUser("dave", "dave@example.com"),
            makeUser("eve", "eve@example.com"),
        ],
        organizations: [makeOrg("org_1", "Acme", "acme")],
        memberships: [
            makeMembership("mem_alice", "alice", "org_1", "ADMIN"),
            makeMembership("mem_bob", "bob", "org_1", "MODERATOR"),
            makeMembership("mem_carol", "carol", "org_1", "MEMBER"),
            makeMembership("mem_eve", "eve", "org_1", "MEMBER"),
        ],
        boards: [
            makeBoard("brd_1", "Roadmap"),
            makeBoard("brd_2", "Backlog"),
        ],
        sections: [
            makeSection("sec_1", "Todo", 0),
            makeSection("sec_2", "Doing", 1),
            makeSection("sec_3", "Done", 2),
            makeSection("sec_4", "Else", 0, "brd_2"),
        ],
        issues: [
            makeIssue("iss_1", "Login", "sec_1", 0),
            makeIssue("iss_2", "Signup", "sec_1", 1),
            makeIssue("iss_3", "Deploy", "sec_2", 0),
        ],
    });

describe("POST /api/v1/sections/:id/issues", () => {
    test("appends an issue to the end of the section with defaults", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            { title: "  Metrics  " },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.issue).toMatchObject({
            title: "Metrics",
            order: 2,
            priority: "NONE",
            dueDate: null,
            sectionId: "sec_1",
        });
    });

    test("accepts priority and dueDate", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            {
                title: "Fix bug",
                priority: "HIGH",
                dueDate: "2026-08-20T00:00:00.000Z",
            },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.issue.priority).toBe("HIGH");
        expect(body.issue.dueDate).toBe("2026-08-20T00:00:00.000Z");
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            { title: "Sneak" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            { title: "Sneak" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown section", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/sections/nope/issues",
            { title: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects an empty title", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            { title: " " },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("rejects an invalid priority", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/sections/sec_1/issues",
            { title: "X", priority: "SUPER" },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("PATCH /api/v1/issues/:id", () => {
    test("updates title, description, priority and dueDate", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/issues/iss_1",
            {
                title: "Login flow",
                description: "Fix redirect",
                priority: "URGENT",
                dueDate: "2026-08-10T00:00:00.000Z",
            },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.issue).toMatchObject({
            title: "Login flow",
            description: "Fix redirect",
            priority: "URGENT",
            dueDate: "2026-08-10T00:00:00.000Z",
        });
    });

    test("clears description and dueDate with null", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        await http.patch(
            "/api/v1/issues/iss_1",
            { description: "hi", dueDate: "2026-08-10T00:00:00.000Z" },
            cookie
        );
        const res = await http.patch(
            "/api/v1/issues/iss_1",
            { description: null, dueDate: null },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.issue.description).toBeNull();
        expect(body.issue.dueDate).toBeNull();
    });

    test("rejects an invalid dueDate", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/issues/iss_1",
            { dueDate: "not-a-date" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("rejects an invalid priority", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/issues/iss_1",
            { priority: "SUPER" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.patch(
            "/api/v1/issues/iss_1",
            { title: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown issue", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/issues/nope",
            { title: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });
});

describe("DELETE /api/v1/issues/:id", () => {
    test("deletes an issue and closes the order gap", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/issues/iss_1", cookie);

        expect(res.status).toBe(200);

        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        const todo = detail.board.sections.find((s: any) => s.id === "sec_1");
        expect(todo.issues.map((i: any) => i.title)).toEqual(["Signup"]);
        expect(todo.issues.map((i: any) => i.order)).toEqual([0]);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/issues/iss_1", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown issue", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/issues/nope", cookie);

        expect(res.status).toBe(404);
    });
});

describe("POST /api/v1/issues/:id/move", () => {
    test("moves an issue to another section at the given order", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "sec_2", order: 1 },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.issue).toMatchObject({
            sectionId: "sec_2",
            order: 1,
        });

        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        const doing = detail.board.sections.find((s: any) => s.id === "sec_2");
        expect(doing.issues.map((i: any) => i.title)).toEqual([
            "Deploy",
            "Login",
        ]);
    });

    test("moves an issue to the end of an empty section", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "sec_3" },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.issue).toMatchObject({ sectionId: "sec_3", order: 0 });
    });

    test("reorders within the same section", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_2/move",
            { sectionId: "sec_1", order: 0 },
            cookie
        );

        expect(res.status).toBe(200);

        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        const todo = detail.board.sections.find((s: any) => s.id === "sec_1");
        expect(todo.issues.map((i: any) => i.title)).toEqual([
            "Signup",
            "Login",
        ]);
    });

    test("returns 404 for a missing target section", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "nope" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("blocks moving across boards", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "sec_4" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "sec_2" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("rejects a negative order", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/move",
            { sectionId: "sec_2", order: -1 },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("PUT /api/v1/issues/:id/assignees", () => {
    test("sets org members as assignees", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: ["carol", "eve"] },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.issue.assignees.map((a: any) => a.id).sort()).toEqual([
            "carol",
            "eve",
        ]);
        expect(body.issue.assignees[0].password).toBeUndefined();
    });

    test("clears assignees with an empty list", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: ["carol"] },
            cookie
        );
        const res = await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: [] },
            cookie
        );

        expect(res.status).toBe(200);
        expect((await (res.json() as Promise<any>)).issue.assignees).toEqual(
            []
        );
    });

    test("rejects a non-org-member assignee", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: ["dave"] },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: [] },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown issue", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/issues/nope/assignees",
            { assigneeIds: [] },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects a non-array body", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/issues/iss_1/assignees",
            { assigneeIds: "carol" },
            cookie
        );

        expect(res.status).toBe(400);
    });
});
