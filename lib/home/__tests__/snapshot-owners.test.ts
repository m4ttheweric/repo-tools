import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claimZone, InvalidZoneError, normalizeZone, readOwners, releaseZone } from "../snapshot-owners.ts";

const EMPTY_TEMPLATE =
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
});

describe("readOwners", () => {
  test("parses the empty template as zero zones", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    expect(readOwners(path)).toEqual({ zones: {} });
  });

  test("returns zero zones for a missing file", () => {
    const path = ownersPath();

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

  test("throws on malformed jsonc", () => {
    const path = ownersPath();
    writeFileSync(path, "{ not: valid");

    expect(() => readOwners(path)).toThrow();
  });
});

describe("claimZone / releaseZone", () => {
  test("claim on the empty template creates the zones entry and preserves the header comment", () => {
    const path = ownersPath();
    writeFileSync(path, EMPTY_TEMPLATE);

    claimZone(path, "prefs", "matt");

    const owners = readOwners(path);
    expect(Object.keys(owners.zones)).toEqual(["prefs/"]);
    expect(owners.zones["prefs/"]?.owner).toBe("matt");
    expect(typeof owners.zones["prefs/"]?.claimedAt).toBe("string");
    expect(readFileSync(path, "utf8")).toContain("snapshot-owners.jsonc — claimed zones");
  });

  test("claim on a missing file creates it", () => {
    const path = ownersPath();

    claimZone(path, "prefs", "matt", "personal prefs");

    const owners = readOwners(path);
    expect(owners.zones["prefs/"]).toEqual({
      owner: "matt",
      claimedAt: owners.zones["prefs/"]?.claimedAt as string,
      note: "personal prefs",
    });
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
