/**
 * Round-trip tests for the compact↔expanded LaneEntry transform.
 *
 * The transform is bidirectional: compactEntries() collapses repetitive entries
 * (same package, different worktrees or command variants) into grouped objects;
 * normalizeLane() expands them back. Round-tripping a runner config through
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
function stripRuntime(e: LaneEntry): Omit<LaneEntry, "ephemeralPort" | "branch"> {
  const { ephemeralPort: _p, branch: _b, ...rest } = e;
  return rest;
}

function makeEntry(over: Partial<LaneEntry>): LaneEntry {
  return {
    id:              "x",
    targetDir:       "/repo/pkg-a",
    pm:              "pnpm",
    script:          "dev",
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
  const lane: LaneConfig = normalizeLane({
    id:            "1",
    canonicalPort: 3000,
    entries:       compact,
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

  test("multi-command group: N worktrees × M commands produces N*M entries", () => {
    const input = [
      makeEntry({ id: "w1",   worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w1-1", worktree: "/w1", targetDir: "/w1", commandTemplate: "pnpm run build" }),
      makeEntry({ id: "w2",   worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run dev" }),
      makeEntry({ id: "w2-1", worktree: "/w2", targetDir: "/w2", commandTemplate: "pnpm run build" }),
    ];
    const out = roundTrip(input);
    expect(out).toHaveLength(4);
    // Expand iterates cmds outer, worktrees inner — all cmd[0] first, then cmd[1].
    // Ids: cmdIdx=0 uses bare basename; cmdIdx=1 appends "-1".
    expect(out.map((e) => e.id)).toEqual(["w1", "w2", "w1-1", "w2-1"]);
    expect(out.filter((e) => e.commandTemplate === "pnpm run dev")).toHaveLength(2);
    expect(out.filter((e) => e.commandTemplate === "pnpm run build")).toHaveLength(2);
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

  test("solo and groupable entries preserve relative order after compact→expand", () => {
    // Interleaved: solo, group, solo — previously broken by the pos-mixing bug.
    const soloA = makeEntry({ id: "soloA", packageLabel: "solo-a", script: "a", targetDir: "/soloA", worktree: "/soloA" });
    const g1    = makeEntry({ id: "g1", worktree: "/g1", targetDir: "/g1" });
    const g2    = makeEntry({ id: "g2", worktree: "/g2", targetDir: "/g2" });
    const soloB = makeEntry({ id: "soloB", packageLabel: "solo-b", script: "b", targetDir: "/soloB", worktree: "/soloB" });

    const input = [soloA, g1, g2, soloB];
    const out = roundTrip(input);
    // Expanded order: soloA (pos 0), g1+g2 as expanded pair (pos 1), soloB (pos 3)
    const ids = out.map((e) => e.id);
    expect(ids.indexOf("soloA")).toBeLessThan(ids.indexOf("g1"));
    expect(ids.indexOf("g2")).toBeLessThan(ids.indexOf("soloB"));
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
