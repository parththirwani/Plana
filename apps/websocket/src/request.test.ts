import { describe, test, expect } from "bun:test";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "./auth";
import { decideUpgrade } from "./request";

process.env.JWT_SECRET = "test-secret";

const token = jwt.sign({ userId: "usr_1" }, getJwtSecret());

describe("decideUpgrade", () => {
    test("rejects a non-ws path", () => {
        const decision = decideUpgrade(new Request("http://localhost/other"));
        expect(decision).toEqual({
            ok: false,
            status: 404,
            reason: "Not Found",
        });
    });

    test("rejects a missing token", () => {
        const decision = decideUpgrade(
            new Request("http://localhost/ws?boardId=brd_1")
        );
        expect(decision).toEqual({
            ok: false,
            status: 401,
            reason: "Unauthorized",
        });
    });

    test("rejects a bad token", () => {
        const req = new Request(
            "http://localhost/ws?token=garbage&boardId=brd_1"
        );
        expect(decideUpgrade(req).ok).toBe(false);
    });

    test("rejects a missing boardId", () => {
        const req = new Request(`http://localhost/ws?token=${token}`);
        expect(decideUpgrade(req)).toEqual({
            ok: false,
            status: 400,
            reason: "boardId query parameter is required",
        });
    });

    test("accepts a valid token and returns the boardId", () => {
        const req = new Request(
            `http://localhost/ws?token=${token}&boardId=brd_1`
        );
        expect(decideUpgrade(req)).toEqual({
            ok: true,
            userId: "usr_1",
            boardId: "brd_1",
        });
    });

    test("accepts a valid token from the cookie", () => {
        const req = new Request("http://localhost/ws?boardId=brd_1", {
            headers: { Cookie: `token=${token}` },
        });
        expect(decideUpgrade(req).ok).toBe(true);
    });
});
