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
import { randomUUID } from "crypto";

import {
  RT_DIR, DAEMON_SOCK_PATH, DAEMON_PID_PATH,
  API_PORT,
  readDaemonPid,
} from "./daemon-config.ts";
import { repoDataDir } from "./rt-paths.ts";

import { getDaemonLogger, installCrashHandlers } from "./daemon-logger.ts";

import { StateStore }    from "./daemon/state-store.ts";
import { PortAllocator } from "./daemon/port-allocator.ts";
import { LogBuffer }     from "./daemon/log-buffer.ts";
import { AttachServer }  from "./daemon/attach-server.ts";
import { ProcessManager, killGroup } from "./daemon/process-manager.ts";
import { wireProcessEvents } from "./daemon/process-events.ts";
import { matchProcessApiRoute } from "./daemon/api-routes.ts";
import { needsToken, tokenOk } from "./daemon/api-auth.ts";
import { openLogStream, handleLogStreamControl, handleAttachMessage } from "./daemon/log-stream.ts";
import { SuspendManager } from "./daemon/suspend-manager.ts";
import { ProxyManager }  from "./daemon/proxy-manager.ts";
import { TunnelManager } from "./daemon/tunnel-manager.ts";
import { ExclusiveGroup } from "./daemon/exclusive-group.ts";
import { RemedyEngine }  from "./daemon/remedy-engine.ts";
import { cleanupAllWatchers, restoreWatchers } from "./daemon/workspace-sync.ts";
import {
  initMRSubscriptions,
  reconcileMRSubscriptions,
  disposeAllMRSubscriptions,
  getAggregatedConnection,
  getCurrentUserId,
  type MRSubscriptionEnv,
} from "./daemon/mr-subscriptions.ts";
import { checkAndPark } from "./daemon/parking-lot.ts";
import { portlessAvailable } from "./daemon/portless.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const PORT_SCAN_INTERVAL_MS = 30 * 1000;             // 30 seconds
const HOOKS_SCAN_INTERVAL_MS = 60 * 1000;            // 60 seconds (fallback for stale watchers)
const REPOS_JSON_PATH = join(RT_DIR, "repos.json");

/**
 * Local token gating mutating :9401 routes. Generated once and persisted to
 * ~/.rt/api-token (0600) so trusted local clients (CLI, GUI) can read it.
 */
const API_TOKEN_PATH = join(RT_DIR, "api-token");
let apiToken = "";
function loadOrCreateApiToken(): void {
  try {
    if (existsSync(API_TOKEN_PATH)) {
      const existing = readFileSync(API_TOKEN_PATH, "utf8").trim();
      if (existing) { apiToken = existing; return; }
    }
  } catch { /* fall through to regenerate */ }
  apiToken = randomUUID();
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(API_TOKEN_PATH, apiToken, { mode: 0o600 });
  } catch { /* best-effort; token still enforced in-memory this run */ }
}
const CACHE_PATH = join(RT_DIR, "branch-cache.json");

import type { Server, ServerWebSocket } from "bun";

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
import { createTunnelHandlers }    from "./daemon/handlers/tunnel.ts";
import { createProcessHandlers }   from "./daemon/handlers/process.ts";
import { createHooksHandlers }     from "./daemon/handlers/hooks.ts";
import { createStatusHandlers }    from "./daemon/handlers/status.ts";
import { createPortsHandlers }     from "./daemon/handlers/ports.ts";
import { createGroupsHandlers }    from "./daemon/handlers/groups.ts";
import { createWorkspaceHandlers } from "./daemon/handlers/workspace.ts";
import { createMRHandlers }        from "./daemon/handlers/mr.ts";
import { createParkingLotHandlers } from "./daemon/handlers/parking-lot.ts";
import { createDopplerHandlers } from "./daemon/handlers/doppler.ts";
import { reconcileForRepo } from "./daemon/doppler-sync.ts";
import { listWorktreeRoots } from "./git-worktrees.ts";
import { createDiscussionHandlers } from "./daemon/handlers/discussions.ts";
import { createEndpointHandlers }  from "./daemon/handlers/endpoints.ts";
import { startDiscussionsPoller, stopDiscussionsPoller } from "./daemon/discussions-poller.ts";
import { BounceManager } from "./daemon/bounce-manager.ts";
import { restoreEndpoints } from "./daemon/endpoint-restore.ts";
import { bounceEndpointId } from "./daemon/handlers/endpoints.ts";
import { loadEndpoints, loadEndpointState } from "./endpoints-config.ts";
import { describeRecords } from "./daemon/handlers/process.ts";

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

