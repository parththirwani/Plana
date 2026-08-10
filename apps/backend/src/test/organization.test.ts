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
        ],
    });

const seedWithInvitations = (invitations: any[]) =>
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
        ],
        invitations,
    });

describe("POST /api/v1/organizations", () => {
    test("creates an org, sets the creator as ADMIN, and returns a slug", async () => {
        seed();
        const cookie = await http.login("alice@example.com");

        const res = await http.post(
            "/api/v1/organizations",
            { name: "  New Team  " },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.organization.slug).toBe("new-team");
        expect(body.organization.role).toBe("ADMIN");

        const members: any = await (
            await http.get(
                `/api/v1/organizations/${body.organization.id}/members`,
                cookie
            )
        ).json();
        expect(members.members.find((m: any) => m.userId === "alice").role).toBe(
            "ADMIN"
        );
    });

    test("disambiguates a colliding slug with a numeric suffix", async () => {
        seed();
        prismaMock.reset({
            users: [makeUser("alice", "alice@example.com")],
            organizations: [makeOrg("org_1", "Acme", "my-org")],
            memberships: [makeMembership("mem_alice", "alice", "org_1", "ADMIN")],
        });
        const cookie = await http.login("alice@example.com");

        const res = await http.post(
            "/api/v1/organizations",
            { name: "My Org" },
            cookie
        );

        expect(res.status).toBe(201);
        expect((await (res.json() as Promise<any>)).organization.slug).toBe("my-org-2");
    });

    test("rejects an empty name", async () => {
        seed();
        const cookie = await http.login("alice@example.com");

        const res = await http.post("/api/v1/organizations", { name: " " }, cookie);

        expect(res.status).toBe(400);
    });

    test("rejects a non-url orgImage", async () => {
        seed();
        const cookie = await http.login("alice@example.com");

        const res = await http.post(
            "/api/v1/organizations",
            { name: "Acme", orgImage: "not-a-url" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.post("/api/v1/organizations", { name: "Acme" });
        expect(res.status).toBe(401);
    });
});

describe("GET /api/v1/organizations", () => {
    test("returns only orgs the user belongs to", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.get("/api/v1/organizations", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.organizations).toHaveLength(1);
        expect(body.organizations[0]).toMatchObject({
            id: "org_1",
            role: "ADMIN",
        });
    });

    test("returns an empty list for a user with no orgs", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const body: any = await (
            await http.get("/api/v1/organizations", cookie)
        ).json();

        expect(body.organizations).toEqual([]);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.get("/api/v1/organizations");
        expect(res.status).toBe(401);
    });
});

describe("GET /api/v1/organizations/:id", () => {
    test("returns the org for a member with their role", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/organizations/org_1", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.organization).toMatchObject({
            id: "org_1",
            name: "Acme",
            slug: "acme",
            role: "MEMBER",
        });
    });

    test("returns 403 for a non-member", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/organizations/org_1", cookie);

        expect(res.status).toBe(403);
    });

    test("returns 403 (not 404) for a non-member querying an unknown org", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/organizations/nope", cookie);

        expect(res.status).toBe(403);
    });
});

describe("GET /api/v1/organizations/by-slug/:slug", () => {
    test("returns the org for a member", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get("/api/v1/organizations/by-slug/acme", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.organization).toMatchObject({ id: "org_1", role: "MEMBER" });
    });

    test("resolves the regenerated slug after a rename", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        await http.put(
            "/api/v1/organizations/org_1",
            { name: "Acme Corp" },
            cookie
        );

        const res = await http.get(
            "/api/v1/organizations/by-slug/acme-corp",
            cookie
        );

        expect(res.status).toBe(200);
        expect((await (res.json() as Promise<any>)).organization.id).toBe(
            "org_1"
        );
    });

    test("returns 404 for an unknown slug", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get(
            "/api/v1/organizations/by-slug/does-not-exist",
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get("/api/v1/organizations/by-slug/acme", cookie);

        expect(res.status).toBe(403);
    });
});

