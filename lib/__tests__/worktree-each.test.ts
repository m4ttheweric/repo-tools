import { describe, expect, test } from "bun:test";
import {
  parseEachArgs,
  isOnDeck,
  filterTargets,
  relWorktreeName,
  formatSummary,
  hasFailures,
  type WorktreeBinding,
} from "../worktree-each.ts";

const wt = (path: string, branch: string | null, state?: string): WorktreeBinding =>
  ({ path, branch, ...(state ? { state } : {}) });

describe("parseEachArgs", () => {
  test("bare args → pick mode, command joined", () => {
    expect(parseEachArgs(["pnpm", "install"])).toEqual({ mode: "pick", command: "pnpm install" });
  });
  test("--all flag → all mode, flag stripped from command", () => {
    expect(parseEachArgs(["--all", "pnpm", "install"])).toEqual({ mode: "all", command: "pnpm install" });
  });
  test("--on-deck flag → on-deck mode", () => {
    expect(parseEachArgs(["--on-deck", "git", "status"])).toEqual({ mode: "on-deck", command: "git status" });
  });
  test("--parked is a hidden alias for --on-deck", () => {
    expect(parseEachArgs(["--parked", "git", "status"])).toEqual({ mode: "on-deck", command: "git status" });
  });
  test("flag after command is still recognized", () => {
    expect(parseEachArgs(["pnpm", "install", "--all"]).mode).toBe("all");
  });
  test("both --all and --on-deck → error", () => {
    expect(parseEachArgs(["--all", "--on-deck", "ls"]).error).toMatch(/mutually exclusive/i);
  });
  test("both --all and --parked → error", () => {
    expect(parseEachArgs(["--all", "--parked", "ls"]).error).toMatch(/mutually exclusive/i);
  });
  test("no command → error", () => {
    expect(parseEachArgs(["--all"]).error).toMatch(/no command/i);
  });
});

describe("isOnDeck", () => {
  test("state on-deck → true", () => {
    expect(isOnDeck(wt("/a", "on-deck/3", "on-deck"))).toBe(true);
  });
  test("state claimed → false", () => {
    expect(isOnDeck(wt("/a", "feature/x", "claimed"))).toBe(false);
  });
  test("no state (git-only fallback) → false", () => {
    expect(isOnDeck(wt("/a", "feature/x"))).toBe(false);
  });
  test("detached (null branch), on-deck state → still true", () => {
    expect(isOnDeck(wt("/a", null, "on-deck"))).toBe(true);
  });
});

describe("filterTargets", () => {
  const bindings = [
    wt("/repo/wt0", "feature/a", "claimed"),
    wt("/repo/wt1", "on-deck/wt1", "on-deck"),
    wt("/repo/wt2", "on-deck/wt2", "on-deck"),
  ];
  test("all → every binding", () => {
    expect(filterTargets(bindings, "all")).toHaveLength(3);
  });
  test("on-deck → only on-deck", () => {
    expect(filterTargets(bindings, "on-deck").map(b => b.path)).toEqual(["/repo/wt1", "/repo/wt2"]);
  });
  test("pick → returned unchanged (picker selects later)", () => {
    expect(filterTargets(bindings, "pick")).toHaveLength(3);
  });
});

describe("relWorktreeName", () => {
  test("strips the parent dir prefix", () => {
    expect(relWorktreeName("/Users/m/Github/repo-tools", "/Users/m/Github/repo-tools-wt1")).toBe("repo-tools-wt1");
  });
  test("falls back to full path when not under parent", () => {
    expect(relWorktreeName("/Users/m/Github/repo-tools", "/elsewhere/x")).toBe("/elsewhere/x");
  });
});

describe("formatSummary / hasFailures", () => {
  test("all ok", () => {
    const r = [{ name: "wt0", code: 0 }, { name: "wt1", code: 0 }];
    expect(hasFailures(r)).toBe(false);
    expect(formatSummary(r)).toMatch(/2 ok/);
  });
  test("some failed lists names + codes", () => {
    const r = [{ name: "wt0", code: 0 }, { name: "wt1", code: 1 }];
    expect(hasFailures(r)).toBe(true);
    expect(formatSummary(r)).toMatch(/1 ok/);
    expect(formatSummary(r)).toMatch(/1 failed/);
    expect(formatSummary(r)).toMatch(/wt1 \(exit 1\)/);
  });
});
