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

const shrink = (data: unknown): unknown => {
    const issue = (data as any)?.issue as { id?: string; title?: string } | undefined;
    if (issue?.id) {
        // title can itself exceed the 8 KB cap; truncate so the marker is
        // bounded regardless of what the user typed.
        return {
            needsRefetch: true,
            issue: { id: issue.id, title: (issue.title ?? "").slice(0, 120) },
        };
    }
    const comment = (data as any)?.comment as { issueId?: string } | undefined;
    if (comment?.issueId) return { needsRefetch: true, comment: { issueId: comment.issueId } };
    return { needsRefetch: true };
};

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

        let payload = JSON.stringify({ boardId, event, actor, data });
        if (Buffer.byteLength(payload) >= 7000) {
            payload = JSON.stringify({ boardId, event, actor, data: shrink(data) });
        }
        // Belt-and-braces: actor name/avatarUrl are unbounded too and shrink
        // does not touch them. Rather than let the whole realtime channel die,
        // drop every non-essential field so NOTIFY can never be rejected.
        if (Buffer.byteLength(payload) >= 7999) {
            payload = JSON.stringify({
                boardId,
                event,
                actor: { id: actor.id },
                data: { needsRefetch: true },
            });
        }

        await getPool().query("SELECT pg_notify($1, $2)", [
            "board_events",
            payload,
        ]);
    } catch (error) {
        console.error("Realtime notify failed:", error);
    }
};
