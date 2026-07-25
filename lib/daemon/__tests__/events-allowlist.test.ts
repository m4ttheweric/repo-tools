import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadEventsAllowlist } from "../freshness.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-events-allow-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadEventsAllowlist", () => {
  test("missing file means nothing opted in", () => {
    expect(loadEventsAllowlist(join(dir, "absent.json")).size).toBe(0);
  });

  test("valid array round-trips as a set", () => {
    const path = join(dir, "allow.json");
    writeFileSync(path, JSON.stringify(["acme-dev", "glance-test-repo"]));
    const allowed = loadEventsAllowlist(path);
    expect(allowed.has("acme-dev")).toBe(true);
    expect(allowed.has("glance-test-repo")).toBe(true);
    expect(allowed.has("koguma")).toBe(false);
  });

  test("corrupt file means nothing opted in", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json");
    expect(loadEventsAllowlist(path).size).toBe(0);
  });

  test("non-array JSON means nothing opted in", () => {
    const path = join(dir, "object.json");
    writeFileSync(path, JSON.stringify({ "acme-dev": true }));
    expect(loadEventsAllowlist(path).size).toBe(0);
  });

  test("non-string entries are dropped", () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, JSON.stringify(["acme-dev", 42, null, { repo: "x" }]));
    const allowed = loadEventsAllowlist(path);
    expect(allowed.size).toBe(1);
    expect(allowed.has("acme-dev")).toBe(true);
  });
});
