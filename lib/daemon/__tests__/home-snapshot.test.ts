import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import type { Logger } from "pino";
import type { RunResult } from "../../subprocess.ts";
import type { Owners } from "../../home/snapshot-owners.ts";
import { startHomeSnapshot, type HomeSnapshotDeps, type HomeSnapshotSettings } from "../home-snapshot.ts";

// ─── test doubles ────────────────────────────────────────────────────────────

function fakeLog(): Logger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  const rec = (level: string) => (...args: unknown[]) => calls.push({ level, args });
  return { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug"), calls } as unknown as Logger & {
    calls: { level: string; args: unknown[] }[];
  };
}

type Responder = (argv: string[]) => RunResult | undefined;

function defaultResponders(opts: {
  isRepo?: boolean;
  branch?: string;
  statusZ?: string;
  commitExit?: number;
  addExit?: number;
  pushExit?: number;
  pushStderr?: string;
  sha?: string;
} = {}): Responder[] {
  const {
    isRepo = true, branch = "main", statusZ = "", commitExit = 0, addExit = 0, pushExit = 0, pushStderr = "", sha = "abc123",
  } = opts;
  return [
    (argv) => (argv[1] === "rev-parse" && argv[2] === "--is-inside-work-tree")
      ? { stdout: isRepo ? "true\n" : "", stderr: isRepo ? "" : "fatal: not a git repository", exitCode: isRepo ? 0 : 128 }
      : undefined,
    (argv) => (argv[1] === "rev-parse" && argv[2] === "--abbrev-ref" && argv[3] === "HEAD")
      ? { stdout: `${branch}\n`, stderr: "", exitCode: 0 }
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

function makeFakeExec(responders: Responder[]) {
  const calls: string[][] = [];
  const fn = async (argv: [string, ...string[]]): Promise<RunResult> => {
    calls.push([...argv]);
    for (const r of responders) {
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
  function fireAll(): void {
    const cbs = [...pending.values()];
    pending.clear();
    for (const t of cbs) t.cb();
  }
  return { setTimeoutFn, clearTimeoutFn, pending, fireAll };
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
    statePath: "/fake/state.json",
    ...overrides,
  };

  return { deps, log, broadcasts, execCalls, watch, timers };
}

// ─── disabled / not-a-repo inert paths ──────────────────────────────────────

describe("startHomeSnapshot — inert paths", () => {
  test("enabled:false — inert, logs once at info, never calls exec or watch", async () => {
    const { deps, log, watch, execCalls } = baseDeps({ readSettings: () => ({ ...DEFAULT_SETTINGS, enabled: false }) });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(handle.status().enabled).toBe(false);
    expect(watch.calls.length).toBe(0);
    expect(execCalls.length).toBe(0);
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
});

// ─── watcher arming + debounce ───────────────────────────────────────────────

describe("startHomeSnapshot — watcher", () => {
  test("arms fs.watch(repoDir, {recursive:true}) and the janitor interval once ready", async () => {
    const { deps, watch, timers } = baseDeps();
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    expect(watch.calls).toEqual([{ path: "/fake/repo", options: { recursive: true } }]);
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

  test("firing the debounce timer runs a snapshot with reason 'watch'", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, watch, timers, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    watch.emit("change", "a.txt");
    timers.fireAll();
    await flushAsync();

    expect(execCalls.some((c) => c[1] === "commit")).toBe(true);
    expect(broadcasts.some((b) => b.type === "home:snapshot")).toBe(true);
  });
});

// ─── preflight ────────────────────────────────────────────────────────────

describe("startHomeSnapshot — preflight", () => {
  test("detached HEAD skips the cycle with one warn, no add/commit", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ branch: "HEAD" }));
    const { deps, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.skipped).toBe("detached");
    expect(execCalls.some((c) => c[1] === "add" || c[1] === "commit")).toBe(false);
    expect(log.calls.some((c) => c.level === "warn")).toBe(true);
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
  test("git add pathspec excludes every claimed zone as separate argv elements", async () => {
    const owners: Owners = {
      zones: {
        "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
        "secrets/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? notes/a.md\0" }));
    const { deps } = baseDeps({ exec: execFn, readOwners: () => owners });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");

    const addCall = execCalls.find((c) => c[1] === "add" && c.includes("--"));
    expect(addCall).toEqual(["git", "add", "-A", "--", ".", ":(exclude)prefs/", ":(exclude)secrets/"]);
  });

  test("commit message and no-op when there is nothing to auto-commit", async () => {
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "" }));
    const { deps, broadcasts } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    const result = await handle.runNow("manual");

    expect(result.committed).toBe(false);
    expect(execCalls.some((c) => c[1] === "add" || c[1] === "commit")).toBe(false);
    expect(broadcasts.length).toBe(0);
  });

  test("janitor zone commits ONLY on reason janitor/manual, never on watch, and uses its own add+commit per zone", async () => {
    const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
    // Zone dirty since long before now, past the (small) threshold.
    const statePath = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-state-"))) + "/state.json";
    writeFileSync(statePath, JSON.stringify({ firstSeenDirty: { "prefs/": 0 } }));

    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0" }));
    const { deps, broadcasts } = baseDeps({
      exec: execFn,
      readOwners: () => owners,
      statePath,
      now: () => 10_000_000, // far past a 1-hour threshold from firstSeenDirty=0
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
    expect(execCalls.some((c) => c[1] === "commit" && c.includes("snapshot: janitor prefs/ (owner matt)"))).toBe(true);
    expect(broadcasts.some((b) => b.type === "home:snapshot" && (b.data as any).paths.includes("prefs/"))).toBe(true);

    rmSync(statePath, { force: true });
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
    const { fn: execFn, calls: execCalls } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 0 }));
    const { deps, timers } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();

    timers.fireAll();
    await flushAsync();

    expect(execCalls).toContainEqual(["git", "push", "-q", "origin", "HEAD"]);
    expect(handle.status().pushPending).toBe(false);
    expect(handle.status().lastPushAt).toBe(1_000_000);
  });

  test("push failure sets pushPending + lastPushError and schedules a retry at pushDelaySec*5", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1, pushStderr: "connection refused" }));
    const { deps, timers, log } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fireAll(); // fires the initial push attempt
    await flushAsync();

    expect(handle.status().pushPending).toBe(true);
    expect(handle.status().lastPushError).toContain("connection refused");
    expect(log.calls.some((c) => c.level === "warn")).toBe(true);

    const retryEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 5 * 1000);
    expect(retryEntry).toBeDefined();
  });

  test("a pending push is retried on the next run even with no new changes", async () => {
    const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0", pushExit: 1 }));
    const { deps, timers } = baseDeps({ exec: execFn });
    const handle = startHomeSnapshot(deps);
    await handle.ready;

    await handle.runNow("manual");
    timers.fireAll();
    await flushAsync();
    expect(handle.status().pushPending).toBe(true);

    timers.pending.clear(); // drop the standing retry timer to prove the NEXT RUN re-schedules one too
    const { fn: execFn2 } = makeFakeExec(defaultResponders({ statusZ: "" })); // nothing dirty this time
    (deps as any).exec = execFn2;
    await handle.runNow("manual");

    const pushEntry = [...timers.pending.values()].find((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
    expect(pushEntry).toBeDefined();
  });
});

