#!/usr/bin/env bun

/**
 * rt daemon — Background service for hooks guarding and cache management.
 *
 * Runs as a long-lived Bun process managed by launchd.
 * Listens on a Unix domain socket at ~/.rt/rt.sock.
 *
 * Responsibilities:
 *  1. Watch .git/config for known repos → re-apply core.hooksPath if clobbered
 *  2. Proactively refresh branch/MR/Linear cache on a timer
 *  3. Serve cached data instantly to CLI commands via socket IPC
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, watch, statSync, type FSWatcher,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { execSync } from "child_process";

import {
  RT_DIR, DAEMON_SOCK_PATH, DAEMON_PID_PATH, DAEMON_LOG_PATH,
} from "./daemon-config.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const LINEAR_REFRESH_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const LOG_MAX_BYTES = 10 * 1024 * 1024;              // 10MB
const REPOS_JSON_PATH = join(RT_DIR, "repos.json");
const CACHE_PATH = join(RT_DIR, "branch-cache.json");

// ─── State ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  ticket: any;
  linearId: string;
  mr: any;
  fetchedAt: number;
}

interface DiskCache {
  entries: Record<string, CacheEntry>;
}

let cache: DiskCache = { entries: {} };
const watchedConfigs = new Map<string, FSWatcher>();
const startedAt = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  // Self-rotate log
  try {
    const stat = statSync(DAEMON_LOG_PATH);
    if (stat.size > LOG_MAX_BYTES) {
      const content = readFileSync(DAEMON_LOG_PATH, "utf8");
      // Keep last 20% of the file
      const keepFrom = Math.floor(content.length * 0.8);
      writeFileSync(DAEMON_LOG_PATH, content.slice(keepFrom));
      log("log rotated (exceeded 10MB)");
    }
  } catch { /* no log file yet, that's fine */ }
}

// ─── Cache ───────────────────────────────────────────────────────────────────

function loadCache(): void {
  try {
    cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    cache = { entries: {} };
  }
}

function flushCache(): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    log(`cache flush failed: ${err}`);
  }
}

// ─── Repo discovery ──────────────────────────────────────────────────────────

interface RepoIndex {
  [repoName: string]: string;
}

function loadRepoIndex(): RepoIndex {
  try {
    return JSON.parse(readFileSync(REPOS_JSON_PATH, "utf8"));
  } catch {
    return {};
  }
}

function resolveGitConfigPath(repoPath: string): string | null {
  // For worktrees, .git is a file pointing to the main repo
  const dotGit = join(repoPath, ".git");
  if (!existsSync(dotGit)) return null;

  try {
    const stat = statSync(dotGit);
    if (stat.isFile()) {
      // Worktree: .git is a file like "gitdir: /path/to/main/.git/worktrees/branch"
      const content = readFileSync(dotGit, "utf8").trim();
      const gitdir = content.replace("gitdir: ", "");
      // Navigate up to the main .git/config
      const mainGitDir = resolve(repoPath, gitdir, "..", "..");
      return join(mainGitDir, "config");
    }
    // Normal repo
    return join(dotGit, "config");
  } catch {
    return null;
  }
}

// ─── Hooks guard ─────────────────────────────────────────────────────────────

function checkAndRepairHooksPath(repoName: string, repoPath: string): boolean {
  const dataDir = join(RT_DIR, repoName);
  const hooksJson = join(dataDir, "hooks.json");
  const shimsDir = join(dataDir, "hooks");

  // Only guard repos that have hooks managed by rt
  if (!existsSync(hooksJson) || !existsSync(shimsDir)) return false;

  try {
    const currentHooksPath = execSync("git config core.hooksPath", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();

    if (currentHooksPath.includes(".rt")) return false; // already pointing to shims

    // Hooks path was clobbered — re-apply
    execSync(`git config core.hooksPath "${shimsDir}"`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    log(`hooks-guard: repaired core.hooksPath for ${repoName} (was: ${currentHooksPath})`);
    return true;
  } catch {
    // git config core.hooksPath not set — check if it should be
    try {
      execSync(`git config core.hooksPath "${shimsDir}"`, {
        cwd: repoPath,
        stdio: "pipe",
      });
      log(`hooks-guard: set core.hooksPath for ${repoName} (was unset)`);
      return true;
    } catch {
      return false;
    }
  }
}

function startWatchingRepo(repoName: string, repoPath: string): void {
  const configPath = resolveGitConfigPath(repoPath);
  if (!configPath || !existsSync(configPath)) return;

  // Don't double-watch
  if (watchedConfigs.has(configPath)) return;

  // Use fs.watch (FSEvents on macOS) for near-instant detection
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(configPath, () => {
    // Debounce: git can trigger multiple rapid writes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkAndRepairHooksPath(repoName, repoPath);
    }, 50);
  });

  watchedConfigs.set(configPath, watcher);
  log(`watching: ${repoName} (${configPath})`);

  // Initial check
  checkAndRepairHooksPath(repoName, repoPath);
}

