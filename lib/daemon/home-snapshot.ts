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
 *
 * A `runNow()` call that lands while another is already in flight (e.g. `rt
 * home snapshot` fired during an in-flight watch-triggered run) does NOT
 * queue a follow-up run of its own — it reuses the in-flight run's promise
 * and returns THAT run's result. A manual invocation timed that way can
 * therefore report a result whose `reason` is "watch", with janitor zones
 * (gated to "janitor"/"manual" reasons) left unprocessed even though the
 * caller asked for "manual". Running it again gets a fresh manual cycle.
 */

import { existsSync, watch as fsWatch } from "fs";
import { isAbsolute, join } from "path";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { mattstackHome, rtDir } from "../rt-paths.ts";
import { runCapture, type RunResult } from "../subprocess.ts";
import { getSetting } from "../settings/resolve.ts";
import {
  getKvValue,
  getStateDb,
  hasKvValue,
  importLegacyJsonFile,
  renameLegacyOutOfTheWay,
  setKvValue,
} from "../state/index.ts";
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
  | "index-locked"
  | "add-failed"
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
  /** The stderr of the most recent FAILED commit attempt (auto or janitor); null once a later commit succeeds. A persistent failure here is otherwise invisible — nothing else in status() distinguishes "nothing to commit" from "tried and failed every cycle". */
  lastCommitError: string | null;
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
  db?: Database;
}

const GIT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 30_000;

// Registry defaults (packages/rt-client/src/settings/registry-defs.ts's
// rt.homeSnapshot row) — also the NaN/non-finite fallback for clampSettings,
// so a corrupt or missing setting degrades to the same values a fresh
// machine starts with, not to some other arbitrary number.
const SETTINGS_FALLBACK = {
  debounceSec: 20,
  pushDelaySec: 60,
  janitorThresholdHours: 6,
  janitorIntervalMin: 30,
} as const;

/**
 * Every interval setting is user-editable jsonc — 0, a negative number, or
 * NaN (a typo, a bad merge) must not reach a `setTimeout` call or a
 * threshold comparison. Clamped once here, centrally, rather than at each
 * of the several call sites that read `deps.readSettings()`.
 */
function clampSettings(raw: HomeSnapshotSettings): HomeSnapshotSettings {
  const clamp = (value: number, min: number, fallback: number): number =>
    Number.isFinite(value) ? Math.max(value, min) : fallback;
  return {
    enabled: raw.enabled,
    debounceSec: clamp(raw.debounceSec, 1, SETTINGS_FALLBACK.debounceSec),
    pushDelaySec: clamp(raw.pushDelaySec, 1, SETTINGS_FALLBACK.pushDelaySec),
    janitorThresholdHours: clamp(raw.janitorThresholdHours, 0.1, SETTINGS_FALLBACK.janitorThresholdHours),
    janitorIntervalMin: clamp(raw.janitorIntervalMin, 1, SETTINGS_FALLBACK.janitorIntervalMin),
  };
}

function ownersPathFor(repoDir: string): string {
  return join(repoDir, "snapshot-owners.jsonc");
}

/** A push failure's stderr can quote the remote URL verbatim (`https://user:token@host/...`) — this must never reach status() or a log line unredacted. */
function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^/@\s]+@/g, "://<redacted>@");
}

const HOME_SNAPSHOT_NS = "home-snapshot";
const HOME_SNAPSHOT_KEY = "state";

interface PersistedHomeSnapshotState {
  firstSeenDirty?: Record<string, number>;
}

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
function legacyStatePath(): string {
  return join(rtDir(), "home-snapshot-state.json");
}

function firstSeenDirtyOf(raw: PersistedHomeSnapshotState | null | undefined): Record<string, number> {
  return raw && typeof raw.firstSeenDirty === "object" && raw.firstSeenDirty !== null ? raw.firstSeenDirty : {};
}

