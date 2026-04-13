/**
 * Workspace Sync — watches a .code-workspace file across all worktrees
 * and auto-syncs changes, preserving per-worktree peacock settings.
 *
 * Part of the rt daemon. Adapted from scripts/sync-workspace.ts.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  watch, statSync, readdirSync, appendFileSync,
  type FSWatcher,
} from "fs";
import { join, resolve, basename, dirname } from "path";
import { execSync } from "child_process";
import { RT_DIR } from "../daemon-config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceSyncConfig {
  fileName: string;
  enabled: boolean;
  preserveKeys: string[];
  lastSyncAt?: string;
  lastSyncSource?: string;
}

interface WorkspaceSyncState {
  config: WorkspaceSyncConfig;
  watchers: FSWatcher[];
  repoName: string;
}

// ─── JSONC Parse (strip comments) ────────────────────────────────────────────

function parseJsonc(text: string): any {
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([\]}])/g, "$1"); // trailing commas
  return JSON.parse(stripped);
}

// ─── Config persistence ─────────────────────────────────────────────────────

function configPath(repoName: string): string {
  return join(RT_DIR, repoName, "workspace-sync.json");
}

export function loadSyncConfig(repoName: string): WorkspaceSyncConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(repoName), "utf8"));
    if (!raw.enabled) return null;
    return raw as WorkspaceSyncConfig;
  } catch {
    return null;
  }
}

export function saveSyncConfig(repoName: string, config: WorkspaceSyncConfig): void {
  const dir = join(RT_DIR, repoName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(repoName), JSON.stringify(config, null, 2));
}

// ─── Git exclude management ─────────────────────────────────────────────────

function gitExcludePath(repoPath: string): string {
  const dotGit = join(repoPath, ".git");
  try {
    const stat = statSync(dotGit);
    if (stat.isFile()) {
      // Worktree: .git is a file → resolve to main repo's info/exclude
      const content = readFileSync(dotGit, "utf8").trim();
      const gitdir = content.replace("gitdir: ", "");
      const mainGitDir = resolve(repoPath, gitdir, "..", "..");
      return join(mainGitDir, "info", "exclude");
    }
  } catch { /* */ }
  return join(dotGit, "info", "exclude");
}

export function ensureGitExclude(repoPath: string, fileName: string): void {
  const excludePath = gitExcludePath(repoPath);
  const dir = dirname(excludePath);
  mkdirSync(dir, { recursive: true });

  try {
    const content = existsSync(excludePath)
      ? readFileSync(excludePath, "utf8")
      : "";
    if (!content.split("\n").some(line => line.trim() === fileName)) {
      appendFileSync(excludePath, `\n${fileName}\n`);
    }
  } catch { /* best-effort */ }
}

export function removeGitExclude(repoPath: string, fileName: string): void {
  const excludePath = gitExcludePath(repoPath);
  if (!existsSync(excludePath)) return;

  try {
    const lines = readFileSync(excludePath, "utf8").split("\n");
    const filtered = lines.filter(line => line.trim() !== fileName);
    writeFileSync(excludePath, filtered.join("\n"));
  } catch { /* best-effort */ }
}

// ─── Worktree discovery ─────────────────────────────────────────────────────

export function getWorktreePaths(repoPath: string): string[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "pipe",
    });
    return output
      .split("\n")
      .filter(l => l.startsWith("worktree "))
      .map(l => l.replace("worktree ", "").trim());
  } catch {
    return [repoPath];
  }
}

// ─── Core sync ───────────────────────────────────────────────────────────────

export function syncWorkspaceFile(
  sourcePath: string,
  targetPaths: string[],
  preserveKeys: string[],
  logger?: (msg: string) => void,
): { synced: number; results: Array<{ path: string; color?: string }> } {
  let source: any;
  try {
    source = parseJsonc(readFileSync(sourcePath, "utf8"));
  } catch (err) {
    logger?.(`sync failed: cannot parse source ${sourcePath}: ${err}`);
    return { synced: 0, results: [] };
  }

  const results: Array<{ path: string; color?: string }> = [];
  let synced = 0;

  for (const targetPath of targetPaths) {
    if (targetPath === sourcePath) continue;
    if (!existsSync(targetPath)) continue;

    let target: any;
    try {
      target = parseJsonc(readFileSync(targetPath, "utf8"));
    } catch {
      // Target is unparseable — overwrite from source (preserving nothing)
      target = { settings: {} };
    }

    // Extract preserved settings from target BEFORE overwrite
    const preserved: Record<string, any> = {};
    for (const key of preserveKeys) {
      if (target.settings?.[key] !== undefined) {
        preserved[key] = target.settings[key];
      }
    }

    // Deep-clone source and re-apply preserved keys
    const merged = JSON.parse(JSON.stringify(source));
    if (!merged.settings) merged.settings = {};
    for (const [key, value] of Object.entries(preserved)) {
      merged.settings[key] = value;
    }

    writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");

    const color = preserved["peacock.color"] || undefined;
    results.push({ path: targetPath, color });
    synced++;
  }

  return { synced, results };
}

