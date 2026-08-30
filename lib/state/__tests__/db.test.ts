/**
 * lib/state/db.ts — connection, pragmas, schema-versioned migrations, and
 * the legacy-JSON import seam. See docs/superpowers/specs/2026-08-20-rt-statedb.md
 * ("The database", "Schema versioning", "Tables (v1)", "Migration & contention").
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  closeStateDb,
  ensureEndpointClaimsStartTimeColumn,
  getStateDb,
  LEGACY_IMPORTS,
  openStateDb,
  SCHEMA_VERSION,
} from "../db.ts";
// Side-effect imports: registering the REAL project-mrs and discussions
// importers (module-load LEGACY_IMPORTS.push), not fakes, so the isolation
// test below exercises a genuine throw (duplicate-iid UNIQUE violation)
// and a genuine benign import, not a hand-rolled stand-in for either.
import "../../daemon/project-mrs-store.ts";
import "../../daemon/discussions-file-store.ts";

const DB_TS_PATH = join(import.meta.dir, "..", "db.ts");

let dir: string;
let registeredImports: typeof LEGACY_IMPORTS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-state-db-"));
  // LEGACY_IMPORTS is a process-global array that real store modules push
  // into at import time. Snapshot it rather than assuming it starts empty:
  // bun shares one module registry across test files, so a store module
  // imported by ANY test file has already registered by the time this runs.
  registeredImports = [...LEGACY_IMPORTS];
});

afterEach(() => {
  closeStateDb();
  // Tests here push fake entries; drop those and restore the real
  // registrations, so later files (barrel.test.ts, branch-cache.test.ts)
  // still see a complete registry no matter the file order.
  LEGACY_IMPORTS.length = 0;
  LEGACY_IMPORTS.push(...registeredImports);
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
}

describe("openStateDb — fresh open", () => {
  test("a fresh database reaches v10 directly, gaining every v1, v2, v3, v4, v6, v7, v8, v9, and v10 change", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(SCHEMA_VERSION).toBe(10);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    // Full table-list coverage lives in db-schema-convergence.test.ts's
    // dynamic presence test, derived from db.ts's own CREATE TABLE
    // statements rather than a hand-maintained list here.
    const cols = (db.query("PRAGMA table_info(chat_rooms);").all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain("archived_at");
    const agentCols = (db.query("PRAGMA table_info(agents);").all() as { name: string }[]).map(c => c.name);
    expect(agentCols).toContain("handle");
    const claimCols = (db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[]).map(c => c.name);
    expect(claimCols).toContain("start_time");
    db.close();
  });

  test("the db file exists on disk after open", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  test("v4 adds chat_presence, chat_dms, and chat_room_defaults", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name IN ('chat_presence','chat_dms','chat_room_defaults')").all(),
    ).toHaveLength(3);
    expect(db.query("PRAGMA user_version").get()).toMatchObject({ user_version: 10 });
    db.close();
  });

  test("v10 moves mention-gated wake rows to all, keeping an explicit none", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec("INSERT INTO chat_rooms (name, created_at) VALUES ('r', 1);");
    db.exec("INSERT INTO chat_members (room, handle, joined_at, last_read_id, wake_on) VALUES ('r','a',1,0,'mention'), ('r','b',1,0,'none'), ('r','c',1,0,'all');");
    db.exec("INSERT INTO chat_room_defaults (room, wake_on) VALUES ('r','mention');");
    db.exec("PRAGMA user_version = 9;");
    db.close();
    const re = openStateDb(dbPath, "cli");
    const modes = re.query("SELECT handle, wake_on FROM chat_members ORDER BY handle;").all();
    expect(modes).toEqual([
      { handle: "a", wake_on: "all" },
      { handle: "b", wake_on: "none" },
      { handle: "c", wake_on: "all" },
    ]);
    expect(re.query("SELECT wake_on FROM chat_room_defaults WHERE room='r';").get()).toMatchObject({ wake_on: "all" });
    re.close();
  });
});

describe("openStateDb — replay over an older user_version", () => {
  test("replaying the current schemas over an older user_version does not throw", () => {
    // The property a future v5 must keep: the runner replays EVERY version's
    // schema over whatever is on disk, so only IF-NOT-EXISTS statements are
    // legal. This exercises v4-over-v3; a v5 bump extends this same test.
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec("PRAGMA user_version = 3;");
    db.close();
    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
  });

  test("v8 adds chat_rooms.archived_at to a v6 database without touching its rows", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec("INSERT INTO chat_rooms (name, created_at) VALUES ('build', 1);");
    // A real v6 file has no such column; SQLite >= 3.35 can drop one, which is
    // what makes this fixture honest rather than a fresh v7 relabelled.
    db.exec("ALTER TABLE chat_rooms DROP COLUMN archived_at;");
    db.exec("PRAGMA user_version = 6;");
    db.close();

    const migrated = openStateDb(dbPath, "cli");
    expect(userVersion(migrated)).toBe(SCHEMA_VERSION);
    const columns = (migrated.query("PRAGMA table_info(chat_rooms);").all() as { name: string }[]).map(c => c.name);
    expect(columns).toContain("archived_at");
    expect(migrated.query("SELECT name, archived_at FROM chat_rooms;").all()).toEqual([{ name: "build", archived_at: null }]);
    migrated.close();

    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
  });

  test("v9 adds agents.handle to a v7 database without touching its rows", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec(
      "INSERT INTO agents (id, repo, cwd, provider, surface, session_id, created_at) VALUES ('ag-1', 'r', '/c', 'claude', 'herdr', 's-1', 1);",
    );
    // A real v7 file has no such column; SQLite >= 3.35 can drop one, which is
    // what makes this fixture honest rather than a fresh v8 relabelled.
    db.exec("ALTER TABLE agents DROP COLUMN handle;");
    db.exec("PRAGMA user_version = 7;");
    db.close();

    const migrated = openStateDb(dbPath, "cli");
    expect(userVersion(migrated)).toBe(SCHEMA_VERSION);
    const columns = (migrated.query("PRAGMA table_info(agents);").all() as { name: string }[]).map(c => c.name);
    expect(columns).toContain("handle");
    expect(migrated.query("SELECT id, handle FROM agents;").all()).toEqual([{ id: "ag-1", handle: null }]);
    migrated.close();

    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
  });

  test("a machine already at v9 gains endpoint_claims.start_time on open (S068, added outside runMigrations' transaction)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    expect(userVersion(db1)).toBe(SCHEMA_VERSION);
    // Simulate a real v9 machine that predates the start_time column: only
    // ensureEndpointClaimsStartTimeColumn's own table_info guard, called
    // unconditionally from openStateDb, can add it back.
    db1.exec("ALTER TABLE endpoint_claims DROP COLUMN start_time;");
    db1.close();

    const beforeDb = new Database(dbPath);
    const columnsBefore = (beforeDb.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[]).map(c => c.name);
    beforeDb.close();
    expect(columnsBefore).not.toContain("start_time");

    const db2 = openStateDb(dbPath, "cli");
    expect(userVersion(db2)).toBe(SCHEMA_VERSION); // unchanged: not a schema-version bump
    const columnsAfter = (db2.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[]).map(c => c.name);
    expect(columnsAfter).toContain("start_time");
    db2.close();
  });

  test("ensureEndpointClaimsStartTimeColumn treats a concurrent winner's duplicate-column error as success", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli"); // already has start_time (v9+)
    expect((db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[]).map(c => c.name)).toContain(
      "start_time",
    );

    // Simulate the race: this process's own PRAGMA read reports the column
    // missing (a snapshot taken before a concurrent winner's ALTER landed),
    // so its own ALTER runs into the real column that already exists.
    const originalQuery = db.query.bind(db) as (...a: unknown[]) => unknown;
    let pragmaCalls = 0;
    const spy = spyOn(db, "query").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (sql === "PRAGMA table_info(endpoint_claims);" && pragmaCalls++ === 0) {
        return { all: () => [] };
      }
      return originalQuery(sql, ...rest);
    }) as Database["query"]);

    try {
      expect(() => ensureEndpointClaimsStartTimeColumn(db)).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect((db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[]).map(c => c.name)).toContain(
      "start_time",
    );
    db.close();
  });

  test("ensureEndpointClaimsStartTimeColumn still propagates an unrelated ALTER failure", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.exec("DROP TABLE endpoint_claims;");

    // The PRAGMA read on a dropped table returns no columns (missing,
    // correctly), but the ALTER itself now fails for a genuine reason (no
    // such table) that a duplicate-column re-check can never paper over.
    expect(() => ensureEndpointClaimsStartTimeColumn(db)).toThrow(/no such table/);
    db.close();
  });
});

/** Hand-built v1-shaped fixture — the exact schema/version a pre-Task-4 machine has on disk, not produced via openStateDb (which would already build v2). */
function buildV1Fixture(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE branch_cache (
      branch TEXT PRIMARY KEY, repo TEXT, ticket TEXT,
      linear_id TEXT NOT NULL DEFAULT '', mr TEXT, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE discussions (
      repo TEXT NOT NULL, iid INTEGER NOT NULL, discussions TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, PRIMARY KEY (repo, iid)
    );
    CREATE TABLE notify_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, event TEXT NOT NULL
    );
    CREATE TABLE project_mrs (
      repo TEXT NOT NULL, iid INTEGER NOT NULL, pr TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, PRIMARY KEY (repo, iid)
    );
    CREATE TABLE project_mrs_meta (
      repo TEXT PRIMARY KEY, list_synced_at INTEGER NOT NULL DEFAULT 0,
      delta_synced_at INTEGER, source TEXT NOT NULL DEFAULT 'poll',
      project_path TEXT NOT NULL DEFAULT '', scope TEXT
    );
    CREATE TABLE project_mr_demands (
      repo TEXT NOT NULL, client TEXT NOT NULL, authors TEXT NOT NULL,
      declared_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (repo, client)
    );
    CREATE TABLE kv (
      ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (ns, k)
    );
  `);
  db.query("INSERT INTO branch_cache (branch, repo, ticket, linear_id, mr, fetched_at) VALUES (?, ?, ?, ?, ?, ?);")
    .run("main", "repo-a", null, "RT-1", null, 1000);
  db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?);")
    .run("events-cursor", "repo-a", JSON.stringify({ since: null, lastEventId: 5 }), 999);
  db.exec("PRAGMA user_version = 1;");
  db.close();
  return db;
}

describe("openStateDb: v1 database migrates to v9", () => {
  test("existing v1 rows survive, and v2's, v3's, v4's, v6's, v7's, v8's, and v9's new tables and columns appear alongside them", () => {
    const dbPath = join(dir, "state.db");
    buildV1Fixture(dbPath);

    const db = openStateDb(dbPath, "cli");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);

    const branchRow = db.query("SELECT branch, repo, linear_id, fetched_at FROM branch_cache WHERE branch = ?;").get("main");
    expect(branchRow).toEqual({ branch: "main", repo: "repo-a", linear_id: "RT-1", fetched_at: 1000 });

    const kvRow = db.query("SELECT v FROM kv WHERE ns = ? AND k = ?;").get("events-cursor", "repo-a") as { v: string };
    expect(JSON.parse(kvRow.v)).toEqual({ since: null, lastEventId: 5 });

    const { n: claimCount } = db.query("SELECT COUNT(*) as n FROM endpoint_claims;").get() as { n: number };
    const { n: historyCount } = db.query("SELECT COUNT(*) as n FROM run_history;").get() as { n: number };
    expect(claimCount).toBe(0);
    expect(historyCount).toBe(0);

    db.close();
  });

  test("the legacy-import seam does not re-fire: a legacy file present at the v1->v2 bump is left untouched", () => {
    const dbPath = join(dir, "state.db");
    buildV1Fixture(dbPath);
    const legacyPath = join(dir, "fake-store.json");
    writeFileSync(legacyPath, JSON.stringify({ hello: "world" }));

    let called = false;
    LEGACY_IMPORTS.push({
      file: "fake-store.json",
      import: () => { called = true; },
    });

    const db = openStateDb(dbPath, "cli");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(called).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
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
    expect(userVersion(db1)).toBe(SCHEMA_VERSION);
    expect(importCount).toBe(1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(userVersion(db2)).toBe(SCHEMA_VERSION);
    expect(importCount).toBe(1); // not re-imported
    db2.close();
  });

  test("a future SCHEMA_VERSION bump replaying the full DDL string against an already-v7 db does not throw on the sections column", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    expect(userVersion(db1)).toBe(SCHEMA_VERSION);
    db1.close();

    // Force user_version back below SCHEMA_VERSION on a db that already has
    // the v7 shape (sections column included) -- exactly what every existing
    // v7 db looks like to a future SCHEMA_VERSION bump, whose migration
    // re-execs this same combined DDL string.
    const raw = new Database(dbPath);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
    raw.close();

    let db2: Database | undefined;
    expect(() => {
      db2 = openStateDb(dbPath, "cli");
    }).not.toThrow();

    expect(userVersion(db2!)).toBe(SCHEMA_VERSION);
    const sectionsColumns = (db2!.query("PRAGMA table_info(project_mr_demands);").all() as { name: string }[]).filter(
      (c) => c.name === "sections",
    );
    expect(sectionsColumns).toHaveLength(1);
    db2!.close();
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

  test("a throwing legacy importer is isolated: db reaches SCHEMA_VERSION, the other importer's rows land, and the offending file is still renamed", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dbPath = join(dir, "state.db");

      // project-mrs-store's real importer: keys "5" and "05" both bind
      // Number(iidStr) === 5, so the second INSERT hits project_mrs's
      // (repo, iid) PRIMARY KEY and throws mid-transaction.
      const projectMrsPath = join(dir, "project-mrs.json");
      writeFileSync(
        projectMrsPath,
        JSON.stringify({
          "host/repo": {
            mrs: {
              "5": { pr: { iid: 5, title: "first" }, fetchedAt: 111 },
              "05": { pr: { iid: 5, title: "duplicate" }, fetchedAt: 222 },
            },
          },
        }),
      );

      // discussions-file-store's real importer: a benign, unrelated file
      // that must still land even though the importer above throws.
      const discussionsPath = join(dir, "discussions.json");
      writeFileSync(
        discussionsPath,
        JSON.stringify({
          "host/repo:7": { discussions: [{ id: "d1" }], fetchedAt: 333 },
        }),
      );

      const db = openStateDb(dbPath, "cli");

      expect(db.query("PRAGMA user_version;").get()).toEqual({ user_version: SCHEMA_VERSION });

      const discussionsRow = db
        .query("SELECT repo, iid, fetched_at FROM discussions WHERE repo = ? AND iid = ?;")
        .get("host/repo", 7);
      expect(discussionsRow).toEqual({ repo: "host/repo", iid: 7, fetched_at: 333 });

      expect(existsSync(projectMrsPath)).toBe(false);
      expect(existsSync(`${projectMrsPath}.migrated`)).toBe(true);
      expect(existsSync(discussionsPath)).toBe(false);
      expect(existsSync(`${discussionsPath}.migrated`)).toBe(true);

      const warnedAboutOffender = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("project-mrs.json")),
      );
      expect(warnedAboutOffender).toBe(true);

      db.close();
    } finally {
      warnSpy.mockRestore();
    }
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

  test("getStateDb('daemon') reports busy_timeout 250 even after a default open", () => {
    const cli = getStateDb(); // opens singleton, cli flavor
    expect(cli.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    const daemon = getStateDb("daemon"); // same singleton, must not stay at 5000
    expect(daemon.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 250 });
  });
});

describe("startup busy budget — open+migrate blocks, it does not throw", () => {
  test("a daemon-flavor open waits out a write lock held well past its 250ms serve-time budget", async () => {
    // Spec "Migration & contention": "if a CLI process is mid-import when the
    // daemon starts, the daemon blocks in startup, not in its event loop."
    // Under the daemon flavor's 250ms steady-state timeout, runMigrations'
    // BEGIN IMMEDIATE would instead throw SQLITE_BUSY and crash startup.
    const dbPath = join(dir, "state.db");
    openStateDb(dbPath, "cli").close(); // db already exists at v1

    const markerPath = join(dir, "lock-held.marker");
    const holderPath = join(dir, "lock-holder.ts");
    writeFileSync(
      holderPath,
      [
        `import { Database } from "bun:sqlite";`,
        `import { writeFileSync } from "fs";`,
        `const db = new Database(${JSON.stringify(dbPath)});`,
        `db.exec("PRAGMA busy_timeout = 5000;");`,
        `db.exec("BEGIN IMMEDIATE;");`,
        `db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?);").run("startup-race", "held", "1", 1);`,
        `writeFileSync(${JSON.stringify(markerPath)}, "held");`,
        // Longer than 250ms, comfortably under the 5s startup budget — the
        // exact window the spec promises the daemon will wait through.
        `Bun.sleepSync(1200);`,
        `db.exec("COMMIT;");`,
        `db.close();`,
      ].join("\n"),
    );

    const holder = Bun.spawn([process.execPath, "run", holderPath], { stdout: "pipe", stderr: "pipe" });
    while (!existsSync(markerPath)) await Bun.sleep(10);

    const started = Date.now();
    const db = openStateDb(dbPath, "daemon"); // must not throw
    const waitedMs = Date.now() - started;

    expect(waitedMs).toBeGreaterThan(250);
    // Proof it waited for the holder's COMMIT rather than racing past it.
    const { n } = db.query("SELECT COUNT(*) as n FROM kv WHERE ns = 'startup-race';").get() as { n: number };
    expect(n).toBe(1);
    // ...and that the daemon's serve-time policy is back in force afterwards.
    const { timeout } = db.query("PRAGMA busy_timeout;").get() as { timeout: number };
    expect(timeout).toBe(250);

    db.close();
    expect(await holder.exited).toBe(0);
  }, 20_000);
});

