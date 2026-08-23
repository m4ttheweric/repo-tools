import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

  test("a pre-existing endpoints.json is imported on first read, and renamed to .migrated", () => {
    const path = endpointsPath("r4");
    mkdirSync(dirname(path), { recursive: true });
    const legacyClaim = { worktree: "/stale", role: "web", port: 1, ts: "x" };
    writeFileSync(path, JSON.stringify({ claims: [legacyClaim] }));
    expect(existsSync(path)).toBe(true);

    expect(loadClaims("r4")).toEqual([legacyClaim]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);

    // A later save still overwrites the imported value, and renames (not
    // unlinks) anything left at the legacy path.
    const fresh = { worktree: "/fresh", role: "web", port: 3001, ts: new Date().toISOString() };
    saveClaims("r4", [fresh]);
    expect(loadClaims("r4")).toEqual([fresh]);
  });

  test("a corrupt endpoints.json warns and is left in place; loadClaims reads as empty", () => {
    const path = endpointsPath("r5");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(loadClaims("r5")).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