/** A missing row is the normal first-run case (silent); a present-but-unparseable row is a real loss of the janitor-threshold clock and must be loud, per the catch policy. */
function loadState(db: Database, log: Logger): Record<string, number> {
  if (hasKvValue(HOME_SNAPSHOT_NS, HOME_SNAPSHOT_KEY, db)) {
    return firstSeenDirtyOf(getKvValue<PersistedHomeSnapshotState>(
      HOME_SNAPSHOT_NS,
      HOME_SNAPSHOT_KEY,
      {},
      db,
      (err) => log.warn({ err }, "home-snapshot: state row corrupt; starting from empty first-seen-dirty state"),
    ));
  }

  const result = importLegacyJsonFile<Record<string, number>>(
    legacyStatePath(),
    (json) => {
      const firstSeenDirty = firstSeenDirtyOf(json as PersistedHomeSnapshotState | null);
      setKvValue(HOME_SNAPSHOT_NS, HOME_SNAPSHOT_KEY, { firstSeenDirty }, db);
      return firstSeenDirty;
    },
    (err) => log.warn({ err }, "home-snapshot: legacy state file corrupt; starting from empty first-seen-dirty state"),
  );
  return result.imported ? result.value! : {};
}

function persistState(db: Database, firstSeenDirty: Record<string, number>, log: Logger): void {
  try {
    setKvValue(HOME_SNAPSHOT_NS, HOME_SNAPSHOT_KEY, { firstSeenDirty }, db);
    renameLegacyOutOfTheWay(legacyStatePath());
  } catch (err) {
    log.warn({ err }, "home-snapshot: failed to persist state");
  }
}

