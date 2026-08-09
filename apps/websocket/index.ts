import pg from "pg";
import { getJwtSecret } from "./src/auth";
import { decideUpgrade } from "./src/request";
import { isBoardMember } from "./src/access";
import { addSocket, removeSocket, relayToBoard } from "./src/hub";

type ServerData = {
    userId: string;
    boardIds: Set<string>;
};

const server = Bun.serve<ServerData>({
    port: Number(process.env.WS_PORT ?? 9000),
    async fetch(req, server) {
        const decision = decideUpgrade(req);
        if (!decision.ok) {
            return new Response(decision.reason, { status: decision.status });
        }

        if (!(await isBoardMember(decision.userId, decision.boardId))) {
            return new Response("Not a member of this board", {
                status: 403,
            });
        }

        const success = server.upgrade(req, {
            data: {
                userId: decision.userId,
                boardIds: new Set([decision.boardId]),
            },
        });
        return success
            ? undefined
            : new Response("Upgrade failed", { status: 500 });
    },
    websocket: {
        open(ws) {
            addSocket(ws);
        },
        message() {
            // subscription is fixed to ?boardId= at connect; messages are ignored
        },
        close(ws) {
            removeSocket(ws);
        },
    },
});

const startListener = async () => {
    const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
    });
    client.on("error", (error) => {
        console.error("Realtime pg client error:", error);
    });
    await client.connect();
    await client.query("LISTEN board_events");

    console.log(
        `Realtime server on ws://localhost:${server.port}/ws (LISTEN board_events)`
    );

    client.on("notification", (notification) => {
        if (notification.channel !== "board_events" || !notification.payload) {
            return;
        }
        try {
            const parsed = JSON.parse(notification.payload) as {
                boardId?: string;
            };
            if (parsed.boardId) {
                relayToBoard(parsed.boardId, notification.payload);
            }
        } catch {
            // ignore malformed payloads
        }
    });
};

getJwtSecret();
startListener().catch((error) => {
    console.error("Realtime listener failed to start:", error);
});
