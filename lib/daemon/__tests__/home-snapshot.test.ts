import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { runCapture, type RunResult } from "../../subprocess.ts";
import type { Owners } from "../../home/snapshot-owners.ts";
import { openStateDb } from "../../state/db.ts";
import { closeStateDb, getKvValue } from "../../state/index.ts";
import { readHomePushRecord } from "../../home/push-record.ts";
import { rtDir } from "../../rt-paths.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { homeSnapshotSpec, startHomeSnapshot, startSnapshot, teamScope, teamSnapshotSpec, type HomeSnapshotDeps, type HomeSnapshotSettings } from "../home-snapshot.ts";

// ─── test doubles ────────────────────────────────────────────────────────────

function fakeLog(): Logger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  const rec = (level: string) => (...args: unknown[]) => calls.push({ level, args });
  return { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug"), calls } as unknown as Logger & {
    calls: { level: string; args: unknown[] }[];
  };
}

type ExecOpts = { cwd?: string; timeoutMs?: number; stderr?: "ignore" | "pipe" };
type Responder = (argv: string[]) => RunResult | undefined;

/** The git subcommand, past any leading `-c <config>` pairs — snapshot commits carry `-c commit.gpgsign=false`, so argv[1] is not always the verb. */
function gitVerb(argv: string[]): string | undefined {
  let i = 1;
  while (argv[i] === "-c") i += 2;
  return argv[i];
}

function defaultResponders(opts: {
  isRepo?: boolean;
  branch?: string;
  branchExit?: number;
  statusZ?: string;
  commitExit?: number;
  addExit?: number;
  pushExit?: number;
  pushStderr?: string;
  sha?: string;
  hasRemote?: boolean;
  hasIdentity?: boolean;
} = {}): Responder[] {
  const {
    isRepo = true, branch = "main", branchExit = 0, statusZ = "", commitExit = 0, addExit = 0, pushExit = 0, pushStderr = "", sha = "abc123",
    hasRemote = true, hasIdentity = true,
  } = opts;
  return [
    (argv) => (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree")
      ? { stdout: isRepo ? "true\n" : "", stderr: isRepo ? "" : "fatal: not a git repository", exitCode: isRepo ? 0 : 128 }
      : undefined,
    (argv) => (argv[1] === "rev-parse" && argv[2] === "--abbrev-ref" && argv[3] === "HEAD")
      ? { stdout: `${branch}\n`, stderr: "", exitCode: branchExit }
      : undefined,
    (argv) => (argv[1] === "rev-parse" && argv[2] === "HEAD")
      ? { stdout: `${sha}\n`, stderr: "", exitCode: 0 }
      : undefined,
    (argv) => (argv[1] === "status") ? { stdout: statusZ, stderr: "", exitCode: 0 } : undefined,
    (argv) => (argv[1] === "add") ? { stdout: "", stderr: "", exitCode: addExit } : undefined,
    // git identity probe, checked right before either commit site runs...
    // defaults to "resolvable" so every fixture not testing R043 stays green.
    (argv) => (argv[1] === "var" && argv[2] === "GIT_COMMITTER_IDENT")
      ? (hasIdentity
        ? { stdout: "rt test <rt@example.test> 1700000000 +0000\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "fatal: empty ident name (for <>) not allowed\n", exitCode: 128 })
      : undefined,
    (argv) => (gitVerb(argv) === "commit") ? { stdout: "", stderr: "", exitCode: commitExit } : undefined,
    // `hasRemote()`'s own probe — most fixtures simulate a repo that already has origin configured, matching every pre-existing push test's assumption.
    (argv) => (argv[1] === "remote" && argv.length === 2) ? { stdout: hasRemote ? "origin\n" : "", stderr: "", exitCode: 0 } : undefined,
    (argv) => (argv[1] === "push") ? { stdout: "", stderr: pushStderr, exitCode: pushExit } : undefined,
  ];
}

/** Records both argv and opts, so a test can assert cwd/timeoutMs actually reach exec, not just the command shape. */
function makeFakeExec(responders: Responder[]) {
  const calls: string[][] = [];
  const optsLog: ExecOpts[] = [];
  const fn = async (argv: [string, ...string[]], opts: ExecOpts = {}): Promise<RunResult> => {
    calls.push([...argv]);
    optsLog.push(opts);
    for (const r of responders) {
      const res = r(argv);
      if (res) return res;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { fn, calls, optsLog };
}

/**
 * Same as makeFakeExec, but the responder set can be swapped mid-test. The
 * module captures `exec` once at construction and never re-reads the deps
 * object afterward, so a test that wants to change exec's BEHAVIOR partway
 * through needs a double whose function reference stays fixed while what it
 * does underneath changes.
 */
function makeSwitchableExec(initial: Responder[]) {
  let responders = initial;
  const calls: string[][] = [];
  const fn = async (argv: [string, ...string[]]): Promise<RunResult> => {
    calls.push([...argv]);
    for (const r of responders) {
      const res = r(argv);
      if (res) return res;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { fn, calls, setResponders: (r: Responder[]) => { responders = r; } };
}

/** A gated exec double: every call answers immediately except `git push`, which blocks on `gate` until the test releases it — lets a test hold one push "in flight" while driving a second push attempt. */
function makeGatedPushExec(gate: Promise<void>, opts: { statusZ?: string } = {}) {
  const calls: string[][] = [];
  const fn = async (argv: [string, ...string[]]): Promise<RunResult> => {
    calls.push([...argv]);
    if (argv[1] === "push") {
      await gate;
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    for (const r of defaultResponders({ statusZ: opts.statusZ ?? "?? a.txt\0" })) {
      const res = r(argv);
      if (res) return res;
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { fn, calls };
}

interface PendingTimer { cb: () => void; ms: number }

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, PendingTimer>();
  const setTimeoutFn = (cb: () => void, ms: number) => {
    const id = nextId++;
    pending.set(id, { cb, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFn = (id: ReturnType<typeof setTimeout>) => {
    pending.delete(id as unknown as number);
  };
  /** Fires only timers matching `predicate`, leaving everything else (e.g. the janitor interval) pending — a test driving one specific timer must not incidentally trigger an unrelated one. */
  function fire(predicate: (t: PendingTimer) => boolean): void {
    const matched: PendingTimer[] = [];
    for (const [id, t] of pending.entries()) {
      if (predicate(t)) { matched.push(t); pending.delete(id); }
    }
    for (const t of matched) t.cb();
  }
  return { setTimeoutFn, clearTimeoutFn, pending, fire };
}

function makeFakeWatch() {
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  let closed = false;
  const calls: { path: string; options: unknown }[] = [];
  const fn = (path: string, options: { recursive: boolean }, l: (eventType: string, filename: string | null) => void) => {
    calls.push({ path, options });
    listener = l;
    return { close: () => { closed = true; } };
  };
  return { fn, calls, emit: (ev: string, filename: string | null) => listener?.(ev, filename), isClosed: () => closed };
}

const DEFAULT_SETTINGS: HomeSnapshotSettings = {
  enabled: true,
  debounceSec: 5,
  pushDelaySec: 10,
  janitorThresholdHours: 1,
  janitorIntervalMin: 15,
};

const NO_OWNERS: Owners = { zones: {} };

// A real directory (never touched; every git call underneath it is faked):
// the S090 existsSync guard runs against the real filesystem, so
// the fixture repoDir the whole suite shares must actually exist on disk,
// not just look plausible as a string.
const FAKE_REPO_DIR = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-fakerepo-")));
afterAll(() => {
  try { rmSync(FAKE_REPO_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

async function flushAsync(): Promise<void> {
  // Real macrotask hop — lets fake-exec's async chain (all microtasks, no
  // real timers involved) fully settle before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// baseDeps' default db points at a real (but throwaway) temp state.db, not a
// bogus in-memory stand-in — persistState does a real setKvValue against it,
// and a fake unwritable target would silently fail (caught and warned, per
// its own design) rather than exercising the real write path these tests
// want to cover. Every call gets its OWN fresh db (never the process-wide
// getStateDb() singleton), so tests never leak state into each other.
const createdStateDirs: string[] = [];
afterAll(() => {
  for (const dir of createdStateDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

function freshDb(): Database {
  const stateDir = mkdtempSync(join(tmpdir(), "rt-home-snapshot-fakestate-"));
  createdStateDirs.push(stateDir);
  return openStateDb(join(stateDir, "state.db"), "cli");
}

function baseDeps(overrides: Partial<HomeSnapshotDeps> = {}): {
  deps: HomeSnapshotDeps;
  log: ReturnType<typeof fakeLog>;
  broadcasts: { type: string; data: unknown }[];
  execCalls: string[][];
  watch: ReturnType<typeof makeFakeWatch>;
  timers: ReturnType<typeof makeFakeTimers>;
} {
  const log = fakeLog();
  const broadcasts: { type: string; data: unknown }[] = [];
  const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders());
  const watch = makeFakeWatch();
  const timers = makeFakeTimers();

  const deps: HomeSnapshotDeps = {
    log,
    broadcast: (type, data) => broadcasts.push({ type, data }),
    repoDir: FAKE_REPO_DIR,
    exec: execFn,
    watch: watch.fn,
    setTimeout: timers.setTimeoutFn,
    clearTimeout: timers.clearTimeoutFn,
    now: () => 1_000_000,
    readSettings: () => DEFAULT_SETTINGS,
    readOwners: () => NO_OWNERS,
    db: freshDb(),
    ...overrides,
  };

  return { deps, log, broadcasts, execCalls, watch, timers };
}

// ─── disabled / not-a-repo inert paths ──────────────────────────────────────

describe("startHomeSnapshot — inert paths", () => {
  test("enabled:false — inert, logs once at info, arms neither the watcher nor the janitor timer", async () => {
    const { deps, log, watch, execCalls, timers } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, enabled: false }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().enabled).toBe(false);
    expect(handle.status().watching).toBe(false);
    expect(watch.calls.length).toBe(0);
    expect(timers.pending.size).toBe(0);
    // The is-a-repo probe still runs (so a later live re-enable's manual run has already confirmed the directory) — nothing beyond it.
    expect(execCalls.length).toBe(1);
    expect(log.calls.filter((c) => c.level === "info").length).toBe(1);

    const result = await handle.runNow("manual");
    expect(result).toMatchObject({ committed: false, sha: null, paths: [], skipped: "disabled" });
  });

  test("not a git repo — inert, warns once, never arms the watcher", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ isRepo: false }));
    const { deps, log, watch } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(watch.calls.length).toBe(0);
    expect(log.calls.filter((c) => c.level === "warn").length).toBe(1);

    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("not-a-repo");
    // Only the one is-inside-work-tree probe — no further git calls attempted.
    expect(execCalls.length).toBe(1);
  });

  test("S090: a missing repoDir is diagnosed 'not-provisioned', names `rt home init`, never spawns git", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders());
    const { deps, log, watch } = baseDeps({ exec: execFn, repoDir: "/does/not/exist/rt-home-snapshot-s090" });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(watch.calls.length).toBe(0);
    const warnCall = log.calls.find((c) => c.level === "warn");
    expect(warnCall?.args[1]).toContain("rt home init");
    // The existsSync guard runs before any git spawn at all.
    expect(execCalls.length).toBe(0);

    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("not-provisioned");
    expect(execCalls.length).toBe(0);
  });

  test("a throwing watch seam (fs.watch EMFILE/ENOSPC/ENOENT) resolves ready promptly and makes runNow return an inert result, not hang", async () => {
    const throwingWatch = () => { throw new Error("EMFILE: too many open files"); };
    const { deps, log } = baseDeps({ watch: throwingWatch as any });
    const handle = startHomeSnapshot(deps);

    await handle.ready; // must resolve — a bare `await init()` without try/finally would hang here forever

    expect(log.calls.some((c) => c.level === "warn")).toBe(true);
    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("init-failed");
  });
});

// ─── live enable/disable ─────────────────────────────────────────────────────

describe("startHomeSnapshot — live enabled toggle", () => {
  test("a live rt.homeSnapshot.enabled=false stops auto-commits on the very next run, no daemon restart", async () => {
    let enabled = true;
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    enabled = false;
    const result = await handle.runNow("manual");

    expect(result.skipped).toBe("disabled");
    expect(execCalls.some((c) => c[1] === "add" || gitVerb(c) === "commit")).toBe(false);
  });

  test("status().enabled reflects the live setting on every call, not a value captured at startup", async () => {
    let enabled = true;
    const { deps } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().enabled).toBe(true);
    enabled = false;
    expect(handle.status().enabled).toBe(false);
    enabled = true;
    expect(handle.status().enabled).toBe(true);
  });

  test("a daemon that started disabled lazily arms the watcher and janitor timer on its first run after a live re-enable", async () => {
    let enabled = false;
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, watch, timers } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().watching).toBe(false);
    expect(watch.calls.length).toBe(0);

    enabled = true;
    const result = await handle.runNow("manual");

    expect(result.committed).toBe(true);
    expect(handle.status().watching).toBe(true);
    expect(watch.calls).toEqual([{ path: FAKE_REPO_DIR, options: { recursive: true } }]);
    const janitorEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.janitorIntervalMin * 60_000);
    expect(janitorEntry).toBeDefined();
  });

  test("an already-armed daemon does not re-arm a second watcher on later runs", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, watch } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    expect(watch.calls.length).toBe(1);

    await handle.runNow("manual");

    expect(watch.calls.length).toBe(1);
  });
});

// ─── watcher arming + debounce ───────────────────────────────────────────────

describe("startHomeSnapshot — watcher", () => {
  test("arms fs.watch(repoDir, {recursive:true}) and the janitor interval once ready", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(watch.calls).toEqual([{ path: FAKE_REPO_DIR, options: { recursive: true } }]);
    expect(handle.status().watching).toBe(true);
    // One pending timer: the janitor interval (debounceSec*1000 == distinguishable via ms below).
    const janitorEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.janitorIntervalMin * 60_000);
    expect(janitorEntry).toBeDefined();
  });

  test("ignores .git/ and bare .git events — no debounce armed", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    const before = timers.pending.size;

    watch.emit("change", ".git/index");
    watch.emit("change", ".git");
    watch.emit("rename", ".git/refs/heads/main");

    expect(timers.pending.size).toBe(before);
  });

  test("a real event arms a trailing debounce of debounceSec", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    const before = timers.pending.size;

    watch.emit("change", "prefs/foo.md");

    expect(timers.pending.size).toBe(before + 1);
    const armed = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.debounceSec * 1000);
    expect(armed).toBeDefined();
  });

  test("trailing edge — a second event before the timer fires resets the debounce, not stacks it", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    const before = timers.pending.size;

    watch.emit("change", "a.txt");
    watch.emit("change", "b.txt");

    // Still exactly one MORE pending timer than baseline — the first debounce timer was cleared, not left dangling.
    expect(timers.pending.size).toBe(before + 1);
  });

  test("readSettings is resolved once per debounce window, not once per fs event", async () => {
    let readSettingsCalls = 0;
    const readSettings = () => { readSettingsCalls++; return DEFAULT_SETTINGS; };
    const { deps, watch, timers } = baseDeps({ readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    readSettingsCalls = 0; // ignore whatever init()/armWatcher's own bookkeeping already did

    watch.emit("change", "a.txt");
    watch.emit("change", "b.txt");
    watch.emit("change", "c.txt");
    watch.emit("change", "d.txt");

    // One NEW window opened by the first event; the following three only extend it.
    expect(readSettingsCalls).toBe(1);

    timers.fire((t) => t.ms === DEFAULT_SETTINGS.debounceSec * 1000);
    await flushAsync();

    // A second, later window (after the first fired) resolves settings again exactly once.
    const afterWindowOne = readSettingsCalls;
    watch.emit("change", "e.txt");
    watch.emit("change", "f.txt");
    expect(readSettingsCalls).toBe(afterWindowOne + 1);
  });

  test("firing the debounce timer runs a snapshot with reason 'watch', message unprefixed", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, watch, timers, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    watch.emit("change", "a.txt");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.debounceSec * 1000);
    await flushAsync();

    const commitCall = execCalls.find((c) => gitVerb(c) === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain("snapshot: a.txt");
    expect(broadcasts.some((b) => b.type === "home:snapshot")).toBe(true);
  });
});

