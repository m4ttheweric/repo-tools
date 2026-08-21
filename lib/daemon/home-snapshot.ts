/**
 * Home-repo snapshot daemon module: watches ~/.mattstack/user for changes,
 * auto-commits everything NOT inside a claimed zone, and janitor-commits a
 * claimed zone left dirty past its threshold. Zones stay owner-authored:
 * `runNow` never stages a claimed zone except through the janitor path, and
 * never on reason "watch" (only "janitor"/"manual" — see planSnapshot's
 * caller below).
 *
 * All git calls go through the injected `exec` (real default: runCapture,
 * the async non-blocking wrapper — never execSync on the daemon thread).
 * `watch`/`setTimeout`/`clearTimeout`/`now` are also injected so the test
 * suite can drive the debounce/push-delay/janitor timers and the fs watcher
 * without touching a real filesystem or clock.
 */

import { existsSync, mkdirSync, readFileSync, watch as fsWatch, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Logger } from "pino";

import { mattstackHome, rtDir } from "../rt-paths.ts";
import { runCapture, type RunResult } from "../subprocess.ts";
import { getSetting } from "../settings/resolve.ts";
import { readOwners as readOwnersReal, type Owners } from "../home/snapshot-owners.ts";
import { parsePorcelainZ, planSnapshot } from "./home-snapshot-plan.ts";

export type SnapshotReason = "manual" | "watch" | "janitor";

export type SkipReason =
  | "disabled"
  | "not-a-repo"
  | "detached"
  | "merge-in-progress"
  | "owners-read-error"
  | "no-changes";

export interface SnapshotResult {
  committed: boolean;
  sha: string | null;
  paths: string[];
  reason: SnapshotReason;
  skipped?: SkipReason;
}

export interface SnapshotStatus {
  enabled: boolean;
  repoDir: string;
  lastRunAt: number;
  lastCommit: { sha: string; message: string; at: number } | null;
  pushPending: boolean;
  lastPushAt: number;
  lastPushError: string | null;
  claimedZones: string[];
  firstSeenDirty: Record<string, number>;
  /** Set (and cleared) each time status() re-reads the owners file — surfaces a fail-closed readOwners throw without hiding it behind a stale cache. */
  ownersError: string | null;
}

export interface HomeSnapshotHandle {
  stop(): void;
  runNow(reason: SnapshotReason): Promise<SnapshotResult>;
  status(): SnapshotStatus;
  /** Resolves once startup arming (the enabled + is-a-repo checks) has settled. Not needed by the daemon (which just fires and forgets); tests await it so assertions don't race the async repo check. */
  ready: Promise<void>;
}

export interface HomeSnapshotSettings {
  enabled: boolean;
  debounceSec: number;
  pushDelaySec: number;
  janitorThresholdHours: number;
  janitorIntervalMin: number;
}

type ExecFn = (argv: [string, ...string[]], opts?: { cwd?: string; timeoutMs?: number; stderr?: "ignore" | "pipe" }) => Promise<RunResult>;
type WatchFn = (path: string, options: { recursive: boolean }, listener: (eventType: string, filename: string | null) => void) => { close(): void };
type TimeoutFn = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
type ClearTimeoutFn = (handle: ReturnType<typeof setTimeout>) => void;

export interface HomeSnapshotDeps {
  log: Logger;
  broadcast: (type: string, data: unknown) => void;
  repoDir?: string;
  exec?: ExecFn;
  watch?: WatchFn;
  setTimeout?: TimeoutFn;
  clearTimeout?: ClearTimeoutFn;
  now?: () => number;
  readSettings?: () => HomeSnapshotSettings;
  readOwners?: (path: string) => Owners;
  statePath?: string;
}

const GIT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 30_000;

function ownersPathFor(repoDir: string): string {
  return join(repoDir, "snapshot-owners.jsonc");
}

function loadState(path: string): Record<string, number> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as { firstSeenDirty?: unknown };
    return raw && typeof raw.firstSeenDirty === "object" && raw.firstSeenDirty !== null
      ? (raw.firstSeenDirty as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function persistState(path: string, firstSeenDirty: Record<string, number>, log: Logger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ firstSeenDirty }, null, 2));
  } catch (err) {
    log.warn({ err }, "home-snapshot: failed to persist state");
  }
}

