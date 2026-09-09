import { test, expect } from "bun:test";
import { selectEnrichmentBranches, COLD_RECHECK_MS, COLD_PER_CYCLE } from "../cache-refresh.ts";
import type { CacheEntry } from "../../state/index.ts";

const NOW = 10_000_000;

function entry(state: "opened" | "merged" | "closed" | "draft" | null, fetchedAt = NOW - 60_000): CacheEntry {
  return {
    ticket: null,
    linearId: "",
    mr: state ? ({ state } as any) : null,
    fetchedAt,
  };
}

function cand(branch: string, worktree = false) {
  return { path: "/repo", branch, worktree };
}

function lookupFrom(map: Record<string, CacheEntry>) {
  return (branch: string) => map[branch];
}

test("worktree branches are always selected, even when cached merged and fresh", () => {
  const sel = selectEnrichmentBranches(
    [cand("cv-1", true), cand("cv-2", true)],
    lookupFrom({ "cv-1": entry("merged"), "cv-2": entry(null) }),
    NOW,
  );
  expect(sel.map((s) => s.branch).sort()).toEqual(["cv-1", "cv-2"]);
});

test("a branch the cache has never seen is selected", () => {
  const sel = selectEnrichmentBranches([cand("cv-new")], lookupFrom({}), NOW);
  expect(sel.map((s) => s.branch)).toEqual(["cv-new"]);
});

test("branches with a cached open or draft MR stay hot", () => {
  const sel = selectEnrichmentBranches(
    [cand("cv-open"), cand("cv-draft")],
    lookupFrom({ "cv-open": entry("opened"), "cv-draft": entry("draft") }),
    NOW,
  );
  expect(sel.map((s) => s.branch).sort()).toEqual(["cv-draft", "cv-open"]);
});

test("freshly-checked merged, closed, and no-MR branches are not selected", () => {
  // The 2026-09-09 shape: ~290 of 302 candidate branches were already known
  // merged/closed/MR-less, and re-asking GitLab about all of them every cycle
  // held the query at ~29s against the ~30s server budget.
  const sel = selectEnrichmentBranches(
    [cand("cv-merged"), cand("cv-closed"), cand("cv-none"), cand("cv-open")],
    lookupFrom({
      "cv-merged": entry("merged"),
      "cv-closed": entry("closed"),
      "cv-none": entry(null),
      "cv-open": entry("opened"),
    }),
    NOW,
  );
  expect(sel.map((s) => s.branch)).toEqual(["cv-open"]);
});

test("a cold branch overdue for its recheck is selected again", () => {
  const overdue = NOW - COLD_RECHECK_MS - 1;
  const sel = selectEnrichmentBranches(
    [cand("cv-merged")],
    lookupFrom({ "cv-merged": entry("merged", overdue) }),
    NOW,
  );
  expect(sel.map((s) => s.branch)).toEqual(["cv-merged"]);
});

test("overdue cold branches are capped per cycle, stalest first; hot is never capped", () => {
  const candidates = [cand("hot-wt", true)];
  const map: Record<string, CacheEntry> = {};
  for (let i = 0; i < COLD_PER_CYCLE + 10; i++) {
    const b = `cold-${String(i).padStart(2, "0")}`;
    candidates.push(cand(b));
    // cold-00 is the stalest, cold-34 the freshest (all overdue)
    map[b] = entry("merged", NOW - COLD_RECHECK_MS - 1_000_000 + i * 1_000);
  }
  const sel = selectEnrichmentBranches(candidates, lookupFrom(map), NOW);
  const cold = sel.filter((s) => s.branch.startsWith("cold-"));
  expect(sel.some((s) => s.branch === "hot-wt")).toBe(true);
  expect(cold.length).toBe(COLD_PER_CYCLE);
  expect(cold[0]!.branch).toBe("cold-00");
  expect(cold.at(-1)!.branch).toBe(`cold-${String(COLD_PER_CYCLE - 1).padStart(2, "0")}`);
});
