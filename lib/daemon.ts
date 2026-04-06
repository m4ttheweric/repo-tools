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
 *  4. Zero-config port discovery via lsof + CWD matching
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
  readDaemonPid,
} from "./daemon-config.ts";

import { StateStore }    from "./daemon/state-store.ts";
import { PortAllocator } from "./daemon/port-allocator.ts";
import { LogBuffer }     from "./daemon/log-buffer.ts";
import { AttachServer }  from "./daemon/attach-server.ts";
import { ProcessManager } from "./daemon/process-manager.ts";
import { SuspendManager } from "./daemon/suspend-manager.ts";
import { ProxyManager }  from "./daemon/proxy-manager.ts";
import { ExclusiveGroup } from "./daemon/exclusive-group.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const LINEAR_REFRESH_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const PORT_SCAN_INTERVAL_MS = 30 * 1000;             // 30 seconds
const LOG_MAX_BYTES = 10 * 1024 * 1024;              // 10MB
const API_PORT = 9401;
const REPOS_JSON_PATH = join(RT_DIR, "repos.json");
const CACHE_PATH = join(RT_DIR, "branch-cache.json");

import type { ServerWebSocket } from "bun";

import {
  scanListeningPorts,
  type PortEntry,
} from "./port-scanner.ts";

import { checkAndNotify, drainNotifications, peekNotifications, onNotification } from "./notifier.ts";

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
let portCache: PortEntry[] = [];
let portCacheUpdatedAt = 0;
let lastRefreshTimestamp = 0;
const watchedConfigs = new Map<string, FSWatcher>();
const startedAt = Date.now();

// ─── Daemon units (process management) ───────────────────────────────────────

const stateStore     = new StateStore();
const portAllocator  = new PortAllocator();
const logBuffer      = new LogBuffer();
const attachServer   = new AttachServer({ logBuffer });
const processManager = new ProcessManager({ stateStore, logBuffer, attachServer });
const suspendManager = new SuspendManager({ processManager, stateStore });
const proxyManager   = new ProxyManager();
const exclusiveGroup = new ExclusiveGroup({ suspendManager, stateStore });

// Wire circular reference: AttachServer needs ProcessManager for output subscriptions
attachServer.setProcessManager(processManager);
// Wire SuspendManager into ProcessManager so kill() can resume warm processes
processManager.suspendManager = suspendManager;