// ─── Logging ─────────────────────────────────────────────────────────────────
// Pino-backed structured logger. See lib/daemon-logger.ts. Top-level await
// initializes the singleton before any other startup code runs, so `log` is
// always usable from sync contexts (including catch blocks).

const loggerHandle = await getDaemonLogger();
const log = loggerHandle.logger;

// ─── Daemon units (process management) ───────────────────────────────────────

const stateStore     = new StateStore();
const portAllocator  = new PortAllocator();
const logBuffer      = new LogBuffer();
const attachServer   = new AttachServer({ logBuffer });
const processManager = new ProcessManager({ stateStore, logBuffer, attachServer });
const suspendManager = new SuspendManager({ processManager, stateStore });
const proxyManager   = new ProxyManager();
const bounceManager  = new BounceManager();
const exclusiveGroup = new ExclusiveGroup({ suspendManager, stateStore });

// ─── Remedy engine (auto-detect errors → run fix → restart) ─────────────────

/** Bounded ring buffer of recent remedy fire events for UI polling. */
const remedyEventQueue: RemedyEvent[] = [];

// Remedy banner styling — a single blank line is emitted above and below each
// banner so it stands out from the surrounding stack traces. The match banner
// is broken across three lines (title + pattern + running) because a single
// long line wraps awkwardly in narrow panes and is hard to scan at a glance.
const ANSI_RESET  = "\x1b[0m";
const ANSI_YELLOW = "\x1b[1;33m"; // matched
const ANSI_GREEN  = "\x1b[1;32m"; // ✓ fix succeeded
const ANSI_RED    = "\x1b[1;31m"; // ✗ fix failed
const ANSI_DIM    = "\x1b[2m";    // label gutter

function matchBanner(name: string, pattern: string, cmd: string): string {
  return (
    `\r\n\r\n` +
    `${ANSI_YELLOW}▸ rt remedy matched: ${name}${ANSI_RESET}\r\n` +
    `${ANSI_DIM}    pattern:${ANSI_RESET}  ${pattern}\r\n` +
    `${ANSI_DIM}    running:${ANSI_RESET}  ${cmd}\r\n` +
    `\r\n`
  );
}

function fireBanner(name: string, success: boolean, willRestart: boolean): string {
  const color = success ? ANSI_GREEN : ANSI_RED;
  const mark  = success ? "✓" : "✗";
  const tail  = success
    ? (willRestart ? "fix succeeded — restarting process" : "fix succeeded")
    : "fix failed";
  return (
    `\r\n` +
    `${color}▸ rt remedy ${mark} ${name} — ${tail}${ANSI_RESET}\r\n` +
    `\r\n\r\n`
  );
}

const remedyEngine = new RemedyEngine({
  processManager,
  stateStore,
  onMatch: (id, remedy, pattern) => {
    const cmdPreview = remedy.cmds.join(" && ");
    processManager.emitNotice(id, matchBanner(remedy.name, pattern, cmdPreview));
    log.info({ remedy: remedy.name, id, pattern }, "remedy matched");
  },
  onFire: (id, remedy, success) => {
    remedyEventQueue.push({ id, name: remedy.name, success, firedAt: Date.now() });
    if (remedyEventQueue.length > 50) remedyEventQueue.shift(); // bounded
    broadcast("remedy", { id, name: remedy.name, success });
    const willRestart = success && remedy.thenRestart !== false;
    processManager.emitNotice(id, fireBanner(remedy.name, success, willRestart));
    log.info({ remedy: remedy.name, id, success }, "remedy fired");
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
  log.info("remedy: global rules loaded");
} catch (err) {
  log.warn({ err }, "remedy: could not load global rules at startup");
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
          log.info({ count: rules.length }, "remedy: hot-reloaded global rules");
        } catch (err) {
          log.error({ err }, "remedy: parse failed; retaining previous rules");
        }
      }, GLOBAL_REMEDY_DEBOUNCE_MS);
    });
  } catch (err) {
    log.warn({ err }, "remedy: could not watch global dir");
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
  if (pruned > 0) log.info({ pruned }, "pruned stale port allocations");
} catch {
  // best-effort; don't crash daemon startup on prune failure
}

