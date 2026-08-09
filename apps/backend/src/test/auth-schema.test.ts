import { describe, test, expect } from "bun:test";
import { UserSchema, normalizeEmail } from "../schema/auth";

describe("UserSchema", () => {
    test("accepts a valid email and password", () => {
        const result = UserSchema.safeParse({
            email: "user@example.com",
            password: "password123",
        });
        expect(result.success).toBe(true);
    });

    test("rejects an invalid email", () => {
        const result = UserSchema.safeParse({
            email: "not-an-email",
            password: "password123",
        });
        expect(result.success).toBe(false);
    });

    test("rejects an empty email", () => {
        const result = UserSchema.safeParse({ email: "", password: "password" });
        expect(result.success).toBe(false);
    });

    test("rejects a password shorter than 5 chars", () => {
        const result = UserSchema.safeParse({
            email: "user@example.com",
            password: "1234",
        });
        expect(result.success).toBe(false);
    });

    test("accepts a password of exactly 5 chars", () => {
        const result = UserSchema.safeParse({
            email: "user@example.com",
            password: "12345",
        });
        expect(result.success).toBe(true);
    });
});

describe("normalizeEmail", () => {
    test("trims whitespace and lowercases", () => {
        expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
    });
});
