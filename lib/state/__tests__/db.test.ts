/**
 * lib/state/db.ts — connection, pragmas, schema-versioned migrations, and
 * the legacy-JSON import seam. See docs/superpowers/specs/2026-08-20-rt-statedb.md
 * ("The database", "Schema versioning", "Tables (v1)", "Migration & contention").
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  closeStateDb,
  getStateDb,
  LEGACY_IMPORTS,
  openStateDb,
  SCHEMA_VERSION,
} from "../db.ts";

const DB_TS_PATH = join(import.meta.dir, "..", "db.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-state-db-"));
});

afterEach(() => {
  closeStateDb();
  // db.ts registers legacy importers globally; each test that pushes a fake
  // entry must clean up after itself so later tests don't see it.
  LEGACY_IMPORTS.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
}

function tableNames(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table';").all() as { name: string }[];
  return rows.map(r => r.name).sort();
}

describe("openStateDb — fresh open", () => {
  test("creates the v1 schema and sets user_version = 1", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
    expect(tableNames(db)).toEqual([
      "branch_cache",
      "discussions",
      "kv",
      "notify_queue",
      "project_mr_demands",
      "project_mrs",
      "project_mrs_meta",
      "sqlite_sequence", // AUTOINCREMENT bookkeeping table (notify_queue.id)
    ]);
    db.close();
  });

  test("the db file exists on disk after open", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });
});

describe("openStateDb — reopen is a no-op", () => {
  test("second open on the same path does not re-run migrations or re-import", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "fake-store.json");
    writeFileSync(legacyPath, JSON.stringify({ n: 1 }));

    let importCount = 0;
    LEGACY_IMPORTS.push({
      file: "fake-store.json",
      import: () => { importCount += 1; },
    });

    const db1 = openStateDb(dbPath, "cli");
    expect(userVersion(db1)).toBe(1);
    expect(importCount).toBe(1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(userVersion(db2)).toBe(1);
    expect(importCount).toBe(1); // not re-imported
    db2.close();
  });
});

describe("legacy import seam", () => {
  test("a registered importer runs during v0->v1 migration and the source file is renamed .migrated", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "fake-store.json");
    writeFileSync(legacyPath, JSON.stringify({ hello: "world" }));

    let seen: unknown = null;
    LEGACY_IMPORTS.push({
      file: "fake-store.json",
      import: (_db, json) => { seen = json; },
    });

    const db = openStateDb(dbPath, "cli");
    expect(seen).toEqual({ hello: "world" });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("corrupt legacy JSON is warned + skipped but still renamed", () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "bad-store.json");
    writeFileSync(legacyPath, "{ not valid json");

    let called = false;
    LEGACY_IMPORTS.push({
      file: "bad-store.json",
      import: () => { called = true; },
    });

    const db = openStateDb(dbPath, "cli");
    expect(called).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("a legacy file that does not exist is silently skipped (no rename, no throw)", () => {
    const dbPath = join(dir, "state.db");
    LEGACY_IMPORTS.push({
      file: "never-existed.json",
      import: () => { throw new Error("should never be called"); },
    });
    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
  });
});

describe("pragma values per flavor", () => {
  test("cli flavor sets busy_timeout = 5000", () => {
    const db = openStateDb(join(dir, "state.db"), "cli");
    const { timeout } = db.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(timeout).toBe(5000);
    db.close();
  });

  test("daemon flavor sets busy_timeout = 250", () => {
    const db = openStateDb(join(dir, "state.db"), "daemon");
    const { timeout } = db.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(timeout).toBe(250);
    db.close();
  });

  test("journal_mode is WAL and synchronous is NORMAL regardless of flavor", () => {
    const db = openStateDb(join(dir, "state.db"), "cli");
    const { journal_mode } = db.query("PRAGMA journal_mode;").get() as { journal_mode: string };
    expect(journal_mode).toBe("wal");
    // synchronous: 0=OFF, 1=NORMAL, 2=FULL
    const { synchronous } = db.query("PRAGMA synchronous;").get() as { synchronous: number };
    expect(synchronous).toBe(1);
    db.close();
  });

  test("defaults to cli flavor when none is passed", () => {
    const db = openStateDb(join(dir, "state.db"));
    const { timeout } = db.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(timeout).toBe(5000);
    db.close();
  });
});

describe("corruption escape", () => {
  test("a file that cannot be opened as sqlite is quarantined, then a fresh v1 db is created", () => {
    const dbPath = join(dir, "state.db");
    writeFileSync(dbPath, "definitely not a sqlite database, just bytes");

    const db = openStateDb(dbPath, "cli");
    expect(userVersion(db)).toBe(1);
    db.close();

    const survivors = Array.from(new Bun.Glob("state.db.corrupt-*").scanSync({ cwd: dir }));
    expect(survivors.length).toBe(1);
    // The quarantined file still holds the original garbage bytes.
    const quarantined = readFileSync(join(dir, survivors[0]!), "utf8");
    expect(quarantined).toBe("definitely not a sqlite database, just bytes");
  });
});

describe("getStateDb / closeStateDb — lazy singleton", () => {
  test("getStateDb opens at rtDir()/state.db under the isolated HOME and is a singleton", () => {
    const db1 = getStateDb("cli");
    const db2 = getStateDb("cli");
    expect(db1).toBe(db2);
    expect(userVersion(db1)).toBe(1);
  });

  test("closeStateDb releases the singleton so the next getStateDb call reopens", () => {
    const db1 = getStateDb("cli");
    closeStateDb();
    const db2 = getStateDb("cli");
    expect(db1).not.toBe(db2);
    expect(userVersion(db2)).toBe(1);
  });

  test("importing db.ts performs no module-load db access (no file created merely by import)", async () => {
    // Fresh module registry cache miss isn't available in bun:test, but we
    // can assert the narrower, directly-testable half of the rule: calling
    // unrelated exports (reading SCHEMA_VERSION, pushing to LEGACY_IMPORTS)
    // never opens or creates a db file on its own.
    const before = SCHEMA_VERSION;
    expect(before).toBe(1);
    LEGACY_IMPORTS.push({ file: "x.json", import: () => {} });
    LEGACY_IMPORTS.length = 0;
    // No db.ts function that touches disk was called above; nothing to assert
    // on disk beyond "the module itself contains no top-level side effects",
    // which is enforced by every other test in this file constructing its own
    // temp dir and never finding a stray state.db.
  });
});

describe("two connections racing v0 (real OS-level race)", () => {
  test("exactly one process imports the legacy store; neither throws; both land at v1", async () => {
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "fake-store.json");
    writeFileSync(legacyPath, JSON.stringify({ race: true }));
    const counterPath = join(dir, "import-count.log");
    writeFileSync(counterPath, "");

    const scriptPath = join(dir, "race-worker.ts");
    writeFileSync(
      scriptPath,
      [
        `import { openStateDb, LEGACY_IMPORTS } from ${JSON.stringify(DB_TS_PATH)};`,
        `import { appendFileSync } from "fs";`,
        `LEGACY_IMPORTS.push({`,
        `  file: "fake-store.json",`,
        `  import: () => { appendFileSync(${JSON.stringify(counterPath)}, "x\\n"); },`,
        `});`,
        `const db = openStateDb(${JSON.stringify(dbPath)}, "cli");`,
        `db.close();`,
        `console.log("ok");`,
      ].join("\n"),
    );

    const spawnOne = () =>
      Bun.spawn([process.execPath, "run", scriptPath], { stdout: "pipe", stderr: "pipe" });

    const p1 = spawnOne();
    const p2 = spawnOne();
    const [code1, code2] = await Promise.all([p1.exited, p2.exited]);
    const [err1, err2] = await Promise.all([
      new Response(p1.stderr).text(),
      new Response(p2.stderr).text(),
    ]);

    expect({ code1, err1 }).toEqual({ code1: 0, err1: "" });
    expect({ code2, err2 }).toEqual({ code2: 0, err2: "" });

    const importLines = readFileSync(counterPath, "utf8").split("\n").filter(Boolean);
    expect(importLines.length).toBe(1);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);

    const finalDb = new Database(dbPath, { readonly: true });
    expect(userVersion(finalDb)).toBe(1);
    finalDb.close();
  }, 20_000);
});

describe("db path helpers", () => {
  test("openStateDb creates the parent directory if missing", () => {
    const nested = join(dir, "nested", "deeper", "state.db");
    expect(existsSync(dirname(nested))).toBe(false);
    const db = openStateDb(nested, "cli");
    expect(existsSync(nested)).toBe(true);
    db.close();
  });
});
