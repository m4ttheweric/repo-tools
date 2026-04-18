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
import { join, resolve, dirname, basename } from "path";
import { execSync } from "child_process";

import {
  RT_DIR, DAEMON_SOCK_PATH, DAEMON_PID_PATH, DAEMON_LOG_PATH,
  readDaemonPid,
} from "./daemon-config.ts";

import { StateStore }    from "./daemon/state-store.ts";
import { PortAllocator } from "./daemon/port-allocator.ts";
import { LogBuffer }     from "./daemon/log-buffer.ts";
import { AttachServer }  from "./daemon/attach-server.ts";
import { ProcessManager, killGroup } from "./daemon/process-manager.ts";
import { SuspendManager } from "./daemon/suspend-manager.ts";
import { ProxyManager }  from "./daemon/proxy-manager.ts";
import { ExclusiveGroup } from "./daemon/exclusive-group.ts";
import { RemedyEngine }  from "./daemon/remedy-engine.ts";
import { cleanupAllWatchers, restoreWatchers } from "./daemon/workspace-sync.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const PORT_SCAN_INTERVAL_MS = 30 * 1000;             // 30 seconds
const HOOKS_SCAN_INTERVAL_MS = 60 * 1000;            // 60 seconds (fallback for stale watchers)
const LOG_MAX_BYTES = 10 * 1024 * 1024;              // 10MB
const API_PORT = 9401;
const REPOS_JSON_PATH = join(RT_DIR, "repos.json");
const CACHE_PATH = join(RT_DIR, "branch-cache.json");

import type { ServerWebSocket } from "bun";

import { scanListeningPorts, type PortEntry } from "./port-scanner.ts";

import { checkAndNotify, onNotification } from "./notifier.ts";
import {
  listRunnerConfigs, loadRunnerConfig, entryWindowName,
  loadGlobalRemedies, globalRemedyPath,
} from "./runner-store.ts";

// ─── State ───────────────────────────────────────────────────────────────────

import type { CacheEntry, RemedyEvent, HandlerContext, HandlerMap } from "./daemon/handlers/types.ts";
import { createCacheHandlers }     from "./daemon/handlers/cache.ts";
import { createRemedyHandlers }    from "./daemon/handlers/remedy.ts";
import { createProxyHandlers }     from "./daemon/handlers/proxy.ts";
import { createProcessHandlers }   from "./daemon/handlers/process.ts";
import { createHooksHandlers }     from "./daemon/handlers/hooks.ts";
import { createStatusHandlers }    from "./daemon/handlers/status.ts";
import { createPortsHandlers }     from "./daemon/handlers/ports.ts";
import { createGroupsHandlers }    from "./daemon/handlers/groups.ts";
import { createWorkspaceHandlers } from "./daemon/handlers/workspace.ts";

interface DiskCache {
  entries: Record<string, CacheEntry>;
}

// Stable reference across reloads — loadCache() mutates `cache.entries` in place
// so handler modules can hold a live reference via HandlerContext.cache.
const cache: DiskCache = { entries: {} };
// Port scan cache, held as a single mutable ref so handler modules can read
// fresh values without getters. refreshPortCache mutates it in place.
const portCacheRef: { ports: PortEntry[]; updatedAt: number } = { ports: [], updatedAt: 0 };
// Refresh-cycle status ref (last successful cache refresh), also mutated in place
// so status handlers read a live value.
const refreshStatusRef = { lastRefreshAt: 0 };
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

// ─── Remedy engine (auto-detect errors → run fix → restart) ─────────────────

/** Bounded ring buffer of recent remedy fire events for UI polling. */
const remedyEventQueue: RemedyEvent[] = [];

const remedyEngine = new RemedyEngine({
  processManager,
  stateStore,
  onFire: (id, remedy, success) => {
    remedyEventQueue.push({ id, name: remedy.name, success, firedAt: Date.now() });
    if (remedyEventQueue.length > 50) remedyEventQueue.shift(); // bounded
    broadcast("remedy", { id, name: remedy.name, success });
    log(`remedy: ${success ? "✓" : "✗"} "${remedy.name}" fired for ${id}`);
  },
});

// Wire circular reference: AttachServer needs ProcessManager for output subscriptions
attachServer.setProcessManager(processManager);
// Wire SuspendManager into ProcessManager so kill() can resume warm processes
processManager.suspendManager = suspendManager;

// ─── Global remedy file watcher ──────────────────────────────────────────────
// Load at startup, then hot-reload whenever ~/.rt/remedies/_global.json changes.
//
// Debounce: fs.watch emits multiple rename+change events per atomic-rename save
// (common editor pattern). A ~100ms settle window collapses these to one reload.
// Parse error: retain last-good state — editors briefly produce invalid JSON
// during saves, and loadGlobalRemedies throws. If we reloaded on every throw
// we'd wipe rules every save-cycle and only recover on the next valid write.

