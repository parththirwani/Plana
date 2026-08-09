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
  prismaMock.reset({
    users: [
      {
        id: "usr_1",
        email: "user@example.com",
        password: "hashed-password",
        name: "Ada",
        avatarUrl: null,
        onboardingCompleted: true,
      } satisfies MockUser,
    ],
  });
});

describe("GET /api/v1/ws-token", () => {
  test("returns a fresh token for an authenticated user", async () => {
    const login = await http.post("/api/v1/auth/signin", {
      email: "user@example.com",
      password: "hashed-password",
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? null;
    expect(cookie).not.toBeNull();
    const res = await http.get("/api/v1/ws-token", cookie);

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(10);
  });

  test("rejects when unauthenticated", async () => {
    const res = await http.get("/api/v1/ws-token");
    expect(res.status).toBe(401);
  });

  test("rejects an invalid token", async () => {
    const res = await http.get("/api/v1/ws-token", "token=not-a-real-token");
    expect(res.status).toBe(401);
  });
});