function refreshWatchedRepos(): void {
  const repos = loadRepoIndex();
  for (const [repoName, repoPath] of Object.entries(repos)) {
    if (!existsSync(repoPath)) continue;
    startWatchingRepo(repoName, repoPath);
  }
}

// ─── Cache refresh ───────────────────────────────────────────────────────────

async function refreshCache(): Promise<void> {
  log("cache: starting background refresh");

  try {
    // Dynamic import to avoid loading heavy deps if not needed
    const { enrichBranches } = await import("./enrich.ts");
    const repos = loadRepoIndex();

    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (!existsSync(repoPath)) continue;

      try {
        // 1. Discover worktree branches
        const worktreeOutput = execSync("git worktree list --porcelain", {
          cwd: repoPath,
          encoding: "utf8",
          stdio: "pipe",
        });

        const branches: Array<{ path: string; branch: string }> = [];
        let currentPath = "";
        let currentBranch = "";

        for (const line of worktreeOutput.split("\n")) {
          if (line.startsWith("worktree ")) {
            if (currentPath && currentBranch) {
              branches.push({ path: currentPath, branch: currentBranch });
            }
            currentPath = line.replace("worktree ", "").trim();
            currentBranch = "";
          } else if (line.startsWith("branch ")) {
            currentBranch = line.replace("branch refs/heads/", "").trim();
          }
        }
        if (currentPath && currentBranch) {
          branches.push({ path: currentPath, branch: currentBranch });
        }

        // 2. Discover local branches (not just worktrees)
        //    These are the branches you'd see in `rt branch switch`
        const worktreeBranchSet = new Set(branches.map(b => b.branch));
        try {
          const localBranchOutput = execSync(
            "git for-each-ref --format='%(refname:short)' refs/heads/",
            { cwd: repoPath, encoding: "utf8", stdio: "pipe" },
          );

          for (const name of localBranchOutput.split("\n")) {
            const trimmed = name.trim().replace(/^'|'$/g, "");
            if (!trimmed || worktreeBranchSet.has(trimmed)) continue;
            // Only cache branches with a Linear ID — plain branches have nothing to enrich
            const { extractLinearId } = await import("./linear.ts");
            if (extractLinearId(trimmed)) {
              branches.push({ path: repoPath, branch: trimmed });
            }
          }
        } catch { /* git command failed — continue with worktree branches only */ }

        if (branches.length > 0) {
          // Get remote URL
          let remoteUrl: string | undefined;
          try {
            remoteUrl = execSync("git config --get remote.origin.url", {
              cwd: repoPath, encoding: "utf8", stdio: "pipe",
            }).trim();
          } catch { /* no remote */ }

          // Fetch fresh data (silent mode — no spinner)
          await enrichBranches(branches, remoteUrl, { silent: true });
        }
      } catch {
        // Skip repos that error
      }
    }

    // Reload cache from disk (enrichBranches writes to disk)
    loadCache();
    log(`cache: refresh complete (${Object.keys(cache.entries).length} entries)`);
  } catch (err) {
    log(`cache: refresh failed: ${err}`);
  }
}

// ─── Socket server ───────────────────────────────────────────────────────────

