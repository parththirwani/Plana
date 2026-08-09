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

const makeBoard = (id: string, title: string): MockBoard => ({
    id,
    title,
    description: null,
    organizationId: "org_1",
});

const makeSection = (id: string, title: string, order: number): MockSection => ({
    id,
    title,
    order,
    boardId: "brd_1",
});

const seed = () =>
    prismaMock.reset({
        users: [
            makeUser("alice", "alice@example.com"),
            makeUser("bob", "bob@example.com"),
            makeUser("carol", "carol@example.com"),
            makeUser("dave", "dave@example.com"),
        ],
        organizations: [makeOrg("org_1", "Acme", "acme")],
        memberships: [
            makeMembership("mem_alice", "alice", "org_1", "ADMIN"),
            makeMembership("mem_bob", "bob", "org_1", "MODERATOR"),
            makeMembership("mem_carol", "carol", "org_1", "MEMBER"),
        ],
        boards: [
            makeBoard("brd_1", "Roadmap"),
            makeBoard("brd_2", "Backlog"),
        ],
        sections: [
            makeSection("sec_1", "Todo", 0),
            makeSection("sec_2", "Doing", 1),
            makeSection("sec_3", "Done", 2),
        ],
    });

describe("POST /api/v1/organizations/:id/boards", () => {
    test("lets an ADMIN create a board", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/boards",
            { title: "  Q3  " },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.board).toMatchObject({
            title: "Q3",
            organizationId: "org_1",
        });
    });

    test("lets a MODERATOR create a board", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/boards",
            { title: "Q3" },
            cookie
        );

        expect(res.status).toBe(201);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/boards",
            { title: "Q3" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/boards",
            { title: "Q3" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("rejects an empty title", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/boards",
            { title: " " },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.post("/api/v1/organizations/org_1/boards", {
            title: "Q3",
        });
        expect(res.status).toBe(401);
    });
});

describe("GET /api/v1/organizations/:id/boards", () => {
    test("lists boards for a member", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/organizations/org_1/boards", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.boards.map((b: any) => b.id).sort()).toEqual([
            "brd_1",
            "brd_2",
        ]);
    });

    test("returns an empty list for an org with no boards", async () => {
        prismaMock.reset({
            users: [makeUser("alice", "alice@example.com")],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [makeMembership("m1", "alice", "org_1", "ADMIN")],
        });
        const cookie = await http.login("alice@example.com");
        const body: any = await (
            await http.get("/api/v1/organizations/org_1/boards", cookie)
        ).json();

        expect(body.boards).toEqual([]);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/organizations/org_1/boards", cookie);

        expect(res.status).toBe(403);
    });
});

describe("GET /api/v1/boards/:id", () => {
    test("returns the board with ordered sections for a member", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/boards/brd_1", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.board).toMatchObject({ id: "brd_1", title: "Roadmap" });
        expect(body.board.sections.map((s: any) => s.title)).toEqual([
            "Todo",
            "Doing",
            "Done",
        ]);
    });

    test("forbids non-members of the board's org", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/boards/brd_1", cookie);

        expect(res.status).toBe(403);
    });

    test("includes ordered issues per section", async () => {
        prismaMock.reset({
            users: [
                makeUser("alice", "alice@example.com"),
                makeUser("carol", "carol@example.com"),
            ],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [
                makeMembership("mem_alice", "alice", "org_1", "ADMIN"),
                makeMembership("mem_carol", "carol", "org_1", "MEMBER"),
            ],
            boards: [makeBoard("brd_1", "Roadmap")],
            sections: [makeSection("sec_1", "Todo", 0)],
            issues: [
                {
                    id: "iss_1",
                    title: "B",
                    description: null,
                    order: 1,
                    priority: "NONE",
                    dueDate: null,
                    sectionId: "sec_1",
                    assigneeIds: ["carol"],
                },
                {
                    id: "iss_2",
                    title: "A",
                    description: null,
                    order: 0,
                    priority: "HIGH",
                    dueDate: null,
                    sectionId: "sec_1",
                    assigneeIds: [],
                },
            ],
        });
        const cookie = await http.login("carol@example.com");

        const body: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();

        const todo = body.board.sections.find((s: any) => s.id === "sec_1");
        expect(todo.issues.map((i: any) => i.title)).toEqual(["A", "B"]);
        expect(todo.issues[1].assignees).toMatchObject([{ id: "carol" }]);
    });

    test("returns 404 for an unknown board", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.get("/api/v1/boards/nope", cookie);

        expect(res.status).toBe(404);
    });
});

describe("PUT /api/v1/boards/:id", () => {
    test("lets a MODERATOR update the board", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/boards/brd_1",
            { title: "Q3 Roadmap", description: "Focus" },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.board).toMatchObject({
            title: "Q3 Roadmap",
            description: "Focus",
        });
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.put(
            "/api/v1/boards/brd_1",
            { title: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.put(
            "/api/v1/boards/brd_1",
            { title: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown board", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/boards/nope",
            { title: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects an empty title", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/boards/brd_1",
            { title: "" },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("DELETE /api/v1/boards/:id", () => {
    test("lets a MODERATOR delete the board", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/boards/brd_1", cookie);

        expect(res.status).toBe(200);

        const after = await http.get("/api/v1/boards/brd_1", cookie);
        expect(after.status).toBe(404);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/boards/brd_1", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown board", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del("/api/v1/boards/nope", cookie);

        expect(res.status).toBe(404);
    });
});

describe("POST /api/v1/boards/:id/sections", () => {
    test("appends a section to the end of the board", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/boards/brd_1/sections",
            { title: "Review" },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.section).toMatchObject({
            title: "Review",
            order: 3,
            boardId: "brd_1",
        });
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/boards/brd_1/sections",
            { title: "Review" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown board", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/boards/nope/sections",
            { title: "Review" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects an empty title", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/boards/brd_1/sections",
            { title: " " },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("PATCH /api/v1/sections/:id", () => {
    test("lets a MODERATOR rename a section", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/sections/sec_1",
            { title: "To Do" },
            cookie
        );

        expect(res.status).toBe(200);
        expect((await (res.json() as Promise<any>)).section.title).toBe(
            "To Do"
        );
    });

    test("reorders a section within the board", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/sections/sec_3",
            { order: 0 },
            cookie
        );

        expect(res.status).toBe(200);
        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        expect(detail.board.sections.map((s: any) => s.title)).toEqual([
            "Done",
            "Todo",
            "Doing",
        ]);
    });

    test("clamps an out-of-range order", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        await http.patch("/api/v1/sections/sec_1", { order: 99 }, cookie);

        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        expect(detail.board.sections.map((s: any) => s.title)).toEqual([
            "Doing",
            "Done",
            "Todo",
        ]);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.patch(
            "/api/v1/sections/sec_1",
            { title: "X" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown section", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/sections/nope",
            { title: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects a negative order", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/sections/sec_1",
            { order: -1 },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("DELETE /api/v1/sections/:id", () => {
    test("deletes a section and closes the order gap", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/sections/sec_2", cookie);

        expect(res.status).toBe(200);

        const detail: any = await (
            await http.get("/api/v1/boards/brd_1", cookie)
        ).json();
        expect(detail.board.sections.map((s: any) => s.title)).toEqual([
            "Todo",
            "Done",
        ]);
        expect(detail.board.sections.map((s: any) => s.order)).toEqual([0, 1]);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/sections/sec_1", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown section", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del("/api/v1/sections/nope", cookie);

        expect(res.status).toBe(404);
    });
});