let globalRemedyWatcher: ReturnType<typeof watch> | undefined;
const GLOBAL_REMEDY_DEBOUNCE_MS = 100;

try {
  remedyEngine.reloadGlobals(loadGlobalRemedies());
  log("remedy: global rules loaded");
} catch (err) {
  log(`remedy: could not load global rules at startup (${String(err)}) — starting empty`);
}

(function watchGlobalRemedies() {
  const gPath = globalRemedyPath();
  const dir   = gPath.replace(/_global\.json$/, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    globalRemedyWatcher = watch(dir, (_evt, filename) => {
      if (filename !== "_global.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        try {
          const rules = loadGlobalRemedies();
          remedyEngine.reloadGlobals(rules);
          log(`remedy: hot-reloaded ${rules.length} global rule(s) from _global.json`);
        } catch (err) {
          log(`remedy: parse failed — retaining previous rules (${String(err)})`);
        }
      }, GLOBAL_REMEDY_DEBOUNCE_MS);
    });
  } catch (err) {
    log(`remedy: could not watch global remedy dir (${String(err)})`);
  }
})();

// ── Prune orphaned port allocations from previous sessions ───────────────────
// Build the set of all valid labels (entryWindowName for every entry across all
// runner configs) and remove any allocation whose label is absent. This cleans
// up ports left by the old timestamp-label bug or crashed daemon restarts.
try {
  const validLabels = new Set<string>();
  for (const name of listRunnerConfigs()) {
    for (const lane of loadRunnerConfig(name)) {
      for (const entry of lane.entries) {
        validLabels.add(entryWindowName(lane.id, entry.id));
      }
    }
  }
  const pruned = portAllocator.pruneToLabels(validLabels);
  if (pruned > 0) console.error(`[daemon] pruned ${pruned} stale port allocation(s)`);
} catch {
  // best-effort; don't crash daemon startup on prune failure
}

// Resolve the user's full PATH once at startup.
// Strategy: use `zsh -lc` (login shell, no interactive) — fast because it
// sources .zprofile/.zlogin but skips Oh My Zsh compinit (~28s overhead).
// Then layer in an explicit NVM resolution so nvm-managed tools (node, pnpm,
// etc.) are included regardless of how the daemon was launched.
{
  const shell = process.env.SHELL ?? "/bin/zsh";
  let resolvedPath = process.env.PATH ?? ""; // baseline

  // 1. Login shell profile (fast: no compinit, no OMZ theme)
  try {
    resolvedPath = execSync(`${shell} -lc 'echo $PATH' 2>/dev/null`, {
      encoding: "utf8",
      timeout: 8000,
    }).trim() || resolvedPath;
  } catch { /* timeout or shell error — keep baseline */ }

  // 2. Explicit NVM: source nvm.sh on top of the already-resolved PATH so
  //    NVM prepends its bin dirs without losing Homebrew/login-shell entries.
  try {
    const nvmDir = process.env.NVM_DIR ?? `${process.env.HOME}/.nvm`;
    const nvmScript = `${nvmDir}/nvm.sh`;
    const nvmPath = execSync(
      `[ -s "${nvmScript}" ] && export PATH="${resolvedPath}" && . "${nvmScript}" && echo $PATH`,
      { encoding: "utf8", timeout: 5000, shell: "/bin/zsh" },
    ).trim();
    if (nvmPath) resolvedPath = nvmPath;
  } catch { /* nvm not installed or failed */ }

  processManager.userPath = resolvedPath || process.env.PATH;

  // Log so we can verify key tools are present after restarts
  const pathEntries = resolvedPath.split(":");
  const hasTool = (name: string) => pathEntries.some(p => {
    try { return Bun.file(`${p}/${name}`).size > 0; } catch { return false; }
  });
  log(`PATH resolved (${pathEntries.length} entries, pnpm=${hasTool("pnpm") ? "✓" : "✗"} doppler=${hasTool("doppler") ? "✓" : "✗"})`);
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
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    cache.entries = parsed?.entries ?? {};
  } catch {
    cache.entries = {};
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
      checkAndRepairHooksPath(repoName, repoPath);
    }, 100); // slightly longer debounce: rename events can cluster
  });

  watchedConfigs.set(configPath, watcher);
  log(`watching: ${repoName} (${gitDir}/${configFile})`);

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
    portCacheRef.ports = scanListeningPorts();
    portCacheRef.updatedAt = Date.now();
    log(`ports: scanned ${portCacheRef.ports.length} listening ports matching known repos`);

    // Broadcast to WebSocket clients
    broadcast("ports", { ports: portCacheRef.ports, updatedAt: portCacheRef.updatedAt });
  } catch (err) {
    log(`ports: scan failed: ${err}`);
  }
}

// ─── Cache refresh ───────────────────────────────────────────────────────────
//
// Coalesce concurrent callers: the 5-minute timer and `cache:refresh` IPC both
// fire-and-forget into refreshCache. Without a guard they stack up, each
// running execSync across every repo + a batch GraphQL. If a refresh is
// already in flight, return the same promise so callers await the existing
// run instead of starting a second one.

