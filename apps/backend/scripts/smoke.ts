// End-to-end smoke test against a live database.
// Run from apps/backend: `bun run smoke`. Requires a reachable Postgres at
// packages/db/.env `DATABASE_URL`. Independent from the mocked unit tests.

import {
  startTestServer,
  makeHttp,
  tokenCookieFrom,
} from "../src/test-utils/http";

process.env.NODE_ENV = "test";

const loadEnvFile = async (path: string) => {
  for (const line of (await Bun.file(path).text()).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!.replace(/^"|"$/g, "");
    }
  }
};

await loadEnvFile(new URL("../.env", import.meta.url).pathname);

let failures = 0;
const check = (cond: unknown, label: string) => {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
};
const expectStatus = (res: Response, expected: number, label: string) => {
  check(
    res.status === expected,
    `${label} -> ${res.status} (want ${expected})`,
  );
  return res;
};

const stamp = Date.now().toString(36);
const email = (prefix: string) => `${prefix}_${stamp}@smoke.test`;

const main = async () => {
  const { server, baseUrl } = await startTestServer();
  const http = makeHttp(baseUrl);

  try {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — start Postgres and set packages/db/.env",
      );
    }

    console.log("signup users");
    const a = email("a");
    const b = email("b");
    const c = email("c");
    const ra = expectStatus(
      await http.post("/api/v1/auth/signup", {
        email: a,
        password: "password123",
      }),
      201,
      "signup A",
    );
    const rb = expectStatus(
      await http.post("/api/v1/auth/signup", {
        email: b,
        password: "password123",
      }),
      201,
      "signup B",
    );
    const rc = expectStatus(
      await http.post("/api/v1/auth/signup", {
        email: c,
        password: "password123",
      }),
      201,
      "signup C",
    );
    const cookieA = tokenCookieFrom(ra);
    const cookieB = tokenCookieFrom(rb);
    const cookieC = tokenCookieFrom(rc);
    const userBId = ((await rb.json()) as any).user.id as string;
    check(!!cookieA && !!cookieB && !!cookieC, "auth cookies set");

    console.log("onboarding");
    expectStatus(
      await http.post(
        "/api/v1/onboarding",
        { name: "Smoke User A", avatarUrl: "https://example.com/a.png" },
        cookieA,
      ),
      200,
      "complete onboarding A",
    );
    expectStatus(
      await http.post("/api/v1/onboarding", { name: "Smoke User B" }, cookieB),
      200,
      "complete onboarding B",
    );
    expectStatus(
      await http.post("/api/v1/onboarding", { name: "Again" }, cookieA),
      409,
      "onboarding A is idempotent-guarded",
    );

    console.log("organization");
    const orgRes = expectStatus(
      await http.post(
        "/api/v1/organizations",
        { name: "Smoke Org", description: "created by smoke" },
        cookieA,
      ),
      201,
      "create org",
    );
    const orgId = ((await orgRes.json()) as any).organization.id as string;
    check(typeof orgId === "string", `org id resolved (${orgId})`);

    expectStatus(
      await http.post(
        `/api/v1/organizations/${orgId}/members`,
        { email: b },
        cookieA,
      ),
      201,
      "invite member B",
    );

    console.log("access control");
    expectStatus(
      await http.get(`/api/v1/organizations/${orgId}`, cookieC),
      403,
      "non-member GET org -> 403",
    );

    console.log("board + sections");
    const boardRes = expectStatus(
      await http.post(
        `/api/v1/organizations/${orgId}/boards`,
        { title: "Smoke Board" },
        cookieA,
      ),
      201,
      "create board",
    );
    const boardId = ((await boardRes.json()) as any).board.id as string;

    const s1Res = expectStatus(
      await http.post(
        `/api/v1/boards/${boardId}/sections`,
        { title: "To Do" },
        cookieA,
      ),
      201,
      "create section 1",
    );
    const s2Res = expectStatus(
      await http.post(
        `/api/v1/boards/${boardId}/sections`,
        { title: "Done" },
        cookieA,
      ),
      201,
      "create section 2",
    );
    const s1 = ((await s1Res.json()) as any).section.id as string;
    const s2 = ((await s2Res.json()) as any).section.id as string;

    expectStatus(
      await http.get(`/api/v1/boards/${boardId}`, cookieC),
      403,
      "non-member GET board -> 403",
    );

    console.log("issues");
    const i1Res = expectStatus(
      await http.post(
        `/api/v1/sections/${s1}/issues`,
        { title: "Smoke Issue 1", priority: "HIGH" },
        cookieA,
      ),
      201,
      "create issue 1",
    );
    const i1 = ((await i1Res.json()) as any).issue.id as string;
    expectStatus(
      await http.post(
        `/api/v1/sections/${s1}/issues`,
        { title: "Smoke Issue 2" },
        cookieA,
      ),
      201,
      "create issue 2",
    );

    expectStatus(
      await http.post(
        `/api/v1/issues/${i1}/move`,
        { sectionId: s2, order: 0 },
        cookieA,
      ),
      200,
      "move issue across sections",
    );
    expectStatus(
      await http.put(
        `/api/v1/issues/${i1}/assignees`,
        { assigneeIds: [userBId] },
        cookieA,
      ),
      200,
      "assign member B",
    );

    console.log("comments");
    expectStatus(
      await http.post(
        `/api/v1/issues/${i1}/comments`,
        { content: "smoke comment" },
        cookieB,
      ),
      201,
      "member B comments",
    );
    expectStatus(
      await http.post(
        `/api/v1/issues/${i1}/comments`,
        { content: "" },
        cookieB,
      ),
      400,
      "empty comment rejected",
    );

    console.log("board detail");
    const detail = expectStatus(
      await http.get(`/api/v1/boards/${boardId}`, cookieA),
      200,
      "GET board detail",
    ).json();
    const board = ((await detail) as any).board as any;
    const sections = board.sections as any[];
    check(sections.length === 2, "board has 2 sections");
    const doneSection = sections.find((s) => s.id === s2);
    const moved = doneSection?.issues.find((i: any) => i.id === i1);
    check(moved?.title === "Smoke Issue 1", "issue 1 lives in section 2");
    check(
      moved?.assignees?.some((u: any) => u.email === b),
      "issue 1 has assignee B",
    );
    check(
      Array.isArray(moved?.assignees) && moved.assignees.length === 1,
      "issue 1 has exactly one assignee",
    );
    check(moved?.comments === undefined, "issue detail omits comments");

    console.log("realtime");
    const wsTok = expectStatus(
      await http.get("/api/v1/ws-token", cookieA),
      200,
      "GET /api/v1/ws-token",
    );
    expectStatus(
      await http.get("/api/v1/ws-token"),
      401,
      "ws-token without auth -> 401",
    );
    const { token: wsTokenA } = (await wsTok.json()) as any;
    const wsTokenB = (
      (await (await http.get("/api/v1/ws-token", cookieB)).json()) as any
    ).token;
    check(!!wsTokenA && !!wsTokenB, "ws tokens issued");

    const wsModule = await import("../../websocket/index.ts");
    const wsUrl = `ws://localhost:${wsModule.server.port}/ws?boardId=${boardId}&token=`;
    const sockA = new WebSocket(`${wsUrl}${wsTokenA}`);
    const sockB = new WebSocket(`${wsUrl}${wsTokenB}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("websocket connect timeout")),
        5000,
      );
      let opened = 0;
      const onOpen = () => {
        if (++opened === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      sockA.onopen = onOpen;
      sockB.onopen = onOpen;
      sockA.onerror = () => reject(new Error("websocket A error"));
      sockB.onerror = () => reject(new Error("websocket B error"));
    });

    const received: string[] = [];
    sockA.onmessage = (event: any) => received.push(String(event.data));

    expectStatus(
      await http.patch(
        `/api/v1/organizations/${orgId}/members/${userBId}`,
        { role: "MODERATOR" },
        cookieA,
      ),
      200,
      "promote B to MODERATOR",
    );

    expectStatus(
      await http.patch(
        `/api/v1/issues/${i1}`,
        { title: "Renamed live" },
        cookieB,
      ),
      200,
      "member B updates issue (triggers relay)",
    );

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (received.some((m) => m.includes('"issue.updated"'))) {
          clearInterval(poll);
          resolve();
        }
      }, 25);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, 3000);
    });
    check(
      received.some((m) => {
        try {
          const p = JSON.parse(m);
          return (
            p.event === "issue.updated" &&
            p.boardId === boardId &&
            p.actor?.id === userBId
          );
        } catch {
          return false;
        }
      }),
      "socket A receives issue.updated relayed with actor B",
    );

    sockA.close();
    sockB.close();
    wsModule.server.stop(true);

    console.log("auth lifecycle");
    expectStatus(await http.get("/api/v1/auth/me", cookieB), 200, "GET /me");
    const logout = expectStatus(
      await http.post("/api/v1/auth/logout", {}, cookieA),
      200,
      "logout",
    );
    check(
      /max-age=0|expires=thu, 01 jan 1970/.test(
        (logout.headers.get("set-cookie") ?? "").toLowerCase(),
      ),
      "logout clears the cookie",
    );
    expectStatus(await http.get("/api/v1/auth/me"), 401, "no cookie -> 401");

    console.log("cleanup");
    expectStatus(
      await http.del(`/api/v1/organizations/${orgId}`, cookieA),
      200,
      "delete org (cascades)",
    );
    expectStatus(
      await http.get(`/api/v1/organizations/${orgId}`, cookieA),
      403,
      "org gone after delete",
    );
    const { prisma } = await import("@repo/db/db");
    await prisma.user.deleteMany({ where: { email: { in: [a, b, c] } } });
    check(true, "smoke users removed");
  } finally {
    server.close();
  }

  if (failures > 0) {
    console.error(`\nSMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nSMOKE OK");
  process.exit(0);
};

main().catch((error) => {
  console.error("SMOKE ERROR:", error);
  process.exit(1);
});
