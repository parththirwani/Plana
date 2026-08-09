import { describe, test, expect } from "bun:test";
import jwt from "jsonwebtoken";
import { getJwtSecret, tokenFromRequest, verifySocketToken } from "./auth";

process.env.JWT_SECRET = "test-secret";

const sign = (userId: string) =>
    jwt.sign({ userId }, getJwtSecret(), { expiresIn: "1h" });

describe("verifySocketToken", () => {
    test("accepts a valid token", () => {
        expect(verifySocketToken(sign("usr_1"))).toEqual({
            userId: "usr_1",
        });
    });

    test("rejects a garbage token", () => {
        expect(verifySocketToken("nope")).toBeNull();
    });

    test("rejects a token signed with another secret", () => {
        const other = jwt.sign({ userId: "usr_1" }, "wrong-secret");
        expect(verifySocketToken(other)).toBeNull();
    });
});

describe("tokenFromRequest", () => {
    test("reads the token query parameter", () => {
        const req = new Request("http://localhost/ws?token=abc");
        expect(tokenFromRequest(req)).toBe("abc");
    });

    test("reads the token cookie", () => {
        const req = new Request("http://localhost/ws", {
            headers: { Cookie: "token=cookie-token; other=1" },
        });
        expect(tokenFromRequest(req)).toBe("cookie-token");
    });

    test("returns null without a token", () => {
        expect(tokenFromRequest(new Request("http://localhost/ws"))).toBeNull();
    });
});
