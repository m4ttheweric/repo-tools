/**
 * S057: fs.watch handles in hooks-guard have no 'error' listener (an
 * emitted error with no listener is an uncaught exception, which
 * installCrashHandlers turns into a daemon exit(1) and a launchd relaunch
 * that re-arms the same watchers and hits the same limit); and
 * refreshWatchedRepos is add-only, so a relocated or removed repo's stale
 * watcher on a dead .git dir is kept forever.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { createHooksGuard } from "../hooks-guard.ts";

const log = pino({ level: "silent" });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-hooks-guard-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeRepo(name: string): string {
  const repoPath = join(dir, name);
  mkdirSync(join(repoPath, ".git"), { recursive: true });
  writeFileSync(join(repoPath, ".git", "config"), "[core]\n");
  return repoPath;
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
