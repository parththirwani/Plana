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
    MockComment,
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

const makeComment = (
    id: string,
    content: string,
    authorId: string,
    createdAt: string
): MockComment => ({
    id,
    content,
    issueId: "iss_1",
    authorId,
    createdAt,
    updatedAt: createdAt,
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
            {
                id: "brd_1",
                title: "Roadmap",
                description: null,
                organizationId: "org_1",
            } satisfies MockBoard,
        ],
        sections: [
            {
                id: "sec_1",
                title: "Todo",
                order: 0,
                boardId: "brd_1",
            } satisfies MockSection,
        ],
        issues: [
            {
                id: "iss_1",
                title: "Login",
                description: null,
                order: 0,
                priority: "NONE",
                dueDate: null,
                sectionId: "sec_1",
                assigneeIds: [],
            } satisfies MockIssue,
        ],
        comments: [
            makeComment("com_1", "First", "carol", "2026-08-01T00:00:00.000Z"),
            makeComment("com_2", "Second", "bob", "2026-08-02T00:00:00.000Z"),
        ],
    });

describe("POST /api/v1/issues/:id/comments", () => {
    test("lets a member comment as themselves", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/comments",
            { content: "  Looks good  " },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.comment).toMatchObject({
            content: "Looks good",
            issueId: "iss_1",
            authorId: "carol",
        });
        expect(body.comment.author).toMatchObject({
            id: "carol",
            email: "carol@example.com",
        });
        expect(body.comment.author.password).toBeUndefined();
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/comments",
            { content: "Intrude" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown issue", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/issues/nope/comments",
            { content: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("rejects empty content", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/issues/iss_1/comments",
            { content: " " },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("GET /api/v1/issues/:id/comments", () => {
    test("lists comments in creation order with authors", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/issues/iss_1/comments", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.comments.map((c: any) => c.content)).toEqual([
            "First",
            "Second",
        ]);
        expect(body.comments[0].author.id).toBe("carol");
        expect(body.comments[1].author.id).toBe("bob");
    });

    test("returns an empty list for an issue with no comments", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/issues/iss_1/comments", cookie);

        expect(res.status).toBe(200);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/issues/iss_1/comments", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown issue", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/issues/nope/comments", cookie);

        expect(res.status).toBe(404);
    });
});

describe("PATCH /api/v1/comments/:id", () => {
    test("lets the author edit their own comment", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.patch(
            "/api/v1/comments/com_1",
            { content: "Revised" },
            cookie
        );

        expect(res.status).toBe(200);
        expect((await (res.json() as Promise<any>)).comment.content).toBe(
            "Revised"
        );
    });

    test("lets a MODERATOR edit someone else's comment", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/comments/com_1",
            { content: "Cleaned up" },
            cookie
        );

        expect(res.status).toBe(200);
    });

    test("forbids a MEMBER editing another member's comment", async () => {
        seed();
        prismaMock.reset({
            users: [
                makeUser("carol", "carol@example.com"),
                makeUser("eve", "eve@example.com"),
            ],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [
                makeMembership("m1", "carol", "org_1", "MEMBER"),
                makeMembership("m2", "eve", "org_1", "MEMBER"),
            ],
            boards: [
                {
                    id: "brd_1",
                    title: "Roadmap",
                    description: null,
                    organizationId: "org_1",
                } satisfies MockBoard,
            ],
            sections: [
                {
                    id: "sec_1",
                    title: "Todo",
                    order: 0,
                    boardId: "brd_1",
                } satisfies MockSection,
            ],
            issues: [
                {
                    id: "iss_1",
                    title: "Login",
                    description: null,
                    order: 0,
                    priority: "NONE",
                    dueDate: null,
                    sectionId: "sec_1",
                    assigneeIds: [],
                } satisfies MockIssue,
            ],
            comments: [makeComment("com_1", "First", "eve", "2026-08-01T00:00:00.000Z")],
        });
        const cookie = await http.login("carol@example.com");
        const res = await http.patch(
            "/api/v1/comments/com_1",
            { content: "Tamper" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.patch(
            "/api/v1/comments/com_1",
            { content: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown comment", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.patch(
            "/api/v1/comments/nope",
            { content: "X" },
            cookie
        );

        expect(res.status).toBe(404);
    });
});

describe("DELETE /api/v1/comments/:id", () => {
    test("lets the author delete their own comment", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/comments/com_1", cookie);

        expect(res.status).toBe(200);

        const body: any = await (
            await http.get("/api/v1/issues/iss_1/comments", cookie)
        ).json();
        expect(body.comments.map((c: any) => c.id)).toEqual(["com_2"]);
    });

    test("lets a MODERATOR delete someone else's comment", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/comments/com_1", cookie);

        expect(res.status).toBe(200);
    });

    test("forbids a MEMBER deleting another member's comment", async () => {
        seed();
        prismaMock.reset({
            users: [
                makeUser("carol", "carol@example.com"),
                makeUser("eve", "eve@example.com"),
            ],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [
                makeMembership("m1", "carol", "org_1", "MEMBER"),
                makeMembership("m2", "eve", "org_1", "MEMBER"),
            ],
            boards: [
                {
                    id: "brd_1",
                    title: "Roadmap",
                    description: null,
                    organizationId: "org_1",
                } satisfies MockBoard,
            ],
            sections: [
                {
                    id: "sec_1",
                    title: "Todo",
                    order: 0,
                    boardId: "brd_1",
                } satisfies MockSection,
            ],
            issues: [
                {
                    id: "iss_1",
                    title: "Login",
                    description: null,
                    order: 0,
                    priority: "NONE",
                    dueDate: null,
                    sectionId: "sec_1",
                    assigneeIds: [],
                } satisfies MockIssue,
            ],
            comments: [makeComment("com_1", "First", "eve", "2026-08-01T00:00:00.000Z")],
        });
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/comments/com_1", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 404 for an unknown comment", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.del("/api/v1/comments/nope", cookie);

        expect(res.status).toBe(404);
    });
});

describe("cascade semantics", () => {
    test("deleting an issue removes its comments", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/issues/iss_1", cookie);

        expect(res.status).toBe(200);

        const remaining = await prismaMock.prisma.comment.findMany({
            where: { issueId: "iss_1" },
        });
        expect(remaining).toEqual([]);
    });
});