// ─── preflight ────────────────────────────────────────────────────────────

describe("startHomeSnapshot — preflight", () => {
  test("detached HEAD (rc 0, prints HEAD) skips the cycle with one warn, no add/commit", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ branch: "HEAD", branchExit: 0 }));
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.skipped).toBe("detached");
    expect(execCalls.some((c) => c[1] === "add" || gitVerb(c) === "commit")).toBe(false);
    expect(log.calls.some((c) => c.level === "warn")).toBe(true);
  });

  test("an unborn branch (rc!=0, also prints HEAD) is NOT treated as detached — it still takes a first snapshot", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ branch: "HEAD", branchExit: 128, statusZ: "?? a.txt\0" }));
    const { deps } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.skipped).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(execCalls.some((c) => gitVerb(c) === "commit")).toBe(true);
  });

  test("a MERGE_HEAD present skips the cycle", async () => {
    const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-preflight-")));
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "MERGE_HEAD"), "abc\n");
    try {
      const { deps } = baseDeps({ repoDir });
      const handle = startHomeSnapshot(deps);
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.skipped).toBe("merge-in-progress");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("a rebase-merge dir present skips the cycle", async () => {
    const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-preflight-")));
    mkdirSync(join(repoDir, ".git", "rebase-merge"), { recursive: true });
    try {
      const { deps } = baseDeps({ repoDir });
      const handle = startHomeSnapshot(deps);
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.skipped).toBe("merge-in-progress");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("a .git FILE (linked worktree) resolves the real gitdir via rev-parse --git-dir before checking MERGE_HEAD", async () => {
    const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-gitdir-")));
    const realGitDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-realgitdir-")));
    writeFileSync(join(repoDir, ".git"), `gitdir: ${realGitDir}\n`);
    writeFileSync(join(realGitDir, "MERGE_HEAD"), "abc\n");
    try {
      const { fn: execFn } = makeFakeExec([
        (argv) => (argv[1] === "rev-parse" && argv[2] === "--git-dir") ? { stdout: `${realGitDir}\n`, stderr: "", exitCode: 0 } : undefined,
        ...defaultResponders(),
      ]);
      const { deps } = baseDeps({ exec: execFn, repoDir });
      const handle = startHomeSnapshot(deps);
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.skipped).toBe("merge-in-progress");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(realGitDir, { recursive: true, force: true });
    }
  });
});

// ─── owners fail-closed ──────────────────────────────────────────────────────

describe("startHomeSnapshot — owners read failure", () => {
  test("readOwners throws — skip the cycle, warn once per distinct error, surface in status()", async () => {
    let calls = 0;
    const readOwners = () => { calls++; throw new Error("boom: malformed jsonc"); };
    const { deps, log } = baseDeps({ readOwners });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const r1 = await handle.runNow("manual");
    const r2 = await handle.runNow("manual");

    expect(r1.skipped).toBe("owners-read-error");
    expect(r2.skipped).toBe("owners-read-error");
    expect(log.calls.filter((c) => c.level === "warn").length).toBe(1);

    const status = handle.status();
    expect(status.ownersError).toContain("boom: malformed jsonc");
    expect(status.claimedZones).toEqual([]);
  });

  test("a distinct error message after a fixed one warns again", async () => {
    let message = "first error";
    const readOwners = () => { throw new Error(message); };
    const { deps, log } = baseDeps({ readOwners });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    message = "second, different error";
    await handle.runNow("manual");

    expect(log.calls.filter((c) => c.level === "warn").length).toBe(2);
  });
});

// ─── the exact pathspec / commit / janitor shapes ───────────────────────────

describe("startHomeSnapshot — commit shapes", () => {
  test("git add AND git commit both carry the same exclude pathspec, as separate argv elements", async () => {
    const owners: Owners = {
      zones: {
        "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
        "secrets/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const { fn: execFn, calls: execCalls, optsLog } = makeFakeExec(defaultResponders({ statusZ: "?? notes/a.md\0" }));
    const { deps } = baseDeps({ exec: execFn, readOwners: () => owners, repoDir: FAKE_REPO_DIR });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");

    const addIdx = execCalls.findIndex((c) => c[1] === "add");
    const commitIdx = execCalls.findIndex((c) => gitVerb(c) === "commit");
    expect(execCalls[addIdx]).toEqual(["git", "add", "-A", "--", ".", ":(exclude)prefs/", ":(exclude)secrets/"]);
    // The commit is pathspec-restricted too, not just the add — a plain
    // `git commit` would otherwise sweep in anything staged outside this
    // add (e.g. by the user, or inside a claimed zone), regardless of what
    // THIS add excluded.
    expect(execCalls[commitIdx]).toEqual([
      "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "snapshot (manual): notes",
      "--", ".", ":(exclude)prefs/", ":(exclude)secrets/",
    ]);
    expect(optsLog[addIdx]?.cwd).toBe(FAKE_REPO_DIR);
    expect(optsLog[addIdx]?.timeoutMs).toBeGreaterThan(0);
    expect(optsLog[commitIdx]?.cwd).toBe(FAKE_REPO_DIR);
    expect(optsLog[commitIdx]?.timeoutMs).toBeGreaterThan(0);
  });

  test("reason 'manual' prefixes the commit message; reason 'watch' leaves it bare", async () => {
    const { fn: manualExec, calls: manualCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps: manualDeps } = baseDeps({ exec: manualExec });
    const manualHandle = startHomeSnapshot(manualDeps);
    await manualHandle.ready;
    await manualHandle.runNow("manual");
    expect(manualCalls.find((c) => gitVerb(c) === "commit")).toContain("snapshot (manual): a.txt");

    const { fn: watchExec, calls: watchCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps: watchDeps } = baseDeps({ exec: watchExec });
    const watchHandle = startHomeSnapshot(watchDeps);
    await watchHandle.ready;
    await watchHandle.runNow("watch");
    expect(watchCalls.find((c) => gitVerb(c) === "commit")).toContain("snapshot: a.txt");
  });

  test("nothing to auto-commit — no-op, no add/commit, skipped:'no-changes'", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "" }));
    const { deps, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.committed).toBe(false);
    expect(result.skipped).toBe("no-changes");
    expect(execCalls.some((c) => c[1] === "add" || gitVerb(c) === "commit")).toBe(false);
    expect(broadcasts.length).toBe(0);
  });

  test("janitor zone commits ONLY on reason janitor/manual, never on watch, exact message shape, own pathspec-restricted commit", async () => {
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    // Zone dirty since long before now, past the (small) threshold — seeded
    // straight into the store, matching how a prior run's persistState left it.
    const db = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('home-snapshot', 'state', ?, 0);")
      .run(JSON.stringify({ firstSeenDirty: { "prefs/": 0 } }));

    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0" }));
    const { deps, broadcasts } = baseDeps({
      exec: execFn,
      readOwners: () => owners,
      db,
      now: () => 10_000_000, // far past a 1-hour threshold from firstSeenDirty=0 -> floor(10_000_000/3_600_000) = 2 hours
    });

    const watchHandle = startHomeSnapshot(deps);
    await watchHandle.ready;
    const watchResult = await watchHandle.runNow("watch");
    expect(watchResult.committed).toBe(false); // no auto paths (only the claimed zone changed) and janitor withheld on watch
    expect(execCalls.some((c) => c[1] === "add" && c.includes("prefs/"))).toBe(false);

    execCalls.length = 0;
    const manualResult = await watchHandle.runNow("manual");
    expect(manualResult.committed).toBe(true);
    expect(execCalls).toContainEqual(["git", "add", "-A", "--", "prefs/"]);
    expect(execCalls).toContainEqual([
      "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "snapshot (janitor): prefs/ dirty >2h, owner matt", "--", "prefs/",
    ]);
    expect(broadcasts.some((b) => b.type === "home:snapshot" && (b.data as any).paths.includes("prefs/"))).toBe(true);
  });

  test("every commit site runs with commit.gpgsign=false — a global signing config with an unusable key must not fail an unattended snapshot", async () => {
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    const db = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('home-snapshot', 'state', ?, 0);")
      .run(JSON.stringify({ firstSeenDirty: { "prefs/": 0 } }));

    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? notes/a.md\0?? prefs/x.md\0" }));
    const { deps } = baseDeps({ exec: execFn, readOwners: () => owners, db, now: () => 10_000_000 });

    const handle = startHomeSnapshot(deps);
    await handle.ready;
    await handle.runNow("manual");

    const commits = execCalls.filter((c) => gitVerb(c) === "commit");
    expect(commits.length).toBe(2); // the auto commit and the janitor zone commit
    for (const argv of commits) expect(argv.slice(0, 3)).toEqual(["git", "-c", "commit.gpgsign=false"]);
  });

  test("R043: missing git identity skips with 'no-git-identity', warns once, never attempts the commit", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", hasIdentity: false }));
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("no-git-identity");
    expect(execCalls.some((c) => gitVerb(c) === "commit")).toBe(false);
    expect(log.calls.filter((c) => c.level === "warn" && String(c.args[c.args.length - 1]).includes("git config --global user.name")).length).toBe(1);

    // A later manual call short-circuits without re-probing identity or git status.
    execCalls.length = 0;
    const secondResult = await handle.runNow("manual");
    expect(secondResult.skipped).toBe("no-git-identity");
    expect(execCalls.length).toBe(0);
    expect(log.calls.filter((c) => c.level === "warn").length).toBe(1); // still just the one warn
  });

  test("git identity resolvable: commits normally, exactly one `git var` probe and no config reads", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");
    expect(result.committed).toBe(true);
    expect(execCalls.filter((c) => c[1] === "var" && c[2] === "GIT_COMMITTER_IDENT").length).toBe(1);
    expect(execCalls.some((c) => c[1] === "config" && c[2] === "user.name")).toBe(false);
  });

  test("R043: a janitor-only cycle (no auto paths, one dirty claimed zone past threshold) with no git identity also skips 'no-git-identity', never attempts the janitor commit", async () => {
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    const db = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('home-snapshot', 'state', ?, 0);")
      .run(JSON.stringify({ firstSeenDirty: { "prefs/": 0 } }));

    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0", hasIdentity: false }));
    const { deps, log } = baseDeps({
      exec: execFn,
      readOwners: () => owners,
      db,
      now: () => 10_000_000, // far past a 1-hour threshold from firstSeenDirty=0
    });

    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("no-git-identity");
    // Only the claimed zone was dirty, so this cycle has no auto commit at
    // all: the identity gate must still catch the janitor-only path.
    expect(execCalls.some((c) => c[1] === "add")).toBe(false);
    expect(execCalls.some((c) => gitVerb(c) === "commit")).toBe(false);
    expect(log.calls.filter((c) => c.level === "warn" && String(c.args[c.args.length - 1]).includes("git config --global user.name")).length).toBe(1);
  });
});

