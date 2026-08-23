import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { closeStateDb } from "../../state/index.ts";
import { endpointsPath, loadClaims, saveClaims } from "../store.ts";

describe("claims store — state.db persistence", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-endpoint-store-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
  });

  test("load on an untouched repo returns empty", () => {
    expect(loadClaims("fresh-repo")).toEqual([]);
  });

  test("round-trips claims through state.db", () => {
    const claim = { worktree: "/tmp/wt-a", role: "backend", port: 10400, pid: 123, ts: new Date().toISOString() };
    saveClaims("r1", [claim]);
    expect(loadClaims("r1")).toEqual([claim]);
  });

  test("saving one repo's claims does not disturb another repo's", () => {
    saveClaims("r2", [{ worktree: "/a", role: "web", port: 3000, ts: new Date().toISOString() }]);
    saveClaims("r3", []);
    expect(loadClaims("r2").length).toBe(1);
  });

  test("a stale on-disk endpoints.json is ignored once the store owns the value, and gets unlinked on write", () => {
    const path = endpointsPath("r4");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ claims: [{ worktree: "/stale", role: "web", port: 1, ts: "x" }] }));
    expect(existsSync(path)).toBe(true);

    // The store, not the stale file, is authoritative — nothing written yet.
    expect(loadClaims("r4")).toEqual([]);

    const fresh = { worktree: "/fresh", role: "web", port: 3001, ts: new Date().toISOString() };
    saveClaims("r4", [fresh]);
    expect(loadClaims("r4")).toEqual([fresh]);
    expect(existsSync(path)).toBe(false);
  });
});