describe("PUT /api/v1/organizations/:id", () => {
    test("lets an ADMIN update the org", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Acme Corp", description: "Best company" },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.organization.name).toBe("Acme Corp");
        expect(body.organization.description).toBe("Best company");
    });

    test("regenerates the slug on rename", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Totally New Name" },
            cookie
        );

        expect((await (res.json() as Promise<any>)).organization.slug).toBe(
            "totally-new-name"
        );
    });

    test("keeps the slug when the name is unchanged", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Acme", description: "still Acme" },
            cookie
        );

        expect((await (res.json() as Promise<any>)).organization.slug).toBe(
            "acme"
        );
    });

    test("disambiguates a renamed slug against another org", async () => {
        prismaMock.reset({
            users: [makeUser("alice", "alice@example.com")],
            organizations: [
                makeOrg("org_1", "Acme", "acme"),
                makeOrg("org_2", "Old", "new-name"),
            ],
            memberships: [
                makeMembership("m1", "alice", "org_1", "ADMIN"),
                makeMembership("m2", "alice", "org_2", "ADMIN"),
            ],
        });
        const cookie = await http.login("alice@example.com");

        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "New Name" },
            cookie
        );

        expect((await (res.json() as Promise<any>)).organization.slug).toBe(
            "new-name-2"
        );
    });

    test("forbids MODERATOR", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids MEMBER", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "Hijack" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("rejects invalid body", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.put(
            "/api/v1/organizations/org_1",
            { name: "" },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("DELETE /api/v1/organizations/:id", () => {
    test("lets an ADMIN delete the org", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del("/api/v1/organizations/org_1", cookie);

        expect(res.status).toBe(200);

        const after = await http.get("/api/v1/organizations/org_1", cookie);
        expect(after.status).toBe(403);
    });

    test("forbids MODERATOR", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del("/api/v1/organizations/org_1", cookie);

        expect(res.status).toBe(403);
    });
});

describe("POST /api/v1/organizations/:id/members", () => {
    test("lets an ADMIN invite an existing user, creating a pending invitation", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "  EVE@example.com  " },
            cookie
        );

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.invitation).toMatchObject({
            organizationId: "org_1",
            email: "eve@example.com",
            role: "MEMBER",
        });
    });

    test("returns 404 for an unknown user", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "ghost@example.com" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("returns 409 for an existing member", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "carol@example.com" },
            cookie
        );

        expect(res.status).toBe(409);
    });

    test("returns 409 for a duplicate pending invitation", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "eve@example.com" },
            cookie
        );

        expect(res.status).toBe(409);
    });

    test("forbids MODERATOR", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "eve@example.com" },
            cookie
        );

        expect(res.status).toBe(403);
    });

    test("rejects an invalid email", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/members",
            { email: "not-an-email" },
            cookie
        );

        expect(res.status).toBe(400);
    });
});

describe("GET /api/v1/invitations", () => {
    test("lists only the caller's pending invitations with org details", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
            { id: "inv_2", organizationId: "org_1", email: "dave@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("eve@example.com");
        const res = await http.get("/api/v1/invitations", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.invitations).toHaveLength(1);
        expect(body.invitations[0]).toMatchObject({
            id: "inv_1",
            organizationId: "org_1",
            organizationName: "Acme",
            role: "MEMBER",
        });
    });

    test("returns an empty list with no invitations", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const body: any = await (
            await http.get("/api/v1/invitations", cookie)
        ).json();

        expect(body.invitations).toEqual([]);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.get("/api/v1/invitations");
        expect(res.status).toBe(401);
    });
});

describe("POST /api/v1/invitations/:id/accept", () => {
    test("accepts an invitation, joins the org, and removes the invitation", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("eve@example.com");
        const res = await http.post("/api/v1/invitations/inv_1/accept", undefined, cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.organization).toMatchObject({ id: "org_1", name: "Acme", role: "MEMBER" });

        const members: any = await (
            await http.get("/api/v1/organizations/org_1/members", cookie)
        ).json();
        expect(members.members.find((m: any) => m.userId === "eve").role).toBe("MEMBER");

        const invites: any = await (
            await http.get("/api/v1/invitations", cookie)
        ).json();
        expect(invites.invitations).toEqual([]);
    });

    test("returns 404 when the invitation belongs to someone else", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("dave@example.com");
        const res = await http.post("/api/v1/invitations/inv_1/accept", undefined, cookie);

        expect(res.status).toBe(404);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.post("/api/v1/invitations/inv_1/accept");
        expect(res.status).toBe(401);
    });
});