async function handleCommand(cmd: string, payload: any): Promise<any> {
  switch (cmd) {
    case "ping":
      return { ok: true, uptime: Date.now() - startedAt, pid: process.pid };

    case "cache:read": {
      const branches = payload?.branches as string[] | undefined;
      if (!branches) return { ok: true, data: cache.entries };
      const filtered: Record<string, CacheEntry> = {};
      for (const b of branches) {
        if (cache.entries[b]) filtered[b] = cache.entries[b];
      }
      return { ok: true, data: filtered };
    }

    case "cache:refresh":
      // Fire-and-forget refresh
      refreshCache().catch(() => {});
      return { ok: true, message: "refresh started" };

    case "hooks:status": {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const hooksJson = join(RT_DIR, repoName, "hooks.json");
      try {
        const config = JSON.parse(readFileSync(hooksJson, "utf8"));
        return { ok: true, data: config };
      } catch {
        return { ok: true, data: null };
      }
    }

    case "hooks:repair": {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const repos = loadRepoIndex();
      const repoPath = repos[repoName];
      if (!repoPath) return { ok: false, error: "unknown repo" };
      const repaired = checkAndRepairHooksPath(repoName, repoPath);
      return { ok: true, repaired };
    }

    case "hooks:watch": {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const repos = loadRepoIndex();
      const repoPath = repos[repoName];
      if (repoPath) startWatchingRepo(repoName, repoPath);
      return { ok: true };
    }

    case "repos": {
      const repos = loadRepoIndex();
      const watched = [...watchedConfigs.keys()];
      const detailed: Record<string, { path: string; worktrees: Array<{ path: string; branch: string }> }> = {};

      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;

        const worktrees: Array<{ path: string; branch: string }> = [];
        try {
          const output = execSync("git worktree list --porcelain", {
            cwd: repoPath, encoding: "utf8", stdio: "pipe",
          });
          let currentPath = "";
          let currentBranch = "";
          for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
              if (currentPath && currentBranch) {
                worktrees.push({ path: currentPath, branch: currentBranch });
              }
              currentPath = line.replace("worktree ", "").trim();
              currentBranch = "";
            } else if (line.startsWith("branch ")) {
              currentBranch = line.replace("branch refs/heads/", "").trim();
            }
          }
          if (currentPath && currentBranch) {
            worktrees.push({ path: currentPath, branch: currentBranch });
          }
        } catch { /* git command failed */ }

        detailed[repoName] = { path: repoPath, worktrees };
      }

      return { ok: true, data: { repos: detailed, watched } };
    }

    case "branch:enrich": {
      const branch = payload?.branch as string;
      const repoPath = payload?.repoPath as string;
      const remoteUrl = payload?.remoteUrl as string | undefined;

      if (!branch) return { ok: false, error: "missing branch" };

      // Return cached data if available
      if (cache.entries[branch]) {
        return { ok: true, data: cache.entries[branch], source: "cache" };
      }

      // On-demand enrichment (async — returns promise result)
      if (!repoPath) return { ok: false, error: "missing repoPath for cold enrichment" };

      try {
        const { enrichBranches } = await import("./enrich.ts");
        const results = await enrichBranches(
          [{ path: repoPath, branch }],
          remoteUrl,
          { silent: true },
        );

        // Reload cache (enrichBranches writes to disk)
        loadCache();

        if (cache.entries[branch]) {
          return { ok: true, data: cache.entries[branch], source: "fresh" };
        }

        return { ok: true, data: null, source: "empty" };
      } catch (err) {
        return { ok: false, error: `enrichment failed: ${err}` };
      }
    }

    case "status": {
      return {
        ok: true,
        data: {
          pid: process.pid,
          uptime: Date.now() - startedAt,
          watchedRepos: watchedConfigs.size,
          cacheEntries: Object.keys(cache.entries).length,
        },
      };
    }

    case "shutdown":
      log("received shutdown command");
      cleanup();
      setTimeout(() => process.exit(0), 100);
      return { ok: true, message: "shutting down" };

    default:
      return { ok: false, error: `unknown command: ${cmd}` };
  }
}

function startSocketServer(): void {
  // Clean up stale socket
  if (existsSync(DAEMON_SOCK_PATH)) {
    try { unlinkSync(DAEMON_SOCK_PATH); } catch { /* */ }
  }

  Bun.serve({
    unix: DAEMON_SOCK_PATH,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const cmd = url.pathname.slice(1); // "/cache:read" → "cache:read"

        let payload: any = {};
        if (req.method === "POST") {
          try { payload = await req.json(); } catch { /* empty body is fine */ }
        }

        const result = await handleCommand(cmd, payload);
        return Response.json(result);
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      }
    },
  });

  log(`socket server listening on ${DAEMON_SOCK_PATH}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function writePidFile(): void {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
}

function cleanup(): void {
  // Stop all file watches
  for (const [configPath, watcher] of watchedConfigs.entries()) {
    try { watcher.close(); } catch { /* */ }
  }
  watchedConfigs.clear();

  // Flush cache
  flushCache();

  // Remove runtime files
  for (const path of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* */ }
  }

  log("daemon stopped");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

function main(): void {
  mkdirSync(RT_DIR, { recursive: true });

  log("daemon starting");
  writePidFile();

  // Load cache from disk
  loadCache();
  log(`cache: loaded ${Object.keys(cache.entries).length} entries from disk`);

  // Start socket server
  startSocketServer();

  // Discover and watch repos
  refreshWatchedRepos();

  // Watch repos.json for changes (new repos added)
  if (existsSync(REPOS_JSON_PATH)) {
    watch(REPOS_JSON_PATH, () => {
      log("repos.json changed — refreshing watched repos");
      refreshWatchedRepos();
    });
  }

  // Schedule periodic cache refresh
  setTimeout(() => refreshCache(), 5000); // initial refresh after 5s
  setInterval(() => refreshCache(), MR_REFRESH_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  log(`daemon ready (pid: ${process.pid})`);
}

main();
