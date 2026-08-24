import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getKnownRepos, loadRepoIndexEntries, updateRepoIndex } from "../../lib/repo-index.ts";
import { loadRepoTracking } from "../../lib/repo-tracking.ts";
import { closeStateDb } from "../../lib/state/index.ts";
import { reposPrune, reposRegister, type RegisterDeps } from "../repos.ts";

function testDeps(): RegisterDeps & { lines: string[] } {
  const lines: string[] = [];
  return { print: (s) => lines.push(s), lines };
}

/** Every usage/bad-path refusal exits via the real process.exit(2) (exitUserError), not an injectable seam. */
async function runExpectingProcessExit(fn: () => Promise<void>): Promise<number | undefined> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  try {
    await fn();
    return undefined;
  } catch {
    return exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
  } finally {
    exitSpy.mockRestore();
  }
}

describe("reposRegister", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    // A per-test HOME (not the ambient test-setup.ts one) — reposRegister
    // writes real repos.json + settings-store files, and the ambient HOME is
    // shared with other test files that assume nothing else touches it.
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-register-home-")));
    process.env.HOME = home;
    // getStateDb()'s singleton binds to whatever HOME is live on its first
    // call and is held for the rest of the process — without this reset,
    // this test's loadRepoIndex traffic reuses a handle opened under a
    // different HOME (or, after afterEach below, a deleted one).
    closeStateDb();
  });

  afterEach(() => {
    closeStateDb();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function makeTempRepo(): string {
    const dir = realpathSync(mkdtempSync(join(home, "repo-")));
    execSync("git init -q", { cwd: dir });
    return dir;
  }

  test("registers a repo path into the global index", async () => {
    const repoPath = makeTempRepo();
    const name = basename(repoPath);
    const deps = testDeps();

    await reposRegister([repoPath], {}, deps);

    const entry = getKnownRepos().find((r) => r.repoName === name);
    expect(entry).toBeDefined();
    expect(entry!.worktrees[0]!.path).toBe(repoPath);
    expect(deps.lines).toEqual([`registered ${name} (${repoPath})`]);
  });

  test("--track poll --caches branches,project-mrs grants tracking", async () => {
    const repoPath = makeTempRepo();
    const name = basename(repoPath);
    const deps = testDeps();

    await reposRegister([repoPath, "--track", "poll", "--caches", "branches,project-mrs"], {}, deps);

    const tracking = loadRepoTracking();
    expect(tracking[name]).toEqual({ mode: "poll", caches: ["branches", "project-mrs"] });
  });

  test("--track without --caches defaults to branches", async () => {
    const repoPath = makeTempRepo();
    const name = basename(repoPath);
    const deps = testDeps();

    await reposRegister([repoPath, "--track", "live"], {}, deps);

    const tracking = loadRepoTracking();
    expect(tracking[name]).toEqual({ mode: "live", caches: ["branches"] });
  });

  test("--json prints a contract envelope naming the registered repo", async () => {
    const repoPath = makeTempRepo();
    const name = basename(repoPath);
    const deps = testDeps();

    await reposRegister([repoPath, "--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({ contract: 1, registered: [{ name, path: repoPath, tracking: null }] });
  });

  test("no paths exits 2 with a usage error", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposRegister([], {}, deps));
    expect(code).toBe(2);
  });

  test("a nonexistent path exits 2 with a bad-path error", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposRegister(["/no/such/path/here"], {}, deps));
    expect(code).toBe(2);
  });

  test("an unknown --track value exits 2", async () => {
    const repoPath = makeTempRepo();
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposRegister([repoPath, "--track", "bogus"], {}, deps));
    expect(code).toBe(2);
  });

  test("a directory that exists but isn't a git repo exits 2, not a claimed success", async () => {
    const plainDir = realpathSync(mkdtempSync(join(home, "notarepo-")));
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposRegister([plainDir], {}, deps));

    expect(code).toBe(2);
    expect(getKnownRepos().find((r) => r.repoName === basename(plainDir))).toBeUndefined();
  });

  test("multi-path register is all-or-nothing: a bad path later in the list leaves an earlier good one untouched", async () => {
    const goodPath = makeTempRepo();
    const goodName = basename(goodPath);
    const badPath = realpathSync(mkdtempSync(join(home, "notarepo-")));
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposRegister([goodPath, badPath, "--track", "live"], {}, deps));

    expect(code).toBe(2);
    // Neither the index nor the tracking grant for the good path was written —
    // a partial apply would leave it indexed without the --track it asked for.
    expect(getKnownRepos().find((r) => r.repoName === goodName)).toBeUndefined();
    expect(loadRepoTracking()[goodName]).toBeUndefined();
  });
});

describe("reposPrune", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-prune-home-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    closeStateDb();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function makeTempRepo(name: string): string {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q", { cwd: dir });
    return realpathSync(dir);
  }

  test("reports a clean index as clean", async () => {
    updateRepoIndex("alpha", makeTempRepo("alpha"));
    const deps = testDeps();

    await reposPrune([], {}, deps);

    expect(deps.lines).toEqual(["repo index is clean — nothing to prune"]);
  });

  test("removes a renamed repo's retired name and says which name kept the directory", async () => {
    const deck = makeTempRepo("deck");
    symlinkSync(deck, join(home, "local-apps"));
    updateRepoIndex("local-apps", join(home, "local-apps"));
    updateRepoIndex("deck", deck);
    const deps = testDeps();

    await reposPrune([], {}, deps);

    // updateRepoIndex stores what `git worktree list` reports, which resolves
    // the symlink — so both names land on the SAME spelling here. The other
    // shape (a row still holding the symlink path, from an older write or the
    // legacy repos.json import) is covered in repo-index-rename.test.ts.
    expect(deps.lines).toEqual([
      `removed local-apps (${deck.replace(homedir(), "~")}) — same directory as deck`,
    ]);
    expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["deck"]);
  });

  test("--dry-run says what it would do and writes nothing", async () => {
    updateRepoIndex("gone", join(home, "never-existed"));
    const deps = testDeps();

    await reposPrune(["--dry-run"], {}, deps);

    expect(deps.lines).toEqual([
      `would remove gone (${join(home, "never-existed").replace(homedir(), "~")}) — path no longer exists`,
    ]);
    expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["gone"]);
  });

  test("--json emits the removals in an envelope", async () => {
    updateRepoIndex("gone", join(home, "never-existed"));
    const deps = testDeps();

    await reposPrune(["--json"], {}, deps);

    const parsed = JSON.parse(deps.lines[0]!);
    expect(parsed.contract).toBe(1);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.removed).toEqual([
      { repoName: "gone", path: join(home, "never-existed"), reason: "missing" },
    ]);
  });

  test("an unknown flag is a usage error, not a silent no-op prune", async () => {
    updateRepoIndex("gone", join(home, "never-existed"));
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposPrune(["--force"], {}, deps));

    expect(code).toBe(2);
    expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["gone"]);
  });
});