// Resolve the user's full PATH once at startup.
// Strategy: use `$SHELL -ilc` (interactive login). Sources .zprofile AND
// .zshrc, which is where most users actually put their PATH exports
// (bun, ~/.local/bin, etc.). Slower than `-lc` due to compinit/OMZ, but
// the daemon is long-running so the one-time cost is irrelevant.
// Then layer in an explicit NVM resolution so nvm-managed tools (node, pnpm,
// etc.) are included regardless of how the daemon was launched.
{
  const shell = process.env.SHELL ?? "/bin/zsh";
  let resolvedPath = process.env.PATH ?? ""; // baseline

  // 1. Interactive login shell — sources both .zprofile and .zshrc.
  try {
    resolvedPath = execSync(`${shell} -ilc 'echo $PATH' 2>/dev/null`, {
      encoding: "utf8",
      timeout: 30000,
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

  // Also overlay the resolved PATH onto the daemon's own env so direct
  // execSync calls outside ProcessManager (setup commands, agent
  // invocations) inherit pnpm/doppler/bun without re-resolving the shell
  // themselves.
  if (resolvedPath) process.env.PATH = resolvedPath;

  // Log so we can verify key tools are present after restarts
  const pathEntries = resolvedPath.split(":");
  const hasTool = (name: string) => pathEntries.some(p => {
    try { return Bun.file(`${p}/${name}`).size > 0; } catch { return false; }
  });
  log.info({ entries: pathEntries.length, hasPnpm: hasTool("pnpm"), hasDoppler: hasTool("doppler") }, "PATH resolved");
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
    log.error({ err }, "cache flush failed");
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
  const dataDir = repoDataDir(repoName);
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

    // Repair unless hooksPath points EXACTLY at this repo's shims dir. The old
    // check accepted any path merely containing ".rt", so it never repaired a
    // stale-but-".rt" path — e.g. the pre-repos/ location ~/.rt/<repo>/hooks
    // after the move to ~/.rt/repos/<repo>/hooks. Compare resolved paths.
    if (resolve(currentHooksPath) === resolve(shimsDir)) return false;

    // Hooks path was clobbered — re-apply
    execSync(`git config core.hooksPath "${shimsDir}"`, {
      cwd: repoPath,
      stdio: "pipe",
    });
    log.warn({ repo: repoName, was: currentHooksPath }, "hooks-guard repaired core.hooksPath");
    return true;
  } catch {
    // git config core.hooksPath not set — check if it should be
    try {
      execSync(`git config core.hooksPath "${shimsDir}"`, {
        cwd: repoPath,
        stdio: "pipe",
      });
      log.info({ repo: repoName }, "hooks-guard set core.hooksPath");
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
  log.info({ repo: repoName, file: `${gitDir}/${configFile}` }, "watching repo");

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
    log.info({ count: portCacheRef.ports.length }, "ports scanned");

    // Broadcast to WebSocket clients
    broadcast("ports", { ports: portCacheRef.ports, updatedAt: portCacheRef.updatedAt });
  } catch (err) {
    log.error({ err }, "port scan failed");
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
  log.debug("cache: starting background refresh");

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

          // Optimized: 3 GraphQL calls for ALL open MRs + 1 Linear batch.
          // The onError callback fires on per-MR enrich failures (GitLab,
          // Linear) — recoverable, belongs at warn level.
          await refreshAllMRs(branches, remoteUrl, (msg) => log.warn({ repo: repoName }, msg), repoName);
        }
      } catch (err) {
        log.warn({ err, repo: repoName }, "cache refresh skipped repo");
      }
    }

    // Reload cache from disk (enrichBranches writes to disk)
    loadCache();
    refreshStatusRef.lastRefreshAt = Date.now();
    log.debug({ count: Object.keys(cache.entries).length }, "cache refresh complete");

    // Check for state transitions and fire notifications
    checkAndNotify(cache.entries, portCacheRef.ports, getCurrentUserId());

    // Auto-park worktrees whose MRs just merged/closed.
    try {
      checkAndPark({ cache, repoIndex: loadRepoIndex });
    } catch (err) {
      log.warn({ err }, "parking-lot check failed");
    }

    // Doppler-template reconciliation: keeps ~/.doppler/.doppler.yaml in sync
    // with each repo's ~/.rt/repos/<repo>/doppler-template.yaml. Cheap (file I/O
    // only) and additive — never overwrites existing entries.
    try {
      const repos = loadRepoIndex();
      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;
        try {
          const worktreeRoots = listWorktreeRoots(repoPath);
          const summary = await reconcileForRepo({ repoName, worktreeRoots });
          if (summary.skipped) {
            if (summary.skipped === "malformed-template") {
              log.debug({ repo: repoName, skipped: summary.skipped }, "doppler sync skipped");
            }
            // "no-template" is the silent opt-out case; do not log.
            continue;
          }
          if (summary.wrote > 0 || summary.overridden > 0) {
            log.info({ repo: repoName, ...summary }, "doppler sync");
          }
        } catch (err) {
          log.error({ err, repo: repoName }, "doppler sync failed");
        }
      }
    } catch (err) {
      log.error({ err }, "doppler sync failed");
    }

    // Broadcast to WebSocket clients
    broadcast("status", await handleCommand("tray:status", {}));

    // Reconcile live MR subscriptions against the freshly-loaded cache.
    // Adds/removes watchers for MRs that appeared/disappeared since last tick.
    reconcileMRSubscriptions(mrSubEnv).catch((err) => {
      log.error({ err }, "mr-subscriptions: reconcile failed");
    });
  } catch (err) {
    log.error({ err }, "cache refresh failed");
  }
}

