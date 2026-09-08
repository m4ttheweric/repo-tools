/**
 * Snapshot daemon engine, driven by a `SnapshotSpec`: watches a repo for
 * changes, auto-commits everything NOT inside a claimed zone, and
 * janitor-commits a claimed zone left dirty past its threshold. The home repo
 * (~/.mattstack/user) is one instance of it (`homeSnapshotSpec`), and
 * `startHomeSnapshot` is the wrapper that starts it. Zones stay owner-authored:
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
  deleteKvValue,
  getKvValue,
  getStateDb,
  hasKvValue,
  importLegacyJsonFile,
  renameLegacyOutOfTheWay,
  setKvValue,
} from "../state/index.ts";
import { gitWithToken } from "../team/git-credential.ts";
import { storedForgeToken } from "../team/stored-forge-token.ts";
import type { Probes } from "../setup/probes.ts";
import { readOwners as readOwnersReal, type Owners } from "../home/snapshot-owners.ts";
import { HOME_SNAPSHOT_NS, recordHomePush, type HomePushRecord } from "../home/push-record.ts";
import { parsePorcelainZ, planSnapshot, scopeEntries } from "./home-snapshot-plan.ts";

export type SnapshotReason = "manual" | "watch" | "janitor";

export type SkipReason =
  | "disabled"
  | "not-a-repo"
  | "not-provisioned"
  | "no-git-identity"
  | "git-unavailable"
  | "init-failed"
  | "detached"
  | "merge-in-progress"
  | "owners-read-error"
  | "index-locked"
  | "add-failed"
  | "no-changes"
  | "conflict"
  | "pull-only";

export interface SnapshotResult {
  committed: boolean;
  sha: string | null;
  paths: string[];
  reason: SnapshotReason;
  skipped?: SkipReason;
}

export interface PullResult {
  outcome: "up-to-date" | "fast-forwarded" | "rebased" | "conflict" | "skipped";
  detail: string | null;
}

export interface SnapshotStatus {
  /** The spec this instance was started from ("home" for the home repo). */
  id: string;
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
  /** Stamped only by a fetch that actually reached the remote, so a clone whose token stopped working reads as stale rather than in sync. */
  lastPullAt: number;
  lastPullError: string | null;
  /** The most recent pull's skip reason (e.g. a rebase refused for a dirty `src/`); null after any non-skipped pull. */
  lastPullSkipped: string | null;
  /** A rebase that stopped mid-way. Cleared once the clone is no longer ahead of origin (a hand rebase then `rt team publish`, or a reset to origin); pushes and the applying of pulls stay suspended until then, while the fetch itself keeps running, since that is what observes the clearing condition. */
  conflicted: { at: number; detail: string } | null;
  /** True when this clone only fetches and fast-forwards. */
  pullOnly: boolean;
  claimedZones: string[];
  firstSeenDirty: Record<string, number>;
  /** Set (and cleared) each time status() re-reads the owners file — surfaces a fail-closed readOwners throw without hiding it behind a stale cache. */
  ownersError: string | null;
}

export interface HomeSnapshotHandle {
  stop(): void;
  runNow(reason: SnapshotReason): Promise<SnapshotResult>;
  /** Fetch, then fast-forward or rebase. A spec without a `pull` policy always skips. */
  pullNow(): Promise<PullResult>;
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

type ExecFn = (argv: [string, ...string[]], opts?: { cwd?: string; timeoutMs?: number; stderr?: "ignore" | "pipe"; env?: Record<string, string> }) => Promise<RunResult>;
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

/** What distinguishes one snapshot instance from another. Everything else about a run is identical across instances. */
export interface SnapshotSpec {
  id: string;
  repoDir: string;
  kvNamespace: string;
  eventPrefix: "home" | "team";
  /** Paths (relative to repoDir) the engine may stage; undefined = everything outside claimed zones. */
  scope?: (relPath: string) => boolean;
  /** Fetch + rebase policy; absent = never pull (the home repo is single-writer). */
  pull?: { intervalSec: number };
  /**
   * This machine may not write the remote, so the engine only fetches and
   * fast-forwards: no commit, no push. A clean tree is what keeps
   * fast-forward always sufficient, so a member can never reach the rebase
   * conflict path at all.
   */
  pullOnly?: boolean;
  /** The forge token rt holds for origin; absent = git's own credentials. */
  tokenFor?: () => Promise<string | null>;
  /** The retired pre-kv state file to import once; home only. */
  legacyStatePath?: string;
}

/** The spec carries repoDir, so an instance's deps never do. */
export type SnapshotDeps = Omit<HomeSnapshotDeps, "repoDir">;
export type SnapshotHandle = HomeSnapshotHandle;

const GIT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Cap for schedulePushRetry's geometric backoff (R042): an unreachable
 *  remote must not keep spawning git and re-warning every base retry
 *  window forever. */
const PUSH_RETRY_BACKOFF_CAP_MS = 60 * 60 * 1000;

/** attempt 0 -> baseMs (the existing flat pushDelaySec*5 window), doubling per consecutive failure, capped. */
function nextPushRetryDelayMs(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** attempt, PUSH_RETRY_BACKOFF_CAP_MS);
}

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

/**
 * Everything in a log line that is true of one spec and false of the other:
 * one engine serves both, and an operator reading a team clone's log must not
 * be told to check the home repo's setting or run the home repo's remedy.
 * Keyed by `eventPrefix` so no spec carries prose of its own.
 */
