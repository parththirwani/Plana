import { Pool } from "pg";
import { prisma } from "@repo/db/db";

export type BoardEvent =
    | "board.created"
    | "board.updated"
    | "board.deleted"
    | "section.created"
    | "section.updated"
    | "section.deleted"
    | "issue.created"
    | "issue.updated"
    | "issue.deleted"
    | "issue.moved"
    | "issue.assignees"
    | "comment.created"
    | "comment.updated"
    | "comment.deleted";

export type NotifyActor = {
    id: string;
    name: string | null;
    avatarUrl: string | null;
};

export type NotifyPool = {
    query: (text: string, values: unknown[]) => Promise<unknown>;
};

let pool: NotifyPool | null = null;
let actorLoader: ((id: string) => Promise<NotifyActor | null>) | null = null;

export const setNotifyPool = (p: NotifyPool | null): void => {
    pool = p;
};

export const setNotifyActorLoader = (
    loader: ((id: string) => Promise<NotifyActor | null>) | null
): void => {
    actorLoader = loader;
};

const getPool = (): NotifyPool => {
    if (!pool) {
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
    return pool;
};

const loadActor = (id: string): Promise<NotifyActor | null> =>
    actorLoader
        ? actorLoader(id)
        : prisma.user.findUnique({
              where: { id },
              select: { id: true, name: true, avatarUrl: true },
          });

export const notifyBoard = async (
    boardId: string,
    event: BoardEvent,
    actorId: string,
    data?: unknown
) => {
    if (!process.env.DATABASE_URL) return;

    try {
        const actor = await loadActor(actorId);
        if (!actor) return;

        await getPool().query("SELECT pg_notify($1, $2)", [
            "board_events",
            JSON.stringify({
                boardId,
                event,
                actor,
                data,
            }),
        ]);
    } catch (error) {
        console.error("Realtime notify failed:", error);
    }
};
