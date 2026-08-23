import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoNameForPath } from "../src/repos.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-client-repos-test-"));
  dirs.push(dir);
  return dir;
}

function writeReposJson(contents: Record<string, string>): string {
  const path = join(fixtureDir(), "repos.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** Mirrors rt's real state.db kv table shape closely enough for repoNameFromStateDb's query (ns/k/v columns; v holds JSON-encoded values, matching setKvValue). Lives alongside repos.json, same as the real rt data dir. */
function writeStateDb(dir: string, repoIndex: Record<string, string>): void {
  const db = new Database(join(dir, "state.db"), { create: true });
  db.exec("CREATE TABLE kv (ns TEXT, k TEXT, v TEXT, updated_at INTEGER);");
  for (const [repoName, path] of Object.entries(repoIndex)) {
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('repo-index', ?, ?, 0);").run(repoName, JSON.stringify(path));
  }
  db.close();
}

describe("repoNameForPath", () => {
  test("returns the repo name on an exact path match", () => {
    const path = writeReposJson({ "assured-dev": "/Users/matt/Documents/GitHub/assured/harry" });
    expect(repoNameForPath("/Users/matt/Documents/GitHub/assured/harry", path)).toBe("assured-dev");
  });

  test("returns null when no entry's value matches the path", () => {
    const path = writeReposJson({ "assured-dev": "/Users/matt/Documents/GitHub/assured/harry" });
    expect(repoNameForPath("/somewhere/else", path)).toBeNull();
  });

  test("returns null when the repos.json file does not exist", () => {
    const missing = join(fixtureDir(), "does-not-exist.json");
    expect(repoNameForPath("/anything", missing)).toBeNull();
  });

  test("returns null (never throws) on corrupt JSON", () => {
    const path = join(fixtureDir(), "repos.json");
    writeFileSync(path, "not valid json {{{");
    expect(repoNameForPath("/anything", path)).toBeNull();
  });

  test("prefers a matching state.db entry over a stale repos.json entry for the same path", () => {
    const dir = fixtureDir();
    const path = join(dir, "repos.json");
    writeFileSync(path, JSON.stringify({ "old-name": "/Users/matt/Documents/GitHub/assured/harry" }));
    writeStateDb(dir, { "new-name": "/Users/matt/Documents/GitHub/assured/harry" });

    expect(repoNameForPath("/Users/matt/Documents/GitHub/assured/harry", path)).toBe("new-name");
  });

  test("falls back to repos.json when state.db has no matching entry", () => {
    const dir = fixtureDir();
    const path = join(dir, "repos.json");
    writeFileSync(path, JSON.stringify({ "assured-dev": "/Users/matt/Documents/GitHub/assured/harry" }));
    writeStateDb(dir, { "unrelated-repo": "/somewhere/else" });

    expect(repoNameForPath("/Users/matt/Documents/GitHub/assured/harry", path)).toBe("assured-dev");
  });

  test("falls back to repos.json when state.db does not exist", () => {
    const path = writeReposJson({ "assured-dev": "/Users/matt/Documents/GitHub/assured/harry" });
    expect(repoNameForPath("/Users/matt/Documents/GitHub/assured/harry", path)).toBe("assured-dev");
  });
});
