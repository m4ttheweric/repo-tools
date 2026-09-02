import { describe, expect, test } from "bun:test";
import { parsePorcelainZ, planSnapshot, scopeEntries, type StatusEntry } from "../home-snapshot-plan.ts";
import { teamScope } from "../home-snapshot.ts";
import type { Owners } from "../../home/snapshot-owners.ts";

const NOW = 1_000_000;
const THRESHOLD_MS = 6 * 60 * 60 * 1000;

const NO_OWNERS: Owners = { zones: {} };

function ownersWith(zone: string, owner = "matt"): Owners {
  return { zones: { [zone]: { owner, claimedAt: "2026-01-01T00:00:00.000Z" } } };
}

function entry(path: string, xy = "??"): StatusEntry {
  return { xy, path };
}

describe("parsePorcelainZ", () => {
  test("a clean repo (empty buffer) parses to zero entries", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });

  test("a single untracked entry with a trailing NUL", () => {
    expect(parsePorcelainZ("?? a.txt\0")).toEqual([{ xy: "??", path: "a.txt" }]);
  });

  test("modified and untracked entries mixed", () => {
    expect(parsePorcelainZ(" M skills.jsonc\0?? work/scratch.md\0")).toEqual([
      { xy: " M", path: "skills.jsonc" },
      { xy: "??", path: "work/scratch.md" },
    ]);
  });

  test("a path containing a space — no quoting in -z output", () => {
    expect(parsePorcelainZ("?? my file.txt\0")).toEqual([{ xy: "??", path: "my file.txt" }]);
  });

  test("a rename pair: new path, then a bare origPath with no XY prefix", () => {
    expect(parsePorcelainZ("R  prefs/new.md\0prefs/old.md\0")).toEqual([
      { xy: "R ", path: "prefs/new.md", origPath: "prefs/old.md" },
    ]);
  });

  test("a copy pair", () => {
    expect(parsePorcelainZ("C  b.txt\0a.txt\0")).toEqual([{ xy: "C ", path: "b.txt", origPath: "a.txt" }]);
  });

  test("a rename pair followed by an ordinary entry stays in sync", () => {
    expect(parsePorcelainZ("R  new.md\0old.md\0?? untracked.txt\0")).toEqual([
      { xy: "R ", path: "new.md", origPath: "old.md" },
      { xy: "??", path: "untracked.txt" },
    ]);
  });
});

