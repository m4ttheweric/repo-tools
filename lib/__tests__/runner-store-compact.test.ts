/**
 * Round-trip tests for the compact↔expanded LaneEntry transform.
 *
 * The transform is bidirectional for a single persisted lane entry:
 * compactEntries() collapses repetitive runtime entries (same package, different
 * worktrees or command variants) into grouped objects; normalizeLane() expands
 * the singular `entry` object back. Round-tripping one compact group through
 * compact→expand must produce an entry set that's functionally identical to
 * the input (modulo runtime-derived fields: branch, ephemeralPort, id).
 *
 * Historically these transforms had no tests. Edge cases (shared-vs-diverged
 * remedies, multi-command groups, solo entries interleaved with groups) all
 * lived in a 140-line region that was easy to regress silently.
 */

import { describe, test, expect } from "bun:test";
import { compactEntries, normalizeLane } from "../runner-store.ts";
import type { LaneEntry, LaneConfig } from "../runner-store.ts";

/** Fields the transform does NOT preserve (runtime-derived). */
function stripRuntime(e: LaneEntry): Omit<LaneEntry, "ephemeralPort" | "branch" | "id"> {
  const { ephemeralPort: _p, branch: _b, id: _id, ...rest } = e;
  return rest;
}

function makeEntry(over: Partial<LaneEntry>): LaneEntry {
  return {
    id:              "x",
    targetDir:       "/repo/pkg-a",
    packageLabel:    "pkg-a",
    worktree:        "/repo",
    branch:          "main",
    ephemeralPort:   3001,
    commandTemplate: "pnpm run dev",
    ...over,
  };
}

/** Round-trip: compact → wrap in a lane-shaped object → normalizeLane → entries. */
function roundTrip(entries: LaneEntry[]): LaneEntry[] {
  const compact = compactEntries(entries);
  expect(compact).toHaveLength(1);
  const lane: LaneConfig = normalizeLane({
    id:            "1",
    canonicalPort: 3000,
    entry:         compact[0],
    repoName:      "repo",
    mode:          "warm",
  });
  return lane.entries;
}

