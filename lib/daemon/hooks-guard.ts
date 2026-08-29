/**
 * Hooks guard — keeps core.hooksPath pointed at rt's shim dir for every
 * tracked repo.
 *
 * Watches each repo's .git/config parent directory and re-applies the hooks
 * path when it is clobbered (e.g. by another tool running `git config`).
 */

import { existsSync, watch, type FSWatcher } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { Logger } from "pino";
import { repoDataDir } from "../rt-paths.ts";
import { runCapture } from "../subprocess.ts";
import { loadRepoIndex, resolveGitConfigPath } from "./repo-index.ts";
import type { RepoIndex } from "./handlers/types.ts";

export interface HooksGuard {
  /** Live map of repo git-config watchers (configPath → FSWatcher). */
  watchedConfigs: Map<string, FSWatcher>;
  /** Re-apply rt hooks shim dir if clobbered; returns true if a repair happened. */
  checkAndRepairHooksPath(repoName: string, repoPath: string): Promise<boolean>;
  /** Start a directory watch over a repo's .git/config and run an initial check. */
  startWatchingRepo(repoName: string, repoPath: string): void;
  /** Discover repos from the index and ensure each is watched. */
  refreshWatchedRepos(): void;
  /** Close every watcher (shutdown). */
  closeAll(): void;
}

export function createHooksGuard(
  log: Logger,
  deps: { loadRepoIndexFn?: () => RepoIndex } = {},
): HooksGuard {
  const loadRepoIndexFn = deps.loadRepoIndexFn ?? loadRepoIndex;
  const watchedConfigs = new Map<string, FSWatcher>();

  async function checkAndRepairHooksPath(repoName: string, repoPath: string): Promise<boolean> {
    const dataDir = repoDataDir(repoName);
    const hooksJson = join(dataDir, "hooks.json");
    const shimsDir = join(dataDir, "hooks");

    // Only guard repos that have hooks managed by rt
    if (!existsSync(hooksJson) || !existsSync(shimsDir)) return false;

    const current = await runCapture(["git", "config", "core.hooksPath"], { cwd: repoPath, timeoutMs: 5000 });
    if (current.exitCode === 0) {
      const currentHooksPath = current.stdout.trim();

      // Repair unless hooksPath points EXACTLY at this repo's shims dir. The old
      // check accepted any path merely containing the rt state-dir name, so it
      // never repaired a stale-but-rt-owned path — e.g. the pre-repos/ location
      // <rtDir>/<repo>/hooks after the move to <rtDir>/repos/<repo>/hooks.
      // Compare resolved paths.
      if (resolve(currentHooksPath) === resolve(shimsDir)) return false;

      // Hooks path was clobbered — re-apply
      const set = await runCapture(["git", "config", "core.hooksPath", shimsDir], { cwd: repoPath, timeoutMs: 5000 });
      if (set.exitCode !== 0) return false;
      log.warn({ repo: repoName, was: currentHooksPath }, "hooks-guard repaired core.hooksPath");
      return true;
    }

    // git config core.hooksPath not set — set it
    const set = await runCapture(["git", "config", "core.hooksPath", shimsDir], { cwd: repoPath, timeoutMs: 5000 });
    if (set.exitCode !== 0) return false;
    log.info({ repo: repoName }, "hooks-guard set core.hooksPath");
    return true;
  }

  function startWatchingRepo(repoName: string, repoPath: string): void {
    const configPath = resolveGitConfigPath(repoPath);
    if (!configPath || !existsSync(configPath)) return;

    // Don't double-watch
    if (watchedConfigs.has(configPath)) return;

    // Watch the PARENT DIRECTORY, not the file itself.
    //
    // git config always writes atomically: it writes to .git/config.lock then
    // renames it to .git/config. Each rename creates a new inode. An fs.watch
    // on a specific file inode goes deaf after the first such rename, silently
    // missing every subsequent change. Watching the directory is inode-agnostic:
    // it fires on any create/rename/modify within the dir regardless of inodes.
    const gitDir     = dirname(configPath);
    const configFile = basename(configPath); // "config"

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const watcher = watch(gitDir, (_event, filename) => {
      // Only act on the config file — ignore refs, COMMIT_EDITMSG, etc.
      if (filename !== configFile) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void checkAndRepairHooksPath(repoName, repoPath);
      }, 100); // slightly longer debounce: rename events can cluster
    });

    // FSWatcher is an EventEmitter: an 'error' with no listener is an
    // uncaught exception, which installCrashHandlers turns into a daemon
    // exit(1) and a launchd relaunch that re-arms the same watchers and
    // hits the same limit (EMFILE, a watched dir unlinked, ...).
    watcher.on("error", (err) => {
      log.warn({ err, repo: repoName, configPath }, "hooks-guard watcher error; dropping this watch");
      watchedConfigs.delete(configPath);
      try { watcher.close(); } catch { /* already gone */ }
    });

    watchedConfigs.set(configPath, watcher);
    log.debug({ repo: repoName, file: `${gitDir}/${configFile}` }, "watching repo");

    // Initial check
    void checkAndRepairHooksPath(repoName, repoPath);
  }

  function refreshWatchedRepos(): void {
    const repos = loadRepoIndexFn();
    const liveConfigPaths = new Set<string>();
    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (!existsSync(repoPath)) continue;
      const configPath = resolveGitConfigPath(repoPath);
      if (configPath) liveConfigPaths.add(configPath);
      startWatchingRepo(repoName, repoPath);
    }
    // Reconcile, not just add: a repo relocated (rt repos locate) or removed
    // from the index leaves its old watcher pointed at a dead .git dir, and
    // status().watchedRepos over-reports forever without this.
    for (const [configPath, watcher] of watchedConfigs) {
      if (liveConfigPaths.has(configPath)) continue;
      try { watcher.close(); } catch { /* already gone */ }
      watchedConfigs.delete(configPath);
    }
  }

  function closeAll(): void {
    for (const [, watcher] of watchedConfigs.entries()) {
      try { watcher.close(); } catch { /* */ }
    }
    watchedConfigs.clear();
  }

  return { watchedConfigs, checkAndRepairHooksPath, startWatchingRepo, refreshWatchedRepos, closeAll };
}
