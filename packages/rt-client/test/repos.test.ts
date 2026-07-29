import { describe, expect, test, afterEach } from "bun:test";
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
});