// Resolve the user's full PATH once at startup by running a login+interactive
// shell. This handles NVM, bun, volta, fnm etc. regardless of whether the
// daemon was launched by launchd (minimal PATH) or from a terminal session.
// We do it once so spawns don't pay shell init overhead (compinit, Oh My Zsh…).
try {
  const shell = process.env.SHELL ?? "/bin/zsh";
  processManager.userPath = execSync(`${shell} -lic 'echo $PATH' 2>/dev/null`, {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
} catch {
  // Fall back to the daemon's own PATH — better than nothing
  processManager.userPath = process.env.PATH;
}

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



function refreshPortCache(): void {
  try {
    portCache = scanListeningPorts();
    portCacheUpdatedAt = Date.now();
    log(`ports: scanned ${portCache.length} listening ports matching known repos`);

    // Broadcast to WebSocket clients
    broadcast("ports", { ports: portCache, updatedAt: portCacheUpdatedAt });
  } catch (err) {
    log(`ports: scan failed: ${err}`);
  }
}

// ─── Cache refresh ───────────────────────────────────────────────────────────

async function refreshCache(): Promise<void> {
  log("cache: starting background refresh");

  try {
    // Dynamic import to avoid loading heavy deps if not needed
    const { refreshAllMRs } = await import("./enrich.ts");
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
        const worktreeBranchSet = new Set(branches.map(b => b.branch));
        try {
          const localBranchOutput = execSync(
            "git for-each-ref --format='%(refname:short)' refs/heads/",
            { cwd: repoPath, encoding: "utf8", stdio: "pipe" },
          );

          for (const name of localBranchOutput.split("\n")) {
            const trimmed = name.trim().replace(/^'|'$/g, "");
            if (!trimmed || worktreeBranchSet.has(trimmed)) continue;
            const { extractLinearId } = await import("./linear.ts");
            if (extractLinearId(trimmed)) {
              branches.push({ path: repoPath, branch: trimmed });
            }
          }
        } catch { /* git command failed */ }

        if (branches.length > 0) {
          // Get remote URL
          let remoteUrl: string | undefined;
          try {
            remoteUrl = execSync("git config --get remote.origin.url", {
              cwd: repoPath, encoding: "utf8", stdio: "pipe",
            }).trim();
          } catch { /* no remote */ }

          // Optimized: 3 GraphQL calls for ALL open MRs + 1 Linear batch
          await refreshAllMRs(branches, remoteUrl);
        }
      } catch {
        // Skip repos that error
      }
    }

    // Reload cache from disk (enrichBranches writes to disk)
    loadCache();
    lastRefreshTimestamp = Date.now();
    log(`cache: refresh complete (${Object.keys(cache.entries).length} entries)`);

    // Check for state transitions and fire notifications
    checkAndNotify(cache.entries, portCache, log);

    // Broadcast to WebSocket clients
    broadcast("status", await handleCommand("tray:status", {}));
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

    case "ports": {
      // Return cached port data, optionally filtered by repo
      const repoFilter = payload?.repo as string | undefined;
      let ports = portCache;
      if (repoFilter) {
        ports = ports.filter(p => p.repo === repoFilter);
      }

      // Group by repo → worktree for structured display
      const grouped: Record<string, Record<string, PortEntry[]>> = {};
      for (const entry of ports) {
        const repoKey = entry.repo || "unknown";
        const wtKey = entry.worktree || "unknown";
        if (!grouped[repoKey]) grouped[repoKey] = {};
        if (!grouped[repoKey]![wtKey]) grouped[repoKey]![wtKey] = [];
        grouped[repoKey]![wtKey]!.push(entry);
      }

      return {
        ok: true,
        data: {
          ports,
          grouped,
          updatedAt: portCacheUpdatedAt,
          age: portCacheUpdatedAt ? Date.now() - portCacheUpdatedAt : null,
        },
      };
    }

    case "status": {
      return {
        ok: true,
        data: {
          pid: process.pid,
          uptime: Date.now() - startedAt,
          watchedRepos: watchedConfigs.size,
          cacheEntries: Object.keys(cache.entries).length,
          portsCached: portCache.length,
          portCacheAge: portCacheUpdatedAt ? Date.now() - portCacheUpdatedAt : null,
        },
      };
    }

    case "notifications": {
      // Drain the notification queue — tray app calls this on startup
      // to pick up any events that accumulated while it was offline
      return { ok: true, data: drainNotifications() };
    }

    case "notifications:peek": {
      // Peek without draining — for diagnostics
      return { ok: true, data: peekNotifications() };
    }

    case "tray:status": {
      // Richer status payload designed for the menu bar tray app
      const portsByRepo: Record<string, number> = {};
      for (const p of portCache) {
        const repo = p.repo || "unknown";
        portsByRepo[repo] = (portsByRepo[repo] || 0) + 1;
      }

      return {
        ok: true,
        data: {
          pid: process.pid,
          uptime: Date.now() - startedAt,
          memoryUsage: process.memoryUsage().rss,
          watchedRepos: watchedConfigs.size,
          cacheEntries: Object.keys(cache.entries).length,
          portsCached: portCache.length,
          portCacheAge: portCacheUpdatedAt ? Date.now() - portCacheUpdatedAt : null,
          lastRefresh: lastRefreshTimestamp || null,
          portsByRepo,
          pendingNotifications: peekNotifications().length,
        },
      };
    }

    // ── Process management ─────────────────────────────────────────────────────

    case "process:spawn": {
      const { id, cmd, cwd, env } = payload as { id: string; cmd: string; cwd: string; env?: Record<string, string> };
      if (!id || !cmd || !cwd) return { ok: false, error: "missing id, cmd, or cwd" };
      await processManager.spawn(id, cmd, { cwd, env });
      return { ok: true };
    }

    case "process:kill": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await processManager.kill(id);
      return { ok: true };
    }

    case "process:respawn": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await processManager.respawn(id);
      return { ok: true };
    }

    case "process:list": {
      return { ok: true, data: processManager.list() };
    }

    case "process:state": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: stateStore.getState(id) };
    }

    case "process:states": {
      return { ok: true, data: stateStore.getAll() };
    }

    case "process:logs": {
      const { id, n } = payload as { id: string; n?: number };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: logBuffer.getLastLines(id, n) };
    }

    case "process:attach-info": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      const socketPath = attachServer.socketPath(id);
      const hasSocket = existsSync(socketPath);
      const state = stateStore.getState(id) ?? "stopped";
      return { ok: true, data: { socketPath: hasSocket ? socketPath : null, state } };
    }

    case "process:suspend": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await suspendManager.suspend(id);
      return { ok: true };
    }

    case "process:resume": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await suspendManager.resume(id);
      return { ok: true };
    }

    // ── Port allocation ────────────────────────────────────────────────────────

    case "port:allocate": {
      const { label } = payload as { label: string };
      if (!label) return { ok: false, error: "missing label" };
      const port = portAllocator.allocate(label);
      return { ok: true, data: { port } };
    }

    case "port:release": {
      const { label, port } = payload as { label?: string; port?: number };
      if (label) {
        portAllocator.releaseByLabel(label);
      } else if (port !== undefined) {
        portAllocator.release(port);
      } else {
        return { ok: false, error: "missing label or port" };
      }
      return { ok: true };
    }

    case "port:list": {
      return { ok: true, data: portAllocator.list() };
    }

    // ── Proxy management ───────────────────────────────────────────────────────

    case "proxy:start": {
      const { id, canonicalPort, upstreamPort } = payload as { id: string; canonicalPort: number; upstreamPort: number };
      if (!id || !canonicalPort || !upstreamPort) return { ok: false, error: "missing id, canonicalPort, or upstreamPort" };
      proxyManager.start(id, canonicalPort, upstreamPort);
      return { ok: true };
    }

    case "proxy:stop": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      proxyManager.stop(id);
      return { ok: true };
    }

    case "proxy:set-upstream": {
      const { id, port } = payload as { id: string; port: number };
      if (!id || !port) return { ok: false, error: "missing id or port" };
      proxyManager.setUpstream(id, port);
      return { ok: true };
    }

    case "proxy:status": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: proxyManager.getStatus(id) };
    }

    case "proxy:list": {
      return { ok: true, data: proxyManager.list() };
    }

    // ── Exclusive groups ───────────────────────────────────────────────────────

    case "group:create": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      exclusiveGroup.create(id);
      return { ok: true };
    }

    case "group:remove": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      exclusiveGroup.remove(id);
      return { ok: true };
    }

    case "group:add": {
      const { groupId, processId } = payload as { groupId: string; processId: string };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      exclusiveGroup.addMember(groupId, processId);
      return { ok: true };
    }

    case "group:remove-member": {
      const { groupId, processId } = payload as { groupId: string; processId: string };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      exclusiveGroup.removeMember(groupId, processId);
      return { ok: true };
    }

    case "group:activate": {
      const { groupId, processId, mode } = payload as { groupId: string; processId: string; mode?: "warm" | "single" };
      if (!groupId || !processId) return { ok: false, error: "missing groupId or processId" };
      await exclusiveGroup.activate(groupId, processId, mode ?? "warm");
      return { ok: true };
    }

    case "group:list": {
      return { ok: true, data: exclusiveGroup.list() };
    }

    case "group:get": {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: exclusiveGroup.get(id) };
    }

    // ──────────────────────────────────────────────────────────────────────────

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

