import { describe, test, expect } from "bun:test";
import { resolveFzf, ensureFzf, FZF_MISSING_MESSAGE } from "../fzf.ts";

describe("resolveFzf", () => {
  test("prefers the fzf bundled inside mattstack.app", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => "/Applications/mattstack.app/Contents/Helpers/fzf"))
      .toBe("/Applications/mattstack.app/Contents/Helpers/fzf");
  });
  test("falls back to PATH when nothing is bundled (source runs, dev mode)", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => null)).toBe("/opt/homebrew/bin/fzf");
  });
  test("null when neither exists", () => {
    expect(resolveFzf(() => null, () => null)).toBeNull();
  });
});

describe("ensureFzf", () => {
  test("returns the resolved path when present", () => {
    expect(ensureFzf(() => null, (msg) => { throw new Error(msg); }, () => "/x/fzf")).toBe("/x/fzf");
  });
  test("fails with an actionable message naming the bundle when missing", () => {
    let captured = "";
    expect(() => ensureFzf(() => null, (msg) => { captured = msg; throw new Error("would-exit"); }, () => null)).toThrow("would-exit");
    expect(captured).toContain("fzf not found");
    expect(captured).toContain("mattstack.app");
  });
});

describe("FZF_MISSING_MESSAGE", () => {
  test("says where rt looks and what to do", () => {
    expect(FZF_MISSING_MESSAGE).toContain("Contents/Helpers/fzf");
    expect(FZF_MISSING_MESSAGE).toContain("brew install fzf");
  });
});
