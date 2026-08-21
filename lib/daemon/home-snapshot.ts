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

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch as fsWatch, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, isAbsolute, join } from "path";
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
  | "init-failed"
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
  /** True once the fs watcher is actually armed — false for a daemon that started with enabled:false and hasn't yet taken a manual run to lazily arm it (see doRun's `!watcher` check). */
  watching: boolean;
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

/** A push failure's stderr can quote the remote URL verbatim (`https://user:token@host/...`) — this must never reach status() or a log line unredacted. */
function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^/@\s]+@/g, "://<redacted>@");
}

/** A missing file is the normal first-run case (no warn); a present-but-unparseable file is a real loss of the janitor-threshold clock and must be loud, not silently swallowed. */
function loadState(path: string, log: Logger): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { firstSeenDirty?: unknown };
    return raw && typeof raw.firstSeenDirty === "object" && raw.firstSeenDirty !== null
      ? (raw.firstSeenDirty as Record<string, number>)
      : {};
  } catch (err) {
    log.warn({ err, path }, "home-snapshot: state file unreadable; starting from empty first-seen-dirty state");
    return {};
  }
}

/** Write-temp-then-rename (mirrors lib/home/snapshot-owners.ts's writeIntoOwnersFile) — a crash mid-write must never leave a truncated/corrupt state.json for the next boot's loadState to choke on. */
function persistState(path: string, firstSeenDirty: Record<string, number>, log: Logger): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ firstSeenDirty }, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp was never created, or already gone */ }
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

  let disabledReason: "not-a-repo" | "init-failed" | null = null;
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
  let pushInFlight: Promise<void> | null = null;
  /** A commit landed (or a retry is due) while a push was already running — the in-flight one has already captured its HEAD snapshot, so this must not be silently coalesced away or the new commit never gets pushed until some unrelated future commit happens to re-arm the timer. */
  let pushAgainRequested = false;
  let lastPushAt = 0;
  let lastPushError: string | null = null;
  let firstSeenDirty: Record<string, number> = loadState(deps.statePath, deps.log);
  let lastLoggedOwnersError: string | null = null;

  const startupSettings = deps.readSettings();
  if (startupSettings.enabled === false) {
    // Logged once, informationally, but NOT sticky: `disabledReason` stays
    // null so a live `rt.homeSnapshot.enabled` flip is picked up by doRun's
    // own top-of-run check without a daemon restart (only "not-a-repo" and
    // "init-failed" below are permanent — a directory's git-repo-ness
    // doesn't change mid-process the way a setting can). The watcher/janitor
    // timer stay unarmed for now; doRun lazily arms them on its own first
    // call once it observes a live re-enable, so a manual run reaching that
    // point also leaves the daemon watching from then on — no restart needed.
    deps.log.info("home-snapshot: disabled (rt.homeSnapshot.enabled=false) at startup — watcher/janitor stay unarmed until a run observes a live re-enable");
  }

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  void init();

  /** Arms the watcher + janitor timer; on a throw (fs.watch EMFILE/ENOSPC/ENOENT), marks the module permanently inert instead of leaving it half-armed. Shared by init() (the normal startup path) and doRun's lazy-arm (a daemon that started disabled and was later live re-enabled). */
  function tryArm(): boolean {
    try {
      armWatcher();
      scheduleJanitor();
      return true;
    } catch (err) {
      disabledReason = "init-failed";
      deps.log.warn({ err }, "home-snapshot: watcher arming failed; inert");
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
      return false;
    }
  }

  async function init(): Promise<void> {
    try {
      const check = await deps.exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: deps.repoDir,
        timeoutMs: GIT_TIMEOUT_MS,
        stderr: "pipe",
      });
      if (stopped) return;
      if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
        disabledReason = "not-a-repo";
        deps.log.warn({ repoDir: deps.repoDir }, "home-snapshot: repoDir is not a git repository; inert");
        return;
      }
      if (deps.readSettings().enabled !== false) {
        tryArm();
      }
    } catch (err) {
      // The is-inside-work-tree exec call itself never throws per its own
      // contract, but this still guards resolveReady() unconditionally —
      // without it, any surprise here would leave every runNow() (including
      // the home:snapshot IPC handler) awaiting readyPromise forever.
      disabledReason = "init-failed";
      deps.log.warn({ err }, "home-snapshot: startup arming failed; inert");
    } finally {
      resolveReady();
    }
  }

  function armWatcher(): void {
    let currentDebounceMs: number | null = null;
    watcher = deps.watch(deps.repoDir, { recursive: true }, (_eventType, filename) => {
      if (filename !== null && (filename === ".git" || filename.startsWith(".git/"))) return;
      if (debounceTimer === null) {
        // Only resolved when a NEW debounce window opens, not on every
        // event in it — this fs.watch callback fires on the daemon's main
        // thread, and rt.homeSnapshot.debounceSec's read is a settings-store
        // round trip (sync file reads + jsonc parse); doing that per event
        // during a bulk write (hundreds of fs events) is an event-loop
        // stall waiting to happen. The eventual runNow("watch") still reads
        // fresh settings on its own.
        currentDebounceMs = deps.readSettings().debounceSec * 1000;
      } else {
        deps.clearTimeout(debounceTimer);
      }
      debounceTimer = deps.setTimeout(() => {
        debounceTimer = null;
        currentDebounceMs = null;
        void runNow("watch");
      }, currentDebounceMs!);
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
    if (stopped) return;
    // A fresh commit supersedes any standing failed-push retry — without
    // canceling it here, the retry timer and this new trailing-push timer
    // both eventually fire `doPush()` independently (the in-flight guard
    // below stops them overlapping, but not the redundant second attempt).
    if (pushRetryTimer) { deps.clearTimeout(pushRetryTimer); pushRetryTimer = null; }
    if (pushTimer) deps.clearTimeout(pushTimer);
    const delayMs = deps.readSettings().pushDelaySec * 1000;
    pushTimer = deps.setTimeout(() => {
      pushTimer = null;
      void doPush();
    }, delayMs);
  }

  function schedulePushRetry(): void {
    if (stopped) return;
    if (pushRetryTimer) deps.clearTimeout(pushRetryTimer);
    const retryMs = deps.readSettings().pushDelaySec * 5 * 1000;
    pushRetryTimer = deps.setTimeout(() => {
      pushRetryTimer = null;
      void doPush();
    }, retryMs);
  }

  /**
   * In-flight guard mirrors runNow's: the push timer and the retry timer can
   * both fire close together (schedulePush cancels a *standing* retry, but
   * not one already mid-flight), so doPush itself must not let two `git
   * push` processes overlap.
   *
   * A call that arrives while one is already running does NOT just get
   * coalesced away, though: the in-flight push already captured its HEAD
   * before this call arrived, so a commit that landed in between would
   * otherwise sit unpushed until some unrelated future commit re-arms the
   * timer. `pushAgainRequested` remembers that a caller showed up mid-flight
   * so the finally block below re-schedules a push once the current one
   * settles.
   */
  async function doPush(): Promise<void> {
    if (pushInFlight) {
      pushAgainRequested = true;
      return pushInFlight;
    }
    const p = doPushInner();
    pushInFlight = p;
    try {
      await p;
    } finally {
      pushInFlight = null;
      if (pushAgainRequested) {
        pushAgainRequested = false;
        schedulePush();
      }
    }
  }

  async function doPushInner(): Promise<void> {
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
      // `origin`'s URL can carry embedded credentials, and git echoes it
      // verbatim into a failure message ("fatal: unable to access
      // 'https://user:token@host/...'") — redact before it ever reaches
      // status() or a log line, not after.
      const redactedStderr = redactCredentials(result.stderr);
      pushPending = true;
      lastPushError = redactedStderr;
      deps.log.warn({ stderr: redactedStderr }, "home-snapshot: push failed");
      schedulePushRetry();
    }
  }

  async function getHeadSha(): Promise<string> {
    const result = await deps.exec(["git", "rev-parse", "HEAD"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    return result.stdout.trim();
  }

  /** `git rev-parse --git-dir`, resolved against repoDir when relative — a linked worktree's `.git` is a FILE ("gitdir: <path>"), not a directory, so `join(repoDir, ".git", "MERGE_HEAD")` silently checks the wrong tree. Falls back to the conventional `<repoDir>/.git` on any exec failure rather than throwing the preflight off course. */
  async function resolveGitDir(): Promise<string> {
    const result = await deps.exec(["git", "rev-parse", "--git-dir"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    const raw = result.stdout.trim();
    if (result.exitCode !== 0 || raw === "") return join(deps.repoDir, ".git");
    return isAbsolute(raw) ? raw : join(deps.repoDir, raw);
  }

  async function doRun(reason: SnapshotReason): Promise<SnapshotResult> {
    lastRunAt = deps.now();

    const settings = deps.readSettings();
    if (settings.enabled === false) {
      // debug, not info/warn: this fires on every debounce/janitor tick
      // while the watcher stays armed but the setting is off — an info line
      // per tick would spam the log for as long as the user leaves it
      // disabled.
      deps.log.debug("home-snapshot: disabled via rt.homeSnapshot.enabled=false; skipping cycle");
      return { committed: false, sha: null, paths: [], reason, skipped: "disabled" };
    }
    // Lazily arms a daemon that started with enabled:false and has since
    // been live re-enabled — init() only arms once, at startup, gated on
    // the settings value AT THAT TIME. `!watcher` is false on every normal
    // (started-enabled) run, so this is a no-op there.
    if (!watcher && !stopped) {
      if (!tryArm()) {
        return { committed: false, sha: null, paths: [], reason, skipped: "init-failed" };
      }
    }

    const branch = await deps.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: deps.repoDir,
      timeoutMs: GIT_TIMEOUT_MS,
      stderr: "pipe",
    });
    // An unborn branch (freshly `git init`'d, no commits yet) ALSO prints
    // "HEAD" here, but with a non-zero exit code (git can't resolve the
    // symbolic ref to a commit yet) — unlike a genuinely detached HEAD
    // (exit 0). `git commit` works fine on an unborn branch, so only the
    // exit-0 case is actually a reason to skip.
    if (branch.stdout.trim() === "HEAD" && branch.exitCode === 0) {
      deps.log.warn("home-snapshot: HEAD is detached; skipping cycle");
      return { committed: false, sha: null, paths: [], reason, skipped: "detached" };
    }
    const gitDir = await resolveGitDir();
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
      // The same exclude pathspec rides the commit too, not just the add:
      // `git add -A -- . :(exclude)Z` only governs what THIS add stages —
      // a plain `git commit` afterward commits the WHOLE index regardless,
      // so content the user (or a stray earlier `git add`) staged inside a
      // claimed zone would ship under the daemon's message. Restricting the
      // commit to the same pathspec makes it self-contained: only matched
      // paths are committed, whatever sits staged for the zone is left
      // exactly as it was.
      await deps.exec(["git", "add", "-A", "--", ".", ...excludeArgs], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      const message = reason === "manual" ? plan.message.replace(/^snapshot:/, "snapshot (manual):") : plan.message;
      const commitResult = await deps.exec(["git", "commit", "-q", "-m", message, "--", ".", ...excludeArgs], {
        cwd: deps.repoDir,
        timeoutMs: GIT_TIMEOUT_MS,
        stderr: "pipe",
      });
      if (commitResult.exitCode === 0) {
        sha = await getHeadSha();
        committed = true;
        lastCommit = { sha, message, at: deps.now() };
        deps.broadcast("home:snapshot", { sha, paths: plan.autoPaths, reason });
      } else {
        deps.log.warn({ stderr: commitResult.stderr }, "home-snapshot: commit failed");
      }
    }

    if ((reason === "janitor" || reason === "manual") && plan.janitorZones.length > 0) {
      for (const jz of plan.janitorZones) {
        const dirtyHours = Math.floor((deps.now() - jz.dirtySinceMs) / (60 * 60 * 1000));
        const message = `snapshot (janitor): ${jz.zone} dirty >${dirtyHours}h, owner ${jz.owner}`;
        await deps.exec(["git", "add", "-A", "--", jz.zone], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
        // Same self-contained-commit reasoning as the auto commit above.
        const commitResult = await deps.exec(["git", "commit", "-q", "-m", message, "--", jz.zone], {
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

    if (!committed && plan.autoPaths.length === 0 && plan.janitorZones.length === 0) {
      return { committed: false, sha: null, paths: [], reason, skipped: "no-changes" };
    }
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
      enabled: deps.readSettings().enabled !== false,
      watching: watcher !== null,
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
    watcher = null;
    if (debounceTimer) deps.clearTimeout(debounceTimer);
    if (pushTimer) deps.clearTimeout(pushTimer);
    if (pushRetryTimer) deps.clearTimeout(pushRetryTimer);
    if (janitorTimer) deps.clearTimeout(janitorTimer);
  }

  return { stop, runNow, status, ready: readyPromise };
}