// ─── REST API + WebSocket server ─────────────────────────────────────────────

const API_INDEX = {
  name: "rt daemon",
  version: "1.0.0",
  docs: `http://localhost:${API_PORT}/`,
  websocket: `ws://localhost:${API_PORT}/ws`,
  endpoints: [
    { method: "GET",  path: "/api/status",        description: "Daemon health, uptime, memory, cache stats" },
    { method: "GET",  path: "/api/ports",          description: "Listening ports grouped by repo/worktree" },
    { method: "GET",  path: "/api/cache",           description: "All branch cache entries (MR, Linear, pipeline)" },
    { method: "GET",  path: "/api/cache/:branch",   description: "Single branch cache entry" },
    { method: "GET",  path: "/api/repos",           description: "Tracked repos with worktrees and watched status" },
    { method: "GET",  path: "/api/notifications",   description: "Pending notifications (drains queue)" },
    { method: "POST", path: "/api/refresh",         description: "Trigger a background cache refresh" },
    { method: "POST", path: "/api/hooks/:repo/repair", description: "Repair hooks path for a repo" },
    { method: "POST", path: "/api/shutdown",        description: "Gracefully stop the daemon" },
  ],
  websocket_events: [
    { type: "status",       description: "Full daemon status — after each cache refresh (~5 min)" },
    { type: "ports",        description: "Full port list — after each port scan (~30s)" },
    { type: "notification", description: "Notification event — when a transition fires" },
  ],
};

const REST_ROUTES: Record<string, { cmd: string; method: string }> = {
  "/api/status":        { cmd: "tray:status", method: "GET" },
  "/api/ports":         { cmd: "ports", method: "GET" },
  "/api/cache":         { cmd: "cache:read", method: "GET" },
  "/api/repos":         { cmd: "repos", method: "GET" },
  "/api/notifications": { cmd: "notifications", method: "GET" },
  "/api/refresh":       { cmd: "cache:refresh", method: "POST" },
  "/api/shutdown":      { cmd: "shutdown", method: "POST" },
};

