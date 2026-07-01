import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome } from "../harness.ts";
import { startInteractive, type TermwrightSession } from "../interactive.ts";
import {
  createFixtureRepo,
  seedRepoIndex,
  addWorktree,
  ensureShellWrapper,
} from "../fixtures.ts";

describe("picker identity", () => {
  let session: TermwrightSession | null = null;
  let cleanups: Array<() => void> = [];

  function makeHome(): string {
    const { path, cleanup } = createTestHome();
    cleanups.push(cleanup);
    mkdirSync(join(path, ".rt"), { recursive: true });
    writeFileSync(join(path, ".rt", "daemon.json"), "{}");
    return path;
  }

  afterEach(async () => {
    if (session) {
      await session.stop();
      session = null;
    }
    for (const fn of cleanups) fn();
    cleanups = [];
  });

  test("single-repo with worktrees: ctrl-up at worktree picker exits", async () => {
    const home = makeHome();
    ensureShellWrapper(home);

    const { path: repoPath, repoName } = createFixtureRepo(home, {
      name: "identity-single",
      scripts: { dev: "echo dev" },
    });
    addWorktree(repoPath, "feature-a", home);
    seedRepoIndex(home, [{ name: repoName, path: repoPath }]);

    // rt cd from HOME (outside any repo). Repo auto-selected (only 1),
    // worktree picker shown.
    session = await startInteractive({ args: ["cd"], home });
    await session.waitForText("worktree", 8000);

    // ctrl-up at worktree picker with 1 repo -> exit
    await session.ctrl("up");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 15_000);

  test("single-worktree repo: rt run ctrl-up exits", async () => {
    const home = makeHome();

    const { path: repoPath } = createFixtureRepo(home, {
      name: "only-repo",
      scripts: { dev: "echo dev", test: "echo test", lint: "echo lint" },
    });

    // rt run from inside the single-worktree repo.
    // Identity auto-resolved, worktree auto-selected.
    // No packages -> jumps to script picker.
    session = await startInteractive({ args: ["run"], home, cwd: repoPath });
    await session.waitForText("Select script", 8000);

    // First ctrl-up re-enters via the full picker chain (1 repo,
    // 1 worktree -> auto-selected, re-shows script picker).
    await session.ctrl("up");
    await session.waitForText("Select script", 5000);

    // Second ctrl-up propagates to process.exit(0) since there's only
    // 1 known repo.
    await session.ctrl("up");

    const code = await session.exitCode;
    expect(code).toBe(0);
    session = null;
  }, 20_000);

  test("multi-repo: ctrl-up at worktree picker goes back to repo picker", async () => {
    const home = makeHome();
    ensureShellWrapper(home);

    const { path: path1, repoName: name1 } = createFixtureRepo(home, {
      name: "identity-multi-a",
      scripts: { dev: "echo dev" },
    });
    addWorktree(path1, "feat-1", home);

    const { path: path2, repoName: name2 } = createFixtureRepo(home, {
      name: "identity-multi-b",
      scripts: { dev: "echo dev" },
    });
    addWorktree(path2, "feat-2", home);

    seedRepoIndex(home, [
      { name: name1, path: path1 },
      { name: name2, path: path2 },
    ]);

    // rt cd from HOME -> shows repo picker (2 repos)
    session = await startInteractive({ args: ["cd"], home });
    await session.waitForText("Pick a repo", 8000);

    // Select first repo -> worktree picker
    await session.press("Enter");
    await session.waitForText("worktree", 5000);

    // ctrl-up -> back to repo picker
    await session.ctrl("up");
    await session.waitForText("Pick a repo", 5000);

    const screen = await session.screen();
    expect(screen).toContain("identity-multi-a");
    expect(screen).toContain("identity-multi-b");
  }, 15_000);
});