// ─── Find most recently modified workspace file ─────────────────────────────

export interface WorkspaceCandidate {
  filePath: string;
  worktree: string;
  fileName: string;
  mtime: Date;
}

export function findLatestWorkspaceFile(
  worktrees: string[],
): WorkspaceCandidate | null {
  let latest: WorkspaceCandidate | null = null;

  for (const wt of worktrees) {
    try {
      const files = readdirSync(wt).filter(f => f.endsWith(".code-workspace"));
      for (const f of files) {
        const filePath = join(wt, f);
        try {
          const stat = statSync(filePath);
          if (!latest || stat.mtime > latest.mtime) {
            latest = {
              filePath,
              worktree: wt,
              fileName: f,
              mtime: stat.mtime,
            };
          }
        } catch { /* stat failed */ }
      }
    } catch { /* readdir failed */ }
  }

  return latest;
}

// ─── Workspace Watcher ──────────────────────────────────────────────────────

const activeWatchers = new Map<string, WorkspaceSyncState>();

export function startWatching(
  repoName: string,
  repoPath: string,
  config: WorkspaceSyncConfig,
  logger: (msg: string) => void,
): void {
  // Stop any existing watcher for this repo
  stopWatching(repoName, logger);

  const worktrees = getWorktreePaths(repoPath);
  const watchers: FSWatcher[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const wt of worktrees) {
    const filePath = join(wt, config.fileName);
    // Watch the directory, not the file (same pattern as .git/config watching)
    // VS Code writes atomically: write temp → rename → old inode gone
    if (!existsSync(wt)) continue;

    try {
      const watcher = watch(wt, (_event, filename) => {
        if (filename !== config.fileName) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const sourcePath = join(wt, config.fileName);
          if (!existsSync(sourcePath)) return;

          const allTargets = worktrees.map(w => join(w, config.fileName));
          const { synced, results } = syncWorkspaceFile(
            sourcePath,
            allTargets,
            config.preserveKeys,
            logger,
          );

          if (synced > 0) {
            config.lastSyncAt = new Date().toISOString();
            config.lastSyncSource = wt;
            saveSyncConfig(repoName, config);
            logger(`workspace-sync: ${config.fileName} changed in ${basename(wt)} → synced to ${synced} worktree(s)`);
          }
        }, 500); // 500ms debounce for atomic writes
      });

      watchers.push(watcher);
    } catch (err) {
      logger(`workspace-sync: failed to watch ${wt}: ${err}`);
    }
  }

  activeWatchers.set(repoName, { config, watchers, repoName });
  logger(`workspace-sync: watching ${config.fileName} across ${watchers.length} worktree(s) for ${repoName}`);
}

export function stopWatching(repoName: string, logger?: (msg: string) => void): void {
  const state = activeWatchers.get(repoName);
  if (!state) return;

  for (const watcher of state.watchers) {
    try { watcher.close(); } catch { /* */ }
  }
  activeWatchers.delete(repoName);
  logger?.(`workspace-sync: stopped watching for ${repoName}`);
}

export function getWatcherStatus(repoName: string): {
  active: boolean;
  config: WorkspaceSyncConfig | null;
  watcherCount: number;
} {
  const state = activeWatchers.get(repoName);
  if (!state) {
    return { active: false, config: loadSyncConfig(repoName), watcherCount: 0 };
  }
  return {
    active: true,
    config: state.config,
    watcherCount: state.watchers.length,
  };
}

export function cleanupAllWatchers(): void {
  for (const [repoName] of activeWatchers) {
    stopWatching(repoName);
  }
}

// ─── Boot-time restore ──────────────────────────────────────────────────────

export function restoreWatchers(
  repos: Record<string, string>,
  logger: (msg: string) => void,
): void {
  for (const [repoName, repoPath] of Object.entries(repos)) {
    if (!existsSync(repoPath)) continue;
    const config = loadSyncConfig(repoName);
    if (config?.enabled) {
      startWatching(repoName, repoPath, config, logger);
    }
  }
}
