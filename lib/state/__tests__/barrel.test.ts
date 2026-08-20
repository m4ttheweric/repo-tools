/**
 * lib/state/index.ts — the barrel contract (RT-48, orchestrator ruling).
 *
 * Two halves, both load-bearing:
 *  1. Importing ONLY the barrel is enough to make a fresh db import every
 *     store's legacy JSON. The v0->v1 migration is one-shot, so a consumer
 *     that opened the db before a store module had been imported would skip
 *     that store's legacy import permanently.
 *  2. Importing the barrel opens NO database (registration is pure array
 *     pushes) — spec "The database": no module-load db access, ever.
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The ONLY import of state APIs in this file — deliberately: it is the thing
// under test. Do not add a direct ./db.ts or ./branch-cache.ts import here.
import { LEGACY_IMPORTS, openStateDb } from "../index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-state-barrel-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("lib/state barrel", () => {
  test("importing only the barrel registers every store's legacy importer", () => {
    // Not an exhaustive list assertion: later RT-48 tasks add more entries.
    // What must hold is that a store module's registration happened without
    // this file importing that module.
    expect(LEGACY_IMPORTS.map((e) => e.file)).toContain("branch-cache.json");
  });

  test("a fresh db opened through the barrel imports a legacy branch-cache.json", () => {
    writeFileSync(
      join(dir, "branch-cache.json"),
      JSON.stringify({
        entries: {
          "feature/barrel": { ticket: null, linearId: "RT-48", mr: null, fetchedAt: 4242 },
        },
      }),
    );

    const db = openStateDb(join(dir, "state.db"));
    const row = db
      .query("SELECT branch, linear_id, fetched_at FROM branch_cache WHERE branch = ?;")
      .get("feature/barrel") as { branch: string; linear_id: string; fetched_at: number } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row!.linear_id).toBe("RT-48");
    expect(row!.fetched_at).toBe(4242);
    // The source is consumed, exactly as the migration promises.
    expect(existsSync(join(dir, "branch-cache.json"))).toBe(false);
    expect(existsSync(join(dir, "branch-cache.json.migrated"))).toBe(true);
  });

  test("importing the barrel opens no database and touches no file", async () => {
    // Fresh child process so module-load side effects are observable: the
    // parent already imported the barrel above. HOME is repointed at an
    // empty dir so any lazy rtDir() write would show up as a file.
    const home = join(dir, "home");
    const barrel = join(import.meta.dir, "..", "index.ts");
    const script = `
      import ${JSON.stringify(barrel)};
      console.log("imported");
    `;
    const scriptPath = join(dir, "import-barrel.ts");
    writeFileSync(scriptPath, script);

    const proc = Bun.spawn(["bun", "run", scriptPath], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe("imported");
    expect(stderr).toBe("");

    // Nothing under HOME at all: no ~/.mattstack/rt, no state.db, no
    // migration of the RT-46 legacy dir.
    const created = existsSync(home) ? readdirSync(home) : [];
    expect(created).toEqual([]);
  });

  test("openStateDb is reachable through the barrel and yields a usable handle", () => {
    const db = openStateDb(join(dir, "state.db"));
    expect(db).toBeInstanceOf(Database);
    db.close();
  });
});
