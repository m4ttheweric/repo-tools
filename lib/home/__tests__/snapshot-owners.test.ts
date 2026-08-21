import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claimZone, InvalidZoneError, normalizeZone, readOwners, releaseZone } from "../snapshot-owners.ts";
import { renderOwnersFile } from "../init-plan.ts";

const EMPTY_TEMPLATE = renderOwnersFile();

/** The pre-fix live template: comment-only, no "zones" property — still tolerated on READ. */
const LEGACY_TEMPLATE =
  "{\n  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n  // auto-commit. Empty until a zone is claimed.\n}\n";

let dir: string | undefined;

function ownersPath(): string {
  dir = mkdtempSync(join(tmpdir(), "snapshot-owners-test-"));
  return join(dir, "snapshot-owners.jsonc");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("normalizeZone", () => {
  test("appends a trailing slash", () => {
    expect(normalizeZone("prefs")).toBe("prefs/");
  });

  test("leaves an already-slash-terminated zone as-is", () => {
    expect(normalizeZone("prefs/")).toBe("prefs/");
  });

  test("accepts a nested zone", () => {
    expect(normalizeZone("work/project")).toBe("work/project/");
  });

  test("rejects an empty zone", () => {
    expect(() => normalizeZone("")).toThrow(InvalidZoneError);
  });

  test("rejects a leading slash", () => {
    expect(() => normalizeZone("/prefs")).toThrow(InvalidZoneError);
  });

  test("rejects a .. segment", () => {
    expect(() => normalizeZone("work/../etc")).toThrow(InvalidZoneError);
    expect(() => normalizeZone("..")).toThrow(InvalidZoneError);
  });

  test("rejects a . segment", () => {
    expect(() => normalizeZone("./prefs")).toThrow(InvalidZoneError);
    expect(() => normalizeZone(".")).toThrow(InvalidZoneError);
  });

  test("rejects a backslash", () => {
    expect(() => normalizeZone("work\\project")).toThrow(InvalidZoneError);
  });
});

describe("readOwners", () => {
  test("parses the seeded template (zones: {}) as zero zones", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    expect(readOwners(path)).toEqual({ zones: {} });
  });

  test("parses the legacy comment-only template (no zones key) as zero zones", () => {
    const path = ownersPath();
    writeFileSync(path, LEGACY_TEMPLATE);

    expect(readOwners(path)).toEqual({ zones: {} });
  });

  test("returns zero zones for a missing file", () => {
    const path = ownersPath();

    expect(readOwners(path)).toEqual({ zones: {} });
  });

  test("returns zero zones for a whitespace-only file", () => {
    const path = ownersPath();
    writeFileSync(path, "   \n\n  ");

    expect(readOwners(path)).toEqual({ zones: {} });
  });

  test("parses a populated file, comments included", () => {
    const path = ownersPath();
    writeFileSync(
      path,
      '{\n  // header\n  "zones": {\n    "prefs/": { "owner": "matt", "claimedAt": "2026-01-01T00:00:00.000Z" }\n  }\n}\n',
    );

    expect(readOwners(path)).toEqual({
      zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } },
    });
  });

  test("normalizes a hand-edited zone key missing its trailing slash", () => {
    const path = ownersPath();
    writeFileSync(path, '{ "zones": { "prefs": { "owner": "matt", "claimedAt": "2026-01-01T00:00:00.000Z" } } }\n');

    expect(Object.keys(readOwners(path).zones)).toEqual(["prefs/"]);
  });

  test("throws on malformed jsonc", () => {
    const path = ownersPath();
    writeFileSync(path, "{ not: valid");

    expect(() => readOwners(path)).toThrow();
  });

  test("throws when zones is a string, not an object", () => {
    const path = ownersPath();
    writeFileSync(path, '{ "zones": "oops" }\n');

    expect(() => readOwners(path)).toThrow();
  });

  test("throws when zones is an array, not an object", () => {
    const path = ownersPath();
    writeFileSync(path, '{ "zones": ["oops"] }\n');

    expect(() => readOwners(path)).toThrow();
  });

  test("throws when a zone entry is not an object", () => {
    const path = ownersPath();
    writeFileSync(path, '{ "zones": { "prefs/": "matt" } }\n');

    expect(() => readOwners(path)).toThrow();
  });

  test("throws on a duplicate top-level zones key (modify edits the first, parse reads the last)", () => {
    const path = ownersPath();
    writeFileSync(
      path,
      '{ "zones": { "prefs/": { "owner": "matt", "claimedAt": "2026-01-01T00:00:00.000Z" } }, "zones": {} }\n',
    );

    expect(() => readOwners(path)).toThrow();
  });

  test("throws on a hand-edited zone key that fails normalization", () => {
    const path = ownersPath();
    writeFileSync(path, '{ "zones": { "./prefs/": { "owner": "matt", "claimedAt": "2026-01-01T00:00:00.000Z" } } }\n');

    expect(() => readOwners(path)).toThrow();
  });
});

describe("claimZone / releaseZone", () => {
  test("claim on the empty template creates the zones entry and keeps the header comment above it", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    claimZone(path, "prefs", "matt");

    const owners = readOwners(path);
    expect(Object.keys(owners.zones)).toEqual(["prefs/"]);
    expect(owners.zones["prefs/"]?.owner).toBe("matt");
    expect(typeof owners.zones["prefs/"]?.claimedAt).toBe("string");

    const text = readFileSync(path, "utf8");
    const headerIdx = text.indexOf("snapshot-owners.jsonc — claimed zones");
    const zonesIdx = text.indexOf('"zones"');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(zonesIdx).toBeGreaterThan(headerIdx);
  });

  test("claim on a missing file creates it from the seeded template", () => {
    const path = ownersPath();

    claimZone(path, "prefs", "matt", "personal prefs");

    const owners = readOwners(path);
    expect(owners.zones["prefs/"]).toEqual({
      owner: "matt",
      claimedAt: owners.zones["prefs/"]?.claimedAt as string,
      note: "personal prefs",
    });

    const text = readFileSync(path, "utf8");
    const headerIdx = text.indexOf("snapshot-owners.jsonc — claimed zones");
    const zonesIdx = text.indexOf('"zones"');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(zonesIdx).toBeGreaterThan(headerIdx);
  });

  test("claim normalizes the zone before writing", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    claimZone(path, "work/project", "matt");

    expect(Object.keys(readOwners(path).zones)).toEqual(["work/project/"]);
  });

  test("claim rejects a bad zone and writes nothing", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    expect(() => claimZone(path, "../etc", "matt")).toThrow(InvalidZoneError);
    expect(readFileSync(path, "utf8")).toBe(EMPTY_TEMPLATE);
  });

  test("release removes a claimed zone, preserving comments and any remaining zones", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);
    claimZone(path, "prefs", "matt");
    claimZone(path, "work", "matt");

    releaseZone(path, "prefs");

    const owners = readOwners(path);
    expect(Object.keys(owners.zones)).toEqual(["work/"]);
    expect(readFileSync(path, "utf8")).toContain("snapshot-owners.jsonc — claimed zones");
  });

  test("release on an unclaimed zone is a no-op", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    releaseZone(path, "prefs");

    expect(readOwners(path)).toEqual({ zones: {} });
  });
});