// ─── concurrency guard ───────────────────────────────────────────────────────

describe("startHomeSnapshot — concurrency guard", () => {
  test("overlapping runNow calls reuse the same in-flight run, not start a second one", async () => {
    const { deps, execCalls } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const [r1, r2] = await Promise.all([handle.runNow("manual"), handle.runNow("manual")]);

    expect(r1).toEqual(r2);
    // Exactly one "git status" call across both overlapping callers — the
    // second call reused the first's in-flight run instead of starting its own.
    expect(execCalls.filter((c) => c[1] === "status").length).toBe(1);
  });
});

// ─── push scheduling ──────────────────────────────────────────────────────

describe("startHomeSnapshot — push", () => {
  test("a commit schedules a trailing push after pushDelaySec; success clears pushPending", async () => {
    const { fn: execFn, calls: execCalls, optsLog } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 0 }));
    const { deps, timers } = baseDeps({ exec: execFn, repoDir: FAKE_REPO_DIR });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();

    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    const pushIdx = execCalls.findIndex((c) => c[0] === "git" && c[1] === "push");
    expect(execCalls[pushIdx]).toEqual(["git", "push", "-q", "origin", "HEAD"]);
    expect(optsLog[pushIdx]?.cwd).toBe(FAKE_REPO_DIR);
    expect(optsLog[pushIdx]?.timeoutMs).toBeGreaterThan(0);
    expect(handle.status().pushPending).toBe(false);
    expect(handle.status().lastPushAt).toBe(1_000_000);
  });

  test("push failure sets pushPending + lastPushError and schedules a retry at pushDelaySec*5", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: "connection refused" }));
    const { deps, timers, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000); // fires ONLY the initial push attempt, not the unrelated janitor interval
    await flushAsync();

    expect(handle.status().pushPending).toBe(true);
    expect(handle.status().lastPushError).toContain("connection refused");
    expect(log.calls.some((c) => c.level === "warn")).toBe(true);

    const retryEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000);
    expect(retryEntry).toBeDefined();
  });

  test("a credentialed remote URL in a push failure's stderr is redacted before it reaches status() or a log line", async () => {
    const credentialedStderr = "fatal: unable to access 'https://alice:s3cr3t-token@github.com/acme/user.git/': The requested URL returned error: 403";
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: credentialedStderr }));
    const { deps, timers, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(handle.status().lastPushError).not.toContain("s3cr3t-token");
    expect(handle.status().lastPushError).toContain("https://<redacted>@github.com");

    const warnCall = log.calls.find((c) => c.level === "warn" && c.args[1] === "home-snapshot: push failed");
    expect(JSON.stringify(warnCall?.args)).not.toContain("s3cr3t-token");
  });

  test("R042: an unchanged push failure error does not repeat the warn log or the kv persist, and the retry backs off past the flat pushDelaySec*5 window", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: "connection refused" }));
    const { deps, timers, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    const warnAfterFirst = log.calls.filter((c) => c.level === "warn" && c.args[1] === "home-snapshot: push failed").length;
    expect(warnAfterFirst).toBe(1);
    const firstRetry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000);
    expect(firstRetry).toBeDefined();

    // Fire the retry itself -- same error, same stderr text.
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000);
    await flushAsync();

    const warnAfterSecond = log.calls.filter((c) => c.level === "warn" && c.args[1] === "home-snapshot: push failed").length;
    expect(warnAfterSecond).toBe(1); // unchanged error text: not re-logged

    const secondRetry = [...timers.pending.values()].find((t) => t.ms > DEFAULT_SETTINGS.pushDelaySec * 5 * 1000);
    expect(secondRetry).toBeDefined(); // backed off past the flat window
  });

  test("a pending push is retried on the next run even though that run commits nothing new", async () => {
    const switchable = makeSwitchableExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers } = baseDeps({ exec: switchable.fn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(handle.status().pushPending).toBe(true);

    timers.pending.clear(); // drop the standing retry timer to prove the NEXT RUN re-schedules one too
    switchable.setResponders(defaultResponders({ statusZ: "" })); // nothing dirty this time — the exec FUNCTION is unchanged, only its behavior
    const result = await handle.runNow("manual");

    expect(result.committed).toBe(false);
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();
  });

  test("a new commit after a failed push cancels the standing retry instead of stacking two pushes", async () => {
    const switchable = makeSwitchableExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers } = baseDeps({ exec: switchable.fn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(handle.status().pushPending).toBe(true);
    expect([...timers.pending.values()].some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000)).toBe(true);

    switchable.setResponders(defaultResponders({ statusZ: "?? b.txt\0", pushExit: 0 }));
    await handle.runNow("manual");

    const pending = [...timers.pending.values()];
    expect(pending.filter((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000).length).toBe(1);
    expect(pending.some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000)).toBe(false);
  });

  test("a second commit's push, arriving while the first push is still in flight, is not dropped — it runs once the first settles", async () => {
    let releasePush!: () => void;
    const gate = new Promise<void>((resolve) => { releasePush = resolve; });
    const gated = makeGatedPushExec(gate);
    const { deps, timers } = baseDeps({ exec: gated.fn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    // Commit 1, then fire its push timer — the push call blocks on `gate`.
    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(gated.calls.filter((c) => c[1] === "push").length).toBe(1);

    // Commit 2 lands while push 1 is still gated, and its own push timer fires too.
    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    // Coalesced into the in-flight push, not a second overlapping `git push` process.
    expect(gated.calls.filter((c) => c[1] === "push").length).toBe(1);

    // Releasing push 1 must re-schedule a push for the commit that arrived meanwhile.
    releasePush();
    await flushAsync();
    const rescheduled = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(rescheduled).toBeDefined();

    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(gated.calls.filter((c) => c[1] === "push").length).toBe(2);
  });

  test("stop() during an in-flight run prevents it from arming a push timer afterward", async () => {
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const exec: NonNullable<HomeSnapshotDeps["exec"]> = async (argv) => {
      if (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "", exitCode: 0 };
      if (argv[1] === "rev-parse" && argv[2] === "--abbrev-ref") return { stdout: "main\n", stderr: "", exitCode: 0 };
      if (argv[1] === "rev-parse" && argv[2] === "--git-dir") return { stdout: "", stderr: "", exitCode: 1 };
      if (argv[1] === "rev-parse" && argv[2] === "HEAD") return { stdout: "sha1\n", stderr: "", exitCode: 0 };
      if (argv[1] === "status") return { stdout: "?? a.txt\0", stderr: "", exitCode: 0 };
      if (argv[1] === "add") return { stdout: "", stderr: "", exitCode: 0 };
      if (argv[1] === "config") return { stdout: "rt test\n", stderr: "", exitCode: 0 };
      if (gitVerb(argv) === "commit") { await gate; return { stdout: "", stderr: "", exitCode: 0 }; }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { deps, timers } = baseDeps({ exec });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const runPromise = handle.runNow("manual");
    await flushAsync(); // let the run reach the gated commit call
    handle.stop();
    releaseCommit();
    await runPromise;

    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeUndefined();
  });
});

// ─── state store round-trip (RT-50 collapse) ──────────────────────────────────

describe("startHomeSnapshot — state persistence", () => {
  test("nextFirstSeenDirty is persisted to the store and reloaded by a fresh handle sharing the same db", async () => {
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0" }));
    const { deps } = baseDeps({ exec: execFn, readOwners: () => owners, now: () => 42 });

    const handle = startHomeSnapshot(deps);
    await handle.ready;
    await handle.runNow("manual");

    const onStore = getKvValue<{ firstSeenDirty: Record<string, number> }>("home-snapshot", "state", { firstSeenDirty: {} }, deps.db);
    expect(onStore.firstSeenDirty["prefs/"]).toBe(42);
    expect(handle.status().firstSeenDirty["prefs/"]).toBe(42);

    // A second handle sharing the SAME db (a daemon restart against the same
    // state.db) picks the persisted value back up.
    const { deps: deps2 } = baseDeps({ readOwners: () => owners, db: deps.db });
    const handle2 = startHomeSnapshot(deps2);
    await handle2.ready;
    expect(handle2.status().firstSeenDirty["prefs/"]).toBe(42);
  });

  test("the last-push record survives later commit cycles — its own kv row, never a sibling field of the one persistState rewrites wholesale", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, timers } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("watch");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(readHomePushRecord(deps.db)).toMatchObject({ ok: true, at: 1_000_000 });

    // persistState writes `{ firstSeenDirty }` over its whole row on EVERY
    // cycle, committing or not — a lastPush stored there would be gone here.
    await handle.runNow("watch");
    await handle.runNow("watch");
    await flushAsync();
    expect(readHomePushRecord(deps.db)).toMatchObject({ ok: true, at: 1_000_000 });
    expect(Object.keys(getKvValue<Record<string, unknown>>("home-snapshot", "state", {}, deps.db))).toEqual(["firstSeenDirty"]);

    handle.stop();
  });

  test("a failed push records why, so the home.backup row can name it", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: "remote: Permission to o/r.git denied\n" }));
    const { deps, timers } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("watch");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(readHomePushRecord(deps.db)).toMatchObject({ ok: false, error: "remote: Permission to o/r.git denied\n" });
    handle.stop();
  });

  test("a credentialed remote URL never reaches the persisted record", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({
      statusZ: "?? a.txt\0",
      pushExit: 128,
      pushStderr: "fatal: unable to access 'https://matt:ghp_secret@github.com/o/r.git/'",
    }));
    const { deps, timers } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("watch");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(readHomePushRecord(deps.db)?.error).not.toContain("ghp_secret");
    handle.stop();
  });

  test("a malformed stored row starts from empty state instead of crashing, and warns loudly", async () => {
    const db = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('home-snapshot', 'state', '{not json', 0);").run();
    const { deps, log } = baseDeps({ db });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().firstSeenDirty).toEqual({});
    expect(log.calls.some((c) => c.level === "warn" && c.args[1] === "home-snapshot: state row corrupt; starting from empty first-seen-dirty state")).toBe(true);
  });

  test("no prior write (first run) does NOT warn", async () => {
    const { deps, log } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(log.calls.filter((c) => c.level === "warn").length).toBe(0);
    expect(handle.status().firstSeenDirty).toEqual({});
  });

  test("a pre-existing home-snapshot-state.json is imported on first read, and renamed to .migrated", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-snapshot-legacy-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    closeStateDb();
    try {
      const legacyPath = join(home, ".mattstack", "rt", "home-snapshot-state.json");
      mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ firstSeenDirty: { "claimed-zone/": 1 } }));
      expect(existsSync(legacyPath)).toBe(true);

      const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? notes.md\0" }));
      // No `db` override: this run goes through the real getStateDb() singleton,
      // matching the real daemon wiring, so the legacy-import path (which
      // targets rtDir()) actually lands under the HOME faked above.
      const { deps } = baseDeps({ exec: execFn, db: undefined, now: () => 99 });

      const handle = startHomeSnapshot(deps);
      await handle.ready;

      // Imported before any run: the janitor-threshold clock for a
      // previously-dirty claimed zone survives the upgrade.
      expect(handle.status().firstSeenDirty["claimed-zone/"]).toBe(1);
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    } finally {
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt on-disk home-snapshot-state.json warns and is left in place; state starts empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-snapshot-legacy-corrupt-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    closeStateDb();
    try {
      const legacyPath = join(home, ".mattstack", "rt", "home-snapshot-state.json");
      mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
      writeFileSync(legacyPath, "{ not valid json");

      const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? notes.md\0" }));
      const { deps, log } = baseDeps({ exec: execFn, db: undefined, now: () => 99 });

      const handle = startHomeSnapshot(deps);
      await handle.ready;

      expect(handle.status().firstSeenDirty).toEqual({});
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
      expect(log.calls.some((c) => c.level === "warn")).toBe(true);
    } finally {
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── boot order: db must open daemon-flavored, never at construction ────────

describe("startHomeSnapshot (boot order)", () => {
  test("constructing startHomeSnapshot does not open the state.db singleton before the caller's next await", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-snapshot-bootorder-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    closeStateDb();
    try {
      const stateDbPath = join(home, ".mattstack", "rt", "state.db");
      const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
      // No `db` override: this exercises the real getStateDb() singleton,
      // matching lib/daemon.ts's module-scope `startHomeSnapshot(...)` call,
      // the exact call site that used to open state.db "cli"-flavored before
      // startDaemon() ever got to openBranchCacheStore().
      const { deps } = baseDeps({ exec: execFn, db: undefined });

      const handle = startHomeSnapshot(deps);

      // Synchronously, right after construction returns, mirroring the
      // module-scope call in lib/daemon.ts, which runs to completion before
      // startDaemon() (and its openBranchCacheStore() daemon-flavored open)
      // is ever reached, no db file may exist yet.
      expect(existsSync(stateDbPath)).toBe(false);

      await handle.ready;
      // First real use (init()'s loadState, past its own `await deps.exec`)
      // has by now opened it.
      expect(existsSync(stateDbPath)).toBe(true);
    } finally {
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── stop() ───────────────────────────────────────────────────────────────

describe("startHomeSnapshot — stop", () => {
  test("stop() closes the watcher and clears pending timers", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    expect(timers.pending.size).toBeGreaterThan(0);

    handle.stop();

    expect(watch.isClosed()).toBe(true);
    expect(timers.pending.size).toBe(0);
    expect(handle.status().watching).toBe(false);
  });
});

// ─── real-git integration tests (temp HOME, local bare origin, no network) ──

describe("startHomeSnapshot — real git integration", () => {
  function initRepoWithOrigin(root: string): { originDir: string; repoDir: string } {
    const originDir = join(root, "origin.git");
    const repoDir = join(root, "user");
    execFileSync("git", ["init", "--bare", "-q", originDir]);
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    execFileSync("git", ["config", "user.email", "rt@example.test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "rt test"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });
    return { originDir, repoDir };
  }

  test("commits auto paths, pushes to the local bare origin, leaves a claimed zone uncommitted", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-integration-")));
    const { originDir, repoDir } = initRepoWithOrigin(root);
    const db = openStateDb(join(root, "state.db"), "cli");

    try {
      writeFileSync(join(repoDir, "README.md"), "seed\n");
      mkdirSync(join(repoDir, "prefs"), { recursive: true });
      writeFileSync(join(repoDir, "prefs", "owned.md"), "seed\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoDir });
      execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repoDir });
      execFileSync("git", ["branch", "--set-upstream-to=origin/main", "main"], { cwd: repoDir });

      writeFileSync(join(repoDir, "notes.md"), "new note\n");
      writeFileSync(join(repoDir, "prefs", "owned.md"), "claimed-zone edit — must stay uncommitted\n");

      const log = fakeLog();
      const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
      // Real setTimeout, at the clamped floor of 1s (clampSettings enforces
      // pushDelaySec >= 1) — no long waiting, this only speeds up the
      // trailing push.
      const handle = startHomeSnapshot({
        log,
        broadcast: () => {},
        repoDir,
        db,
        readSettings: () => ({ ...DEFAULT_SETTINGS, pushDelaySec: 1 }),
        readOwners: () => owners,
      });
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.committed).toBe(true);
      expect(result.sha).not.toBeNull();

      // Let the real (1s) trailing push timer fire.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const log_ = execFileSync("git", ["log", "--oneline", "-1"], { cwd: repoDir }).toString();
      expect(log_).toContain("snapshot (manual):");

      const originHead = execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: originDir }).toString().trim();
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();
      expect(originHead).toBe(localHead);

      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString();
      expect(status).toContain("prefs/owned.md");

      handle.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("a staged file inside a claimed zone survives a snapshot uncommitted", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-staged-zone-")));
    const { repoDir } = initRepoWithOrigin(root);
    const db = openStateDb(join(root, "state.db"), "cli");

    try {
      mkdirSync(join(repoDir, "prefs"), { recursive: true });
      writeFileSync(join(repoDir, "prefs", "owned.md"), "seed\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoDir });

      // Simulate the user (or a stray earlier `git add`) having already
      // staged a change INSIDE the claimed zone before this snapshot cycle.
      writeFileSync(join(repoDir, "prefs", "owned.md"), "user's own staged edit\n");
      execFileSync("git", ["add", "prefs/owned.md"], { cwd: repoDir });

      // Plus an ordinary outside-the-zone change to actually trigger a commit.
      writeFileSync(join(repoDir, "notes.md"), "new note\n");

      const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
      const handle = startHomeSnapshot({
        log: fakeLog(),
        broadcast: () => {},
        repoDir,
        db,
        readSettings: () => ({ ...DEFAULT_SETTINGS, pushDelaySec: 3600 }), // don't push in this test
        readOwners: () => owners,
      });
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.committed).toBe(true);

      const committedFiles = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repoDir })
        .toString().trim().split("\n").filter(Boolean);
      expect(committedFiles).toEqual(["notes.md"]);

      // The zone's edit is still staged (index differs from HEAD for it) but not committed.
      const diffCached = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repoDir }).toString().trim();
      expect(diffCached).toBe("prefs/owned.md");

      handle.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("a claimed FILE zone is genuinely excluded end-to-end — the exclude pathspec, against real git, actually protects a single file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-file-zone-")));
    const { repoDir } = initRepoWithOrigin(root);
    const db = openStateDb(join(root, "state.db"), "cli");

    try {
      mkdirSync(join(repoDir, "scripts"), { recursive: true });
      writeFileSync(join(repoDir, "scripts", "deploy.sh"), "#!/bin/sh\necho seed\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoDir });

      // Edit the claimed file AND a same-prefix sibling that must NOT be
      // protected by it (the exact bug: a naive trailing-slash exclude would
      // either miss the claimed file entirely or over-match this sibling).
      writeFileSync(join(repoDir, "scripts", "deploy.sh"), "#!/bin/sh\necho changed\n");
      writeFileSync(join(repoDir, "scripts", "deploy.sh.bak"), "backup\n");
      writeFileSync(join(repoDir, "notes.md"), "new note\n");

      const owners: Owners = { zones: { "scripts/deploy.sh": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
      const handle = startHomeSnapshot({
        log: fakeLog(),
        broadcast: () => {},
        repoDir,
        db,
        readSettings: () => ({ ...DEFAULT_SETTINGS, pushDelaySec: 3600 }),
        readOwners: () => owners,
      });
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.committed).toBe(true);

      const committedFiles = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repoDir })
        .toString().trim().split("\n").filter(Boolean).sort();
      expect(committedFiles).toEqual(["notes.md", "scripts/deploy.sh.bak"]);

      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString();
      expect(status).toContain(" M scripts/deploy.sh");

      handle.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

// ─── commit observability: one info log, persistent-failure visibility ─────

describe("startHomeSnapshot — commit observability", () => {
  test("a successful commit logs one info line with sha, path count, and reason", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0?? b.txt\0" }));
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");

    const committedLogs = log.calls.filter((c) => c.level === "info" && c.args[1] === "home-snapshot: committed");
    expect(committedLogs.length).toBe(1);
    expect(committedLogs[0]!.args[0]).toMatchObject({ sha: "abc123", paths: 2, reason: "manual" });
  });

  test("a failed commit sets status().lastCommitError; a later success clears it", async () => {
    const switchable = makeSwitchableExec(defaultResponders({ statusZ: "?? a.txt\0", commitExit: 1 }));
    const { deps } = baseDeps({ exec: switchable.fn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    expect(handle.status().lastCommitError).not.toBeNull();

    switchable.setResponders(defaultResponders({ statusZ: "?? b.txt\0", commitExit: 0 }));
    await handle.runNow("manual");
    expect(handle.status().lastCommitError).toBeNull();
  });

  test("a repeated identical commit failure warns once; a different failure message warns again", async () => {
    let stderr = "fatal: unable to write new index file";
    const execWithStderr: NonNullable<HomeSnapshotDeps["exec"]> = async (argv) => {
      if (gitVerb(argv) === "commit") return { stdout: "", stderr, exitCode: 1 };
      for (const r of defaultResponders({ statusZ: "?? a.txt\0" })) {
        const res = r(argv);
        if (res) return res;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { deps, log } = baseDeps({ exec: execWithStderr });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    await handle.runNow("manual");
    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === "home-snapshot: commit failed").length).toBe(1);

    stderr = "fatal: a different failure";
    await handle.runNow("manual");
    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === "home-snapshot: commit failed").length).toBe(2);
  });
});

// ─── git add failure handling ────────────────────────────────────────────────

describe("startHomeSnapshot — git add failure", () => {
  test("a git add failure mentioning index.lock skips with 'index-locked', never attempts commit", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec([
      (argv) => (argv[1] === "add") ? { stdout: "", stderr: "fatal: Unable to create '.git/index.lock': File exists.", exitCode: 128 } : undefined,
      ...defaultResponders({ statusZ: "?? a.txt\0" }),
    ]);
    const { deps } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.skipped).toBe("index-locked");
    expect(execCalls.some((c) => gitVerb(c) === "commit")).toBe(false);
  });

  test("a git add failure NOT mentioning index.lock skips with 'add-failed'", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec([
      (argv) => (argv[1] === "add") ? { stdout: "", stderr: "fatal: disk full", exitCode: 1 } : undefined,
      ...defaultResponders({ statusZ: "?? a.txt\0" }),
    ]);
    const { deps } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.skipped).toBe("add-failed");
    expect(execCalls.some((c) => gitVerb(c) === "commit")).toBe(false);
  });

  test("a repeated identical git add failure warns once", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec([
      (argv) => (argv[1] === "add") ? { stdout: "", stderr: "fatal: disk full", exitCode: 1 } : undefined,
      ...defaultResponders({ statusZ: "?? a.txt\0" }),
    ]);
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    await handle.runNow("manual");

    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === "home-snapshot: git add failed; skipping cycle").length).toBe(1);
    expect(execCalls.filter((c) => c[1] === "add").length).toBe(2); // still attempted every run, just not re-warned
  });
});

