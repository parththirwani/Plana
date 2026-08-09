import { describe, test, expect } from "bun:test";
import { slugify } from "../lib/slug";

describe("slugify", () => {
    test("lowercases and dashes basic names", () => {
        expect(slugify("My Org")).toBe("my-org");
    });

    test("trims surrounding whitespace", () => {
        expect(slugify("  Acme  ")).toBe("acme");
    });

    test("collapses runs of non-alphanumerics into one dash", () => {
        expect(slugify("A B  C")).toBe("a-b-c");
    });

    test("strips special characters", () => {
        expect(slugify("A!@#$ B%^&*()C")).toBe("a-b-c");
    });

    test("removes leading and trailing dashes", () => {
        expect(slugify("--Hello--")).toBe("hello");
    });

    test("caps length at 60 chars", () => {
        expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
    });

    test("falls back to 'org' for names with no slugifiable chars", () => {
        expect(slugify("!!!")).toBe("org");
        expect(slugify("   ")).toBe("org");
    });
});
