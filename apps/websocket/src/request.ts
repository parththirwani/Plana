import { tokenFromRequest, verifySocketToken } from "./auth";

export type UpgradeDecision =
    | { ok: true; userId: string; boardId: string }
    | { ok: false; status: number; reason: string };

export const decideUpgrade = (req: Request): UpgradeDecision => {
    const url = new URL(req.url);

    if (url.pathname !== "/ws") {
        return { ok: false, status: 404, reason: "Not Found" };
    }

    const token = tokenFromRequest(req);
    const auth = token ? verifySocketToken(token) : null;
    if (!auth) {
        return { ok: false, status: 401, reason: "Unauthorized" };
    }

    const boardId = url.searchParams.get("boardId");
    if (!boardId) {
        return {
            ok: false,
            status: 400,
            reason: "boardId query parameter is required",
        };
    }

    return { ok: true, userId: auth.userId, boardId };
};