describe("corruption escape", () => {
  test("a file that cannot be opened as sqlite is quarantined, then a fresh db is created at SCHEMA_VERSION", () => {
    const dbPath = join(dir, "state.db");
    writeFileSync(dbPath, "definitely not a sqlite database, just bytes");

    const db = openStateDb(dbPath, "cli");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
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
    expect(userVersion(db1)).toBe(SCHEMA_VERSION);
  });

  test("closeStateDb releases the singleton so the next getStateDb call reopens", () => {
    const db1 = getStateDb("cli");
    closeStateDb();
    const db2 = getStateDb("cli");
    expect(db1).not.toBe(db2);
    expect(userVersion(db2)).toBe(SCHEMA_VERSION);
  });

  test("importing db.ts performs no module-load db access (no file created merely by import)", async () => {
    // Fresh module registry cache miss isn't available in bun:test, but we
    // can assert the narrower, directly-testable half of the rule: calling
    // unrelated exports (reading SCHEMA_VERSION, pushing to LEGACY_IMPORTS)
    // never opens or creates a db file on its own.
    const before = SCHEMA_VERSION;
    expect(before).toBe(10);
    LEGACY_IMPORTS.push({ file: "x.json", import: () => {} });
    LEGACY_IMPORTS.length = 0;
    // No db.ts function that touches disk was called above; nothing to assert
    // on disk beyond "the module itself contains no top-level side effects",
    // which is enforced by every other test in this file constructing its own
    // temp dir and never finding a stray state.db.
  });
});