const SPEC_VOCAB = {
  home: {
    label: "home-snapshot",
    settingsKey: "rt.homeSnapshot",
    missingRepo: "home repo not provisioned; run `rt home init`",
  },
  team: {
    label: "team-snapshot",
    settingsKey: "rt.teamSnapshot",
    missingRepo: "team clone directory is missing; the supervisor drops it on the next rescan",
  },
} as const;

function vocabOf(spec: SnapshotSpec): (typeof SPEC_VOCAB)[SnapshotSpec["eventPrefix"]] {
  return SPEC_VOCAB[spec.eventPrefix];
}

/** A push failure's stderr can quote the remote URL verbatim (`https://user:token@host/...`) — this must never reach status() or a log line unredacted. */
function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^/@\s]+@/g, "://<redacted>@");
}

/**
 * `origin` specifically, not any remote: the push below is `origin`-only, so
 * an `upstream`-only repo would push to a remote that does not exist. An exec
 * failure (spawn error, `GIT_TIMEOUT_MS` kill — `exitCode: -1`) also reads as
 * "no remote", so a broken git goes quiet rather than attempting a push.
 */
async function hasRemote(exec: ExecFn, cwd: string): Promise<boolean> {
  const result = await exec(["git", "remote"], { cwd, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  return result.exitCode === 0 && result.stdout.split("\n").some((name) => name.trim() === "origin");
}

/**
 * Compares against `refs/remotes/origin/<branch>` directly — never `@{u}`.
 * A repo `git init`-ed locally and given a remote later has no
 * `branch.<name>.remote` configured, so `@{u}` exits 128 even though the
 * remote-tracking ref itself exists. A missing ref means everything is
 * unpushed (an absent ref is FATAL to `rev-list`, not empty), so its
 * absence is checked explicitly before ever calling `rev-list` against it.
 *
 * An unborn branch (a remote attached before the first commit ever landed
 * (e.g. `git commit` failing outright because git could resolve no
 * committer identity) prints its branch name via `symbolic-ref` just fine, exit 0,
 * same as a normal branch — HEAD itself must be verified separately, or
 * this arms a `git push` with nothing to push ("src refspec HEAD does not
 * match any"), which fails every time and drives a retry storm.
 */
async function unpushedAgainstOrigin(exec: ExecFn, cwd: string): Promise<boolean> {
  const branchResult = await exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (branchResult.exitCode !== 0) return false; // detached HEAD: never green, never arm
  const headResult = await exec(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (headResult.exitCode !== 0) return false; // unborn branch: no commits yet, nothing to push
  const branch = branchResult.stdout.trim();
  const ref = `refs/remotes/origin/${branch}`;
  const hasRef = await exec(["git", "rev-parse", "--verify", "-q", ref], { cwd, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (hasRef.exitCode !== 0) return true; // no remote-tracking ref yet: everything is unpushed
  const ahead = await exec(["git", "rev-list", "--count", `${ref}..HEAD`], { cwd, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  return ahead.exitCode === 0 && Number(ahead.stdout.trim()) > 0;
}

const HOME_SNAPSHOT_KEY = "state";
const CONFLICT_KEY = "conflict";

interface PersistedHomeSnapshotState {
  firstSeenDirty?: Record<string, number>;
}

function firstSeenDirtyOf(raw: PersistedHomeSnapshotState | null | undefined): Record<string, number> {
  return raw && typeof raw.firstSeenDirty === "object" && raw.firstSeenDirty !== null ? raw.firstSeenDirty : {};
}

/** A missing row is the normal first-run case (silent); a present-but-unparseable row is a real loss of the janitor-threshold clock and must be loud, per the catch policy. */
function loadState(spec: SnapshotSpec, db: Database, log: Logger): Record<string, number> {
  if (hasKvValue(spec.kvNamespace, HOME_SNAPSHOT_KEY, db)) {
    return firstSeenDirtyOf(getKvValue<PersistedHomeSnapshotState>(
      spec.kvNamespace,
      HOME_SNAPSHOT_KEY,
      {},
      db,
      (err) => log.warn({ err }, `${vocabOf(spec).label}: state row corrupt; starting from empty first-seen-dirty state`),
    ));
  }

  if (spec.legacyStatePath === undefined) return {};
  const result = importLegacyJsonFile<Record<string, number>>(
    spec.legacyStatePath,
    (json) => {
      const firstSeenDirty = firstSeenDirtyOf(json as PersistedHomeSnapshotState | null);
      setKvValue(spec.kvNamespace, HOME_SNAPSHOT_KEY, { firstSeenDirty }, db);
      return firstSeenDirty;
    },
    {
      onCorrupt: (err) => log.warn({ err }, `${vocabOf(spec).label}: legacy state file corrupt; starting from empty first-seen-dirty state`),
      verifyPersisted: () => hasKvValue(spec.kvNamespace, HOME_SNAPSHOT_KEY, db),
    },
  );
  return result.imported ? result.value! : {};
}

function persistState(spec: SnapshotSpec, db: Database, firstSeenDirty: Record<string, number>, log: Logger): void {
  try {
    setKvValue(spec.kvNamespace, HOME_SNAPSHOT_KEY, { firstSeenDirty }, db);
    if (spec.legacyStatePath !== undefined) renameLegacyOutOfTheWay(spec.legacyStatePath);
  } catch (err) {
    log.warn({ err }, `${vocabOf(spec).label}: failed to persist state`);
  }
}

/** The `home.backup` row's only source for WHY a push is failing — the one thing about a broken backup that git's own refs cannot show. Its own kv key, never HOME_SNAPSHOT_KEY, which persistState overwrites wholesale every cycle. */
function persistPushRecord(spec: SnapshotSpec, db: Database, record: HomePushRecord, log: Logger): void {
  try {
    recordHomePush(db, record, spec.kvNamespace);
  } catch (err) {
    log.warn({ err }, `${vocabOf(spec).label}: failed to persist the last-push record`);
  }
}

const TEAM_SCOPE_ROOTS = ["mattstack", ".sops.yaml", ".claude-plugin"] as const;

/** A team clone can also be a working repo (a team's tools repo can carry src/ and docs/); only the store, the recipients file and the marketplace are the daemon's to commit. */
export function teamScope(relPath: string): boolean {
  return TEAM_SCOPE_ROOTS.some((root) => relPath === root || relPath.startsWith(`${root}/`));
}

export function homeSnapshotSpec(repoDir: string = join(mattstackHome(), "user")): SnapshotSpec {
  return {
    id: "home",
    repoDir,
    kvNamespace: HOME_SNAPSHOT_NS,
    eventPrefix: "home",
    legacyStatePath: join(rtDir(), "home-snapshot-state.json"),
  };
}

/** A team clone: no legacy state file (nothing predates it), and it pulls (multi-writer), unlike the home repo. */
export function teamSnapshotSpec(
  slug: string,
  repoDir: string,
  opts: { pullIntervalSec: number; originUrl: string; probes: Probes; pullOnly?: boolean; readToken?: (p: Probes, remote: string) => Promise<string | null> },
): SnapshotSpec {
  const readToken = opts.readToken ?? storedForgeToken;
  return {
    id: `team:${slug}`,
    repoDir,
    kvNamespace: `team-snapshot:${slug}`,
    eventPrefix: "team",
    scope: teamScope,
    pull: { intervalSec: opts.pullIntervalSec },
    pullOnly: opts.pullOnly === true,
    tokenFor: () => readToken(opts.probes, opts.originUrl),
  };
}

export function startHomeSnapshot(rawDeps: HomeSnapshotDeps): HomeSnapshotHandle {
  const { repoDir, ...rest } = rawDeps;
  return startSnapshot(homeSnapshotSpec(repoDir), rest);
}

export function startSnapshot(spec: SnapshotSpec, rawDeps: SnapshotDeps): SnapshotHandle {
  const repoDir = spec.repoDir;
  const rawReadSettings = rawDeps.readSettings ?? (() => getSetting<HomeSnapshotSettings>("rt.homeSnapshot").value);
  // Thunk, not a resolved value: module-scope construction (lib/daemon.ts)
  // must not open state.db before startDaemon() has opened it daemon-flavored
  // via openBranchCacheStore; see loadState's call site inside init() below,
  // which is the first place this ever actually gets invoked.
  const resolveDb = rawDeps.db ? (() => rawDeps.db!) : (() => getStateDb("daemon"));
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
  };

  const ownersPath = ownersPathFor(deps.repoDir);
  const { label, settingsKey, missingRepo } = vocabOf(spec);

  let disabledReason: SkipReason | null = null;
  let stopped = false;
  let watcher: { close(): void } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let janitorTimer: ReturnType<typeof setTimeout> | null = null;
  let pullTimer: ReturnType<typeof setTimeout> | null = null;
  let runInFlight: Promise<SnapshotResult> | null = null;
  let pullInFlight: Promise<PullResult> | null = null;

  let lastPullAt = 0;
  let lastPullError: string | null = null;
  let lastPullSkipped: string | null = null;
  let conflicted: { at: number; detail: string } | null = null;
  /** `spec.tokenFor` is a keychain read plus a sops decrypt, so it is resolved once per pull interval rather than per git call. */
  let cachedToken: { value: string | null; at: number } | null = null;
  /** Dedup key for remoteGit's token-read warn: a keychain that stays locked must warn once, not on every fetch and every push. */
  let lastLoggedTokenError: string | null = null;

  let lastRunAt = 0;
  let lastCommit: { sha: string; message: string; at: number } | null = null;
  let lastCommitError: string | null = null;
  let lastLoggedCommitError: string | null = null;
  let lastLoggedAddError: string | null = null;
  let lastLoggedPushError: string | null = null;
  /** Consecutive failed-push count, for schedulePushRetry's geometric backoff (R042). Reset on any successful push or a fresh commit's schedulePush(). */
  let pushRetryAttempt = 0;
  let pushPending = false;
  let pushInFlight: Promise<void> | null = null;
  /** A commit landed (or a retry is due) while a push was already running — the in-flight one has already captured its HEAD snapshot, so this must not be silently coalesced away or the new commit never gets pushed until some unrelated future commit happens to re-arm the timer. */
  let pushAgainRequested = false;
  let lastPushAt = 0;
  let lastPushError: string | null = null;
  /** True once `home:push-failed` has been broadcast for the CURRENT unbroken run of push failures — reset to false the moment a push succeeds, so a retry storm broadcasts once, not on every attempt. */
  let pushFailureBroadcast = false;
  /** Populated in init(), after the is-inside-work-tree check; see resolveDb's comment for why this can't happen at construction time. */
  let firstSeenDirty: Record<string, number> = {};
  let lastLoggedOwnersError: string | null = null;
  /** Shared dedup key for every "deps.readSettings() itself threw" warn (armWatcher's debounce read, status(), safeReadSettings) — a settings store that broke after boot and stays broken must warn once, not on every fs event or every `rt home snapshot --status` poll. */
  let lastLoggedSettingsError: string | null = null;

  /**
   * S091: every timer-path settings read (scheduleJanitor, schedulePush,
   * schedulePushRetry, doPushInner's kill switch, doRun's own kill switch)
   * used to call deps.readSettings() raw. A throw there (an authored
   * `${repoRoot}` inside rt.homeSnapshot making getSetting expand and throw)
   * rejected whichever async chain was mid-flight: doRun's promise, a
   * scheduleJanitor `.finally` re-arm, or a bare setTimeout callback. None of
   * those are caught anywhere upstream, so the janitor/push cycle for that
   * repo silently stopped for the rest of the daemon's life while status()
   * kept reporting enabled=true. One fallback path, matching armWatcher's
   * already-correct debounce-read guard.
   */
  function safeReadSettings(): HomeSnapshotSettings {
    try {
      const settings = deps.readSettings();
      lastKnownEnabled = settings.enabled !== false;
      return settings;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastLoggedSettingsError) {
        deps.log.warn({ err }, `${label}: failed to read settings; using the last-known enabled state`);
        lastLoggedSettingsError = message;
      }
      return { enabled: lastKnownEnabled, ...SETTINGS_FALLBACK };
    }
  }

  let gitLock: Promise<unknown> = Promise.resolve();
  /**
   * Serializes the commit cycle and the pull, so a timer-driven rebase never
   * overlaps an add/commit on the same clone. Push stays OUTSIDE the lock: it
   * calls pullNow(), which takes the lock itself, so a push held inside it
   * would wait on itself.
   */
  function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = gitLock.then(fn, fn);
    gitLock = run.catch(() => undefined);
    return run;
  }

  /**
   * `runCapture` REPLACES the child's environment when `env` is given
   * (lib/subprocess.ts), so the token vars ride on top of a full copy of
   * process.env or git loses PATH and HOME. A spec without `tokenFor` (home)
   * keeps today's plain exec, env untouched.
   *
   * Never throws. `spec.tokenFor` is the one throw source in the fetch/push
   * chain (a locked keychain, a failed sops decrypt), and both call sites are
   * reached through a `void` timer callback where a rejection would escape
   * unhandled: the pull would skip its own bookkeeping and the push would skip
   * its failure branch, stalling the retry ladder until the next commit. A
   * token read failure is reported as a failed git run so each caller's own
   * failure path runs.
   */
  async function remoteGit(args: string[], timeoutMs: number): Promise<RunResult> {
    if (!spec.tokenFor) return deps.exec(["git", ...args] as [string, ...string[]], { cwd: deps.repoDir, timeoutMs, stderr: "pipe" });
    const ttlMs = (spec.pull?.intervalSec ?? 300) * 1000;
    if (!cachedToken || deps.now() - cachedToken.at > ttlMs) {
      try {
        cachedToken = { value: await spec.tokenFor(), at: deps.now() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== lastLoggedTokenError) {
          deps.log.warn({ err, id: spec.id }, `${label}: could not read the forge token for origin`);
          lastLoggedTokenError = message;
        }
        return { stdout: "", stderr: `could not read the forge token: ${message}`, exitCode: -1 };
      }
    }
    lastLoggedTokenError = null;
    const cmd = gitWithToken(args, cachedToken.value, { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" });
    return deps.exec(cmd.argv as [string, ...string[]], { cwd: deps.repoDir, timeoutMs, stderr: "pipe", env: cmd.env });
  }

  // Guarded: this runs at construction time, synchronously, in whatever
  // starts the instance (module scope in lib/daemon.ts, via
  // startHomeSnapshot): an unregistered key or a broken settings store must
  // degrade to "stay inert, warn", never throw out of the daemon's boot sequence.
  let startupSettings: HomeSnapshotSettings | null = null;
  try {
    startupSettings = deps.readSettings();
  } catch (err) {
    deps.log.warn({ err }, `${label}: failed to read ${settingsKey} settings at startup`);
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
    deps.log.info(`${label}: disabled (${settingsKey}.enabled=false) at startup... watcher/janitor stay unarmed until a run observes a live re-enable`);
  }

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  void init();

  /** Arms the watcher, the janitor timer and (for a pulling spec) the pull timer; on a throw (fs.watch EMFILE/ENOSPC/ENOENT), marks the module permanently inert instead of leaving it half-armed. Shared by init() (the normal startup path) and doRun's lazy-arm (a daemon that started disabled and was later live re-enabled). The pull timer belongs here rather than in init(), or a re-enabled clone would keep committing and pushing while never fetching again. */
  function tryArm(): boolean {
    try {
      armWatcher();
      scheduleJanitor();
      schedulePull();
      return true;
    } catch (err) {
      disabledReason = "init-failed";
      deps.log.warn({ err }, `${label}: watcher arming failed; inert`);
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
      return false;
    }
  }

  async function init(): Promise<void> {
    try {
      // Checked before spawning git at all: a missing repoDir (never `rt
      // home init`'d) otherwise reaches the same exitCode === -1 branch as a
      // genuinely missing git binary, misdiagnosing "not provisioned" as
      // "could not run git".
      if (!existsSync(deps.repoDir)) {
        disabledReason = "not-provisioned";
        deps.log.warn({ repoDir: deps.repoDir }, `${label}: ${missingRepo}; inert`);
        return;
      }
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
        deps.log.warn({ repoDir: deps.repoDir }, `${label}: could not run git (is it on PATH?); inert`);
        return;
      }
      if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
        disabledReason = "not-a-repo";
        deps.log.warn({ repoDir: deps.repoDir }, `${label}: repoDir is not a git repository; inert`);
        return;
      }
      // First real db touch: this await already put us past the daemon's
      // synchronous boot pass, so by now startDaemon() has opened state.db
      // daemon-flavored via openBranchCacheStore (see resolveDb above).
      firstSeenDirty = loadState(spec, resolveDb(), deps.log);
      // A conflict outlives the daemon: a restart must not resume pushing a
      // clone whose rebase a human has not yet finished.
      conflicted = getKvValue<{ at: number; detail: string } | null>(spec.kvNamespace, CONFLICT_KEY, null, resolveDb());
      if (deps.readSettings().enabled !== false) {
        tryArm();
        // tryArm arms the interval; this is the boot pull, so a daemon that
        // just started does not wait a whole interval to see the remote.
        // Same reasoning as schedulePull's catch, and it matters more here:
        // this runs inside the daemon's boot window.
        if (spec.pull && !disabledReason) {
          void pullNow().catch((err) => { deps.log.warn({ err }, `${label}: boot pull failed; continuing`); });
        }
      }
    } catch (err) {
      // The is-inside-work-tree exec call itself never throws per its own
      // contract, but this still guards resolveReady() unconditionally —
      // without it, any surprise here would leave every runNow() (including
      // the home:snapshot IPC handler) awaiting readyPromise forever.
      disabledReason = "init-failed";
      deps.log.warn({ err }, `${label}: startup arming failed; inert`);
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
            deps.log.warn({ err }, `${label}: failed to read settings while arming the debounce; using the default`);
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
    const intervalMs = safeReadSettings().janitorIntervalMin * 60_000;
    janitorTimer = deps.setTimeout(() => {
      void runNow("janitor").finally(() => {
        if (!stopped) scheduleJanitor();
      });
    }, intervalMs);
  }

  function schedulePull(): void {
    if (!spec.pull || stopped) return;
    if (pullTimer) deps.clearTimeout(pullTimer);
    pullTimer = deps.setTimeout(() => {
      pullTimer = null;
      // doPull reports its own git failures as outcomes, so a rejection here
      // is a seam throwing (broadcast, a db handle). Swallowed rather than
      // left to `void`: an unhandled rejection is a `process.exit(1)` under
      // the daemon's installCrashHandlers, and the interval must survive it.
      void pullNow()
        .catch((err) => { deps.log.warn({ err }, `${label}: scheduled pull failed; continuing`); })
        .finally(() => { if (!stopped) schedulePull(); });
    }, spec.pull.intervalSec * 1000);
  }

  async function pullNow(): Promise<PullResult> {
    await readyPromise;
    // A fetch and a `git merge --ff-only` need no committer, so a clone that
    // cannot commit still stays current; every other disabledReason
    // (init-failed, not-a-repo, not-provisioned) means there is nothing to
    // pull into.
    const blocked = disabledReason !== null && disabledReason !== "no-git-identity";
    if (!spec.pull || blocked || safeReadSettings().enabled === false) {
      return { outcome: "skipped", detail: "pull not enabled for this repo" };
    }
    if (pullInFlight) return pullInFlight;
    const p = withGitLock(() => doPull());
    pullInFlight = p;
    try {
      const result = await p;
      lastPullSkipped = result.outcome === "skipped" ? result.detail : null;
      return result;
    } finally {
      pullInFlight = null;
    }
  }

  async function doPull(): Promise<PullResult> {
    if (!(await hasRemote(deps.exec, deps.repoDir))) return { outcome: "skipped", detail: "no remote" };
    const branchResult = await deps.exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    if (branchResult.exitCode !== 0) return { outcome: "skipped", detail: "detached HEAD" };
    const branch = branchResult.stdout.trim();
    const fetch = await remoteGit(["fetch", "-q", "origin", branch], FETCH_TIMEOUT_MS);
    if (fetch.exitCode !== 0) {
      lastPullError = redactCredentials(fetch.stderr);
      return { outcome: "skipped", detail: lastPullError };
    }
    // Stamped only here: a pull that never reached the remote must read as
    // stale, or a joiner with a bad token would look in sync.
    lastPullAt = deps.now();
    lastPullError = null;
    const counts = await deps.exec(["git", "rev-list", "--left-right", "--count", `refs/remotes/origin/${branch}...HEAD`], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    if (counts.exitCode !== 0) return { outcome: "skipped", detail: "no remote-tracking ref yet" };
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    // Cleared only once local is no longer ahead of origin. A hand rebase on
    // its own does NOT get there: it leaves the replayed commits ahead, and
    // the daemon's push stays suspended meanwhile, so the recovery is
    // `rt team publish` after the rebase, or resetting the clone to origin.
    if (conflicted && ahead === 0) clearConflict();
    if (conflicted) return { outcome: "skipped", detail: conflicted.detail };
    if (behind === 0) return { outcome: "up-to-date", detail: null };
    if (ahead === 0) {
      const ff = await deps.exec(["git", "merge", "-q", "--ff-only", `refs/remotes/origin/${branch}`], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      if (ff.exitCode !== 0) return { outcome: "skipped", detail: redactCredentials(ff.stderr) };
      deps.log.info({ id: spec.id, behind }, `${label}: fast-forwarded`);
      return { outcome: "fast-forwarded", detail: null };
    }
    const rebase = await deps.exec(["git", "-c", "commit.gpgsign=false", "rebase", "-q", `refs/remotes/origin/${branch}`], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    if (rebase.exitCode === 0) {
      deps.log.info({ id: spec.id, behind, ahead }, `${label}: rebased`);
      return { outcome: "rebased", detail: null };
    }
    // A rebase that never started (unstaged changes outside the scope, a lock)
    // exits 1 too, but leaves no rebase-merge/rebase-apply behind; only a
    // rebase that stopped mid-way is a conflict.
    const gitDir = await resolveGitDir();
    const rebaseStopped = existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"));
    if (!rebaseStopped) {
      const reason = redactCredentials(rebase.stderr.trim() || "rebase refused");
      deps.log.warn({ id: spec.id, reason }, `${label}: rebase refused; will retry next tick`);
      return { outcome: "skipped", detail: reason };
    }
    await deps.exec(["git", "rebase", "--abort"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    const detail = redactCredentials(rebase.stderr.trim() || "rebase stopped");
    conflicted = { at: deps.now(), detail };
    try {
      setKvValue(spec.kvNamespace, CONFLICT_KEY, conflicted, resolveDb());
    } catch (err) {
      deps.log.warn({ err }, `${label}: failed to persist the conflict marker`);
    }
    if (pushTimer) { deps.clearTimeout(pushTimer); pushTimer = null; }
    if (pushRetryTimer) { deps.clearTimeout(pushRetryTimer); pushRetryTimer = null; }
    // A pull-only clone cannot publish, so the remedy told to it must not name a verb it will
    // itself refuse (team-pull-only) the moment it is tried.
    const remedy = spec.pullOnly ? "reset it to origin or ask the team's owner" : "rebase and `rt team publish` by hand, or reset the clone to origin";
    deps.log.warn({ id: spec.id, detail }, `${label}: rebase conflict; still fetching, but not applying pulls or pushing until you ${remedy}`);
    deps.broadcast(`${spec.eventPrefix}:conflict`, { id: spec.id, detail });
    return { outcome: "conflict", detail };
  }

  function clearConflict(): void {
    conflicted = null;
    try {
      deleteKvValue(spec.kvNamespace, CONFLICT_KEY, resolveDb());
    } catch (err) {
      deps.log.warn({ err }, `${label}: failed to clear the conflict marker`);
    }
    deps.log.info({ id: spec.id }, `${label}: conflict cleared`);
  }

  function schedulePush(): void {
    if (stopped) return;
    // A fresh commit supersedes any standing failed-push retry — without
    // canceling it here, the retry timer and this new trailing-push timer
    // both eventually fire `doPush()` independently (the in-flight guard
    // below stops them overlapping, but not the redundant second attempt).
    if (pushRetryTimer) { deps.clearTimeout(pushRetryTimer); pushRetryTimer = null; }
    pushRetryAttempt = 0; // a fresh commit is a new push attempt, not a continuation of a prior failure streak
    if (pushTimer) deps.clearTimeout(pushTimer);
    const delayMs = safeReadSettings().pushDelaySec * 1000;
    pushTimer = deps.setTimeout(() => {
      pushTimer = null;
      void doPush();
    }, delayMs);
  }

  function schedulePushRetry(): void {
    if (stopped) return;
    if (pushRetryTimer) deps.clearTimeout(pushRetryTimer);
    const baseMs = safeReadSettings().pushDelaySec * 5 * 1000;
    const retryMs = nextPushRetryDelayMs(baseMs, pushRetryAttempt);
    pushRetryAttempt++;
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
    if (safeReadSettings().enabled === false) {
      deps.log.debug(`${label}: disabled via ${settingsKey}.enabled=false; skipping a due push`);
      return;
    }
    // Backstop. A pull-only spec never commits, so nothing should ever arm a
    // push, but the timer is armed from more than one place and this costs
    // nothing.
    if (spec.pullOnly) return;
    // Local-only (rt home init with no remote attached) is a permanent,
    // supported state — not a push failure: no exec, no retry, no broadcast.
    // Clearing pushPending/lastPushError here matters for a remote that
    // existed, failed to push, and was then removed by hand — without this,
    // a stale failure latches into status() forever and `committed ||
    // pushPending` re-arms a push every cycle that only ever no-ops here.
    if (!(await hasRemote(deps.exec, deps.repoDir))) {
      deps.log.debug(`${label}: no remote configured; nothing to push`);
      pushPending = false;
      lastPushError = null;
      return;
    }
    // A pulling spec is multi-writer: replaying the remote first is what keeps
    // a clone from diverging, and a conflict suspends the push rather than
    // resolving it in either direction.
    if (spec.pull) {
      const pulled = await pullNow();
      if (pulled.outcome === "conflict" || conflicted) return;
    }
    let result = await remoteGit(["push", "-q", "origin", "HEAD"], PUSH_TIMEOUT_MS);
    if (result.exitCode !== 0 && spec.pull && pushRetryAttempt === 0 && /\[rejected\]|non-fast-forward|fetch first/i.test(result.stderr)) {
      // The remote moved between the pull above and this push; one inline
      // replay beats waiting out a whole retry-backoff window.
      await pullNow();
      if (conflicted) return;
      result = await remoteGit(["push", "-q", "origin", "HEAD"], PUSH_TIMEOUT_MS);
    }
    if (result.exitCode === 0) {
      pushPending = false;
      pushFailureBroadcast = false;
      lastPushAt = deps.now();
      lastPushError = null;
      lastLoggedPushError = null;
      pushRetryAttempt = 0;
      persistPushRecord(spec, resolveDb(), { at: lastPushAt, ok: true }, deps.log);
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
      // R042: dedupe by message like the commit/add paths -- an unreachable
      // remote otherwise re-warns and re-persists identically on every
      // retry, indefinitely.
      if (redactedStderr !== lastLoggedPushError) {
        persistPushRecord(spec, resolveDb(), { at: deps.now(), ok: false, error: redactedStderr }, deps.log);
        deps.log.warn({ stderr: redactedStderr }, `${label}: push failed`);
        lastLoggedPushError = redactedStderr;
      }
      // Only the FIRST failure of an unbroken streak broadcasts — a retry
      // storm (schedulePushRetry firing every pushDelaySec*5) would
      // otherwise spam every WS/socket client with the same event.
      if (!pushFailureBroadcast) {
        deps.broadcast(`${spec.eventPrefix}:push-failed`, { error: redactedStderr, pushPending: true });
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

    const settings = safeReadSettings();
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
      deps.log.debug(`${label}: disabled via ${settingsKey}.enabled=false; skipping cycle`);
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
      deps.log.warn(`${label}: HEAD is detached; skipping cycle`);
      return { committed: false, sha: null, paths: [], reason, skipped: "detached" };
    }
    const gitDir = await resolveGitDir();
    if (existsSync(join(gitDir, "MERGE_HEAD")) || existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
      deps.log.warn(`${label}: a merge or rebase is in progress; skipping cycle`);
      return { committed: false, sha: null, paths: [], reason, skipped: "merge-in-progress" };
    }
    // Committing on top of a conflicted clone only buries the divergence
    // deeper: nothing more lands until the marker clears (see doPull).
    if (conflicted) {
      return { committed: false, sha: null, paths: [], reason, skipped: "conflict" };
    }
    if (spec.pullOnly) {
      return { committed: false, sha: null, paths: [], reason, skipped: "pull-only" };
    }

    let owners: Owners;
    try {
      owners = deps.readOwners(ownersPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastLoggedOwnersError) {
        deps.log.warn({ err }, `${label}: owners file unreadable; skipping cycle`);
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
    const entries = scopeEntries(parsePorcelainZ(statusResult.stdout), spec.scope);
    // A scoped spec's pathspec is the scoped entries' own paths, never the
    // scope's roots: `git add -A -- mattstack .sops.yaml .claude-plugin`
    // exits 128 and stages nothing when any root is absent from both tree
    // and index, and a clone that lost its marketplace would then fail
    // every cycle as add-failed. A rename's origPath rides along so the old
    // path's deletion lands in the same commit as the new path; scopeEntries
    // is what guarantees both halves are inside the scope.
    const scopeArgs: string[] = spec.scope
      ? [...new Set(entries.flatMap((e) => (e.origPath ? [e.origPath, e.path] : [e.path])))]
      : ["."];

    const plan = planSnapshot({
      entries,
      owners,
      now: deps.now(),
      firstSeenDirty,
      thresholdMs: settings.janitorThresholdHours * 60 * 60 * 1000,
    });

    firstSeenDirty = plan.nextFirstSeenDirty;
    persistState(spec, resolveDb(), firstSeenDirty, deps.log);

    let committed = false;
    let sha: string | null = null;

    // Two independent commit sites below (the auto commit and the
    // janitor-zone loop) can each attempt a commit this cycle; both fail the
    // same doomed way (exit 128, "empty ident name") when git cannot resolve
    // a committer. Checked once, up front, whenever EITHER would run, so a
    // janitor-only cycle (no auto paths, one dirty claimed zone) is covered
    // too, not just the auto-commit path. The probe asks git itself
    // (`git var`), not the config keys: a fresh Mac has no user.name but git
    // derives "<full name> <user@host>" from the account and commits fine,
    // exactly as a hand commit there would.
    const willAutoCommit = plan.autoPaths.length > 0 && plan.message !== null;
    const willJanitorCommit = (reason === "janitor" || reason === "manual") && plan.janitorZones.length > 0;
    if (willAutoCommit || willJanitorCommit) {
      const ident = await deps.exec(["git", "var", "GIT_COMMITTER_IDENT"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      // `runCapture` reports a spawn failure or a GIT_TIMEOUT_MS kill as -1,
      // which says nothing about the repo's identity — init() draws the same
      // line. Latching disabledReason on one slow `git var` would stop this
      // instance committing (and, but for pullNow's exemption, fetching) for
      // the rest of the daemon's life.
      if (ident.exitCode === -1) {
        if (lastLoggedCommitError !== "git-unavailable") {
          deps.log.warn({ stderr: ident.stderr }, `${label}: could not run git to resolve a committer identity (is it on PATH?); skipping cycle`);
          lastLoggedCommitError = "git-unavailable";
        }
        return { committed: false, sha: null, paths: [], reason, skipped: "git-unavailable" };
      }
      if (ident.exitCode !== 0 || !ident.stdout.trim()) {
        disabledReason = "no-git-identity";
        if (lastLoggedCommitError !== "no-git-identity") {
          deps.log.warn(`${label}: git cannot resolve a committer identity; run \`git config --global user.name\` and \`git config --global user.email\`; snapshots inert`);
          lastLoggedCommitError = "no-git-identity";
        }
        return { committed: false, sha: null, paths: [], reason, skipped: "no-git-identity" };
      }
    }

    if (willAutoCommit) {
      // `plan.autoPaths` describes what the STATUS SNAPSHOT at the top of
      // this run looked like — a purely descriptive record of intent. The
      // exclude pathspec built from `plan.excludedZones` (identical on both
      // the add and the commit below) is what's actually AUTHORITATIVE:
      // whatever changed on disk between the status read and this add/commit
      // pair is governed by the live pathspec, not by the stale path list.
      const excludeArgs = plan.excludedZones.map((zone) => `:(exclude)${zone}`);
      const addResult = await deps.exec(["git", "add", "-A", "--", ...scopeArgs, ...excludeArgs], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      if (addResult.exitCode !== 0) {
        const addSkipped: SkipReason = addResult.stderr.toLowerCase().includes("index.lock") ? "index-locked" : "add-failed";
        if (addResult.stderr !== lastLoggedAddError) {
          deps.log.warn({ stderr: addResult.stderr }, `${label}: git add failed; skipping cycle`);
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
      //
      // `-c commit.gpgsign=false`: a global signing config with an unusable
      // key fails every snapshot commit outright (exit 128), and nothing
      // about an unattended backup commit needs a signature. (Git identity
      // is confirmed once, above, before either commit site runs.)
      const message = reason === "manual" ? plan.message!.replace(/^snapshot:/, "snapshot (manual):") : plan.message!;
      const commitResult = await deps.exec(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", ...scopeArgs, ...excludeArgs], {
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
        deps.log.info({ sha, paths: plan.autoPaths.length, reason }, `${label}: committed`);
        deps.broadcast(`${spec.eventPrefix}:snapshot`, { sha, paths: plan.autoPaths, reason });
      } else {
        lastCommitError = commitResult.stderr;
        if (commitResult.stderr !== lastLoggedCommitError) {
          deps.log.warn({ stderr: commitResult.stderr }, `${label}: commit failed`);
          lastLoggedCommitError = commitResult.stderr;
        }
      }
    }

    if (willJanitorCommit) {
      for (const jz of plan.janitorZones) {
        const dirtyHours = Math.floor((deps.now() - jz.dirtySinceMs) / (60 * 60 * 1000));
        const message = `snapshot (janitor): ${jz.zone} dirty >${dirtyHours}h, owner ${jz.owner}`;
        const addResult = await deps.exec(["git", "add", "-A", "--", jz.zone], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
        if (addResult.exitCode !== 0) {
          deps.log.warn({ stderr: addResult.stderr, zone: jz.zone }, `${label}: janitor add failed; skipping this zone this cycle`);
          continue;
        }
        // Same self-contained-commit and unsigned-commit reasoning as the auto commit above.
        const commitResult = await deps.exec(["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, "--", jz.zone], {
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
          deps.log.info({ sha, paths: 1, reason }, `${label}: committed`);
          deps.broadcast(`${spec.eventPrefix}:snapshot`, { sha, paths: [jz.zone], reason });
        } else {
          lastCommitError = commitResult.stderr;
          if (commitResult.stderr !== lastLoggedCommitError) {
            deps.log.warn({ stderr: commitResult.stderr, zone: jz.zone }, `${label}: janitor commit failed`);
            lastLoggedCommitError = commitResult.stderr;
          }
        }
      }
    }

    if (committed || pushPending) {
      schedulePush();
    } else if (reason !== "watch" && (await hasRemote(deps.exec, deps.repoDir)) && (await unpushedAgainstOrigin(deps.exec, deps.repoDir))) {
      // The only path that notices a remote attached by hand after commits
      // already existed. Excluded from the watch debounce (and only there):
      // these five git spawns would otherwise run on every no-op fs cycle, to
      // detect a state that only ever changes by hand. `rt home snapshot` is
      // the affordance a user reaches for right after attaching a remote, so
      // "manual" must reach this even with nothing to commit.
      schedulePush();
    }

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
    const p = withGitLock(() => doRun(reason));
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
        deps.log.warn({ err }, `${label}: failed to read settings in status(); using the last-known value`);
        lastLoggedSettingsError = message;
      }
    }
    return {
      id: spec.id,
      enabled: lastKnownEnabled,
      watching: watcher !== null,
      repoDir: deps.repoDir,
      lastRunAt,
      lastCommit,
      lastCommitError,
      pushPending,
      lastPushAt,
      lastPushError,
      lastPullAt,
      lastPullError,
      lastPullSkipped,
      conflicted,
      pullOnly: spec.pullOnly === true,
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
    if (pullTimer) deps.clearTimeout(pullTimer);
  }

  return { stop, runNow, pullNow, status, ready: readyPromise };
}