// ─── Socket server ───────────────────────────────────────────────────────────

const tunnelManager  = new TunnelManager({ processManager });

/**
 * Extracted-handler map, built once at module load. Every command goes through
 * a single map lookup in handleCommand; only the lifecycle-coupled `shutdown`
 * and `default` fall-throughs remain inline in the switch below.
 */
const handlerCtx: HandlerContext = {
  processManager, stateStore, remedyEngine, suspendManager, proxyManager,
  tunnelManager,
  attachServer, logBuffer, exclusiveGroup,
  cache, refreshCache, loadCache, flushCache, remedyEvents: remedyEventQueue,
  portAllocator,
  portlessAvailable: () => portlessAvailable(),
  log,
  startedAt,
  portCacheRef,
  watchedConfigs,
  repoIndex: loadRepoIndex,
  checkAndRepairHooksPath,
  startWatchingRepo,
  refreshStatusRef,
  repoDataDirOf: (repo) => repoDataDir(repo),
  bounceManager,
  // Placeholder; overwritten immediately below after the literal is closed.
  liveOriginsFor: (_repo: string) => () => new Set<string>(),
};

// liveOriginsFor closes over handlerCtx (to see fresh process state per call),
// so it must be assigned after the literal rather than inside it.
handlerCtx.liveOriginsFor = (repo: string) => () => {
  const origins = new Set<string>();
  for (const rec of describeRecords(handlerCtx)) {
    if (rec.repo === repo && rec.state === "running" && rec.url) {
      try { origins.add(new URL(rec.url).origin); } catch { /* skip bad url */ }
    }
  }
  return origins;
};

/** Env bundle for the MR subscription subsystem. */
const mrSubEnv: MRSubscriptionEnv = { ctx: handlerCtx, broadcast };

