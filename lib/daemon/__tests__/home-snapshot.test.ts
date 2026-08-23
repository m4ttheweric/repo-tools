import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { RunResult } from "../../subprocess.ts";
import type { Owners } from "../../home/snapshot-owners.ts";
import { openStateDb } from "../../state/db.ts";
import { closeStateDb, getKvValue } from "../../state/index.ts";
import { startHomeSnapshot, type HomeSnapshotDeps, type HomeSnapshotSettings } from "../home-snapshot.ts";

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
} = {}): Responder[] {
  const {
    isRepo = true, branch = "main", branchExit = 0, statusZ = "", commitExit = 0, addExit = 0, pushExit = 0, pushStderr = "", sha = "abc123",
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
    (argv) => (argv[1] === "commit") ? { stdout: "", stderr: "", exitCode: commitExit } : undefined,
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
    repoDir: "/fake/repo",
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
    expect(execCalls.some((c) => c[1] === "add" || c[1] === "commit")).toBe(false);
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
    expect(watch.calls).toEqual([{ path: "/fake/repo", options: { recursive: true } }]);
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

    expect(watch.calls).toEqual([{ path: "/fake/repo", options: { recursive: true } }]);
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

    const commitCall = execCalls.find((c) => c[1] === "commit");
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
    expect(execCalls.some((c) => c[1] === "add" || c[1] === "commit")).toBe(false);
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
    expect(execCalls.some((c) => c[1] === "commit")).toBe(true);
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
    const { deps } = baseDeps({ exec: execFn, readOwners: () => owners, repoDir: "/fake/repo" });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");

    const addIdx = execCalls.findIndex((c) => c[1] === "add");
    const commitIdx = execCalls.findIndex((c) => c[1] === "commit");
    expect(execCalls[addIdx]).toEqual(["git", "add", "-A", "--", ".", ":(exclude)prefs/", ":(exclude)secrets/"]);
    // The commit is pathspec-restricted too, not just the add — a plain
    // `git commit` would otherwise sweep in anything staged outside this
    // add (e.g. by the user, or inside a claimed zone), regardless of what
    // THIS add excluded.
    expect(execCalls[commitIdx]).toEqual([
      "git", "commit", "-q", "-m", "snapshot (manual): notes",
      "--", ".", ":(exclude)prefs/", ":(exclude)secrets/",
    ]);
    expect(optsLog[addIdx]?.cwd).toBe("/fake/repo");
    expect(optsLog[addIdx]?.timeoutMs).toBeGreaterThan(0);
    expect(optsLog[commitIdx]?.cwd).toBe("/fake/repo");
    expect(optsLog[commitIdx]?.timeoutMs).toBeGreaterThan(0);
  });

  test("reason 'manual' prefixes the commit message; reason 'watch' leaves it bare", async () => {
    const { fn: manualExec, calls: manualCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps: manualDeps } = baseDeps({ exec: manualExec });
    const manualHandle = startHomeSnapshot(manualDeps);
    await manualHandle.ready;
    await manualHandle.runNow("manual");
    expect(manualCalls.find((c) => c[1] === "commit")).toContain("snapshot (manual): a.txt");

    const { fn: watchExec, calls: watchCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps: watchDeps } = baseDeps({ exec: watchExec });
    const watchHandle = startHomeSnapshot(watchDeps);
    await watchHandle.ready;
    await watchHandle.runNow("watch");
    expect(watchCalls.find((c) => c[1] === "commit")).toContain("snapshot: a.txt");
  });

  test("nothing to auto-commit — no-op, no add/commit, skipped:'no-changes'", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "" }));
    const { deps, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.committed).toBe(false);
    expect(result.skipped).toBe("no-changes");
    expect(execCalls.some((c) => c[1] === "add" || c[1] === "commit")).toBe(false);
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
      "git", "commit", "-q", "-m", "snapshot (janitor): prefs/ dirty >2h, owner matt", "--", "prefs/",
    ]);
    expect(broadcasts.some((b) => b.type === "home:snapshot" && (b.data as any).paths.includes("prefs/"))).toBe(true);
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
    const { deps, timers } = baseDeps({ exec: execFn, repoDir: "/fake/repo" });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();

    timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    await flushAsync();

    const pushIdx = execCalls.findIndex((c) => c[0] === "git" && c[1] === "push");
    expect(execCalls[pushIdx]).toEqual(["git", "push", "-q", "origin", "HEAD"]);
    expect(optsLog[pushIdx]?.cwd).toBe("/fake/repo");
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
      if (argv[1] === "commit") { await gate; return { stdout: "", stderr: "", exitCode: 0 }; }
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

  test("a malformed stored row starts from empty state instead of crashing", async () => {
    const db = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('home-snapshot', 'state', '{not json', 0);").run();
    const { deps } = baseDeps({ db });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().firstSeenDirty).toEqual({});
  });

  test("no prior write (first run) does NOT warn", async () => {
    const { deps, log } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(log.calls.filter((c) => c.level === "warn").length).toBe(0);
    expect(handle.status().firstSeenDirty).toEqual({});
  });

  test("a stale on-disk home-snapshot-state.json is ignored once the store owns the value, and gets unlinked on write", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-snapshot-legacy-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    closeStateDb();
    try {
      const legacyPath = join(home, ".mattstack", "rt", "home-snapshot-state.json");
      mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ firstSeenDirty: { "stale/": 1 } }));
      expect(existsSync(legacyPath)).toBe(true);

      const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? notes.md\0" }));
      // No `db` override: this run goes through the real getStateDb() singleton,
      // matching the real daemon wiring, so the legacy-unlink path (which
      // targets rtDir()) actually lands under the HOME faked above.
      const { deps } = baseDeps({ exec: execFn, db: undefined, now: () => 99 });

      const handle = startHomeSnapshot(deps);
      await handle.ready;
      await handle.runNow("manual");

      // The store, not the stale file, is authoritative.
      expect(handle.status().firstSeenDirty["stale/"]).toBeUndefined();
      expect(existsSync(legacyPath)).toBe(false);
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
      if (argv[1] === "commit") return { stdout: "", stderr, exitCode: 1 };
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
    expect(execCalls.some((c) => c[1] === "commit")).toBe(false);
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
    expect(execCalls.some((c) => c[1] === "commit")).toBe(false);
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
});
