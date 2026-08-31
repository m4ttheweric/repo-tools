/**
 * on-deck/* worktree branches are pool plumbing: the daemon never caches them,
 * so gating enrichment on `branches.every(cached)` forced a cold fetch (the
 * "Fetching branch info..." spinner) every time you drilled into a repo with
 * on-deck worktrees. enrichBranches must treat them as trivially Local Only,
 * out of the cache-hit gate and the fetch.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { enrichBranches } from "../enrich.ts";
import * as daemonClient from "../daemon-client.ts";

describe("enrichBranches on-deck short-circuit", () => {
  test("all-on-deck input returns Local Only with no daemon round-trip", async () => {
    const spy = spyOn(daemonClient, "daemonQuery").mockResolvedValue(null as never);
    try {
      const result = await enrichBranches(
        [
          { path: "/x/slot-1", branch: "on-deck/bill" },
          { path: "/x/slot-2", branch: "on-deck/cho" },
        ],
        "git@gitlab.example.com:acme/acme.git",
      );
      expect(result.map((r) => r.branch)).toEqual(["on-deck/bill", "on-deck/cho"]);
      expect(result.every((r) => r.mr === null && r.ticket === null && r.linearId === null)).toBe(true);
      // Pool branches never have MRs and the daemon never caches them, so the
      // enrichment path must not be entered for them at all.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("mixed input preserves order and keeps on-deck as Local Only", async () => {
    // `silent` skips the daemon path so the test stays offline/deterministic;
    // with no secrets the real branch also resolves to Local Only. The point is
    // the on-deck entry is Local Only and input order is preserved.
    const result = await enrichBranches(
      [
        { path: "/x/main", branch: "master" },
        { path: "/x/slot-1", branch: "on-deck/bill" },
      ],
      "git@gitlab.example.com:acme/acme.git",
      { silent: true },
    );
    expect(result.map((r) => r.branch)).toEqual(["master", "on-deck/bill"]);
    const onDeck = result.find((r) => r.branch === "on-deck/bill")!;
    expect(onDeck.mr).toBe(null);
    expect(onDeck.ticket).toBe(null);
  });
});
