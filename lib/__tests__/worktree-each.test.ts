import { describe, expect, test } from "bun:test";
import {
  parseEachArgs,
  isParked,
  filterTargets,
  relWorktreeName,
  formatSummary,
  hasFailures,
} from "../worktree-each.ts";
import type { WorktreeBinding } from "../daemon/parking-lot.ts";

const wt = (path: string, branch: string | null, index: number): WorktreeBinding =>
  ({ path, branch, index });

describe("parseEachArgs", () => {
  test("bare args → pick mode, command joined", () => {
    expect(parseEachArgs(["pnpm", "install"])).toEqual({ mode: "pick", command: "pnpm install" });
  });
  test("--all flag → all mode, flag stripped from command", () => {
    expect(parseEachArgs(["--all", "pnpm", "install"])).toEqual({ mode: "all", command: "pnpm install" });
  });
  test("--parked flag → parked mode", () => {
    expect(parseEachArgs(["--parked", "git", "status"])).toEqual({ mode: "parked", command: "git status" });
  });
  test("flag after command is still recognized", () => {
    expect(parseEachArgs(["pnpm", "install", "--all"]).mode).toBe("all");
  });
  test("both --all and --parked → error", () => {
    expect(parseEachArgs(["--all", "--parked", "ls"]).error).toMatch(/mutually exclusive/i);
  });
  test("no command → error", () => {
    expect(parseEachArgs(["--all"]).error).toMatch(/no command/i);
  });
});

describe("isParked", () => {
  test("branch matches its slot → parked", () => {
    expect(isParked(wt("/a", "parking-lot/3", 3))).toBe(true);
  });
  test("branch is a different parking slot → not parked", () => {
    expect(isParked(wt("/a", "parking-lot/9", 3))).toBe(false);
  });
  test("feature branch → not parked", () => {
    expect(isParked(wt("/a", "feature/x", 3))).toBe(false);
  });
  test("detached (null branch) → not parked", () => {
    expect(isParked(wt("/a", null, 3))).toBe(false);
  });
  test("no index (0) → not parked even if branch looks parked", () => {
    expect(isParked(wt("/a", "parking-lot/0", 0))).toBe(false);
  });
});

describe("filterTargets", () => {
  const bindings = [
    wt("/repo/wt0", "feature/a", 1),
    wt("/repo/wt1", "parking-lot/2", 2),
    wt("/repo/wt2", "parking-lot/3", 3),
  ];
  test("all → every binding", () => {
    expect(filterTargets(bindings, "all")).toHaveLength(3);
  });
  test("parked → only parked", () => {
    expect(filterTargets(bindings, "parked").map(b => b.path)).toEqual(["/repo/wt1", "/repo/wt2"]);
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
