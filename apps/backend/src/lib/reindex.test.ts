import { describe, test, expect } from "bun:test";
import { reindex, moveTo } from "./reindex";

describe("reindex", () => {
    test("closes gaps and normalizes order", () => {
        expect(
            reindex([
                { id: "a", order: 5 },
                { id: "b", order: 0 },
                { id: "c", order: 3 },
            ])
        ).toEqual([
            { id: "b", order: 0 },
            { id: "c", order: 1 },
            { id: "a", order: 2 },
        ]);
    });

    test("handles empty and single-item lists", () => {
        expect(reindex([])).toEqual([]);
        expect(reindex([{ id: "a", order: 9 }])).toEqual([
            { id: "a", order: 0 },
        ]);
    });
});

describe("moveTo", () => {
    const items = () => [
        { id: "a", order: 0 },
        { id: "b", order: 1 },
        { id: "c", order: 2 },
    ];

    test("moves an item to the target position", () => {
        expect(moveTo(items(), "c", 0)).toEqual([
            { id: "c", order: 0 },
            { id: "a", order: 1 },
            { id: "b", order: 2 },
        ]);
    });

    test("moves an item to the end", () => {
        expect(moveTo(items(), "a", 99)).toEqual([
            { id: "b", order: 0 },
            { id: "c", order: 1 },
            { id: "a", order: 2 },
        ]);
    });

    test("clamps a negative target", () => {
        expect(moveTo(items(), "b", -5)).toEqual([
            { id: "b", order: 0 },
            { id: "a", order: 1 },
            { id: "c", order: 2 },
        ]);
    });

    test("returns items unchanged for an unknown id", () => {
        expect(moveTo(items(), "nope", 1)).toEqual(items());
    });
});
