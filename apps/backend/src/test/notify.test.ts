import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    notifyBoard,
    setNotifyActorLoader,
    setNotifyPool,
} from "../lib/notify";

mock.module("@repo/db/db", () => ({ prisma: {} }));

process.env.DATABASE_URL = "postgres://fake:5432/db";

const notifications: { channel: string; payload: string }[] = [];

setNotifyPool({
    query: async (_text: string, params: unknown[]) => {
        notifications.push({
            channel: params[0] as string,
            payload: params[1] as string,
        });
    },
});

setNotifyActorLoader(async (id) =>
    id === "alice"
        ? {
              id: "alice",
              name: "Alice",
              avatarUrl: "https://example.com/avatar.png",
          }
        : null
);

describe("notifyBoard", () => {
    beforeEach(() => {
        notifications.length = 0;
    });

    test("publishes a board event including the actor's avatarUrl", async () => {
        await notifyBoard("brd_1", "issue.updated", "alice", {
            issue: { id: "iss_1", title: "Login" },
        });

        expect(notifications).toHaveLength(1);
        expect(notifications[0]!.channel).toBe("board_events");
        const payload = JSON.parse(notifications[0]!.payload);
        expect(payload).toMatchObject({
            boardId: "brd_1",
            event: "issue.updated",
            actor: {
                id: "alice",
                name: "Alice",
                avatarUrl: "https://example.com/avatar.png",
            },
            data: { issue: { id: "iss_1", title: "Login" } },
        });
    });

    test("does not publish when the actor is unknown", async () => {
        await notifyBoard("brd_1", "issue.updated", "nobody");
        expect(notifications).toHaveLength(0);
    });

    test("shrinks oversized payloads to a needsRefetch marker", async () => {
        await notifyBoard("brd_1", "issue.updated", "alice", {
            issue: {
                id: "iss_1",
                title: "Login",
                description: "x".repeat(9000),
            },
        });

        expect(notifications).toHaveLength(1);
        const payload = JSON.parse(notifications[0]!.payload);
        expect(payload.data).toMatchObject({
            needsRefetch: true,
            issue: { id: "iss_1", title: "Login" },
        });
        expect(JSON.stringify(payload).length).toBeLessThan(1000);
    });

    test("caps the marker even when the title itself exceeds the limit", async () => {
        await notifyBoard("brd_1", "issue.updated", "alice", {
            issue: {
                id: "iss_1",
                title: "y".repeat(9000),
            },
        });

        expect(notifications).toHaveLength(1);
        const payload = JSON.parse(notifications[0]!.payload);
        expect(payload.data.needsRefetch).toBe(true);
        expect(payload.data.issue.title.length).toBeLessThanOrEqual(120);
        expect(Buffer.byteLength(notifications[0]!.payload)).toBeLessThan(7999);
    });

    test("never sends a payload that exceeds the NOTIFY limit, even with a huge actor name", async () => {
        const big = "n".repeat(7900);
        setNotifyActorLoader(async () => ({
            id: "alice",
            name: big,
            avatarUrl: null,
        }));
        await notifyBoard("brd_1", "issue.created", "alice", {
            issue: { id: "iss_1", title: "Login" },
        });
        setNotifyActorLoader(async (id) =>
            id === "alice"
                ? {
                      id: "alice",
                      name: "Alice",
                      avatarUrl: "https://example.com/avatar.png",
                  }
                : null
        );

        expect(notifications).toHaveLength(1);
        const payload = JSON.parse(notifications[0]!.payload);
        expect(payload.data.needsRefetch).toBe(true);
        expect(Buffer.byteLength(notifications[0]!.payload)).toBeLessThan(7999);
    });
});
