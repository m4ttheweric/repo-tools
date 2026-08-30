import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { setSetting } from "../settings/write.ts";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { getKnownRepos, getKnownReposAsync } from "../repo-index.ts";

const REPO_INDEX_NS = "repo-index";

test("resolveIndexPathForIdentity no longer reaches a sync git via observedMainPath", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "repo-index.ts"), "utf8");
  // observedMainPath (sync execSync) must not be called from the async resolver path.
  expect(src).toMatch(/observedMainPathAsync/);
});

// ─── getKnownReposAsync parity (rt cd repo-list cache, task 1) ─────────────
//
// getKnownReposAsync must deep-equal getKnownRepos for the same on-disk
// state: same rows, order, branches, missing/registered flags. This is the
// whole point of the async twin (it exists so a daemon poll can build the
// list without sync-exec), so the test asserts equality directly rather than
// re-deriving expectations by hand.

describe("getKnownReposAsync parity", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-repoindex-async-home-"));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  /** A directory with just a `.git` marker — enough for the scanner's
   *  `existsSync(join(path, ".git"))` probe; no real git repo needed. */
  function markerRepo(parent: string, name: string): string {
    const dir = join(parent, name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  }

  /** A real, minimal git repo. */
  function realRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: dir, stdio: "pipe" });
  }

  function indexRepo(repoName: string, mainPath: string): void {
    setKvValue(REPO_INDEX_NS, repoName, mainPath);
  }

  function setRepoRoots(entries: unknown[]): void {
    setSetting("rt.repoRoots", entries, "machine");
  }

  test("matches getKnownRepos for single-worktree, linked-worktree, unregistered, and missing rows", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rt-async-parity-"));

    // Single-worktree real repo.
    const singleRoot = join(parent, "single-repo");
    realRepo(singleRoot);
    indexRepo("single-repo", singleRoot);

    // Real repo with an added linked worktree.
    const multiRoot = join(parent, "multi-repo");
    realRepo(multiRoot);
    const linkedPath = join(parent, "multi-repo-linked");
    execSync(`git worktree add -b linked-branch ${JSON.stringify(linkedPath)}`, { cwd: multiRoot, stdio: "pipe" });
    indexRepo("multi-repo", multiRoot);

    // Unregistered markerRepo candidate, surfaced via a configured root.
    const scanRoot = mkdtempSync(join(tmpdir(), "rt-async-parity-scan-"));
    const candidate = markerRepo(scanRoot, "candidate-repo");
    setRepoRoots([scanRoot]);

    // Missing/lost row.
    const goneParent = mkdtempSync(join(tmpdir(), "rt-async-parity-gone-"));
    const gonePath = join(goneParent, "gone-repo");
    realRepo(gonePath);
    indexRepo("gone-repo", gonePath);
    rmSync(goneParent, { recursive: true, force: true });

    const syncResult = getKnownRepos({ includeMissing: true });
    const asyncResult = await getKnownReposAsync({ includeMissing: true });

    expect(asyncResult).toEqual(syncResult);

    // Sanity: the fixture actually exercised all four shapes, so an empty
    // parity pass (e.g. everything silently skipped) can't sneak by green.
    const names = syncResult.map((r) => r.repoName);
    expect(names).toContain("single-repo");
    expect(names).toContain("multi-repo");
    expect(names).toContain("candidate-repo");
    expect(names).toContain("gone-repo");
    const multi = syncResult.find((r) => r.repoName === "multi-repo");
    expect(multi?.worktrees.length).toBe(2);
    const gone = syncResult.find((r) => r.repoName === "gone-repo");
    expect(gone?.missing).toBe(true);

    void candidate;
    rmSync(parent, { recursive: true, force: true });
    rmSync(scanRoot, { recursive: true, force: true });
  });

  test("matches getKnownRepos without includeMissing (missing rows dropped on both sides)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rt-async-parity-nomissing-"));
    const root = join(parent, "repo-a");
    realRepo(root);
    indexRepo("repo-a", root);

    const syncResult = getKnownRepos();
    const asyncResult = await getKnownReposAsync();
    expect(asyncResult).toEqual(syncResult);

    rmSync(parent, { recursive: true, force: true });
  });
});
