import { describe, expect, test } from "bun:test";
import { planSnapshot } from "../home-snapshot-plan.ts";
import type { Owners } from "../../home/snapshot-owners.ts";

const NOW = 1_000_000;
const THRESHOLD_MS = 6 * 60 * 60 * 1000;

const NO_OWNERS: Owners = { zones: {} };

function ownersWith(zone: string, owner = "matt"): Owners {
  return { zones: { [zone]: { owner, claimedAt: "2026-01-01T00:00:00.000Z" } } };
}

describe("planSnapshot", () => {
  test("no status lines: everything empty, message null", () => {
    const plan = planSnapshot({
      statusLines: [],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan).toEqual({
      autoPaths: [],
      excludedZones: [],
      janitorZones: [],
      message: null,
      nextFirstSeenDirty: {},
    });
  });

  test("unclaimed paths only: all become autoPaths, no zones excluded", () => {
    const plan = planSnapshot({
      statusLines: [" M skills.jsonc", "?? work/scratch.md"],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.autoPaths).toEqual(["skills.jsonc", "work/scratch.md"]);
    expect(plan.excludedZones).toEqual([]);
    expect(plan.janitorZones).toEqual([]);
    expect(plan.message).toBe("snapshot: skills.jsonc, work");
    expect(plan.nextFirstSeenDirty).toEqual({});
  });

  test("mixed: paths under a claimed zone are excluded from autoPaths; the zone is dirty", () => {
    const plan = planSnapshot({
      statusLines: [" M skills.jsonc", " M prefs/preferences.md"],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.autoPaths).toEqual(["skills.jsonc"]);
    expect(plan.excludedZones).toEqual(["prefs/"]);
    expect(plan.message).toBe("snapshot: skills.jsonc");
    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": NOW });
  });

  test("a zone newly dirty this run: firstSeen set to now, not a janitor candidate", () => {
    const plan = planSnapshot({
      statusLines: [" M prefs/preferences.md"],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": NOW });
    expect(plan.janitorZones).toEqual([]);
  });

  test("a zone dirty past threshold: firstSeen carried forward, becomes a janitor zone", () => {
    const firstSeen = NOW - THRESHOLD_MS;
    const plan = planSnapshot({
      statusLines: [" M prefs/preferences.md"],
      owners: ownersWith("prefs/", "matt"),
      now: NOW,
      firstSeenDirty: { "prefs/": firstSeen },
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": firstSeen });
    expect(plan.janitorZones).toEqual([{ zone: "prefs/", owner: "matt", dirtySinceMs: firstSeen }]);
  });

  test("a zone dirty but under threshold: carried forward, not a janitor zone", () => {
    const firstSeen = NOW - THRESHOLD_MS + 1;
    const plan = planSnapshot({
      statusLines: [" M prefs/preferences.md"],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: { "prefs/": firstSeen },
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": firstSeen });
    expect(plan.janitorZones).toEqual([]);
  });

  test("a zone that cleaned up: dropped from nextFirstSeenDirty", () => {
    const plan = planSnapshot({
      statusLines: [" M skills.jsonc"],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: { "prefs/": NOW - 1000 },
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.excludedZones).toEqual(["prefs/"]);
    expect(plan.nextFirstSeenDirty).toEqual({});
  });

  test("message formatting: more than 5 distinct top-level paths collapses to +N more", () => {
    const plan = planSnapshot({
      statusLines: ["?? a/x", "?? b/x", "?? c/x", "?? d/x", "?? e/x", "?? f/x", "?? g/x"],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: a, b, c, d, e +2 more");
  });

  test("message formatting: a root-level file's top-level path is the file name itself", () => {
    const plan = planSnapshot({
      statusLines: ["?? README.md"],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: README.md");
  });

  test("message formatting: repeated top-level paths count once", () => {
    const plan = planSnapshot({
      statusLines: ["?? work/a.md", "?? work/b.md", "?? work/c.md"],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: work");
  });
});