describe("POST /api/v1/invitations/:id/decline", () => {
    test("declines an invitation and removes it", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("eve@example.com");
        const res = await http.post("/api/v1/invitations/inv_1/decline", undefined, cookie);

        expect(res.status).toBe(200);

        const invites: any = await (
            await http.get("/api/v1/invitations", cookie)
        ).json();
        expect(invites.invitations).toEqual([]);
    });

    test("returns 404 when the invitation belongs to someone else", async () => {
        seedWithInvitations([
            { id: "inv_1", organizationId: "org_1", email: "eve@example.com", role: "MEMBER" },
        ]);
        const cookie = await http.login("dave@example.com");
        const res = await http.post("/api/v1/invitations/inv_1/decline", undefined, cookie);

        expect(res.status).toBe(404);
    });
});

describe("GET /api/v1/organizations/:id/members", () => {
    test("lists all members with roles for a member", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.get(
            "/api/v1/organizations/org_1/members",
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        const roles = Object.fromEntries(
            body.members.map((m: any) => [m.userId, m.role])
        );
        expect(roles).toEqual({
            alice: "ADMIN",
            bob: "MODERATOR",
            carol: "MEMBER",
        });
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.get(
            "/api/v1/organizations/org_1/members",
            cookie
        );

        expect(res.status).toBe(403);
    });
});

describe("PATCH /api/v1/organizations/:id/members/:userId", () => {
    test("lets an ADMIN change a member's role", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/carol",
            { role: "MODERATOR" },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.membership).toMatchObject({ userId: "carol", role: "MODERATOR" });
    });

    test("rejects an invalid role", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/carol",
            { role: "SUPERUSER" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("returns 404 when the target is not a member", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/dave",
            { role: "MEMBER" },
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("blocks demoting the last admin", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/alice",
            { role: "MEMBER" },
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("allows demoting an admin when another admin exists", async () => {
        seed();
        prismaMock.reset({
            users: [makeUser("alice", "alice@example.com"), makeUser("bob", "bob@example.com")],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [
                makeMembership("m1", "alice", "org_1", "ADMIN"),
                makeMembership("m2", "bob", "org_1", "ADMIN"),
            ],
        });
        const cookie = await http.login("alice@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/bob",
            { role: "MEMBER" },
            cookie
        );

        expect(res.status).toBe(200);
    });

    test("forbids MODERATOR", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.patch(
            "/api/v1/organizations/org_1/members/carol",
            { role: "MEMBER" },
            cookie
        );

        expect(res.status).toBe(403);
    });
});

describe("DELETE /api/v1/organizations/:id/members/:userId", () => {
    test("lets an ADMIN remove a member", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del(
            "/api/v1/organizations/org_1/members/carol",
            cookie
        );

        expect(res.status).toBe(200);

        const members: any = await (
            await http.get("/api/v1/organizations/org_1/members", cookie)
        ).json();
        expect(
            members.members.find((m: any) => m.userId === "carol")
        ).toBeUndefined();
    });

    test("returns 404 when the target is not a member", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del(
            "/api/v1/organizations/org_1/members/dave",
            cookie
        );

        expect(res.status).toBe(404);
    });

    test("blocks removing the last admin", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.del(
            "/api/v1/organizations/org_1/members/alice",
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("forbids MODERATOR", async () => {
        seed();
        const cookie = await http.login("bob@example.com");
        const res = await http.del(
            "/api/v1/organizations/org_1/members/carol",
            cookie
        );

        expect(res.status).toBe(403);
    });
});

describe("POST /api/v1/organizations/:id/leave", () => {
    test("lets a member leave", async () => {
        seed();
        const cookie = await http.login("carol@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/leave",
            undefined,
            cookie
        );

        expect(res.status).toBe(200);

        const after = await http.get("/api/v1/organizations/org_1", cookie);
        expect(after.status).toBe(403);
    });

    test("blocks the last admin from leaving", async () => {
        seed();
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/leave",
            undefined,
            cookie
        );

        expect(res.status).toBe(400);
    });

    test("lets an admin leave when another admin exists", async () => {
        seed();
        prismaMock.reset({
            users: [makeUser("alice", "alice@example.com"), makeUser("bob", "bob@example.com")],
            organizations: [makeOrg("org_1", "Acme", "acme")],
            memberships: [
                makeMembership("m1", "alice", "org_1", "ADMIN"),
                makeMembership("m2", "bob", "org_1", "ADMIN"),
            ],
        });
        const cookie = await http.login("alice@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/leave",
            undefined,
            cookie
        );

        expect(res.status).toBe(200);
    });

    test("forbids non-members", async () => {
        seed();
        const cookie = await http.login("dave@example.com");
        const res = await http.post(
            "/api/v1/organizations/org_1/leave",
            undefined,
            cookie
        );

        expect(res.status).toBe(403);
    });
});