// ─── kill switch cancels a scheduled push ───────────────────────────────────

describe("startHomeSnapshot — kill switch cancels pending push", () => {
  test("a live disable cancels a scheduled push timer and its retry timer", async () => {
    let enabled = true;
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000); // push fails -> schedules a retry
    await flushAsync();
    expect([...timers.pending.values()].some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000)).toBe(true);

    enabled = false;
    await handle.runNow("manual");

    const pending = [...timers.pending.values()];
    expect(pending.some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000)).toBe(false);
    expect(pending.some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000)).toBe(false);
    // pushPending itself is untouched — there's still a real unpushed commit, just nothing scheduled to push it while disabled.
    expect(handle.status().pushPending).toBe(true);
  });

  test("re-enabling later re-arms the push via the normal committed||pushPending check", async () => {
    let enabled = true;
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    enabled = false;
    await handle.runNow("manual");
    expect(timers.pending.size === 0 || [...timers.pending.values()].every((t) => t.ms !== DEFAULT_SETTINGS.pushDelaySec * 1000)).toBe(true);

    enabled = true;
    await handle.runNow("manual");
    expect([...timers.pending.values()].some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000)).toBe(true);
  });

  test("a push timer that fires while disabled never touches git — doPushInner's own kill switch, not just doRun's timer-cancel", async () => {
    // Disabled WITHOUT a further doRun call in between (e.g. debounceSec >
    // pushDelaySec, or the watcher never re-triggers) — doRun's own
    // cancel-the-timer logic never gets a chance to run, so the ALREADY
    // ARMED pushTimer is the only thing standing between this commit and
    // a push while disabled.
    let enabled = true;
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 0 }));
    const { deps, timers } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();

    enabled = false;
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(execCalls.some((c) => c[1] === "push")).toBe(false);
  });

  // CodeRabbit (PR #137): safeReadSettings()'s catch fallback hardcoded
  // enabled:true, so a settings-read failure that hits AFTER the store has
  // already been observed disabled resurrected the kill switch's "enabled"
  // view and let a scheduled push through anyway.
  test("a settings-read failure after the store was observed disabled falls back to disabled, not enabled:true", async () => {
    let mode: "enabled" | "disabled" | "throw" = "enabled";
    const readSettings = () => {
      if (mode === "throw") throw new Error("settings store corrupt");
      return { ...DEFAULT_SETTINGS, enabled: mode === "enabled" };
    };
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 0 }));
    const { deps, timers } = baseDeps({ exec: execFn, readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();

    mode = "disabled";
    handle.status(); // a successful read observes disabled, updating the last-known state

    mode = "throw"; // the settings store breaks while the last-known state is still disabled
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(execCalls.some((c) => c[1] === "push")).toBe(false);
  });
});

