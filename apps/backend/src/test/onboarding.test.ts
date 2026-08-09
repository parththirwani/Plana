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
import type { MockUser } from "../test-utils/prismaMock";
import { tokenCookieFrom, startTestServer, makeHttp } from "../test-utils/http";

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

const signupCookie = async () => {
    const res = await http.post("/api/v1/auth/signup", {
        email: "new@example.com",
        password: "password123",
    });
    return tokenCookieFrom(res)!;
};

describe("POST /api/v1/onboarding", () => {
    test("completes onboarding and marks the user as onboarded", async () => {
        const cookie = await signupCookie();

        const res = await http.post(
            "/api/v1/onboarding",
            { name: "Ada Lovelace", avatarUrl: "https://example.com/ada.png" },
            cookie
        );

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.user).toMatchObject({
            name: "Ada Lovelace",
            avatarUrl: "https://example.com/ada.png",
        });

        const me: any = await (await http.get("/api/v1/auth/me", cookie)).json();
        expect(me.user.onboardingCompleted).toBe(true);
    });

    test("returns 409 when onboarding was already completed", async () => {
        const cookie = await signupCookie();
        await http.post(
            "/api/v1/onboarding",
            { name: "Ada Lovelace" },
            cookie
        );

        const res = await http.post(
            "/api/v1/onboarding",
            { name: "Grace Hopper" },
            cookie
        );

        expect(res.status).toBe(409);
    });

    test("rejects a name shorter than 3 chars", async () => {
        const cookie = await signupCookie();
        const res = await http.post("/api/v1/onboarding", { name: "Ab" }, cookie);
        expect(res.status).toBe(400);
    });

    test("rejects a non-url avatarUrl", async () => {
        const cookie = await signupCookie();
        const res = await http.post(
            "/api/v1/onboarding",
            { name: "Ada Lovelace", avatarUrl: "not-a-url" },
            cookie
        );
        expect(res.status).toBe(400);
    });

    test("rejects unauthenticated requests", async () => {
        const res = await http.post("/api/v1/onboarding", { name: "Ada" });
        expect(res.status).toBe(401);
    });
});