const wsClients = new Set<ServerWebSocket<unknown>>();

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { /* client disconnected */ }
  }
}

function startApiServer(): void {
  Bun.serve({
    port: API_PORT,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // CORS headers for local dev
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // Self-describing root
        if (url.pathname === "/" || url.pathname === "") {
          return Response.json(API_INDEX, { headers: corsHeaders });
        }

        // Single branch lookup: /api/cache/:branch
        if (url.pathname.startsWith("/api/cache/") && req.method === "GET") {
          const branch = decodeURIComponent(url.pathname.slice("/api/cache/".length));
          const result = await handleCommand("cache:read", { branches: [branch] });
          return Response.json(result, { headers: corsHeaders });
        }

        // Hooks repair: /api/hooks/:repo/repair
        if (url.pathname.startsWith("/api/hooks/") && url.pathname.endsWith("/repair") && req.method === "POST") {
          const repo = decodeURIComponent(url.pathname.slice("/api/hooks/".length, -"/repair".length));
          const result = await handleCommand("hooks:repair", { repo });
          return Response.json(result, { headers: corsHeaders });
        }

        // Static routes
        const route = REST_ROUTES[url.pathname];
        if (!route) {
          return Response.json({ ok: false, error: "not found", docs: `http://localhost:${API_PORT}/` }, { status: 404, headers: corsHeaders });
        }

        if (req.method !== route.method && req.method !== "OPTIONS") {
          return Response.json({ ok: false, error: `use ${route.method}` }, { status: 405, headers: corsHeaders });
        }

        // Build payload from query params (GET) or body (POST)
        let payload: any = {};
        if (req.method === "POST") {
          try { payload = await req.json(); } catch { /* empty body */ }
        } else {
          payload = Object.fromEntries(url.searchParams);
        }

        const result = await handleCommand(route.cmd, payload);
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500, headers: corsHeaders });
      }
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        log(`api: WebSocket client connected (${wsClients.size} total)`);
      },
      close(ws) {
        wsClients.delete(ws);
        log(`api: WebSocket client disconnected (${wsClients.size} total)`);
      },
      message(_ws, _msg) {
        // Clients don't send messages — this is a broadcast-only stream
      },
    },
  });

  log(`api server listening on http://localhost:${API_PORT}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function writePidFile(): void {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
}

function cleanup(): void {
  // Kill all managed processes and stop proxy/attach servers
  try {
    for (const { id } of processManager.list()) {
      try { processManager.kill(id).catch(() => {}); } catch { /* */ }
    }
  } catch { /* */ }
  try { proxyManager.stopAll(); } catch { /* */ }
  try { attachServer.closeAll(); } catch { /* */ }

  // Stop all file watches
  for (const [, watcher] of watchedConfigs.entries()) {
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

  // ── Self-healing startup ────────────────────────────────────────────────────
  // If a previous daemon process is still alive (orphan from a failed restart),
  // evict it before we bind the socket. This is the last line of defence
  // when the `start` command's orphan-detection doesn't fire (e.g. launchd
  // relaunches us automatically without going through `rt daemon start`).
  const previousPid = readDaemonPid();
  if (previousPid && previousPid !== process.pid) {
    try {
      process.kill(previousPid, 0); // throws if not alive
      process.kill(previousPid, "SIGTERM");
      log(`evicted stale daemon process (pid ${previousPid})`);
      // Brief pause so the old process can exit and release any shared resources
      Bun.sleepSync(300);
    } catch { /* process not found — nothing to evict */ }
  }
  // ───────────────────────────────────────────────────────────────────────────

  log("daemon starting");
  writePidFile();

  // On restart, all processes are dead — reset any non-stopped states
  stateStore.reconcileAfterRestart();

  // Load cache from disk
  loadCache();
  log(`cache: loaded ${Object.keys(cache.entries).length} entries from disk`);

  // Start socket server (Unix socket for CLI/tray)
  startSocketServer();

  // Start REST API + WebSocket server (HTTP for external clients)
  startApiServer();

  // Wire notification broadcasts to WebSocket clients
  onNotification(broadcast);

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

  // Schedule port scanning (lightweight — every 30s)
  setTimeout(() => refreshPortCache(), 2000); // initial scan after 2s
  setInterval(() => refreshPortCache(), PORT_SCAN_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  log(`daemon ready (pid: ${process.pid})`);
}

main();