// ─── state file round-trip ───────────────────────────────────────────────────

describe("startHomeSnapshot — state persistence", () => {
  test("nextFirstSeenDirty is persisted and reloaded by a fresh handle", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-state-")));
    const statePath = join(dir, "home-snapshot-state.json");
    try {
      const owners: Owners = { zones: { "prefs/": { owner: "matt", claimedAt: "2026-01-01T00:00:00.000Z" } } };
      const { fn: execFn } = makeFakeExec(defaultResponders({ statusZ: "?? prefs/x.md\0" }));
      const { deps } = baseDeps({ exec: execFn, readOwners: () => owners, statePath, now: () => 42 });

      const handle = startHomeSnapshot(deps);
      await handle.ready;
      await handle.runNow("manual");

      expect(existsSync(statePath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
      expect(onDisk.firstSeenDirty["prefs/"]).toBe(42);
      expect(handle.status().firstSeenDirty["prefs/"]).toBe(42);

      const { deps: deps2 } = baseDeps({ readOwners: () => owners, statePath });
      const handle2 = startHomeSnapshot(deps2);
      await handle2.ready;
      expect(handle2.status().firstSeenDirty["prefs/"]).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
  });
});

// ─── ONE real-git integration test (temp HOME, local bare origin, no network) ─

describe("startHomeSnapshot — real git integration", () => {
  test("commits auto paths, pushes to the local bare origin, leaves a claimed zone uncommitted", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rt-home-snapshot-integration-")));
    const originDir = join(root, "origin.git");
    const repoDir = join(root, "user");
    const statePath = join(root, "state.json");

    try {
      execFileSync("git", ["init", "--bare", "-q", originDir]);
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
      execFileSync("git", ["config", "user.email", "rt@example.test"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "rt test"], { cwd: repoDir });
      execFileSync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });

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
      // Real setTimeout, but 0ms — no real waiting, this only speeds up the trailing push.
      const handle = startHomeSnapshot({
        log,
        broadcast: () => {},
        repoDir,
        statePath,
        readSettings: () => ({ ...DEFAULT_SETTINGS, pushDelaySec: 0 }),
        readOwners: () => owners,
      });
      await handle.ready;

      const result = await handle.runNow("manual");
      expect(result.committed).toBe(true);
      expect(result.sha).not.toBeNull();

      // Let the real (0ms) trailing push timer fire.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const log_ = execFileSync("git", ["log", "--oneline", "-1"], { cwd: repoDir }).toString();
      expect(log_).toContain("snapshot:");

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
});
