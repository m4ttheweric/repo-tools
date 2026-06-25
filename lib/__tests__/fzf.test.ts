import { describe, test, expect } from "bun:test";
import { resolveFzf, ensureFzf, FZF_MISSING_MESSAGE } from "../fzf.ts";

describe("resolveFzf", () => {
  test("returns the path when the resolver finds fzf", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf")).toBe("/opt/homebrew/bin/fzf");
  });
  test("returns null when the resolver finds nothing", () => {
    expect(resolveFzf(() => null)).toBeNull();
  });
});

describe("ensureFzf", () => {
  test("returns the resolved path when fzf is present", () => {
    expect(ensureFzf(() => "/opt/homebrew/bin/fzf")).toBe("/opt/homebrew/bin/fzf");
  });

  test("fails with an actionable message when fzf is missing", () => {
    let captured = "";
    expect(() =>
      ensureFzf(
        () => null,
        (msg) => {
          captured = msg;
          throw new Error("would-exit");
        },
      ),
    ).toThrow("would-exit");
    expect(captured).toContain("fzf not found");
    expect(captured).toContain("brew install fzf");
  });
});

describe("FZF_MISSING_MESSAGE", () => {
  test("names the missing binary and the install command", () => {
    expect(FZF_MISSING_MESSAGE).toContain("fzf not found");
    expect(FZF_MISSING_MESSAGE).toContain("brew install fzf");
  });
});