describe("planSnapshot", () => {
  test("no entries: everything empty, message null", () => {
    const plan = planSnapshot({
      entries: [],
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
      entries: [entry("skills.jsonc", " M"), entry("work/scratch.md", "??")],
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
      entries: [entry("skills.jsonc", " M"), entry("prefs/preferences.md", " M")],
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
      entries: [entry("prefs/preferences.md", " M")],
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
      entries: [entry("prefs/preferences.md", " M")],
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
      entries: [entry("prefs/preferences.md", " M")],
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
      entries: [entry("skills.jsonc", " M")],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: { "prefs/": NOW - 1000 },
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.excludedZones).toEqual(["prefs/"]);
    expect(plan.nextFirstSeenDirty).toEqual({});
  });

  test("a rename OUT of a claimed zone still dirties that zone, even though the new path escapes it", () => {
    const plan = planSnapshot({
      entries: [{ xy: "R ", path: "work/moved.md", origPath: "prefs/old.md" }],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": NOW });
    // the new path isn't under any zone, so it's still auto-committable —
    // the zone stays dirty (and eventually janitor-swept) via origPath alone.
    expect(plan.autoPaths).toEqual(["work/moved.md"]);
  });

  test("a rename INTO a claimed zone dirties the zone and excludes the entry from autoPaths", () => {
    const plan = planSnapshot({
      entries: [{ xy: "R ", path: "prefs/new.md", origPath: "work/old.md" }],
      owners: ownersWith("prefs/"),
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.autoPaths).toEqual([]);
    expect(plan.nextFirstSeenDirty).toEqual({ "prefs/": NOW });
  });

  test("message formatting: more than 5 distinct top-level paths collapses to +N more", () => {
    const plan = planSnapshot({
      entries: ["a/x", "b/x", "c/x", "d/x", "e/x", "f/x", "g/x"].map((p) => entry(p)),
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: a, b, c, d, e +2 more");
  });

  test("message formatting: a root-level file's top-level path is the file name itself", () => {
    const plan = planSnapshot({
      entries: [entry("README.md")],
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: README.md");
  });

  test("message formatting: repeated top-level paths count once", () => {
    const plan = planSnapshot({
      entries: ["work/a.md", "work/b.md", "work/c.md"].map((p) => entry(p)),
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.message).toBe("snapshot: work");
  });

  test("fixtures can be routed through the real parser instead of built by hand", () => {
    const plan = planSnapshot({
      entries: parsePorcelainZ(" M skills.jsonc\0?? work/scratch.md\0"),
      owners: NO_OWNERS,
      now: NOW,
      firstSeenDirty: {},
      thresholdMs: THRESHOLD_MS,
    });

    expect(plan.autoPaths).toEqual(["skills.jsonc", "work/scratch.md"]);
  });

  describe("file zones (stored without a trailing slash)", () => {
    test("a claimed FILE excludes exactly that path from autoPaths", () => {
      const plan = planSnapshot({
        entries: [entry("scripts/deploy.sh"), entry("scripts/other.sh")],
        owners: ownersWith("scripts/deploy.sh"),
        now: NOW,
        firstSeenDirty: {},
        thresholdMs: THRESHOLD_MS,
      });

      expect(plan.autoPaths).toEqual(["scripts/other.sh"]);
      expect(plan.excludedZones).toEqual(["scripts/deploy.sh"]);
    });

    test("a claimed FILE does NOT exclude a sibling that merely shares its name as a prefix", () => {
      // The original bug this guards: naive startsWith("scripts/deploy.sh")
      // would ALSO match "scripts/deploy.sh.bak", which was never claimed.
      const plan = planSnapshot({
        entries: [entry("scripts/deploy.sh.bak")],
        owners: ownersWith("scripts/deploy.sh"),
        now: NOW,
        firstSeenDirty: {},
        thresholdMs: THRESHOLD_MS,
      });

      expect(plan.autoPaths).toEqual(["scripts/deploy.sh.bak"]);
    });

    test("a claimed FILE left dirty past the threshold becomes a janitor zone, same as a dir zone", () => {
      const firstSeen = NOW - THRESHOLD_MS;
      const plan = planSnapshot({
        entries: [entry("scripts/deploy.sh")],
        owners: ownersWith("scripts/deploy.sh", "matt"),
        now: NOW,
        firstSeenDirty: { "scripts/deploy.sh": firstSeen },
        thresholdMs: THRESHOLD_MS,
      });

      expect(plan.janitorZones).toEqual([{ zone: "scripts/deploy.sh", owner: "matt", dirtySinceMs: firstSeen }]);
    });

    test("a dir zone and a file zone coexist without either swallowing the other's paths", () => {
      const owners: Owners = {
        zones: {
          "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
          "scripts/deploy.sh": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
        },
      };
      const plan = planSnapshot({
        entries: [entry("prefs/settings.json"), entry("scripts/deploy.sh"), entry("notes.md")],
        owners,
        now: NOW,
        firstSeenDirty: {},
        thresholdMs: THRESHOLD_MS,
      });

      expect(plan.autoPaths).toEqual(["notes.md"]);
    });
  });
});

describe("scopeEntries", () => {
  const entries: StatusEntry[] = [
    { xy: " M", path: "mattstack/settings.team.jsonc" },
    { xy: "??", path: ".sops.yaml" },
    { xy: " M", path: ".claude-plugin/marketplace.json" },
    { xy: " M", path: "src/index.ts" },
    { xy: "??", path: "docs/plan.md" },
  ];
  test("undefined scope keeps everything", () => {
    expect(scopeEntries(entries, undefined)).toHaveLength(5);
  });
  test("teamScope keeps only the team store, the recipients file and the marketplace", () => {
    expect(scopeEntries(entries, teamScope).map((e) => e.path)).toEqual([
      "mattstack/settings.team.jsonc", ".sops.yaml", ".claude-plugin/marketplace.json",
    ]);
  });
  test("teamScope is prefix-safe: mattstack-tools/ is not mattstack/", () => {
    expect(teamScope("mattstack-tools/x")).toBe(false);
    expect(teamScope("mattstack/secrets/board.json")).toBe(true);
    expect(teamScope(".sops.yaml")).toBe(true);
    expect(teamScope(".sops.yaml.bak")).toBe(false);
  });
});
