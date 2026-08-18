import { describe, it, expect, spyOn } from "bun:test";
import { pickName } from "../names.ts";
import { slugifyTicketTitle, disambiguate } from "../branch-name.ts";

describe("pickName", () => {
  it("picks a random unused name from pool", () => {
    const pool = ["alpha", "bravo", "charlie"];
    const used = new Set(["bravo"]);

    // Monkeypatch Math.random to return 0.5 (middle of pool after filter)
    const spy = spyOn(Math, "random").mockReturnValue(0.5);

    const result = pickName(pool, used);

    // With random 0.5 and pool ["alpha", "charlie"], should pick "charlie" (index 1)
    expect(result).toBe("charlie");

    spy.mockRestore();
  });

  it("falls back to neutral generator when pool is exhausted", () => {
    const pool = ["alpha", "bravo"];
    const used = new Set(["alpha", "bravo"]);

    const result = pickName(pool, used);

    // Should be in format "<adj>-<noun>"
    expect(result).toMatch(/^[a-z]+-[a-z]+$/);
    expect(result).not.toEqual("alpha");
    expect(result).not.toEqual("bravo");
  });

  it("falls back to neutral generator when pool is undefined", () => {
    const used = new Set<string>();

    const result = pickName(undefined, used);

    // Should be in format "<adj>-<noun>"
    expect(result).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("retries generator with numeric suffix on collision", () => {
    let callCount = 0;

    // Mock Math.random to return predictable sequence
    // First two calls return 0.0 (first adj, first noun)
    const spy = spyOn(Math, "random").mockImplementation((): number => {
      const sequence: number[] = [0.0, 0.0];
      const value = sequence[callCount % sequence.length]!;
      callCount++;
      return value;
    });

    // Based on the mock, first generation would be "amber-anvil" (indices 0, 0)
    const used = new Set(["amber-anvil"]);

    const result = pickName(undefined, used);

    // Should have tried "amber-anvil", found collision, and returned "amber-anvil-2"
    expect(result).toBe("amber-anvil-2");

    spy.mockRestore();
  });
});

describe("slugifyTicketTitle", () => {
  it("converts ticket ID and title to slug format", () => {
    const result = slugifyTicketTitle("RT-34", "Ephemeral Worktrees: rule!", "<ticket>-<slug>");
    expect(result).toBe("rt-34-ephemeral-worktrees-rule");
  });

  it("handles non-alphanumeric characters", () => {
    const result = slugifyTicketTitle("ABC-123", "Hello & World!!!!", "<ticket>-<slug>");
    expect(result).toBe("abc-123-hello-world");
  });

  it("collapses multiple dashes", () => {
    const result = slugifyTicketTitle("TEST-1", "Multiple  --  Dashes", "<ticket>-<slug>");
    expect(result).toBe("test-1-multiple-dashes");
  });

  it("caps slug at 40 characters", () => {
    // Title that produces a slug longer than 40 chars
    // "aaaaa bbbbb ccccc ddddd eeeee fffff ggggg" → slug "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-ggggg" (41 chars)
    // Capped at 40: "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-gggg"
    const result = slugifyTicketTitle("ID-1", "aaaaa bbbbb ccccc ddddd eeeee fffff ggggg", "<ticket>-<slug>");
    // Exact expected: "id-1-" (5 chars) + slug capped at 40 chars
    expect(result).toBe("id-1-aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-gggg");
  });

  it("trims whitespace from slug", () => {
    const result = slugifyTicketTitle("X-1", "  Title With Spaces  ", "<ticket>-<slug>");
    expect(result).toMatch(/^x-1-/);
    expect(result).not.toMatch(/^x-1-\s/);
    expect(result).not.toMatch(/\s$/);
  });

  it("sanitizes a ticket ID with spaces the same way as the slug", () => {
    const result = slugifyTicketTitle("RT 34", "Worktree lifecycle", "<ticket>-<slug>");
    expect(result).toBe("rt-34-worktree-lifecycle");
  });

  it("sanitizes a ticket ID with non-alphanumeric punctuation", () => {
    const result = slugifyTicketTitle("RT^9", "Fix it", "<ticket>-<slug>");
    expect(result).toBe("rt-9-fix-it");
  });

  it("substitutes every occurrence of a repeated placeholder", () => {
    const result = slugifyTicketTitle("RT-34", "Worktrees", "<ticket>/<ticket>-<slug>");
    expect(result).toBe("rt-34/rt-34-worktrees");
  });

  it("a title containing $& does not corrupt the substitution", () => {
    const result = slugifyTicketTitle("RT-34", "Fix $& in prod", "<ticket>-<slug>");
    expect(result).toBe("rt-34-fix-in-prod");
  });
});

describe("disambiguate", () => {
  it("returns base when exists returns false", () => {
    const result = disambiguate("x", () => false);
    expect(result).toBe("x");
  });

  it("returns base-2 when base exists", () => {
    const result = disambiguate("x", (c) => c === "x");
    expect(result).toBe("x-2");
  });

  it("returns base-3 when base and base-2 exist", () => {
    const result = disambiguate("x", (c) => c === "x" || c === "x-2");
    expect(result).toBe("x-3");
  });

  it("finds first non-existing candidate", () => {
    const result = disambiguate("myname", (c) => c === "myname" || c === "myname-2");
    expect(result).toBe("myname-3");
  });
});
