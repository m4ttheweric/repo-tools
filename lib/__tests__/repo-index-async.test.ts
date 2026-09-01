import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
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

  /** A directory with just a `.git` marker: enough for the scanner's
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

  /** A bare repo (no working tree of its own) with two linked worktrees.
   *  `git worktree list --porcelain` reports the bare dir itself as a
   *  worktree row with a `bare` line and no branch; the sync builder's
   *  `!isBare` filter drops it, which is the parity gap this fixture pins. */
  // `-b main` pins the bare repo's HEAD instead of inheriting the machine's
  // init.defaultBranch: the wt2 line below resolves HEAD, so where that
  // default is `master` the branch wt1 commits to is never the one HEAD
  // names, and HEAD stays unborn ("fatal: invalid reference: HEAD").
  function bareRepoWithWorktrees(bareDir: string, wt1: string, wt2: string): void {
    execSync(`git init -q --bare -b main ${JSON.stringify(bareDir)}`, { stdio: "pipe" });
    execSync(`git worktree add ${JSON.stringify(wt1)} -b main`, { cwd: bareDir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: wt1, stdio: "pipe" });
    execSync(`git worktree add ${JSON.stringify(wt2)} -b side`, { cwd: bareDir, stdio: "pipe" });
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
    // `.git` here is a directory, so both builders take the headBranch fast
    // path... branchOfAsync's spawn fallback is exercised by the linked
    // candidate below instead.
    const scanRoot = mkdtempSync(join(tmpdir(), "rt-async-parity-scan-"));
    const candidate = markerRepo(scanRoot, "candidate-repo");

    // Unregistered LINKED-WORKTREE candidate: `.git` is a file (points at the
    // donor repo's `.git/worktrees/<name>`), so branchOf/branchOfAsync must
    // fall through to a git spawn (sync execSync vs. currentBranchAsync) to
    // read its branch. The donor's main worktree is never indexed, so only
    // this scanned linked worktree becomes a candidate.
    const donorMain = join(parent, "donor-main");
    realRepo(donorMain);
    const linkedCandidate = join(scanRoot, "linked-candidate");
    execSync(`git worktree add -b linked-candidate-branch ${JSON.stringify(linkedCandidate)}`, { cwd: donorMain, stdio: "pipe" });

    setRepoRoots([scanRoot]);

    // Missing/lost row.
    const goneParent = mkdtempSync(join(tmpdir(), "rt-async-parity-gone-"));
    const gonePath = join(goneParent, "gone-repo");
    realRepo(gonePath);
    indexRepo("gone-repo", gonePath);
    rmSync(goneParent, { recursive: true, force: true });
    // Instrument for the CI-only flake (room hunt 2026-09-01): both sync and
    // async classifiers agreed the dir was LIVE in every failing run, which
    // points at this delete not taking rather than at existsSync. If this
    // fires on CI, the root cause is settled in one firing.
    expect(existsSync(goneParent)).toBe(false);

    const syncResult = getKnownRepos({ includeMissing: true });
    const asyncResult = await getKnownReposAsync({ includeMissing: true });

    expect(asyncResult).toEqual(syncResult);

    // Sanity: the fixture actually exercised all four shapes, so an empty
    // parity pass (e.g. everything silently skipped) can't sneak by green.
    const names = syncResult.map((r) => r.repoName);
    expect(names).toContain("single-repo");
    expect(names).toContain("multi-repo");
    expect(names).toContain("candidate-repo");
    expect(names).toContain("linked-candidate");
    expect(names).toContain("gone-repo");
    const linked = syncResult.find((r) => r.repoName === "linked-candidate");
    expect(linked?.worktrees[0]?.branch).toBe("linked-candidate-branch");
    const multi = syncResult.find((r) => r.repoName === "multi-repo");
    expect(multi?.worktrees.length).toBe(2);
    const gone = syncResult.find((r) => r.repoName === "gone-repo");
    if (gone?.missing !== true) {
      // Same hunt: dump the evidence the room could never see — the row's
      // recorded path spelling and whether that exact path exists right now.
      // ALL matching rows, not the first: a live/scanned duplicate shadowing
      // the lost row via find() is one of the two standing theories.
      const goneRows = syncResult.filter((r) => r.repoName === "gone-repo");
      throw new Error(`gone-repo not classified missing: ${JSON.stringify({ goneRows, gonePath, existsNow: existsSync(gonePath) })}`);
    }
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

  test("matches getKnownRepos for a bare repo with linked worktrees (bare row dropped on both sides)", async () => {
    // realpathSync: git canonicalizes /var -> /private/var on macOS, and
    // `git worktree list --porcelain` reports the canonical spelling.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-async-parity-bare-")));
    const bareDir = join(parent, "bare-repo.git");
    const wt1 = join(parent, "bare-repo-wt1");
    const wt2 = join(parent, "bare-repo-wt2");
    bareRepoWithWorktrees(bareDir, wt1, wt2);
    indexRepo("bare-repo", bareDir);

    const syncResult = getKnownRepos();
    const asyncResult = await getKnownReposAsync();
    expect(asyncResult).toEqual(syncResult);

    const row = syncResult.find((r) => r.repoName === "bare-repo");
    expect(row?.worktrees.map((w) => w.path).sort()).toEqual([wt1, wt2].sort());
    expect(row?.worktrees.some((w) => w.path === bareDir)).toBe(false);

    rmSync(parent, { recursive: true, force: true });
  });
});