describe("two connections racing v0 (real OS-level race)", () => {
  test("exactly one process imports the legacy store; neither throws; both land at SCHEMA_VERSION", async () => {
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
    expect(userVersion(finalDb)).toBe(SCHEMA_VERSION);
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

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("file mode — 0600", () => {
  test("a freshly created state.db is 0600", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    db.close();
    expect(mode(dbPath)).toBe(0o600);
  });

  test("an existing 0644 state.db is tightened to 0600 on open, not just at creation", () => {
    const dbPath = join(dir, "state.db");
    openStateDb(dbPath, "cli").close();
    chmodSync(dbPath, 0o644);
    expect(mode(dbPath)).toBe(0o644);

    const db = openStateDb(dbPath, "cli");
    db.close();
    expect(mode(dbPath)).toBe(0o600);
  });
});

describe("isolation from unrelated state.db files (pipeline run DBs)", () => {
  test("migrating/chmod'ing rt/state.db never touches a sibling runs/<repo>/<runId>/state.db", () => {
    const home = mkdtempSync(join(tmpdir(), "rt-state-isolation-"));
    // Repointed for real, not just built under a local `home` var: a future
    // selection bug that globs **/state.db anchored on rtDir()'s HOME (rather
    // than going through the lib/state/index.ts barrel) must land in THIS
    // tree to have any chance of finding the decoy — leaving HOME unrepointed
    // would let such a glob evade this test entirely.
    const origHome = process.env.HOME;
    try {
    process.env.HOME = home;
    const rtStatePath = join(home, ".mattstack", "rt", "state.db");
    const decoyPath = join(home, ".mattstack", "runs", "somerepo", "run1", "state.db");
    mkdirSync(dirname(decoyPath), { recursive: true });

    // A decoy pipeline-run db: unrelated schema, written and closed by a
    // SEPARATE writer before our migration ever runs — pipeline-state.sh
    // shells out to the sqlite3 binary, it never shares this process's
    // open handle, so this fixture closes before openStateDb is called.
    const decoyDb = new Database(decoyPath, { create: true });
    decoyDb.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT);");
    decoyDb.query("INSERT INTO runs (id, status) VALUES (1, 'ok');").run();
    decoyDb.close();
    chmodSync(decoyPath, 0o644);

    const decoyModeBefore = mode(decoyPath);
    const decoyMtimeBefore = statSync(decoyPath).mtimeMs;
    const decoyContentBefore = readFileSync(decoyPath);

    const db = openStateDb(rtStatePath, "cli");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();

    expect(mode(decoyPath)).toBe(decoyModeBefore);
    expect(statSync(decoyPath).mtimeMs).toBe(decoyMtimeBefore);
    expect(readFileSync(decoyPath).equals(decoyContentBefore)).toBe(true);
    expect(existsSync(`${decoyPath}-wal`)).toBe(false);
    expect(existsSync(`${decoyPath}-shm`)).toBe(false);

    // The real db, at its own distinct path, DID get tightened — proving
    // the two are independently reachable, not that nothing ran at all.
    expect(mode(rtStatePath)).toBe(0o600);
    } finally {
      process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