// ─── home:push-failed broadcasts once per failure streak ────────────────────

describe("startHomeSnapshot — home:push-failed broadcast", () => {
  test("only the FIRST push failure of a streak broadcasts home:push-failed", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: "connection refused" }));
    const { deps, timers, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000); // first retry, still failing
    await flushAsync();
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000); // second retry, still failing
    await flushAsync();

    const pushFailedEvents = broadcasts.filter((b) => b.type === "home:push-failed");
    expect(pushFailedEvents.length).toBe(1);
    expect(pushFailedEvents[0]!.data).toMatchObject({ pushPending: true });
  });

  test("a success resets the streak so the NEXT failure broadcasts again", async () => {
    const switchable = makeSwitchableExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers, broadcasts } = baseDeps({ exec: switchable.fn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(broadcasts.filter((b) => b.type === "home:push-failed").length).toBe(1);

    switchable.setResponders(defaultResponders({ statusZ: "?? b.txt\0", pushExit: 0 }));
    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    expect(handle.status().pushPending).toBe(false);

    switchable.setResponders(defaultResponders({ statusZ: "?? c.txt\0", pushExit: 1 }));
    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(broadcasts.filter((b) => b.type === "home:push-failed").length).toBe(2);
  });
});

// ─── settings clamping ────────────────────────────────────────────────────

describe("startHomeSnapshot — settings clamping", () => {
  test("debounceSec below 1 (or NaN) is clamped, never used to arm a sub-second or nonsensical timer", async () => {
    const { deps, watch, timers } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, debounceSec: 0 }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    watch.emit("change", "a.txt");

    const armed = [...timers.pending.values()].find((t) => t.ms >= 1000 && t.ms !== DEFAULT_SETTINGS.janitorIntervalMin * 60_000);
    expect(armed?.ms).toBe(1000); // clamped to the 1s floor, not 0
  });

  test("janitorIntervalMin of NaN falls back to the registry default (30 minutes)", async () => {
    const { deps, timers } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, janitorIntervalMin: Number.NaN }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const janitorEntry = [...timers.pending.values()].find((t) => t.ms === 30 * 60_000);
    expect(janitorEntry).toBeDefined();
  });

  test("janitorThresholdHours is clamped to a 0.1h floor, not allowed to hit 0 or go negative", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0" }));
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    const { deps } = baseDeps({
      exec: execFn,
      readOwners: () => owners,
      readSettings: () => ({ ...DEFAULT_SETTINGS, janitorThresholdHours: -5 }),
      now: () => 1_000_000,
    });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    // firstSeenDirty starts empty, so this run only OPENS the dirty window (now)
    // rather than crossing an already-negative (i.e. instantly-tripped) threshold.
    const result = await handle.runNow("manual");
    expect(result.committed).toBe(false); // no janitor zone yet — first time seen dirty, threshold not yet elapsed
  });

  test("pushDelaySec of 0 is clamped to a 1s floor", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, timers } = baseDeps({ exec: execFn, readSettings: () => ({ ...DEFAULT_SETTINGS, pushDelaySec: 0 }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");

    const pushEntry = [...timers.pending.values()].find((t) => t.ms === 1000);
    expect(pushEntry).toBeDefined();
  });
});

// ─── startup safety ──────────────────────────────────────────────────────────

describe("startHomeSnapshot — startup safety", () => {
  test("readSettings throwing at construction time does not crash startHomeSnapshot itself", () => {
    let calls = 0;
    const readSettings = () => {
      calls++;
      if (calls === 1) throw new Error("settings store corrupt");
      return DEFAULT_SETTINGS;
    };
    const { deps, log } = baseDeps({ readSettings });

    expect(() => startHomeSnapshot(deps)).not.toThrow();
    expect(log.calls.some((c) => c.level === "warn" && c.args[1] === "home-snapshot: failed to read rt.homeSnapshot settings at startup")).toBe(true);
  });

  test("after a startup-only readSettings throw, the module still becomes ready and functions normally", async () => {
    let calls = 0;
    const readSettings = () => {
      calls++;
      if (calls === 1) throw new Error("settings store corrupt");
      return DEFAULT_SETTINGS;
    };
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps } = baseDeps({ exec: execFn, readSettings });
    const handle = startHomeSnapshot(deps);

    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.committed).toBe(true);
  });
});

// ─── spawn failure vs. "not a repo" ──────────────────────────────────────────

describe("startHomeSnapshot — git spawn failure", () => {
  test("exitCode -1 (git not on PATH / spawn failure) logs its own message, distinct from 'not a git repository'", async () => {
    const { fn: execFn } = makeFakeExec([
      (argv) => (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree") ? { stdout: "", stderr: "", exitCode: -1 } : undefined,
      ...defaultResponders(),
    ]);
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const warnCall = log.calls.find((c) => c.level === "warn");
    expect(warnCall?.args[1]).toContain("could not run git");
    expect(warnCall?.args[1]).not.toContain("is not a git repository");

    const result = await handle.runNow("manual");
    expect(result.skipped).toBe("init-failed");
  });
});

// ─── settings-store failures after boot: watcher callback + status() ───────

describe("startHomeSnapshot — settings-read resilience", () => {
  test("a settings-read failure while arming the debounce falls back to the registry default; the warn dedupes by message, not a one-shot", async () => {
    let failMessage: string | null = null;
    const readSettings = () => {
      if (failMessage !== null) throw new Error(failMessage);
      return DEFAULT_SETTINGS;
    };
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, watch, timers, log } = baseDeps({ exec: execFn, readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;
    // Armed fine while readSettings was still healthy (construction, init,
    // scheduleJanitor all succeeded before failMessage was ever set).
    expect(watch.calls.length).toBe(1);

    failMessage = "settings store corrupt";
    watch.emit("change", "a.txt");
    const armed = [...timers.pending.values()].find((t) => t.ms === 20_000); // SETTINGS_FALLBACK.debounceSec * 1000
    expect(armed).toBeDefined();
    const warnLine = "home-snapshot: failed to read settings while arming the debounce; using the default";
    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === warnLine).length).toBe(1);

    // Recover before the run itself actually happens — doRun's OWN
    // top-level settings read is a separate, unguarded call site (out of
    // scope here); this test is only about the debounce-ARMING read.
    failMessage = null;
    timers.fire((t) => t.ms === 20_000);
    await flushAsync();

    // A NEW window, failing again but with a DIFFERENT message, warns again — dedup is per-message, not "ever only once".
    failMessage = "a different settings failure";
    watch.emit("change", "b.txt");
    const armedAgain = [...timers.pending.values()].find((t) => t.ms === 20_000);
    expect(armedAgain).toBeDefined();
    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === warnLine).length).toBe(2);
  });

  test("status() falls back to the last-known enabled value and warns once when settings reads start failing", async () => {
    let broken = false;
    const readSettings = () => {
      if (broken) throw new Error("settings store corrupt");
      return DEFAULT_SETTINGS;
    };
    const { deps, log } = baseDeps({ readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().enabled).toBe(true);

    broken = true;
    expect(handle.status().enabled).toBe(true); // last-known, not a thrown error
    expect(handle.status().enabled).toBe(true);

    const warnLine = "home-snapshot: failed to read settings in status(); using the last-known value";
    expect(log.calls.filter((c) => c.level === "warn" && c.args[1] === warnLine).length).toBe(1);
  });

  test("S091: a readSettings throw during doRun falls back to defaults instead of rejecting the run", async () => {
    let broken = false;
    const readSettings = () => {
      if (broken) throw new Error("settings store corrupt");
      return DEFAULT_SETTINGS;
    };
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, log } = baseDeps({ exec: execFn, readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    broken = true;
    const result = await handle.runNow("manual");

    expect(result.committed).toBe(true); // did not reject; fell back to defaults and still ran
    expect(log.calls.some((c) => c.level === "warn" && c.args[1] === "home-snapshot: failed to read settings; using the last-known enabled state")).toBe(true);
  });

  test("S091: a readSettings throw while re-arming the janitor after a run still re-arms it", async () => {
    let broken = false;
    const readSettings = () => {
      if (broken) throw new Error("settings store corrupt");
      return DEFAULT_SETTINGS;
    };
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "" })); // nothing dirty: a fast, uneventful janitor run
    const { deps, timers } = baseDeps({ exec: execFn, readSettings });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const firstJanitor = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.janitorIntervalMin * 60_000);
    expect(firstJanitor).toBeDefined();

    broken = true;
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.janitorIntervalMin * 60_000);
    await flushAsync();

    // Re-armed on the registry-default interval (30min), not dropped forever
    // -- readSettings is broken, so the re-arm can't see the test's own
    // 15min DEFAULT_SETTINGS override.
    const secondJanitor = [...timers.pending.values()].find((t) => t.ms === 30 * 60_000);
    expect(secondJanitor).toBeDefined();
  });
});

