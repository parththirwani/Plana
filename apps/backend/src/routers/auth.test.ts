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

let app: any;
let server: any;
let baseUrl: string;

beforeAll(async () => {
    ({ app } = await import("../../index"));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://localhost:${(server.address() as any).port}`;
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    prismaMock.reset();
});

const seedUser = (overrides: Partial<MockUser> = {}): MockUser =>
    ({
        id: "usr_1",
        email: "user@example.com",
        password: "hashed-password",
        name: null,
        avatarUrl: null,
        onboardingCompleted: false,
        ...overrides,
    });

const post = (path: string, body: unknown, cookie?: string | null) =>
    fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
    });

const get = (path: string, cookie?: string | null) =>
    fetch(`${baseUrl}${path}`, {
        headers: cookie ? { Cookie: cookie } : {},
    });

const tokenCookieFrom = (res: Response): string | null => {
    const token = res.headers
        .getSetCookie()
        .find((c) => c.startsWith("token="));
    return token?.split(";")[0] ?? null;
};

describe("POST /api/v1/auth/signup", () => {
    test("creates a user and sets an httpOnly cookie", async () => {
        const res = await post("/api/v1/auth/signup", {
            email: "new@example.com",
            password: "password123",
        });

        expect(res.status).toBe(201);
        const body: any = await res.json();
        expect(body.message).toBe("User signed up successfully");
        expect(body.user.email).toBe("new@example.com");
        expect(body.user.password).toBeUndefined();

        const cookie = tokenCookieFrom(res);
        expect(cookie).not.toBeNull();
        expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    });

    test("normalizes the email to lowercase", async () => {
        const res = await post("/api/v1/auth/signup", {
            email: "  New@Example.COM  ",
            password: "password123",
        });

        const body: any = await res.json();
        expect(body.user.email).toBe("new@example.com");
    });

    test("rejects an invalid email", async () => {
        const res = await post("/api/v1/auth/signup", {
            email: "not-an-email",
            password: "password123",
        });
        expect(res.status).toBe(400);
    });

    test("rejects a password shorter than 5 chars", async () => {
        const res = await post("/api/v1/auth/signup", {
            email: "new@example.com",
            password: "1234",
        });
        expect(res.status).toBe(400);
    });

    test("rejects a duplicate email", async () => {
        prismaMock.reset([seedUser()]);

        const res = await post("/api/v1/auth/signup", {
            email: "user@example.com",
            password: "password123",
        });

        expect(res.status).toBe(409);
    });

    test("rejects a duplicate email case-insensitively", async () => {
        prismaMock.reset([seedUser({ email: "Foo@Bar.com" })]);

        const res = await post("/api/v1/auth/signup", {
            email: "foo@bar.com",
            password: "password123",
        });

        expect(res.status).toBe(409);
    });
});

describe("POST /api/v1/auth/signin", () => {
    test("signs in and sets an httpOnly cookie", async () => {
        prismaMock.reset([seedUser()]);

        const res = await post("/api/v1/auth/signin", {
            email: "user@example.com",
            password: "hashed-password",
        });

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.message).toBe("User signed in successfully");
        expect(body.user.email).toBe("user@example.com");
        expect(body.user.password).toBeUndefined();
        expect(body.token).toBeUndefined();

        const cookie = tokenCookieFrom(res);
        expect(cookie).not.toBeNull();
    });

    test("signs in with differently-cased email", async () => {
        prismaMock.reset([seedUser({ email: "User@Example.com" })]);

        const res = await post("/api/v1/auth/signin", {
            email: "USER@example.com",
            password: "hashed-password",
        });

        expect(res.status).toBe(200);
    });

    test("rejects a wrong password", async () => {
        prismaMock.reset([seedUser()]);

        const res = await post("/api/v1/auth/signin", {
            email: "user@example.com",
            password: "wrong-password",
        });

        expect(res.status).toBe(403);
        const body: any = await res.json();
        expect(body.message).toBe("Invalid email or password");
    });

    test("rejects an unknown email", async () => {
        const res = await post("/api/v1/auth/signin", {
            email: "nobody@example.com",
            password: "hashed-password",
        });

        expect(res.status).toBe(403);
    });

    test("does not reveal whether email or password was wrong", async () => {
        prismaMock.reset([seedUser()]);
        const unknown = await post("/api/v1/auth/signin", {
            email: "nobody@example.com",
            password: "whatever",
        });
        const known = await post("/api/v1/auth/signin", {
            email: "user@example.com",
            password: "wrong-password",
        });

        expect((await (unknown.json() as Promise<any>)).message).toBe(
            (await (known.json() as Promise<any>)).message
        );
    });
});

describe("GET /api/v1/auth/me", () => {
    test("returns 401 without a token", async () => {
        const res = await get("/api/v1/auth/me");
        expect(res.status).toBe(401);
    });

    test("returns 401 with an invalid token", async () => {
        const res = await get("/api/v1/auth/me", "token=not-a-real-token");
        expect(res.status).toBe(401);
    });

    test("returns the user for a valid token", async () => {
        const signup = await post("/api/v1/auth/signup", {
            email: "user@example.com",
            password: "hashed-password",
        });
        const cookie = tokenCookieFrom(signup);

        const res = await get("/api/v1/auth/me", cookie);

        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.user).toMatchObject({
            email: "user@example.com",
            name: null,
            onboardingCompleted: false,
        });
    });
});

describe("POST /api/v1/auth/logout", () => {
    test("clears the auth cookie", async () => {
        const res = await post("/api/v1/auth/logout", {});

        expect(res.status).toBe(200);
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("token=");
        expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    });
});
