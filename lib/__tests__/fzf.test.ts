import { describe, test, expect } from "bun:test";
import { resolveFzf, ensureFzf, FZF_MISSING_MESSAGE } from "../fzf.ts";

describe("resolveFzf", () => {
  const none = () => null;
  test("a source checkout's own fetch-deps build wins over the app bundle (dev mode must never pin a stale helper)", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => "/Applications/mattstack-dev.app/Contents/Helpers/fzf", () => "/repo/rt-tray/deps/arm64/fzf", {}))
      .toBe("/repo/rt-tray/deps/arm64/fzf");
  });
  test("prefers the fzf bundled inside mattstack.app over PATH", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", () => "/Applications/mattstack.app/Contents/Helpers/fzf", none, {}))
      .toBe("/Applications/mattstack.app/Contents/Helpers/fzf");
  });
  test("falls back to PATH when nothing is built or bundled", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", none, none, {})).toBe("/opt/homebrew/bin/fzf");
  });
  test("RT_FZF_BIN wins when it exists and is ignored when it does not", () => {
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", none, none, { RT_FZF_BIN: process.execPath })).toBe(process.execPath);
    expect(resolveFzf(() => "/opt/homebrew/bin/fzf", none, none, { RT_FZF_BIN: "/gone/fzf" })).toBe("/opt/homebrew/bin/fzf");
  });
  test("null when nothing exists", () => {
    expect(resolveFzf(none, none, none, {})).toBeNull();
  });
});

describe("ensureFzf", () => {
  test("returns the resolved path when present", () => {
    expect(ensureFzf(() => null, (msg) => { throw new Error(msg); }, () => "/x/fzf", () => null)).toBe("/x/fzf");
  });
  test("fails with an actionable message naming the bundle when missing", () => {
    let captured = "";
    expect(() => ensureFzf(() => null, (msg) => { captured = msg; throw new Error("would-exit"); }, () => null, () => null)).toThrow("would-exit");
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