const routedHandlers: HandlerMap = {
  ...createCacheHandlers(handlerCtx),
  ...createRemedyHandlers(handlerCtx),
  ...createProxyHandlers(handlerCtx),
  ...createTunnelHandlers(handlerCtx),
  ...createProcessHandlers(handlerCtx),
  ...createHooksHandlers(handlerCtx),
  ...createStatusHandlers(handlerCtx),
  ...createPortsHandlers(handlerCtx),
  ...createGroupsHandlers(handlerCtx),
  ...createWorkspaceHandlers(handlerCtx),
  ...createMRHandlers(),
  ...createParkingLotHandlers(handlerCtx),
  ...createDopplerHandlers(handlerCtx),
  ...createDiscussionHandlers(handlerCtx, broadcast),
  ...createEndpointHandlers(handlerCtx),
};

async function handleCommand(cmd: string, payload: any): Promise<any> {
  const routed = routedHandlers[cmd];
  if (routed) return routed(payload);

  switch (cmd) {
    case "shutdown":
      log.info("received shutdown command");
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

  socketServer = Bun.serve({
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

  log.info({ path: DAEMON_SOCK_PATH }, "socket server listening");
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
    { method: "GET",  path: "/api/processes",        description: "Enriched list of all managed processes across repos (state, pid, timing, repo/worktree)" },
    { method: "POST", path: "/api/processes",         description: "Launch a command in a worktree { cwd, cmd, label? } (requires X-RT-Token)" },
    { method: "GET",  path: "/api/worktrees/commands", description: "Runnable packages + scripts for a worktree (?path=...), monorepo-aware" },
    { method: "GET",  path: "/api/endpoints",       description: "Declared canonical endpoints + active state for a repo (?repo=)" },
    { method: "POST", path: "/api/endpoints/map",            description: "Map a forward endpoint to a process { repo, port, processId, upstreamPort } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/unmap",          description: "Unmap a forward endpoint { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/bounce-enable",  description: "Enable a bounce relay on a declared bounce port { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/endpoints/bounce-disable", description: "Disable a bounce relay { repo, port } (X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/start",   description: "Start a process via its stored config (requires X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/stop",    description: "Stop a process (requires X-RT-Token)" },
    { method: "POST", path: "/api/processes/:id/restart", description: "Restart a process (requires X-RT-Token)" },
    { method: "GET",  path: "/api/notifications",   description: "Pending notifications (drains queue)" },
    { method: "POST", path: "/api/refresh",         description: "Trigger a background cache refresh" },
    { method: "POST", path: "/api/hooks/:repo/repair", description: "Repair hooks path for a repo" },
    { method: "POST", path: "/api/shutdown",        description: "Gracefully stop the daemon" },
  ],
  websocket_events: [
    { type: "status",         description: "Full daemon status — after each cache refresh (~5 min)" },
    { type: "ports",          description: "Full port list — after each port scan (~30s)" },
    { type: "notification",   description: "Notification event — when a transition fires" },
    { type: "remedy",         description: "Remedy fire event — when an auto-remedy triggers" },
    { type: "process:changed", description: "Process state transition { id, from, to, pid?, exitCode? }" },
  ],
  log_stream: {
    path: `ws://localhost:${API_PORT}/ws/processes/:id/logs`,
    description: "Read-only per-process log tail: replays recent history, then streams live output",
  },
  auth: {
    header: "X-RT-Token",
    description: "Required on mutating routes (process control, shutdown). Token at ~/.rt/api-token.",
  },
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

/**
 * Per-connection data on the :9401 WebSocket. "broadcast" sockets receive the
 * event stream; "logs" sockets are a read-only tail of one process's output;
 * "attach" sockets are bidirectional — output tail + keystroke input + resize
 * (an interactive terminal). "attach" is token-gated on upgrade because input
 * is arbitrary code execution.
 */
interface ApiWSData {
  kind: "broadcast" | "logs" | "attach";
  id?: string;
  unsub?: () => void;
}

const wsClients = new Set<ServerWebSocket<ApiWSData>>();

// `Server<any>` matches the inferred type Bun.serve() returns for these
// configs (the websocket data type is unconstrained). Don't narrow further —
// it makes server.upgrade() require an explicit data arg.
let socketServer: Server<any> | undefined;
let apiServer: Server<any> | undefined;

/** Broadcast an event to all connected WebSocket clients. */
export function broadcast(type: string, data: any): void {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { /* client disconnected */ }
  }
}

function startApiServer(): void {
  loadOrCreateApiToken();
  apiServer = Bun.serve<ApiWSData, never>({
    port: API_PORT,
    // Bind to loopback only — never expose the control surface on the LAN.
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade — broadcast channel
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { kind: "broadcast" } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket upgrade — read-only per-process log tail
      const logMatch = url.pathname.match(/^\/ws\/processes\/([^/]+)\/logs$/);
      if (logMatch) {
        const id = decodeURIComponent(logMatch[1]!);
        if (server.upgrade(req, { data: { kind: "logs", id } })) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket upgrade — bidirectional interactive attach (terminal).
      // Token-gated: writing to a PTY is arbitrary code execution, so unlike the
      // read-only log tail this requires the local token (injected by the dev
      // proxy on the upgrade request; browsers can't set WS headers themselves).
      const attachMatch = url.pathname.match(/^\/ws\/processes\/([^/]+)\/attach$/);
      if (attachMatch) {
        if (!tokenOk(req.headers.get("x-rt-token"), apiToken)) {
          return new Response("unauthorized", { status: 401 });
        }
        const id = decodeURIComponent(attachMatch[1]!);
        if (server.upgrade(req, { data: { kind: "attach", id } })) return undefined as any;
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

      // Gate mutating routes behind the local token (CORS is *, so this is the
      // CSRF defense against a malicious page driving control endpoints).
      if (needsToken(req.method, url.pathname) && !tokenOk(req.headers.get("x-rt-token"), apiToken)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: corsHeaders });
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

        // Launch a command in a worktree/package
        if (url.pathname === "/api/processes" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          return Response.json(await handleCommand("process:create", body), { headers: corsHeaders });
        }

        // Discover a worktree's runnable packages + scripts
        if (url.pathname === "/api/worktrees/commands" && req.method === "GET") {
          const result = await handleCommand("worktree:commands", { path: url.searchParams.get("path") });
          return Response.json(result, { headers: corsHeaders });
        }

        // Canonical endpoints
        if (url.pathname === "/api/endpoints" && req.method === "GET") {
          const repo = url.searchParams.get("repo") ?? "";
          return Response.json(await handleCommand("endpoints:list", { repo }), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/map" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:map", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/unmap" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:unmap", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/bounce-enable" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:bounce-enable", await req.json()), { headers: corsHeaders });
        }
        if (url.pathname === "/api/endpoints/bounce-disable" && req.method === "POST") {
          return Response.json(await handleCommand("endpoints:bounce-disable", await req.json()), { headers: corsHeaders });
        }

        // Open an interactive terminal session (login shell) in a worktree
        if (url.pathname === "/api/terminals" && req.method === "POST") {
          const body = await req.json().catch(() => ({}));
          return Response.json(await handleCommand("terminal:create", body), { headers: corsHeaders });
        }

        // Process control + introspection surface (/api/processes...)
        const procRoute = matchProcessApiRoute(req.method, url.pathname);
        if (procRoute) {
          const result = await handleCommand(procRoute.cmd, procRoute.payload);
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
        const data = ws.data as { kind?: string; id?: string; unsub?: () => void };
        // Log tail (read-only) and attach (bidirectional) share the same output
        // path: replay history, then forward live PTY output. Attach adds an
        // input path in message() below.
        if ((data?.kind === "logs" || data?.kind === "attach") && data.id) {
          data.unsub = openLogStream(data.id, {
            getReplay: (id) => logBuffer.getLastLines(id),
            subscribe: (id, cb) => processManager.subscribeToOutput(id, cb),
            send: (d) => { try { ws.send(d); } catch { /* client gone */ } },
          });
          return;
        }
        wsClients.add(ws);
        log.debug({ total: wsClients.size }, "ws client connected");
        try {
          ws.send(JSON.stringify({
            type: "mr:status",
            data: { connection: getAggregatedConnection() },
            timestamp: Date.now(),
          }));
        } catch { /* client gone */ }
      },
      close(ws) {
        const data = ws.data as { kind?: string; unsub?: () => void };
        if (data?.kind === "logs" || data?.kind === "attach") {
          // Detach only — the process (e.g. a shell session) keeps running so
          // the user can reconnect later and replay its history.
          try { data.unsub?.(); } catch { /* */ }
          return;
        }
        wsClients.delete(ws);
        log.debug({ total: wsClients.size }, "ws client disconnected");
      },
      message(ws, msg) {
        const data = ws.data as { kind?: string; id?: string };
        if (!data?.id) return;
        const id = data.id;
        // Log clients may send one control message — a resize — so the PTY
        // matches the viewer's terminal grid and TUIs (turbo, start:lite) stop
        // wrapping their in-place redraws.
        if (data.kind === "logs") {
          handleLogStreamControl(msg as string | Uint8Array, {
            resize: (cols, rows) => {
              try { processManager.getTerminal(id)?.resize(cols, rows); } catch { /* gone */ }
            },
          });
          return;
        }
        // Attach clients are bidirectional: binary frames are keystrokes written
        // to the PTY, string frames are control (resize).
        if (data.kind === "attach") {
          handleAttachMessage(msg as string | Uint8Array, {
            resize: (cols, rows) => {
              try { processManager.getTerminal(id)?.resize(cols, rows); } catch { /* gone */ }
            },
            input: (bytes) => {
              try { processManager.getTerminal(id)?.write(bytes); } catch { /* gone */ }
            },
          });
        }
      },
    },
  });

  log.info({ port: API_PORT }, "api server listening");
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function writePidFile(): void {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
}

function cleanup(): void {
  // Stop accepting new traffic first, and force-close all in-flight
  // connections (including the WebSocket broadcast set). Without this, Bun
  // keeps the event loop alive draining sockets and launchd's 5s ExitTimeOut
  // (ProcessType=Interactive default) escalates SIGTERM → SIGKILL before
  // "daemon stopped" can be written.
  try { socketServer?.stop(true); } catch { /* */ }
  try { apiServer?.stop(true); } catch { /* */ }
  wsClients.clear();

  // Kill all managed processes and stop proxy/attach servers
  try {
    for (const { id } of processManager.list()) {
      try { processManager.kill(id).catch(() => {}); } catch { /* */ }
    }
  } catch { /* */ }
  try { proxyManager.stopAll(); } catch { /* */ }
  try { bounceManager.stopAll(); } catch { /* */ }
  // Stop cloudflared tunnels for every active board before we exit so we don't
  // leave orphans bound to remote ingress.
  try {
    for (const { id } of processManager.list()) {
      if (id.startsWith("tunnel-")) {
        const boardName = id.slice("tunnel-".length);
        void tunnelManager.stop(boardName);
      }
    }
  } catch { /* */ }
  try { cleanupAllWatchers(); } catch { /* */ }
  try { disposeAllMRSubscriptions(); } catch { /* */ }
  try { stopDiscussionsPoller(); } catch { /* */ }
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

  log.info("daemon stopped");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export function startDaemon(): void {
  mkdirSync(RT_DIR, { recursive: true });

  // Wire uncaughtException + unhandledRejection through pino. Must run BEFORE
  // any async work that could throw uncaught.
  installCrashHandlers(loggerHandle);

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
      log.warn({ pid: previousPid }, "evicted stale daemon process");
      // Brief pause so the old process can exit and release any shared resources
      Bun.sleepSync(300);
    } catch { /* process not found — nothing to evict */ }
  }
  // ───────────────────────────────────────────────────────────────────────────

  log.info("daemon starting");
  writePidFile();

  // Surface invalid state transitions so drift in VALID_TRANSITIONS shows up
  // in the daemon log instead of being silently permitted.
  stateStore.onInvalidTransition((id, prev, next) => {
    log.warn({ id, prev, next }, "stateStore: invalid transition");
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
      log.warn({ id, pid }, "reaped orphan process");
    } catch { /* pid already gone */ }
  }

  // Load cache from disk
  loadCache();
  log.info({ count: Object.keys(cache.entries).length }, "cache loaded from disk");

  // Start socket server (Unix socket for CLI/tray)
  startSocketServer();

  // Start REST API + WebSocket server (HTTP for external clients)
  startApiServer();

  // Wire notification broadcasts to WebSocket clients
  onNotification(broadcast);

  // Wire process state transitions to WebSocket clients as `process:changed`
  // so external consumers get live updates instead of polling process:states.
  wireProcessEvents({
    onStateChange: (cb) => stateStore.onStateChange(cb),
    pidOf: (id) => stateStore.getPid(id),
    exitCodeOf: (id) => processManager.getExitCode(id),
    broadcast,
  });

  // Discover and watch repos
  refreshWatchedRepos();

  // Restore workspace sync watchers
  try {
    const repos = loadRepoIndex();
    restoreWatchers(repos);
  } catch (err) {
    log.error({ err }, "workspace-sync: failed to restore watchers");
  }

  // Restore canonical endpoints (forward proxies + bounce relays) that were
  // active before this daemon restart. In-memory servers do not survive restarts.
  try {
    const restored = restoreEndpoints({
      repos: Object.keys(loadRepoIndex()),
      loadEndpoints: (repo) => loadEndpoints(repoDataDir(repo)),
      loadState: (repo) => loadEndpointState(repoDataDir(repo)),
      upstreamPortOf: (id) => {
        if (stateStore.getState(id) !== "running") return undefined;
        const p = Number(processManager.getSpawnConfig(id)?.env?.PORT);
        return Number.isFinite(p) ? p : undefined;
      },
      startForward: (proxyId, canonicalPort, upstreamPort) => {
        try { proxyManager.start(proxyId, canonicalPort, upstreamPort, "endpoint:restore"); } catch { /* already bound */ }
      },
      startBounce: (bounceId, canonicalPort, returnParam) => {
        // bounceId encodes the repo as the middle segment: "bounce:<repo>:<port>"
        const repo = bounceId.split(":")[1] ?? "";
        try {
          bounceManager.start(bounceId, canonicalPort, { returnParam, allowedOrigins: handlerCtx.liveOriginsFor(repo) });
        } catch { /* already bound */ }
      },
    });
    log.info({ restored }, "restored canonical endpoints");
  } catch (err) {
    log.error({ err }, "endpoint restore failed");
  }

  // Watch repos.json for changes (new repos added)
  if (existsSync(REPOS_JSON_PATH)) {
    watch(REPOS_JSON_PATH, () => {
      log.info("repos.json changed; refreshing watched repos");
      refreshWatchedRepos();
    });
  }

  // Schedule periodic cache refresh
  setTimeout(() => refreshCache(), 5000); // initial refresh after 5s
  setInterval(() => refreshCache(), MR_REFRESH_INTERVAL_MS);

  // Kick off live MR subscriptions once the first refresh has populated the
  // cache with iids + repoName stamps. reconcileMRSubscriptions inside
  // refreshCacheImpl picks up the slack from there.
  setTimeout(() => {
    initMRSubscriptions(mrSubEnv).catch((err) => {
      log.error({ err }, "mr-subscriptions: init failed");
    });
  }, 7000);

  // Background sweep for new MR comments → `discussions:new-comments` events.
  startDiscussionsPoller({ ctx: handlerCtx, broadcast });

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
  const gracefulExit = (signal: NodeJS.Signals) => {
    log.info({ signal }, "received signal; shutting down");
    cleanup();
    loggerHandle.flush?.();
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));
  process.on("SIGINT",  () => gracefulExit("SIGINT"));
  // SIGHUP: sent when the parent process exits (e.g. launchd session ends, or
  // a tray-spawned daemon's parent tray is killed).  Treat it as a clean stop.
  process.on("SIGHUP",  () => gracefulExit("SIGHUP"));


  log.info({ pid: process.pid }, "daemon ready");
}

// Auto-run when executed directly (source mode: bun run lib/daemon.ts)
if (import.meta.main) {
  startDaemon();
}
