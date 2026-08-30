/**
 * S057: fs.watch handles in hooks-guard have no 'error' listener (an
 * emitted error with no listener is an uncaught exception, which
 * installCrashHandlers turns into a daemon exit(1) and a launchd relaunch
 * that re-arms the same watchers and hits the same limit); and
 * refreshWatchedRepos is add-only, so a relocated or removed repo's stale
 * watcher on a dead .git dir is kept forever.
 *
 * R044: checkAndRepairHooksPath must not revert core.hooksPath when
 * another tool (husky, lefthook, a manual `git config`) owns it now.
 *
 * R045: startWatchingRepo must not let a synchronous fs.watch() throw
 * (EMFILE/ENOSPC at creation) escape and crash the daemon.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { repoDataDir } from "../../rt-paths.ts";
import { createHooksGuard } from "../hooks-guard.ts";

const log = pino({ level: "silent" });

function makeFakeLog() {
  const warnings: unknown[][] = [];
  const fake = {
    warn: (...args: unknown[]) => { warnings.push(args); },
    info: () => {},
    debug: () => {},
  };
  return { log: fake as unknown as typeof log, warnings };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-hooks-guard-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeRepo(name: string): string {
  const repoPath = join(dir, name);
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  writeFileSync(join(repoPath, ".git", "config"), "[core]\n");
  return repoPath;
}

/** A real git repo, needed to exercise `git config core.hooksPath` for real. */
function makeGitRepo(name: string): string {
  const repoPath = join(dir, name);
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  return repoPath;
}

/** Sets up rt's own hooks.json + shims dir so a repo is rt-guarded. */
function makeRtManagedRepo(name: string): { repoPath: string; shimsDir: string } {
  const repoPath = makeGitRepo(name);
  const dataDir = repoDataDir(name);
  const shimsDir = join(dataDir, "hooks");
  mkdirSync(shimsDir, { recursive: true });
  writeFileSync(join(dataDir, "hooks.json"), "{}");
  return { repoPath, shimsDir };
}

test("an emitted 'error' event on the watcher does not throw, and self-heals the bookkeeping", async () => {
  const repoPath = makeRepo("a");
  const guard = createHooksGuard(log);
  guard.startWatchingRepo("a", repoPath);
  expect(guard.watchedConfigs.size).toBe(1);

  const [configPath, watcher] = [...guard.watchedConfigs.entries()][0]!;
  expect(() => watcher.emit("error", new Error("EMFILE"))).not.toThrow();
  // give the close/delete a tick if it's deferred
  await Bun.sleep(0);
  expect(guard.watchedConfigs.has(configPath)).toBe(false);
  guard.closeAll();
});

test("refreshWatchedRepos closes and drops a watcher whose repo left the index (relocated or removed)", () => {
  const repoPathA = makeRepo("a");
  const repoPathB = makeRepo("b");
  let index: Record<string, string> = { a: repoPathA, b: repoPathB };
  const guard = createHooksGuard(log, { loadRepoIndexFn: () => index });

  guard.refreshWatchedRepos();
  expect(guard.watchedConfigs.size).toBe(2);

  // "b" is relocated/removed: the index no longer carries it.
  index = { a: repoPathA };
  guard.refreshWatchedRepos();
  expect(guard.watchedConfigs.size).toBe(1);
  guard.closeAll();
});

test("checkAndRepairHooksPath leaves core.hooksPath alone once another tool owns it, and warns once", async () => {
  const { repoPath } = makeRtManagedRepo("husky-repo");
  execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: repoPath });

  const { log: fakeLog, warnings } = makeFakeLog();
  const guard = createHooksGuard(fakeLog);

  const repaired = await guard.checkAndRepairHooksPath("husky-repo", repoPath);
  expect(repaired).toBe(false);

  const current = execFileSync("git", ["config", "core.hooksPath"], { cwd: repoPath }).toString().trim();
  expect(current).toBe(".husky/_");
  expect(warnings.length).toBe(1);

  // A second check on the same still-foreign value must not warn again.
  await guard.checkAndRepairHooksPath("husky-repo", repoPath);
  expect(warnings.length).toBe(1);
});

test("checkAndRepairHooksPath still repairs a stale rt-owned hooksPath (pre-repos/ legacy layout)", async () => {
  const { repoPath, shimsDir } = makeRtManagedRepo("legacy-repo");
  const legacyShimsDir = join(repoDataDir("legacy-repo"), "..", "legacy-repo-old-hooks");
  mkdirSync(legacyShimsDir, { recursive: true });
  execFileSync("git", ["config", "core.hooksPath", legacyShimsDir], { cwd: repoPath });

  const guard = createHooksGuard(log);
  const repaired = await guard.checkAndRepairHooksPath("legacy-repo", repoPath);
  expect(repaired).toBe(true);

  const current = execFileSync("git", ["config", "core.hooksPath"], { cwd: repoPath }).toString().trim();
  expect(current).toBe(shimsDir);
});

test("startWatchingRepo does not throw when fs.watch throws synchronously at creation (EMFILE)", () => {
  const repoPath = makeRepo("c");
  const { log: fakeLog, warnings } = makeFakeLog();
  const throwingWatch = () => { throw Object.assign(new Error("EMFILE"), { code: "EMFILE" }); };
  const guard = createHooksGuard(fakeLog, { watchFn: throwingWatch as unknown as typeof import("fs").watch });

  expect(() => guard.startWatchingRepo("c", repoPath)).not.toThrow();
  expect(guard.watchedConfigs.size).toBe(0);
  expect(warnings.length).toBe(1);
});