let refreshInFlight: Promise<void> | null = null;

function refreshCache(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshCacheImpl().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function refreshCacheImpl(): Promise<void> {
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
          await refreshAllMRs(branches, remoteUrl, (msg) => log(`cache: ${msg}`));
        }
      } catch (err) {
        log(`cache: skipping ${repoName} due to error: ${err}`);
      }
    }

    // Reload cache from disk (enrichBranches writes to disk)
    loadCache();
    refreshStatusRef.lastRefreshAt = Date.now();
    log(`cache: refresh complete (${Object.keys(cache.entries).length} entries)`);

    // Check for state transitions and fire notifications
    checkAndNotify(cache.entries, portCacheRef.ports, log);

    // Broadcast to WebSocket clients
    broadcast("status", await handleCommand("tray:status", {}));
  } catch (err) {
    log(`cache: refresh failed: ${err}`);
  }
}

// ─── Socket server ───────────────────────────────────────────────────────────

/**
 * Extracted-handler map, built once at module load. Every command goes through
 * a single map lookup in handleCommand; only the lifecycle-coupled `shutdown`
 * and `default` fall-throughs remain inline in the switch below.
 */
const handlerCtx: HandlerContext = {
  processManager, stateStore, remedyEngine, suspendManager, proxyManager,
  attachServer, logBuffer, exclusiveGroup,
  cache, refreshCache, loadCache, remedyEvents: remedyEventQueue,
  portAllocator,
  log,
  startedAt,
  portCacheRef,
  watchedConfigs,
  repoIndex: loadRepoIndex,
  checkAndRepairHooksPath,
  startWatchingRepo,
  refreshStatusRef,
};

const routedHandlers: HandlerMap = {
  ...createCacheHandlers(handlerCtx),
  ...createRemedyHandlers(handlerCtx),
  ...createProxyHandlers(handlerCtx),
  ...createProcessHandlers(handlerCtx),
  ...createHooksHandlers(handlerCtx),
  ...createStatusHandlers(handlerCtx),
  ...createPortsHandlers(handlerCtx),
  ...createGroupsHandlers(handlerCtx),
  ...createWorkspaceHandlers(handlerCtx),
};

async function handleCommand(cmd: string, payload: any): Promise<any> {
  const routed = routedHandlers[cmd];
  if (routed) return routed(payload);

  switch (cmd) {
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
    { type: "remedy",       description: "Remedy fire event — when an auto-remedy triggers" },
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
  try { cleanupAllWatchers(); } catch { /* */ }
  try { attachServer.closeAll(); } catch { /* */ }
  try { globalRemedyWatcher?.close(); } catch { /* */ }

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

export function startDaemon(): void {
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

  // Surface invalid state transitions so drift in VALID_TRANSITIONS shows up
  // in the daemon log instead of being silently permitted.
  stateStore.onInvalidTransition((id, prev, next) => {
    log(`stateStore: invalid transition for "${id}": ${prev} → ${next}`);
  });

  // On restart, most children are gone — but warm (SIGSTOP'd) processes survive
  // as orphans reparented to init. Reap any whose pid we still have recorded:
  // SIGCONT (so the pgroup can actually handle signals) then SIGKILL.
  const orphans = stateStore.reconcileAfterRestart();
  for (const { id, pid } of orphans) {
    try {
      process.kill(pid, 0); // probe — throws if pid is no longer live
      killGroup(pid, "SIGCONT");
      killGroup(pid, "SIGKILL");
      log(`reaped orphan process for "${id}" (pid ${pid})`);
    } catch { /* pid already gone */ }
  }

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

  // Restore workspace sync watchers
  try {
    const repos = loadRepoIndex();
    restoreWatchers(repos, log);
  } catch (err) {
    log(`workspace-sync: failed to restore watchers: ${err}`);
  }

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

  // Periodic hooks scan — belt-and-suspenders fallback in case a directory
  // watcher ever misses a write (e.g. watcher limit hit, FS edge-case).
  // Runs every 60s; each call is cheap (one git-config read per watched repo).
  setInterval(() => {
    const repos = loadRepoIndex();
    for (const [repoName, repoPath] of Object.entries(repos)) {
      if (existsSync(repoPath)) checkAndRepairHooksPath(repoName, repoPath);
    }
  }, HOOKS_SCAN_INTERVAL_MS);

  // Graceful shutdown on all termination signals
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });
  // SIGHUP: sent when the parent process exits (e.g. launchd session ends, or
  // a tray-spawned daemon's parent tray is killed).  Treat it as a clean stop.
  process.on("SIGHUP",  () => { cleanup(); process.exit(0); });


  log(`daemon ready (pid: ${process.pid})`);
}

// Auto-run when executed directly (source mode: bun run lib/daemon.ts)
if (import.meta.main) {
  startDaemon();
}

