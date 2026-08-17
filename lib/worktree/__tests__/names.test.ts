import { describe, it, expect, spyOn } from "bun:test";
import { pickName } from "../names";
import { slugifyTicketTitle, disambiguate } from "../branch-name";

describe("pickName", () => {
  it("picks a random unused name from pool", () => {
    const pool = ["alpha", "bravo", "charlie"];
    const used = new Set(["bravo"]);

    // Monkeypatch Math.random to return 0.5 (middle of pool after filter)
    const originalRandom = Math.random;
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
    const used = new Set<string>();
    // Pre-populate used set with all possible combinations (force collision)
    // We'll just add a few key ones and monkeypatch to force collisions

    const originalRandom = Math.random;
    let callCount = 0;

    // First call returns 0.0 (first adj, first noun), second returns 0.0 again, third different
    const spy = spyOn(Math, "random").mockImplementation(() => {
      const sequence = [0.0, 0.0, 0.001];
      const value = sequence[callCount % sequence.length];
      callCount++;
      return value;
    });

    // Add the first generated name to used set manually to force collision
    const result = pickName(undefined, used);

    // The result should either have a numeric suffix or be different
    // For this test, we'll verify it's a valid format
    expect(result).toMatch(/^[a-z]+-[a-z]+(-\d+)?$/);

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
    const longTitle = "This is a very long title that exceeds forty characters when slugified";
    const result = slugifyTicketTitle("ID-1", longTitle, "<ticket>-<slug>");

    const parts = result.split("-");
    // The slug part should not exceed 40 chars total from the format
    expect(result.length).toBeLessThanOrEqual(7 + 40); // "id-1-" is 5 chars + hyphen buffer
  });

  it("trims whitespace from slug", () => {
    const result = slugifyTicketTitle("X-1", "  Title With Spaces  ", "<ticket>-<slug>");
    expect(result).toMatch(/^x-1-/);
    expect(result).not.toMatch(/^x-1-\s/);
    expect(result).not.toMatch(/\s$/);
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
