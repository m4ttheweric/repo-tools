import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRepoTracking, trackingLevel } from "../freshness.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-tracking-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadRepoTracking", () => {
  test("missing file means nothing tracked", () => {
    expect(loadRepoTracking(join(dir, "absent.json"))).toEqual({});
  });

  test("valid map round-trips", () => {
    const path = join(dir, "tracking.json");
    writeFileSync(path, JSON.stringify({ "acme-dev": "live", "acme-tools": "poll" }));
    expect(loadRepoTracking(path)).toEqual({ "acme-dev": "live", "acme-tools": "poll" });
  });

  test("corrupt file means nothing tracked", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json");
    expect(loadRepoTracking(path)).toEqual({});
  });

  test("array or scalar JSON means nothing tracked", () => {
    const arr = join(dir, "arr.json");
    writeFileSync(arr, JSON.stringify(["acme-dev"]));
    expect(loadRepoTracking(arr)).toEqual({});
  });

  test("unknown levels are dropped, valid siblings kept", () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, JSON.stringify({ "a": "live", "b": "yes", "c": 1, "d": "poll" }));
    expect(loadRepoTracking(path)).toEqual({ a: "live", d: "poll" });
  });
});

describe("trackingLevel", () => {
  test("unlisted repos default to off", () => {
    expect(trackingLevel({ "acme-dev": "live" }, "koguma")).toBe("off");
  });

  test("listed repos return their level", () => {
    expect(trackingLevel({ "acme-dev": "live", "x": "poll" }, "x")).toBe("poll");
  });
});