describe("compact/expand round-trip", () => {
  test("single solo entry survives untouched", () => {
    const input = [makeEntry({ id: "a" })];
    const out = roundTrip(input);
    expect(out.map(stripRuntime)).toEqual(input.map(stripRuntime));
  });

  test("two worktrees of same package group into one compact entry then re-expand", () => {
    const input = [
      makeEntry({ id: "repo-1", worktree: "/work/repo-1", targetDir: "/work/repo-1/pkg-a" }),
      makeEntry({ id: "repo-2", worktree: "/work/repo-2", targetDir: "/work/repo-2/pkg-a" }),
    ];
    const compact = compactEntries(input);
    // Should have collapsed to 1 compact object with 2 worktrees
    expect(compact.length).toBe(1);
    expect((compact[0] as any).worktrees).toHaveLength(2);

    const out = roundTrip(input);
    // Expand produces 2 entries with ids derived from worktree basenames
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.worktree).sort()).toEqual(["/work/repo-1", "/work/repo-2"]);
  });

  test("multi-command compact input: one entry per worktree, menu on each", () => {
    // Entries with distinct commandTemplates in one compactable group now
    // round-trip to one entry per worktree. The full cmd list is preserved as
    // `availableCommands` so the [l][c] picker can switch without re-read.
    const input = [
      makeEntry({ id: "w1",   worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w1-1", worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run build" }),
      makeEntry({ id: "w2",   worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w2-1", worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run build" }),
    ];
    const out = roundTrip(input);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id).sort()).toEqual(["w1", "w2"]);
    // Active cmd is the first one (activeCmdIdx defaults to 0)
    expect(out.every((e) => e.commandTemplate === "pnpm run dev")).toBe(true);
    // Menu is attached to each entry
    for (const e of out) {
      expect(e.availableCommands).toBeDefined();
      expect(e.availableCommands!.map((c) => c.cmd)).toEqual(["pnpm run dev", "pnpm run build"]);
    }
  });

  test("shared remedies across a group are preserved; divergent remedies force per-entry storage", () => {
    const rem = [{ name: "r", pattern: ["err"], cmds: ["true"] }];
    const shared = [
      makeEntry({ id: "s1", worktree: "/s1", targetDir: "/s1", remedies: rem }),
      makeEntry({ id: "s2", worktree: "/s2", targetDir: "/s2", remedies: rem }),
    ];
    const compactShared = compactEntries(shared);
    expect(compactShared.length).toBe(1);
    expect((compactShared[0] as any).remedies).toEqual(rem);

    // Divergent — one has remedies, the other doesn't → cannot share
    const diverged = [
      makeEntry({ id: "s1", worktree: "/s1", targetDir: "/s1", remedies: rem }),
      makeEntry({ id: "s2", worktree: "/s2", targetDir: "/s2" }),
    ];
    const compactDiverged = compactEntries(diverged);
    // Still collapsed on package sig, but remedies shouldn't be on the compact obj
    expect((compactDiverged[0] as any).remedies).toBeUndefined();
  });

  test("ephemeralPort is never written to compact output", () => {
    const input = [
      makeEntry({ id: "a", ephemeralPort: 12345 }),
      makeEntry({ id: "b", ephemeralPort: 12346, worktree: "/other", targetDir: "/other" }),
    ];
    const compact = compactEntries(input);
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("12346");
    expect(serialized).not.toContain("ephemeralPort");
  });

  test("distinct service groups compact to separate objects", () => {
    const api = makeEntry({ id: "api", packageLabel: "api", targetDir: "/repo/api", worktree: "/repo" });
    const web = makeEntry({ id: "web", packageLabel: "web", targetDir: "/repo/web", worktree: "/repo" });

    const compact = compactEntries([api, web]);
    expect(compact).toHaveLength(2);
  });

  test("alias on a command variant is preserved in the menu", () => {
    // User-authored {cmd, alias} object form: alias becomes a UI label.
    // Under the menu model the entries all carry the full alias-bearing menu.
    const input = [
      makeEntry({ id: "w1",   worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w1-1", worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run build", alias: "build" }),
      makeEntry({ id: "w2",   worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w2-1", worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run build", alias: "build" }),
    ];
    const compact = compactEntries(input);
    expect(compact.length).toBe(1);
    const cmdTpl = (compact[0] as any).commandTemplate;
    expect(Array.isArray(cmdTpl)).toBe(true);
    expect(cmdTpl[0]).toBe("pnpm run dev");
    expect(cmdTpl[1]).toEqual({ cmd: "pnpm run build", alias: "build" });

    const out = roundTrip(input);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.availableCommands?.length === 2)).toBe(true);
    expect(out[0]!.availableCommands![1]).toEqual({ cmd: "pnpm run build", alias: "build" });
  });

  test("activeCmdIdx round-trips: picking a non-default cmd persists across load", () => {
    // Start with a menu-backed entry whose active cmd is index 1 (alias "build").
    const menu = [{ cmd: "pnpm run dev" }, { cmd: "pnpm run build", alias: "build" }];
    const input = [
      makeEntry({ id: "w1", worktree: "/w1", targetDir: "/w1",
        commandTemplate: "pnpm run build", alias: "build", availableCommands: menu }),
      makeEntry({ id: "w2", worktree: "/w2", targetDir: "/w2",
        commandTemplate: "pnpm run build", alias: "build", availableCommands: menu }),
    ];
    const compact = compactEntries(input);
    expect(compact.length).toBe(1);
    expect((compact[0] as any).activeCmdIdx).toBe(1);

    const out = roundTrip(input);
    expect(out.every((e) => e.commandTemplate === "pnpm run build")).toBe(true);
    expect(out.every((e) => e.alias === "build")).toBe(true);
  });

  test("single-command group with alias emits {cmd, alias} object form", () => {
    const input = [
      makeEntry({ id: "w1", worktree: "/w1", targetDir: "/w1", commandTemplate: "long cmd", alias: "staging" }),
      makeEntry({ id: "w2", worktree: "/w2", targetDir: "/w2", commandTemplate: "long cmd", alias: "staging" }),
    ];
    const compact = compactEntries(input);
    expect(compact.length).toBe(1);
    expect((compact[0] as any).commandTemplate).toEqual({ cmd: "long cmd", alias: "staging" });

    const out = roundTrip(input);
    expect(out.every((e) => e.alias === "staging")).toBe(true);
  });

  test("collision detection: duplicate basenames get a salt suffix, not a silent alias", () => {
    // Two different worktrees with the SAME basename (e.g. both named `main`).
    const input = [
      makeEntry({ id: "main", worktree: "/repo-a/main", targetDir: "/repo-a/main" }),
      makeEntry({ id: "main", worktree: "/repo-b/main", targetDir: "/repo-b/main" }),
    ];
    const out = roundTrip(input);
    const ids = out.map((e) => e.id);
    // First kept as "main", second gets disambiguated
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("main");
    expect(ids.some((id) => id.startsWith("main~"))).toBe(true);
  });
});