export function startHomeSnapshot(rawDeps: HomeSnapshotDeps): HomeSnapshotHandle {
  const repoDir = rawDeps.repoDir ?? join(mattstackHome(), "user");
  const rawReadSettings = rawDeps.readSettings ?? (() => getSetting<HomeSnapshotSettings>("rt.homeSnapshot").value);
  const deps = {
    log: rawDeps.log,
    broadcast: rawDeps.broadcast,
    repoDir,
    exec: rawDeps.exec ?? runCapture,
    watch: rawDeps.watch ?? (fsWatch as unknown as WatchFn),
    setTimeout: rawDeps.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms)),
    clearTimeout: rawDeps.clearTimeout ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h)),
    now: rawDeps.now ?? (() => Date.now()),
    readSettings: () => clampSettings(rawReadSettings()),
    readOwners: rawDeps.readOwners ?? readOwnersReal,
    db: rawDeps.db ?? getStateDb(),
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
  let lastCommitError: string | null = null;
  let lastLoggedCommitError: string | null = null;
  let lastLoggedAddError: string | null = null;
  let pushPending = false;
  let pushInFlight: Promise<void> | null = null;
  /** A commit landed (or a retry is due) while a push was already running — the in-flight one has already captured its HEAD snapshot, so this must not be silently coalesced away or the new commit never gets pushed until some unrelated future commit happens to re-arm the timer. */
  let pushAgainRequested = false;
  let lastPushAt = 0;
  let lastPushError: string | null = null;
  /** True once `home:push-failed` has been broadcast for the CURRENT unbroken run of push failures — reset to false the moment a push succeeds, so a retry storm broadcasts once, not on every attempt. */
  let pushFailureBroadcast = false;
  let firstSeenDirty: Record<string, number> = loadState(deps.db, deps.log);
  let lastLoggedOwnersError: string | null = null;
  /** Shared dedup key for every "deps.readSettings() itself threw" warn (armWatcher's debounce read, status()) — a settings store that broke after boot and stays broken must warn once, not on every fs event or every `rt home snapshot --status` poll. */
  let lastLoggedSettingsError: string | null = null;

  // Guarded: this runs at construction time, synchronously, in whatever
  // calls startHomeSnapshot() (module scope in lib/daemon.ts) — an
  // unregistered key or a broken settings store must degrade to "stay
  // inert, warn", never throw out of the daemon's boot sequence.
  let startupSettings: HomeSnapshotSettings | null = null;
  try {
    startupSettings = deps.readSettings();
  } catch (err) {
    deps.log.warn({ err }, "home-snapshot: failed to read rt.homeSnapshot settings at startup");
  }
  // status()'s fallback when a LATER readSettings() call throws — seeded
  // from whatever the startup read actually saw (or the optimistic true a
  // construction-time failure leaves it at, matching the same "assume
  // enabled" default the startup guard above falls through to).
  let lastKnownEnabled = startupSettings !== null ? startupSettings.enabled !== false : true;
  if (startupSettings !== null && startupSettings.enabled === false) {
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
      if (check.exitCode === -1) {
        // runCapture's own convention for "the process never even started"
        // (spawn failure — git missing from PATH, permissions, ...), distinct
        // from git itself running and saying "not a repository".
        disabledReason = "init-failed";
        deps.log.warn({ repoDir: deps.repoDir }, "home-snapshot: could not run git (is it on PATH?); inert");
        return;
      }
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
        //
        // Guarded: this runs SYNCHRONOUSLY inside an fs.watch listener — an
        // uncaught throw here propagates straight out of the watcher's
        // emit(), which is not a promise rejection the daemon's existing
        // async error handling can absorb. A broken settings store must
        // fall back to the registry default and warn (deduped), not repeat
        // that throw on every subsequent fs event.
        try {
          currentDebounceMs = deps.readSettings().debounceSec * 1000;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message !== lastLoggedSettingsError) {
            deps.log.warn({ err }, "home-snapshot: failed to read settings while arming the debounce; using the default");
            lastLoggedSettingsError = message;
          }
          currentDebounceMs = SETTINGS_FALLBACK.debounceSec * 1000;
        }
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
    // Kill switch, second door: doRun's own enabled check cancels a
    // scheduled push timer, but only when doRun ITSELF runs — a push
    // already armed with no upcoming debounce/janitor tick to catch it
    // (the watcher never re-arms, or debounceSec > pushDelaySec) would
    // otherwise still fire. pushPending is left untouched (there's still a
    // real unpushed commit); once re-enabled, the next `committed ||
    // pushPending` check re-arms it exactly the same way a cancelled timer would.
    if (deps.readSettings().enabled === false) {
      deps.log.debug("home-snapshot: disabled via rt.homeSnapshot.enabled=false; skipping a due push");
      return;
    }
    const result = await deps.exec(["git", "push", "-q", "origin", "HEAD"], {
      cwd: deps.repoDir,
      timeoutMs: PUSH_TIMEOUT_MS,
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      pushPending = false;
      pushFailureBroadcast = false;
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
      // Only the FIRST failure of an unbroken streak broadcasts — a retry
      // storm (schedulePushRetry firing every pushDelaySec*5) would
      // otherwise spam every WS/socket client with the same event.
      if (!pushFailureBroadcast) {
        deps.broadcast("home:push-failed", { error: redactedStderr, pushPending: true });
        pushFailureBroadcast = true;
      }
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
      // Kill switch: a scheduled push must not survive a live disable — the
      // whole point of flipping this off is "stop touching origin right
      // now." pushPending itself stays true (there's still an unpushed
      // commit); once re-enabled, the `committed || pushPending` check at
      // the end of a later run re-arms schedulePush() naturally.
      if (pushTimer) { deps.clearTimeout(pushTimer); pushTimer = null; }
      if (pushRetryTimer) { deps.clearTimeout(pushRetryTimer); pushRetryTimer = null; }
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
    persistState(deps.db, firstSeenDirty, deps.log);

    let committed = false;
    let sha: string | null = null;

    if (plan.autoPaths.length > 0 && plan.message !== null) {
      // `plan.autoPaths` describes what the STATUS SNAPSHOT at the top of
      // this run looked like — a purely descriptive record of intent. The
      // exclude pathspec built from `plan.excludedZones` (identical on both
      // the add and the commit below) is what's actually AUTHORITATIVE:
      // whatever changed on disk between the status read and this add/commit
      // pair is governed by the live pathspec, not by the stale path list.
      const excludeArgs = plan.excludedZones.map((zone) => `:(exclude)${zone}`);
      const addResult = await deps.exec(["git", "add", "-A", "--", ".", ...excludeArgs], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      if (addResult.exitCode !== 0) {
        const addSkipped: SkipReason = addResult.stderr.toLowerCase().includes("index.lock") ? "index-locked" : "add-failed";
        if (addResult.stderr !== lastLoggedAddError) {
          deps.log.warn({ stderr: addResult.stderr }, "home-snapshot: git add failed; skipping cycle");
          lastLoggedAddError = addResult.stderr;
        }
        if (pushPending) schedulePush();
        return { committed: false, sha: null, paths: [], reason, skipped: addSkipped };
      }
      lastLoggedAddError = null;

      // The same exclude pathspec rides the commit too, not just the add:
      // `git add -A -- . :(exclude)Z` only governs what THIS add stages —
      // a plain `git commit` afterward commits the WHOLE index regardless,
      // so content the user (or a stray earlier `git add`) staged inside a
      // claimed zone would ship under the daemon's message. Restricting the
      // commit to the same pathspec makes it self-contained: only matched
      // paths are committed, whatever sits staged for the zone is left
      // exactly as it was.
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
        lastCommitError = null;
        lastLoggedCommitError = null;
        deps.log.info({ sha, paths: plan.autoPaths.length, reason }, "home-snapshot: committed");
        deps.broadcast("home:snapshot", { sha, paths: plan.autoPaths, reason });
      } else {
        lastCommitError = commitResult.stderr;
        if (commitResult.stderr !== lastLoggedCommitError) {
          deps.log.warn({ stderr: commitResult.stderr }, "home-snapshot: commit failed");
          lastLoggedCommitError = commitResult.stderr;
        }
      }
    }

    if ((reason === "janitor" || reason === "manual") && plan.janitorZones.length > 0) {
      for (const jz of plan.janitorZones) {
        const dirtyHours = Math.floor((deps.now() - jz.dirtySinceMs) / (60 * 60 * 1000));
        const message = `snapshot (janitor): ${jz.zone} dirty >${dirtyHours}h, owner ${jz.owner}`;
        const addResult = await deps.exec(["git", "add", "-A", "--", jz.zone], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
        if (addResult.exitCode !== 0) {
          deps.log.warn({ stderr: addResult.stderr, zone: jz.zone }, "home-snapshot: janitor add failed; skipping this zone this cycle");
          continue;
        }
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
          lastCommitError = null;
          lastLoggedCommitError = null;
          deps.log.info({ sha, paths: 1, reason }, "home-snapshot: committed");
          deps.broadcast("home:snapshot", { sha, paths: [jz.zone], reason });
        } else {
          lastCommitError = commitResult.stderr;
          if (commitResult.stderr !== lastLoggedCommitError) {
            deps.log.warn({ stderr: commitResult.stderr, zone: jz.zone }, "home-snapshot: janitor commit failed");
            lastLoggedCommitError = commitResult.stderr;
          }
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
    // `rt home snapshot --status` calls straight through to this — a
    // settings-store read failure here must degrade to the last value this
    // module actually observed, not throw a raw stack trace at the CLI.
    try {
      lastKnownEnabled = deps.readSettings().enabled !== false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastLoggedSettingsError) {
        deps.log.warn({ err }, "home-snapshot: failed to read settings in status(); using the last-known value");
        lastLoggedSettingsError = message;
      }
    }
    return {
      enabled: lastKnownEnabled,
      watching: watcher !== null,
      repoDir: deps.repoDir,
      lastRunAt,
      lastCommit,
      lastCommitError,
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
