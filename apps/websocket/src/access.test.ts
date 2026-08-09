import { describe, test, expect, mock } from "bun:test";

mock.module("@repo/db/db", () => ({
    prisma: {
        board: {
            findUnique: async ({ where }: any) =>
                where.id === "brd_1"
                    ? { id: "brd_1", organizationId: "org_1" }
                    : null,
        },
        membership: {
            findFirst: async ({ where }: any) =>
                where.organizationId === "org_1" && where.userId === "usr_1"
                    ? { id: "mem_1" }
                    : null,
        },
    },
}));

const { isBoardMember } = await import("./access");

describe("isBoardMember", () => {
    test("allows a member of the board's organization", async () => {
        expect(await isBoardMember("usr_1", "brd_1")).toBe(true);
    });

    test("denies a non-member", async () => {
        expect(await isBoardMember("usr_2", "brd_1")).toBe(false);
    });

    test("denies an unknown board", async () => {
        expect(await isBoardMember("usr_1", "brd_missing")).toBe(false);
    });
});