export function startHomeSnapshot(rawDeps: HomeSnapshotDeps): HomeSnapshotHandle {
  const repoDir = rawDeps.repoDir ?? join(mattstackHome(), "user");
  const deps = {
    log: rawDeps.log,
    broadcast: rawDeps.broadcast,
    repoDir,
    exec: rawDeps.exec ?? runCapture,
    watch: rawDeps.watch ?? (fsWatch as unknown as WatchFn),
    setTimeout: rawDeps.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms)),
    clearTimeout: rawDeps.clearTimeout ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h)),
    now: rawDeps.now ?? (() => Date.now()),
    readSettings: rawDeps.readSettings ?? (() => getSetting<HomeSnapshotSettings>("rt.homeSnapshot").value),
    readOwners: rawDeps.readOwners ?? readOwnersReal,
    statePath: rawDeps.statePath ?? join(rtDir(), "home-snapshot-state.json"),
  };

  const ownersPath = ownersPathFor(deps.repoDir);

  let disabledReason: "disabled" | "not-a-repo" | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let janitorTimer: ReturnType<typeof setTimeout> | null = null;
  let runInFlight: Promise<SnapshotResult> | null = null;

  let lastRunAt = 0;
  let lastCommit: { sha: string; message: string; at: number } | null = null;
  let pushPending = false;
  let lastPushAt = 0;
  let lastPushError: string | null = null;
  let firstSeenDirty: Record<string, number> = loadState(deps.statePath);
  let lastLoggedOwnersError: string | null = null;

  const initialSettings = deps.readSettings();
  const enabledAtStart = initialSettings.enabled !== false;

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  if (!enabledAtStart) {
    disabledReason = "disabled";
    deps.log.info("home-snapshot: disabled (rt.homeSnapshot.enabled=false); not watching");
    resolveReady();
  } else {
    void init();
  }

  async function init(): Promise<void> {
    const check = await deps.exec(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: deps.repoDir,
      timeoutMs: GIT_TIMEOUT_MS,
      stderr: "pipe",
    });
    if (stopped) {
      resolveReady();
      return;
    }
    if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
      disabledReason = "not-a-repo";
      deps.log.warn({ repoDir: deps.repoDir }, "home-snapshot: repoDir is not a git repository; inert");
      resolveReady();
      return;
    }
    armWatcher();
    scheduleJanitor();
    resolveReady();
  }

  function armWatcher(): void {
    watcher = deps.watch(deps.repoDir, { recursive: true }, (_eventType, filename) => {
      if (filename !== null && (filename === ".git" || filename.startsWith(".git/"))) return;
      if (debounceTimer) deps.clearTimeout(debounceTimer);
      const debounceMs = deps.readSettings().debounceSec * 1000;
      debounceTimer = deps.setTimeout(() => {
        debounceTimer = null;
        void runNow("watch");
      }, debounceMs);
    });
  }

  function scheduleJanitor(): void {
    const intervalMs = deps.readSettings().janitorIntervalMin * 60_000;
    janitorTimer = deps.setTimeout(() => {
      void runNow("janitor").finally(() => {
        if (!stopped) scheduleJanitor();
      });
    }, intervalMs);
  }

  function schedulePush(): void {
    if (pushTimer) deps.clearTimeout(pushTimer);
    const delayMs = deps.readSettings().pushDelaySec * 1000;
    pushTimer = deps.setTimeout(() => {
      pushTimer = null;
      void doPush();
    }, delayMs);
  }

  function schedulePushRetry(): void {
    if (pushRetryTimer) deps.clearTimeout(pushRetryTimer);
    const retryMs = deps.readSettings().pushDelaySec * 5 * 1000;
    pushRetryTimer = deps.setTimeout(() => {
      pushRetryTimer = null;
      void doPush();
    }, retryMs);
  }

  async function doPush(): Promise<void> {
    const result = await deps.exec(["git", "push", "-q", "origin", "HEAD"], {
      cwd: deps.repoDir,
      timeoutMs: PUSH_TIMEOUT_MS,
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      pushPending = false;
      lastPushAt = deps.now();
      lastPushError = null;
      if (pushRetryTimer) {
        deps.clearTimeout(pushRetryTimer);
        pushRetryTimer = null;
      }
    } else {
      pushPending = true;
      lastPushError = result.stderr;
      deps.log.warn({ stderr: result.stderr }, "home-snapshot: push failed");
      schedulePushRetry();
    }
  }

  async function getHeadSha(): Promise<string> {
    const result = await deps.exec(["git", "rev-parse", "HEAD"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    return result.stdout.trim();
  }

  async function doRun(reason: SnapshotReason): Promise<SnapshotResult> {
    lastRunAt = deps.now();

    const branch = await deps.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: deps.repoDir,
      timeoutMs: GIT_TIMEOUT_MS,
      stderr: "pipe",
    });
    if (branch.stdout.trim() === "HEAD") {
      deps.log.warn("home-snapshot: HEAD is detached; skipping cycle");
      return { committed: false, sha: null, paths: [], reason, skipped: "detached" };
    }
    const gitDir = join(deps.repoDir, ".git");
    if (existsSync(join(gitDir, "MERGE_HEAD")) || existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
      deps.log.warn("home-snapshot: a merge or rebase is in progress; skipping cycle");
      return { committed: false, sha: null, paths: [], reason, skipped: "merge-in-progress" };
    }

    let owners: Owners;
    try {
      owners = deps.readOwners(ownersPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastLoggedOwnersError) {
        deps.log.warn({ err }, "home-snapshot: owners file unreadable; skipping cycle");
        lastLoggedOwnersError = message;
      }
      return { committed: false, sha: null, paths: [], reason, skipped: "owners-read-error" };
    }
    lastLoggedOwnersError = null;

    const statusResult = await deps.exec(["git", "status", "--porcelain=v1", "-uall", "-z"], {
      cwd: deps.repoDir,
      timeoutMs: GIT_TIMEOUT_MS,
      stderr: "pipe",
    });
    const entries = parsePorcelainZ(statusResult.stdout);

    const settings = deps.readSettings();
    const plan = planSnapshot({
      entries,
      owners,
      now: deps.now(),
      firstSeenDirty,
      thresholdMs: settings.janitorThresholdHours * 60 * 60 * 1000,
    });

    firstSeenDirty = plan.nextFirstSeenDirty;
    persistState(deps.statePath, firstSeenDirty, deps.log);

    let committed = false;
    let sha: string | null = null;

    if (plan.autoPaths.length > 0 && plan.message !== null) {
      const excludeArgs = plan.excludedZones.map((zone) => `:(exclude)${zone}`);
      await deps.exec(["git", "add", "-A", "--", ".", ...excludeArgs], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      const commitResult = await deps.exec(["git", "commit", "-q", "-m", plan.message], {
        cwd: deps.repoDir,
        timeoutMs: GIT_TIMEOUT_MS,
        stderr: "pipe",
      });
      if (commitResult.exitCode === 0) {
        sha = await getHeadSha();
        committed = true;
        lastCommit = { sha, message: plan.message, at: deps.now() };
        deps.broadcast("home:snapshot", { sha, paths: plan.autoPaths, reason });
      } else {
        deps.log.warn({ stderr: commitResult.stderr }, "home-snapshot: commit failed");
      }
    }

    if ((reason === "janitor" || reason === "manual") && plan.janitorZones.length > 0) {
      for (const jz of plan.janitorZones) {
        await deps.exec(["git", "add", "-A", "--", jz.zone], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
        const message = `snapshot: janitor ${jz.zone} (owner ${jz.owner})`;
        const commitResult = await deps.exec(["git", "commit", "-q", "-m", message], {
          cwd: deps.repoDir,
          timeoutMs: GIT_TIMEOUT_MS,
          stderr: "pipe",
        });
        if (commitResult.exitCode === 0) {
          sha = await getHeadSha();
          committed = true;
          lastCommit = { sha, message, at: deps.now() };
          deps.broadcast("home:snapshot", { sha, paths: [jz.zone], reason });
        } else {
          deps.log.warn({ stderr: commitResult.stderr, zone: jz.zone }, "home-snapshot: janitor commit failed");
        }
      }
    }

    if (committed || pushPending) schedulePush();

    return { committed, sha, paths: plan.autoPaths, reason };
  }

  async function runNow(reason: SnapshotReason): Promise<SnapshotResult> {
    await readyPromise;
    if (disabledReason) {
      return { committed: false, sha: null, paths: [], reason, skipped: disabledReason };
    }
    if (runInFlight) return runInFlight;
    const p = doRun(reason);
    runInFlight = p;
    try {
      return await p;
    } finally {
      runInFlight = null;
    }
  }

  function status(): SnapshotStatus {
    let claimedZones: string[] = [];
    let ownersError: string | null = null;
    try {
      claimedZones = Object.keys(deps.readOwners(ownersPath).zones);
    } catch (err) {
      ownersError = err instanceof Error ? err.message : String(err);
    }
    return {
      enabled: enabledAtStart,
      repoDir: deps.repoDir,
      lastRunAt,
      lastCommit,
      pushPending,
      lastPushAt,
      lastPushError,
      claimedZones,
      firstSeenDirty: { ...firstSeenDirty },
      ownersError,
    };
  }

  function stop(): void {
    stopped = true;
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    if (debounceTimer) deps.clearTimeout(debounceTimer);
    if (pushTimer) deps.clearTimeout(pushTimer);
    if (pushRetryTimer) deps.clearTimeout(pushRetryTimer);
    if (janitorTimer) deps.clearTimeout(janitorTimer);
  }

  return { stop, runNow, status, ready: readyPromise };
}