// ─── local-only remote state: real git, no clone — no remote is a state ────

describe("startHomeSnapshot — local-only remote state", () => {
  const createdRoots: string[] = [];
  afterAll(() => {
    for (const root of createdRoots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  });

  const LOCAL_ONLY_SETTINGS: HomeSnapshotSettings = { ...DEFAULT_SETTINGS, pushDelaySec: 1 };
  const PUSH_SETTLE_MS = 1500;

  /** Builds the full sequence against real git — `git init` -> commit -> (later) attach remote -> push -> push again — never a clone, since a clone arrives with upstream already configured and every defect this suite guards against is invisible there. */
  async function harnessWithLocalOnlyRepo() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-localonly-")));
    createdRoots.push(root);
    const repoDir = join(root, "user");
    const originDir = join(root, "origin.git");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    execFileSync("git", ["config", "user.email", "rt@example.test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "rt test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "seed\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoDir });
    execFileSync("git", ["init", "--bare", "-q", originDir]);

    const db = openStateDb(join(root, "state.db"), "cli");
    const broadcastLog: { type: string; data: unknown }[] = [];
    const calls: string[][] = [];
    const exec: NonNullable<HomeSnapshotDeps["exec"]> = async (argv, opts) => {
      calls.push([...argv]);
      return runCapture(argv, opts);
    };

    const handle = startHomeSnapshot({
      log: fakeLog(),
      broadcast: (type, data) => broadcastLog.push({ type, data }),
      repoDir,
      db,
      exec,
      readSettings: () => LOCAL_ONLY_SETTINGS,
      readOwners: () => NO_OWNERS,
    });
    await handle.ready;

    const settle = () => new Promise((resolve) => setTimeout(resolve, PUSH_SETTLE_MS));

    return {
      async writeFile(relPath: string, content: string): Promise<void> {
        const target = join(root, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      },
      async runCycles(n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
          await handle.runNow("watch");
          await settle();
        }
      },
      async janitorTick(): Promise<void> {
        await handle.runNow("janitor");
        await settle();
      },
      async manualTick(): Promise<void> {
        await handle.runNow("manual");
        await settle();
      },
      async attachRemote(): Promise<void> {
        execFileSync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });
      },
      async attachNonOriginRemote(): Promise<void> {
        execFileSync("git", ["remote", "add", "upstream", originDir], { cwd: repoDir });
      },
      execCalls: () => calls,
      commits: () => broadcastLog.filter((b) => b.type === "home:snapshot"),
      broadcasts: (type: string) => broadcastLog.filter((b) => b.type === type).map((b) => b.data),
      stop: () => handle.stop(),
    };
  }

  test("no remote: commits, never pushes, never broadcasts a failure", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.writeFile("user/settings.user.jsonc", "{}");
      await h.runCycles(3);
      expect(h.commits().length).toBeGreaterThan(0);
      expect(h.execCalls().filter((c) => c[1] === "push")).toEqual([]);
      expect(h.broadcasts("home:push-failed")).toEqual([]);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("a non-origin remote never arms a push: the push itself is origin-only", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.writeFile("user/a", "1");
      await h.runCycles(1);
      await h.attachNonOriginRemote();
      await h.janitorTick();
      expect(h.execCalls().filter((c) => c[1] === "push")).toEqual([]);
      expect(h.broadcasts("home:push-failed")).toEqual([]);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("a watch cycle that commits nothing spawns no hand-attached-remote probes", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.attachRemote();
      await h.janitorTick(); // pushes the seed commit, clearing the unpushed state
      const before = h.execCalls().length;
      await h.runCycles(1); // nothing changed on disk
      const during = h.execCalls().slice(before);
      expect(during.filter((c) => c[1] === "remote" || c[1] === "symbolic-ref" || c[1] === "rev-list")).toEqual([]);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("a freshly attached remote arms a push with no new commit", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.writeFile("user/a", "1");
      await h.runCycles(1); // commits locally, no push
      await h.attachRemote(); // git remote add origin <bare>
      await h.janitorTick(); // no file change
      expect(h.execCalls().filter((c) => c[1] === "push").length).toBe(1);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("`rt home snapshot` (reason manual) notices a hand-attached remote too — the affordance a user reaches for right after attaching one", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.writeFile("user/a", "1");
      await h.runCycles(1); // commits locally, no remote yet
      await h.attachRemote();
      await h.manualTick(); // nothing new to commit
      expect(h.execCalls().filter((c) => c[1] === "push").length).toBe(1);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("second push only fires when there is something ahead of the ref", async () => {
    const h = await harnessWithLocalOnlyRepo();
    try {
      await h.attachRemote();
      await h.writeFile("user/a", "1");
      await h.runCycles(1); // first push
      await h.janitorTick(); // nothing new
      expect(h.execCalls().filter((c) => c[1] === "push").length).toBe(1);
    } finally {
      h.stop();
    }
  }, 15_000);

  test("remote attached, zero commits (unborn branch): no push armed, no push-failed", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-unborn-")));
    createdRoots.push(root);
    const repoDir = join(root, "user");
    const originDir = join(root, "origin.git");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    execFileSync("git", ["config", "user.email", "rt@example.test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "rt test"], { cwd: repoDir });
    execFileSync("git", ["init", "--bare", "-q", originDir]);
    execFileSync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });

    const db = openStateDb(join(root, "state.db"), "cli");
    const broadcastLog: { type: string; data: unknown }[] = [];
    const calls: string[][] = [];
    const exec: NonNullable<HomeSnapshotDeps["exec"]> = async (argv, opts) => {
      calls.push([...argv]);
      return runCapture(argv, opts);
    };
    const handle = startHomeSnapshot({
      log: fakeLog(),
      broadcast: (type, data) => broadcastLog.push({ type, data }),
      repoDir,
      db,
      exec,
      readSettings: () => LOCAL_ONLY_SETTINGS,
      readOwners: () => NO_OWNERS,
    });
    try {
      await handle.ready;
      await handle.runNow("janitor"); // no files, nothing to auto-commit — the branch this is actually testing
      await new Promise((resolve) => setTimeout(resolve, PUSH_SETTLE_MS));

      expect(calls.filter((c) => c[1] === "push")).toEqual([]);
      expect(broadcastLog.filter((b) => b.type === "home:push-failed")).toEqual([]);
    } finally {
      handle.stop();
    }
  }, 15_000);
});

describe("startSnapshot: spec", () => {
  test("homeSnapshotSpec is today's home values, and startSnapshot(homeSpec) equals startHomeSnapshot", async () => {
    const spec = homeSnapshotSpec(FAKE_REPO_DIR);
    expect(spec).toMatchObject({ id: "home", repoDir: FAKE_REPO_DIR, kvNamespace: "home-snapshot", eventPrefix: "home" });
    expect(spec.scope).toBeUndefined();
    expect(spec.pull).toBeUndefined();
    expect(spec.tokenFor).toBeUndefined();

    const { fn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot(spec, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.committed).toBe(true);
    expect(broadcasts[0]?.type).toBe("home:snapshot");
    expect(handle.status().id).toBe("home");
    handle.stop();
  });

  test("a spec's eventPrefix and kvNamespace name the broadcasts and the kv rows", async () => {
    const { fn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const spec = { ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team" as const };
    const handle = startSnapshot(spec, specDeps);
    await handle.ready;
    await handle.runNow("manual");
    expect(broadcasts[0]?.type).toBe("team:snapshot");
    expect(getKvValue("team-snapshot:acme", "state", null, deps.db!)).not.toBeNull();
    expect(getKvValue("home-snapshot", "state", null, deps.db!)).toBeNull();
    handle.stop();
  });

  test("a scoped spec stages and commits only scoped paths, and the pathspec is exactly those paths", async () => {
    const statusZ = " M mattstack/settings.team.jsonc\0 D .sops.yaml\0 M src/index.ts\0";
    const { fn, calls } = makeFakeExec(defaultResponders({ statusZ }));
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot({ ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", scope: teamScope }, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.paths).toEqual(["mattstack/settings.team.jsonc", ".sops.yaml"]);
    const add = calls.find((c) => gitVerb(c) === "add")!;
    expect(add).toEqual(["git", "add", "-A", "--", "mattstack/settings.team.jsonc", ".sops.yaml"]);
    const commit = calls.find((c) => gitVerb(c) === "commit")!;
    expect(commit.slice(-3)).toEqual(["--", "mattstack/settings.team.jsonc", ".sops.yaml"]);
    handle.stop();
  });

  test("a rename INTO the scope stages the new path only, never the out-of-scope source's deletion", async () => {
    // `git mv src/foo.ts mattstack/foo.ts`: one porcelain record, new path
    // first, origPath in the entry that follows it.
    const statusZ = "R  mattstack/foo.ts\0src/foo.ts\0";
    const { fn, calls } = makeFakeExec(defaultResponders({ statusZ }));
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot({ ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", scope: teamScope }, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.paths).toEqual(["mattstack/foo.ts"]);
    expect(calls.find((c) => gitVerb(c) === "add")).toEqual(["git", "add", "-A", "--", "mattstack/foo.ts"]);
    expect(calls.find((c) => gitVerb(c) === "commit")!.slice(-2)).toEqual(["--", "mattstack/foo.ts"]);
    handle.stop();
  });

  test("a rename OUT of the scope still stages the in-scope deletion, so the clone does not stay dirty forever", async () => {
    const statusZ = "R  src/foo.ts\0mattstack/foo.ts\0";
    const { fn, calls } = makeFakeExec(defaultResponders({ statusZ }));
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot({ ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", scope: teamScope }, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.committed).toBe(true);
    expect(result.paths).toEqual(["mattstack/foo.ts"]);
    expect(calls.find((c) => gitVerb(c) === "add")).toEqual(["git", "add", "-A", "--", "mattstack/foo.ts"]);
    handle.stop();
  });
});

describe("teamSnapshotSpec", () => {
  test("names the clone by slug, scopes to the team roots, pulls on the interval, and reads the stored forge token for origin", async () => {
    const p = { ...fakeProbes({ home: "/h" }) };
    const spec = teamSnapshotSpec("acme", "/h/.mattstack/teams/acme", { pullIntervalSec: 120, originUrl: "https://gitlab.com/acme/team.git", probes: p, readToken: async () => "glpat-x" });
    expect(spec).toMatchObject({ id: "team:acme", repoDir: "/h/.mattstack/teams/acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", pull: { intervalSec: 120 } });
    expect(spec.scope!("mattstack/x")).toBe(true);
    expect(spec.scope!("src/x")).toBe(false);
    expect(await spec.tokenFor!()).toBe("glpat-x");
    expect(spec.legacyStatePath).toBeUndefined();

    // The team spec carries no legacyStatePath, so a run against it must never
    // import or rename the home repo's legacy state file... proven against the
    // real one under the test's faked HOME, not just by asserting the field is undefined.
    const legacyPath = join(rtDir(), "home-snapshot-state.json");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "{}");
    const { fn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const runSpec = teamSnapshotSpec("acme", FAKE_REPO_DIR, { pullIntervalSec: 120, originUrl: "https://gitlab.com/acme/team.git", probes: p, readToken: async () => "glpat-x" });
    const handle = startSnapshot(runSpec, specDeps);
    await handle.ready;
    await handle.runNow("manual");
    expect(existsSync(legacyPath)).toBe(true);
    handle.stop();
  });
});

function teamSpecFor(tokenValue: string | null = "glpat-team") {
  return {
    ...homeSnapshotSpec(FAKE_REPO_DIR),
    id: "team:acme",
    kvNamespace: "team-snapshot:acme",
    eventPrefix: "team" as const,
    scope: teamScope,
    pull: { intervalSec: 300 },
    tokenFor: async () => tokenValue,
  };
}

/**
 * Responders for the pull stage. `gitVerb` (line ~29 of this file) skips the
 * `-c` pairs `gitWithToken` and the rebase prepend, so `argv[1]` is never the
 * verb here. `ahead`/`behind` are `git rev-list --left-right --count
 * origin/main...HEAD` as "<behind>\t<ahead>". `rebase: "conflict"` makes the
 * rebase exit 1 AND creates `<FAKE_REPO_DIR>/.git/rebase-merge` (the engine
 * classifies by that directory, not by the exit code); `rebase: "refused"`
 * exits 1 with "cannot rebase: You have unstaged changes" and no directory.
 */
function pullResponders(opts: { behind: number; ahead: number; rebase?: "ok" | "conflict" | "refused" }): Responder[] {
  const rebaseDir = join(FAKE_REPO_DIR, ".git", "rebase-merge");
  return [
    (argv) => gitVerb(argv) === "fetch" ? { stdout: "", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "symbolic-ref" ? { stdout: "main\n", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "rev-list" && argv.includes("--left-right") ? { stdout: `${opts.behind}\t${opts.ahead}\n`, stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "rev-parse" && argv.includes("--git-dir") ? { stdout: ".git\n", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "merge" && argv.includes("--ff-only") ? { stdout: "", stderr: "", exitCode: 0 } : undefined,
    (argv) => {
      if (gitVerb(argv) !== "rebase" || argv.includes("--abort")) return undefined;
      if (opts.rebase === "conflict") { mkdirSync(rebaseDir, { recursive: true }); return { stdout: "", stderr: "CONFLICT (content): mattstack/settings.team.jsonc", exitCode: 1 }; }
      if (opts.rebase === "refused") return { stdout: "", stderr: "error: cannot rebase: You have unstaged changes.", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    (argv) => gitVerb(argv) === "rebase" && argv.includes("--abort") ? (rmSync(rebaseDir, { recursive: true, force: true }), { stdout: "", stderr: "", exitCode: 0 }) : undefined,
  ];
}

describe("startSnapshot: pull", () => {
  // The conflict responder creates a real `.git/rebase-merge` under the shared
  // fixture dir; a test that ends mid-conflict would otherwise leave the next
  // one's preflight reading "a rebase is in progress".
  beforeEach(() => {
    rmSync(join(FAKE_REPO_DIR, ".git", "rebase-merge"), { recursive: true, force: true });
  });

  test("fetch and push carry the token through the env, never argv", async () => {
    const { fn, calls, optsLog } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor("glpat-team"), specDeps);
    await handle.ready;
    await handle.pullNow();
    const i = calls.findIndex((c) => gitVerb(c) === "fetch");
    expect(calls[i]).toContain("credential.helper=");
    expect(calls[i]!.join(" ")).not.toContain("glpat-team");
    expect((optsLog[i] as { env?: Record<string, string> }).env?.RT_GIT_TOKEN).toBe("glpat-team");
    handle.stop();
  });

  test("behind only: fast-forward; ahead only: nothing to pull; both: rebase", async () => {
    for (const [behind, ahead, expected] of [[1, 0, "fast-forwarded"], [0, 1, "up-to-date"], [1, 1, "rebased"], [0, 0, "up-to-date"]] as const) {
      const { fn, calls } = makeFakeExec([...pullResponders({ behind, ahead }), ...defaultResponders()]);
      const { deps } = baseDeps({ exec: fn });
      const { repoDir: _r, ...specDeps } = deps;
      const handle = startSnapshot(teamSpecFor(), specDeps);
      await handle.ready;
      expect((await handle.pullNow()).outcome).toBe(expected);
      expect(calls.some((c) => gitVerb(c) === "merge")).toBe(expected === "fast-forwarded");
      expect(calls.some((c) => gitVerb(c) === "rebase")).toBe(expected === "rebased");
      handle.stop();
    }
  });

  test("a rebase refused for unstaged out-of-scope changes is skipped with the reason, never a conflict", async () => {
    const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 1, rebase: "refused" }), ...defaultResponders()]);
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    const result = await handle.pullNow();
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("unstaged");
    expect(handle.status().lastPullSkipped).toContain("unstaged");
    expect(handle.status().conflicted).toBeNull();
    expect(broadcasts.some((b) => b.type === "team:conflict")).toBe(false);
    handle.stop();
  });

  test("a rebase conflict aborts, persists the marker, broadcasts once, suspends push and pull until it clears", async () => {
    const dirty = " M mattstack/settings.team.jsonc\0";
    const exec = makeSwitchableExec([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders({ statusZ: dirty })]);
    const { deps, broadcasts } = baseDeps({ exec: exec.fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;

    const first = await handle.pullNow();
    expect(first.outcome).toBe("conflict");
    expect(exec.calls.some((c) => gitVerb(c) === "rebase" && c.includes("--abort"))).toBe(true);
    expect(handle.status().conflicted?.detail).toContain("settings.team.jsonc");
    expect(getKvValue("team-snapshot:acme", "conflict", null, deps.db!)).not.toBeNull();
    expect(broadcasts.filter((b) => b.type === "team:conflict")).toHaveLength(1);

    // The status snapshot is dirty inside the scope, so a run that reached the
    // commit sites at all would leave `add` and `commit` in the argv log.
    const before = exec.calls.length;
    const suspended = await handle.runNow("manual");
    expect(suspended.skipped).toBe("conflict");
    const duringRun = exec.calls.slice(before).map((c) => gitVerb(c));
    expect(duringRun).not.toContain("add");
    expect(duringRun).not.toContain("commit");
    expect(duringRun).not.toContain("push");
    expect((await handle.pullNow()).outcome).toBe("skipped");
    expect(broadcasts.filter((b) => b.type === "team:conflict")).toHaveLength(1);

    exec.setResponders([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: dirty })]);
    expect((await handle.pullNow()).outcome).toBe("up-to-date");
    expect(handle.status().conflicted).toBeNull();
    expect(getKvValue("team-snapshot:acme", "conflict", null, deps.db!)).toBeNull();
    handle.stop();
  });

  test("a rebase conflict cancels the armed push timer, so a due push never fires while suspended", async () => {
    const dirty = " M mattstack/settings.team.jsonc\0";
    const exec = makeSwitchableExec([...pullResponders({ behind: 0, ahead: 1 }), ...defaultResponders({ statusZ: dirty })]);
    const { deps, timers } = baseDeps({ exec: exec.fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();

    await handle.runNow("manual");
    const pushDelayMs = DEFAULT_SETTINGS.pushDelaySec * 1000;
    expect([...timers.pending.values()].some((t) => t.ms === pushDelayMs)).toBe(true);

    exec.setResponders([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders({ statusZ: dirty })]);
    expect((await handle.pullNow()).outcome).toBe("conflict");

    expect([...timers.pending.values()].some((t) => t.ms === pushDelayMs)).toBe(false);
    timers.fire(() => true);
    await flushAsync();
    expect(exec.calls.filter((c) => gitVerb(c) === "push")).toHaveLength(0);
    handle.stop();
  });

  test("a rebase conflict cancels a standing push-retry timer too, so the ladder stops while suspended", async () => {
    const dirty = " M mattstack/settings.team.jsonc\0";
    // `gitWithToken` prepends `-c` pairs, so defaultResponders' argv[1]-keyed
    // push answer never matches a token-carrying push; this one has to.
    const failingPush: Responder = (argv) => gitVerb(argv) === "push" ? { stdout: "", stderr: "fatal: unable to access origin", exitCode: 1 } : undefined;
    const exec = makeSwitchableExec([failingPush, ...pullResponders({ behind: 0, ahead: 1 }), ...defaultResponders({ statusZ: dirty })]);
    const { deps, timers } = baseDeps({ exec: exec.fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    const retryMs = DEFAULT_SETTINGS.pushDelaySec * 5 * 1000;
    expect([...timers.pending.values()].some((t) => t.ms === retryMs)).toBe(true);
    const pushesBefore = exec.calls.filter((c) => gitVerb(c) === "push").length;

    exec.setResponders([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders({ statusZ: dirty })]);
    expect((await handle.pullNow()).outcome).toBe("conflict");

    expect([...timers.pending.values()].some((t) => t.ms === retryMs)).toBe(false);
    timers.fire(() => true);
    await flushAsync();
    expect(exec.calls.filter((c) => gitVerb(c) === "push")).toHaveLength(pushesBefore);
    handle.stop();
  });

  test("a due push fetches BETWEEN the commit and the push, and a non-fast-forward rejection pulls and retries once", async () => {
    let pushes = 0;
    const responders: Responder[] = [
      ...pullResponders({ behind: 0, ahead: 1 }),
      (argv) => gitVerb(argv) === "push" ? (++pushes === 1
        ? { stdout: "", stderr: "! [rejected] main -> main (fetch first)", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 }) : undefined,
      ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" }),
    ];
    const { fn, calls } = makeFakeExec(responders);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync(); // let the boot pull's own fetch land before the commit
    const fetchesBeforeCommit = calls.filter((c) => gitVerb(c) === "fetch").length;
    expect(fetchesBeforeCommit).toBe(1);

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    // Ordering, not a bare count: the boot pull already fetched once, so only a
    // fetch sitting between the commit and the first push proves the pre-push pull.
    const verbs = calls.map((c) => gitVerb(c));
    const commitIdx = verbs.lastIndexOf("commit");
    const pushIdx = verbs.indexOf("push");
    expect(commitIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(verbs.findIndex((v, i) => v === "fetch" && i > commitIdx && i < pushIdx)).toBeGreaterThan(-1);

    expect(pushes).toBe(2);
    expect(handle.status().pushPending).toBe(false);
    handle.stop();
  });

  test("withGitLock: a commit cycle started while a pull is in flight touches no git until the fetch returns", async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const responders = [...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" })];
    const calls: string[][] = [];
    const exec = async (argv: [string, ...string[]]): Promise<RunResult> => {
      calls.push([...argv]);
      if (gitVerb(argv) === "fetch") {
        await fetchGate;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      for (const r of responders) {
        const res = r(argv);
        if (res) return res;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { deps } = baseDeps({ exec });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();
    expect(calls.some((c) => gitVerb(c) === "fetch")).toBe(true);

    const run = handle.runNow("manual");
    await flushAsync();
    expect(calls.some((c) => gitVerb(c) === "status")).toBe(false);
    expect(calls.some((c) => gitVerb(c) === "add")).toBe(false);

    releaseFetch();
    expect((await run).committed).toBe(true);
    expect(calls.some((c) => gitVerb(c) === "add")).toBe(true);
    handle.stop();
  });

  test("a failed fetch leaves lastPullAt untouched and records the error, so the row can call the clone stale", async () => {
    const responders: Responder[] = [
      // First responder wins: this must precede pullResponders' own fetch answer.
      (argv) => gitVerb(argv) === "fetch" ? { stdout: "", stderr: "remote: HTTP Basic: Access denied", exitCode: 128 } : undefined,
      ...pullResponders({ behind: 0, ahead: 0 }),
      ...defaultResponders(),
    ];
    const { fn } = makeFakeExec(responders);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    const result = await handle.pullNow();
    expect(result.outcome).toBe("skipped");
    expect(handle.status().lastPullAt).toBe(0);
    expect(handle.status().lastPullError).toContain("Access denied");
    handle.stop();
  });

  test("the pull timer fires every pullIntervalSec and at boot, and re-arms after each tick", async () => {
    const { fn, calls } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();
    expect(calls.filter((c) => gitVerb(c) === "fetch")).toHaveLength(1);
    expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(true);

    timers.fire((t) => t.ms === 300_000);
    await flushAsync();
    expect(calls.filter((c) => gitVerb(c) === "fetch")).toHaveLength(2);
    expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(true);
    handle.stop();
  });

  test("a spec that started disabled arms the pull timer, not just the watcher and janitor, on its first run after a live re-enable", async () => {
    let enabled = false;
    const { fn } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" })]);
    const { deps, timers } = baseDeps({ exec: fn, readSettings: () => ({ ...DEFAULT_SETTINGS, enabled }) });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(false);

    enabled = true;
    await handle.runNow("manual");

    expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(true);
    handle.stop();
  });

  test("a token read that throws is a skipped pull carrying the reason, never an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const { fn } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
      const { deps, timers } = baseDeps({ exec: fn });
      const { repoDir: _r, ...specDeps } = deps;
      const spec = { ...teamSpecFor(), tokenFor: async () => { throw new Error("keychain locked"); } };
      const handle = startSnapshot(spec, specDeps);
      await handle.ready;

      const result = await handle.pullNow();
      expect(result.outcome).toBe("skipped");
      expect(result.detail).toContain("keychain locked");
      expect(handle.status().lastPullError).toContain("keychain locked");
      expect(handle.status().lastPullAt).toBe(0);

      // The pull timer's own `void pullNow()` is the un-awaited call site a
      // throw would escape from.
      timers.fire((t) => t.ms === 300_000);
      await flushAsync();
      expect(rejections).toEqual([]);
      handle.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a token read that throws during a push records it as the push error and arms the retry ladder", async () => {
    const { fn } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" })]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const spec = { ...teamSpecFor(), tokenFor: async () => { throw new Error("keychain locked"); } };
    const handle = startSnapshot(spec, specDeps);
    await handle.ready;
    await handle.runNow("manual");

    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    expect(handle.status().lastPushError).toContain("keychain locked");
    expect(handle.status().pushPending).toBe(true);
    expect([...timers.pending.values()].some((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000)).toBe(true);
    handle.stop();
  });

  test("a `git var` that could not run is transient: the next cycle probes again, and the clone keeps pulling", async () => {
    // runCapture's spawn-failure / timeout-kill code, not a verdict from git.
    const identUnavailable: Responder = (argv) => argv[1] === "var" ? { stdout: "", stderr: "", exitCode: -1 } : undefined;
    const { fn, calls } = makeFakeExec([identUnavailable, ...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" })]);
    const { deps, log } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();

    expect((await handle.runNow("manual")).skipped).toBe("git-unavailable");
    expect((await handle.runNow("manual")).skipped).toBe("git-unavailable");
    expect(calls.filter((c) => c[1] === "var")).toHaveLength(2);
    expect(log.calls.filter((c) => c.level === "warn" && String(c.args[c.args.length - 1]).includes("could not run git")).length).toBe(1);
    expect((await handle.pullNow()).outcome).toBe("up-to-date");
    handle.stop();
  });

  test("a genuine identity failure latches the commit, but the clone still pulls and reports the outcome", async () => {
    const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0", hasIdentity: false })]);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();

    expect((await handle.runNow("manual")).skipped).toBe("no-git-identity");
    expect((await handle.runNow("manual")).skipped).toBe("no-git-identity");
    expect((await handle.pullNow()).outcome).toBe("fast-forwarded");
    handle.stop();
  });

  test("a boot pull that rejects outright is logged and swallowed, never an unhandled rejection in the daemon's boot window", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders()]);
      // The conflict broadcast is a real throw source inside doPull.
      const { deps, log } = baseDeps({ exec: fn, broadcast: () => { throw new Error("broadcast seam blew up"); } });
      const { repoDir: _r, ...specDeps } = deps;
      const handle = startSnapshot(teamSpecFor(), specDeps);
      await handle.ready;
      await flushAsync();

      expect(rejections).toEqual([]);
      expect(log.calls.some((c) => c.level === "warn" && String(c.args[c.args.length - 1]).includes("pull failed"))).toBe(true);
      handle.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a timer-driven pull that rejects outright is logged, swallowed, and the interval still re-arms", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const exec = makeSwitchableExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
      const { deps, log, timers } = baseDeps({ exec: exec.fn, broadcast: () => { throw new Error("broadcast seam blew up"); } });
      const { repoDir: _r, ...specDeps } = deps;
      const handle = startSnapshot(teamSpecFor(), specDeps);
      await handle.ready;
      await flushAsync();

      exec.setResponders([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders()]);
      timers.fire((t) => t.ms === 300_000);
      await flushAsync();

      expect(rejections).toEqual([]);
      expect(log.calls.some((c) => c.level === "warn" && String(c.args[c.args.length - 1]).includes("pull failed"))).toBe(true);
      expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(true);
      handle.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("a team instance's disabled lines name rt.teamSnapshot, never rt.homeSnapshot", async () => {
    const { deps, log } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, enabled: false }) });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await handle.runNow("manual");

    const lines = log.calls.map((c) => String(c.args[c.args.length - 1]));
    expect(lines.some((l) => l.startsWith("team-snapshot: disabled (rt.teamSnapshot.enabled=false) at startup"))).toBe(true);
    expect(lines).toContain("team-snapshot: disabled via rt.teamSnapshot.enabled=false; skipping cycle");
    expect(lines.some((l) => l.includes("rt.homeSnapshot"))).toBe(false);
    expect(lines.some((l) => l.startsWith("home-snapshot:"))).toBe(false);
    handle.stop();
  });

  test("a team instance's inert lines describe a team clone, and never prescribe `rt home init`", async () => {
    const missingDir = "/does/not/exist/rt-team-snapshot-vocab";
    const { deps: missingDeps, log: missingLog } = baseDeps();
    const { repoDir: _m, ...missingSpecDeps } = missingDeps;
    const missing = startSnapshot({ ...teamSpecFor(), repoDir: missingDir }, missingSpecDeps);
    await missing.ready;
    expect((await missing.runNow("manual")).skipped).toBe("not-provisioned");
    const missingWarn = missingLog.calls.find((c) => c.level === "warn");
    expect(String(missingWarn?.args[1])).toBe("team-snapshot: team clone directory is missing; the supervisor drops it on the next rescan; inert");
    missing.stop();

    const { fn: notRepoExec } = makeFakeExec(defaultResponders({ isRepo: false }));
    const { deps: notRepoDeps, log: notRepoLog } = baseDeps({ exec: notRepoExec });
    const { repoDir: _n, ...notRepoSpecDeps } = notRepoDeps;
    const notRepo = startSnapshot(teamSpecFor(), notRepoSpecDeps);
    await notRepo.ready;
    expect(String(notRepoLog.calls.find((c) => c.level === "warn")?.args[1])).toBe("team-snapshot: repoDir is not a git repository; inert");
    notRepo.stop();

    const { fn: noIdentExec } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0", hasIdentity: false })]);
    const { deps: noIdentDeps, log: noIdentLog } = baseDeps({ exec: noIdentExec });
    const { repoDir: _i, ...noIdentSpecDeps } = noIdentDeps;
    const noIdent = startSnapshot(teamSpecFor(), noIdentSpecDeps);
    await noIdent.ready;
    await noIdent.runNow("manual");
    expect(noIdentLog.calls.some((c) => c.level === "warn" && String(c.args[c.args.length - 1]).startsWith("team-snapshot: git cannot resolve a committer identity"))).toBe(true);
    noIdent.stop();
  });

  test("the home spec never pulls", async () => {
    const { deps, execCalls } = baseDeps();
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(homeSnapshotSpec(FAKE_REPO_DIR), specDeps);
    await handle.ready;
    expect((await handle.pullNow()).outcome).toBe("skipped");
    expect(execCalls.some((c) => gitVerb(c) === "fetch")).toBe(false);
    handle.stop();
  });

  /** Mirrors the idiom in this describe block. Returns `seen` so each test can reset it past the boot pull. */
  function pullHarness(opts: { behind: number; ahead: number }) {
    const seen: ("fast-forwarded" | "rebased")[] = [];
    let throwNext = false;
    const { fn } = makeFakeExec([...pullResponders({ behind: opts.behind, ahead: opts.ahead }), ...defaultResponders()]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const spec = {
      ...teamSpecFor(),
      pull: {
        intervalSec: 300,
        onPulled: async (outcome: "fast-forwarded" | "rebased") => {
          if (throwNext) throw new Error("converge blew up");
          seen.push(outcome);
        },
      },
    };
    const handle = startSnapshot(spec, specDeps);
    return { handle, seen, timers, throwOnNext: () => { throwNext = true; } };
  }

  /** The boot pull at init() fires the hook before any test-driven pull; settle it, then start from a clean slate. */
  async function pastBootPull(h: { handle: { ready: Promise<void> }; seen: unknown[] }): Promise<void> {
    await h.handle.ready;
    await flushAsync();
    h.seen.length = 0;
  }

  test("onPulled fires for a fast-forward, with the outcome", async () => {
    const h = pullHarness({ behind: 1, ahead: 0 });
    await pastBootPull(h);
    await h.handle.pullNow();
    h.handle.stop();
    expect(h.seen).toEqual(["fast-forwarded"]);
  });

  test("onPulled does not fire when HEAD did not move", async () => {
    const h = pullHarness({ behind: 0, ahead: 0 });
    await pastBootPull(h);
    await h.handle.pullNow();
    h.handle.stop();
    expect(h.seen).toEqual([]);
  });

  test("a throwing onPulled leaves the pull's own outcome intact", async () => {
    const h = pullHarness({ behind: 1, ahead: 0 });
    await pastBootPull(h);
    h.throwOnNext();
    const result = await h.handle.pullNow();
    h.handle.stop();
    expect(result.outcome).toBe("fast-forwarded");
  });

  test("pullNow({ converge: false }) skips the hook, which is how the push path opts out", async () => {
    const h = pullHarness({ behind: 1, ahead: 0 });
    await pastBootPull(h);
    await h.handle.pullNow({ converge: false });
    h.handle.stop();
    expect(h.seen).toEqual([]);
  });

  test("a push fires no converge, even though its pull moves HEAD", async () => {
    const seen: string[] = [];
    const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 0 }), ...defaultResponders({ statusZ: "?? mattstack/new.jsonc\0" })]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot(
      { ...teamSpecFor(), pull: { intervalSec: 300, onPulled: async (o: string) => { seen.push(o); } } },
      specDeps,
    );
    await handle.ready;
    await flushAsync();
    seen.length = 0;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    handle.stop();

    expect(seen).toEqual([]);
  });

  test("the timer-driven pull re-arms after its hook returns", async () => {
    const h = pullHarness({ behind: 1, ahead: 0 });
    await pastBootPull(h);

    // fire() deletes what it fires, so the boot-armed timer is consumed here and
    // any surviving 300s timer can only be schedulePull's .finally re-arm.
    h.timers.fire((t) => t.ms === 300 * 1000);
    await flushAsync();

    expect([...h.timers.pending.values()].some((t) => t.ms === 300 * 1000)).toBe(true);
    h.handle.stop();
  });

  test("two overlapping pulls converge once, never twice on the same clone", async () => {
    let hookCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 0 }), ...defaultResponders()]);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot(
      { ...teamSpecFor(), pull: { intervalSec: 300, onPulled: async () => { hookCalls += 1; await gate; } } },
      specDeps,
    );
    await handle.ready;
    await flushAsync();
    // The boot pull's hook is now open on the gate, and pullInFlight is already
    // null, so this second pull does its own git work while that hook runs.
    expect(hookCalls).toBe(1);

    const second = handle.pullNow();
    await flushAsync();
    release();
    expect((await second).outcome).toBe("fast-forwarded");
    handle.stop();

    expect(hookCalls).toBe(1);
  });

  test("the inline replay after a rejected push fires no converge either", async () => {
    const seen: string[] = [];
    const rejectPush: Responder = (argv) => gitVerb(argv) === "push"
      ? { stdout: "", stderr: "! [rejected] main -> main (fetch first)", exitCode: 1 }
      : undefined;
    const { fn, calls } = makeFakeExec([rejectPush, ...pullResponders({ behind: 1, ahead: 0 }), ...defaultResponders({ statusZ: "?? mattstack/new.jsonc\0" })]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot(
      { ...teamSpecFor(), pull: { intervalSec: 300, onPulled: async (o: string) => { seen.push(o); } } },
      specDeps,
    );
    await handle.ready;
    await flushAsync();
    seen.length = 0;

    await handle.runNow("manual");
    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();
    handle.stop();

    // Two pushes means the rejected one AND the inline replay's retry ran, which
    // is the only way through the pullNow call this test guards.
    expect(calls.filter((c) => gitVerb(c) === "push")).toHaveLength(2);
    expect(seen).toEqual([]);
  });
});
