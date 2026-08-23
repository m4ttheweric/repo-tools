import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rtDir } from "../../rt-paths.ts";
import { closeStateDb, getStateDb } from "../../state/index.ts";
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

  test("a legacy endpoints.json with a duplicate (worktree, role) pair is deduped (last wins), not thrown as a UNIQUE-constraint error", () => {
    const path = endpointsPath("r6");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      claims: [
        { worktree: "/wt", role: "web", port: 3000, ts: "2026-08-20T00:00:00Z" },
        { worktree: "/wt", role: "web", port: 4000, ts: "2026-08-21T00:00:00Z" }, // same pair, later — wins
      ],
    }));

    expect(() => loadClaims("r6")).not.toThrow();
    expect(loadClaims("r6")).toEqual([{ worktree: "/wt", role: "web", port: 4000, ts: "2026-08-21T00:00:00Z" }]);
  });

  test("saveClaims reached WITHOUT a prior load still imports pre-existing claims instead of stranding them", () => {
    const path = endpointsPath("r7");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ claims: [{ worktree: "/old", role: "web", port: 1, ts: "x" }] }));

    // No loadClaims("r7") call before this.
    saveClaims("r7", [{ worktree: "/new", role: "web", port: 2, ts: "y" }]);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
    expect(loadClaims("r7")).toEqual([{ worktree: "/new", role: "web", port: 2, ts: "y" }]);
  });

  test("real contended write: a held write lock during loadClaims's import must NOT rename endpoints.json", () => {
    getStateDb(); // materialize AND keep open — see the worktree registry equivalent test for why
    const dbPath = join(rtDir(), "state.db");

    const path = endpointsPath("r8");
    mkdirSync(dirname(path), { recursive: true });
    const legacyClaim = { worktree: "/held", role: "web", port: 1, ts: "x" };
    writeFileSync(path, JSON.stringify({ claims: [legacyClaim] }));

    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let claims: ReturnType<typeof loadClaims>;
    try {
      claims = loadClaims("r8");
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    expect(claims).toEqual([legacyClaim]); // apply() parsed correctly...
    expect(existsSync(path)).toBe(true);   // ...but nothing was destroyed
    expect(existsSync(`${path}.migrated`)).toBe(false);

    expect(loadClaims("r8")).toEqual([legacyClaim]); // retry succeeds
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  }, 20_000);
});
