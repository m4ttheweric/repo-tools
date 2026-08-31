import { test, expect } from "bun:test";
import { Runner, type RunnerDeps, __test__ } from "../runner.ts";
import type { Engine, ProcessInfo } from "../engine.ts";
import type { SessionEnd, SessionHandle } from "../../ui/spawn.ts";
import type { SessionIntent } from "../../ui/protocol.ts";
import type { RunResolution } from "../../../commands/run.ts";

class FakeEngine implements Engine {
  calls: string[] = [];
  running = new Set<string>();
  text = new Map<string, string>();
  fail: string | null = null;
  async createWorkspace(label: string) { this.calls.push(`ws:${label}`); return { workspaceId: "wX", tabId: "wX:t1", paneId: "wX:p1" }; }
  async createTab(_ws: string, label: string) { this.calls.push(`tab:${label}`); const n = this.calls.filter((c) => c.startsWith("tab:")).length + 1; return { tabId: `wX:t${n}`, paneId: `wX:p${n}` }; }
  async renameTab(tabId: string, label: string) { this.calls.push(`rename:${tabId}:${label}`); }
  async focusTab(tabId: string) { if (this.fail === "focus") throw new Error("boom"); this.calls.push(`focus:${tabId}`); }
  async run(paneId: string, cwd: string, command: string) { this.calls.push(`run:${paneId}:${cwd}:${command}`); this.running.add(paneId); }
  async interrupt(paneId: string) { this.calls.push(`int:${paneId}`); this.running.delete(paneId); this.text.set(paneId, "__rt_exit 130\n"); }
  async processInfo(paneId: string): Promise<ProcessInfo> { return { foregroundPgid: this.running.has(paneId) ? 9 : 1, shellPid: 1, foreground: [] }; }
  async read(paneId: string) { return this.text.get(paneId) ?? "line a\nline b\n"; }
  async closeWorkspace(ws: string) { this.calls.push(`close:${ws}`); }
}

class FakeSession implements SessionHandle {
  pushed: unknown[] = [];
  closedCalls = 0;
  private queue: SessionIntent[];
  private resolveNext: ((v: IteratorResult<SessionIntent>) => void) | null = null;
  exited: Promise<number>;
  private finish!: (code: number) => void;
  constructor(intents: SessionIntent[]) {
    this.queue = [...intents];
    this.exited = new Promise((r) => { this.finish = r; });
  }
  get intents(): AsyncIterable<SessionIntent> {
    const self = this;
    return { [Symbol.asyncIterator]() { return { next: () => self.next() }; } };
  }
  private next(): Promise<IteratorResult<SessionIntent>> {
    const it = this.queue.shift();
    if (it) return Promise.resolve({ value: it, done: false });
    return Promise.resolve({ value: undefined as never, done: true });
  }
  push(m: unknown) { this.pushed.push(m); }
  async close(): Promise<SessionEnd> { this.closedCalls++; this.finish(0); return { reason: "closed", code: 0 }; }
}

/**
 * A session whose intents arrive on demand instead of from a fixed array:
 * `next()` blocks (no polling, no timer) until `send` is called. Lets a test
 * pause the runner mid-session to drive a poll deterministically, then
 * resume it by sending the next intent.
 */
class QueueSession implements SessionHandle {
  pushed: unknown[] = [];
  closedCalls = 0;
  private queue: SessionIntent[] = [];
  private waiter: ((v: IteratorResult<SessionIntent>) => void) | null = null;
  exited: Promise<number>;
  private finish!: (code: number) => void;
  constructor() {
    this.exited = new Promise((r) => { this.finish = r; });
  }
  get intents(): AsyncIterable<SessionIntent> {
    const self = this;
    return { [Symbol.asyncIterator]() { return { next: () => self.next() }; } };
  }
  private next(): Promise<IteratorResult<SessionIntent>> {
    const it = this.queue.shift();
    if (it) return Promise.resolve({ value: it, done: false });
    return new Promise((resolve) => { this.waiter = resolve; });
  }
  send(i: SessionIntent): void {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w({ value: i, done: false });
    } else {
      this.queue.push(i);
    }
  }
  push(m: unknown) { this.pushed.push(m); }
  async close(): Promise<SessionEnd> { this.closedCalls++; this.finish(0); return { reason: "closed", code: 0 }; }
}

/** Drains pending microtasks so an in-flight async chain with no real timers or I/O settles before the next assertion. Not a real-time wait. */
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function deps(over: Partial<RunnerDeps> & { sessions: SessionHandle[]; engine?: FakeEngine }): RunnerDeps & { engine: FakeEngine } {
  const engine = over.engine ?? new FakeEngine();
  let i = 0;
  return {
    engine,
    openSession: async () => over.sessions[i++] ?? new FakeSession([]),
    resolve: over.resolve ?? (async () => ({ kind: "cancelled", code: 1 }) as RunResolution),
    // A frozen clock keeps every launched entry inside LAUNCH_GRACE_MS, so
    // pollLiveness skips them; a test that asserts on a poll needs an
    // advancing `now` override.
    now: over.now ?? (() => new Date("2026-08-30T00:00:00Z")),
    sleep: over.sleep ?? (async () => {}),
    openUrl: over.openUrl ?? (async () => {}),
    workspaceLabel: "rt-runner-test",
    seed: over.seed,
  };
}

test("quit with nothing launched: opens the session, tears nothing down, closes cleanly", async () => {
  const s = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({ sessions: [s] });
  await new Runner(d).run();
  expect(d.engine.calls).toEqual([]);
});

test("a seeded runner launches its seed entries on open without the picker", async () => {
  const s = new FakeSession([{ t: "intent", name: "quit" }]);
  let resolveCalls = 0;
  const seed = [
    { name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" },
    { name: "api", command: "bun run api", cwd: "/repo/api", pkg: "backend", repo: "acme" },
  ];
  const d = deps({
    sessions: [s],
    resolve: async () => { resolveCalls++; return { kind: "cancelled", code: 1 } as RunResolution; },
    seed,
  });
  const r = new Runner(d);
  await r.run();
  expect(resolveCalls).toBe(0);
  expect(r.entries.map((e) => e.name)).toEqual(["dev", "api"]);
  expect(d.engine.calls.some((c) => c.startsWith("run:") && c.includes("/repo/web") && c.includes("bun run dev"))).toBe(true);
  expect(d.engine.calls.some((c) => c.startsWith("run:") && c.includes("/repo/api") && c.includes("bun run api"))).toBe(true);
  expect(r.entries.every((e) => e.state === "starting")).toBe(true);
});

test("add: closes the session, resolves in-process, reopens with an optimistic starting row, then launches", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [first, second],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  expect(first.closedCalls).toBe(1);
  expect(r.entries.map((e) => [e.name, e.pkg, e.repo])).toEqual([["dev", "web", "repo"]]);
  // The resolved cwd (targetDir) reaches engine.run, not the worktree root or the label.
  expect(d.engine.calls.slice(0, 3)).toEqual(["ws:rt-runner-test", "rename:wX:t1:dev", "run:wX:p1:/repo/web:bun run dev"]);
  expect(d.engine.calls.at(-1)).toBe("close:wX");
  // The reopened session gets the post-launch model: the new entry, started.
  expect(second.pushed).toHaveLength(1);
  const pushedModel = second.pushed[0] as { entries: { id: string; name: string; state: string; startedAt: string | null }[] };
  expect(pushedModel.entries).toHaveLength(1);
  expect(pushedModel.entries[0]).toMatchObject({ id: "e1", name: "dev", state: "starting" });
  expect(pushedModel.entries[0]!.startedAt).not.toBeNull();
});

test("a cancelled picker reopens the board unchanged", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({ sessions: [first, second] });
  const r = new Runner(d);
  await r.run();
  expect(r.entries).toEqual([]);
  expect(d.engine.calls).toEqual([]);
});

test("restart on a running entry interrupts, waits for the shell, and re-runs; stop then interrupts once more", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "restart", entryId: "e1" }, { t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  const e = r.entries[0]!;
  expect(d.engine.calls.filter((c) => c.startsWith("int:"))).toHaveLength(2);
  expect(d.engine.calls.filter((c) => c.startsWith("run:"))).toHaveLength(2);
  expect(e.state).toBe("stopping");
});

test("restart on a stopped entry skips the interrupt and just re-runs", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "restart", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  await r.run();
  expect(d.engine.calls.filter((c) => c.startsWith("int:"))).toHaveLength(1);
  expect(d.engine.calls.filter((c) => c.startsWith("run:"))).toHaveLength(2);
  expect(r.entries[0]!.state).toBe("starting");
});

test("restart re-asserts starting even when a poll lands mid-wait and marks the entry running", async () => {
  class RestartEngine extends FakeEngine {
    stillRunning = true;
    override async processInfo(_paneId: string): Promise<ProcessInfo> {
      return { foregroundPgid: this.stillRunning ? 9 : 1, shellPid: 1, foreground: [] };
    }
  }
  const engine = new RestartEngine();
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  let r: Runner | undefined;
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "restart", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    engine,
    now: () => new Date(time),
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
    // restart's wait loop calls sleep between processInfo polls; use that
    // seam to simulate pollLiveness landing mid-wait, while the engine still
    // (falsely, from restart's view) reports the old command running, then
    // let the wait loop see the shell reclaim the foreground next check.
    sleep: async () => {
      time += 1000; // clear LAUNCH_GRACE_MS so pollLiveness reads this entry
      if (r) await __test__.pollLiveness(r);
      engine.stillRunning = false;
    },
  });
  r = new Runner(d);
  await r.run();
  expect(r.entries[0]!.state).toBe("starting");
});

test("focus failure pins an error on the entry and the board stays up", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "focus", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const engine = new FakeEngine();
  engine.fail = "focus";
  const d = deps({ sessions: [s, s2], engine, resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  const r = new Runner(d);
  await r.run();
  expect(r.entries[0]!.error).toContain("boom");
});

test("tail intent reads immediately and pushes a model with tail for that entry only", async () => {
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "tail", entryId: "e1", open: true }, { t: "intent", name: "quit" }]);
  const d = deps({ sessions: [s, s2], resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  await new Runner(d).run();
  const withTail = s2.pushed.find((m) => (m as { entries: { tail: unknown }[] }).entries[0]?.tail);
  expect(withTail).toBeDefined();
  expect((withTail as { entries: { tail: { text: string }[] }[] }).entries[0]!.tail.map((l) => l.text)).toEqual(["line a", "line b"]);
});

test("a session that ends with reason error is treated as died", async () => {
  class Errored extends FakeSession {
    override async close(): Promise<SessionEnd> { this.closedCalls++; return { reason: "error", code: 70, message: "stdin closed" }; }
  }
  const s = new Errored([]);
  const d = deps({ sessions: [s] });
  await expect(new Runner(d).run()).rejects.toThrow(/rt-ui/);
});

test("a picker that throws reopens the board unchanged and warns", async () => {
  const first = new FakeSession([{ t: "intent", name: "add" }]);
  const second = new FakeSession([{ t: "intent", name: "quit" }]);
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const d = deps({ sessions: [first, second], resolve: async () => { throw new Error("picker exploded"); } });
    const r = new Runner(d);
    await r.run();
    expect(r.entries).toEqual([]);
  } finally {
    process.stderr.write = real;
  }
  expect(errs.join("")).toContain("picker exploded");
});

test("a session that dies tears the workspace down", async () => {
  class Dying extends FakeSession {
    override async close(): Promise<SessionEnd> { this.closedCalls++; return { reason: "died", code: 70 }; }
  }
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new Dying([]);
  const d = deps({ sessions: [s, s2], resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }) });
  const r = new Runner(d);
  await expect(r.run()).rejects.toThrow(/rt-ui/);
  expect(d.engine.calls.at(-1)).toBe("close:wX");
});

test("pollLiveness flips a running entry to stopped or crashed once the exit sentinel lands", async () => {
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  const now = () => new Date(time);
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const engine = new FakeEngine();
  const d = deps({
    sessions: [addSession, liveSession],
    engine,
    now,
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  const finished = r.run();
  // Nothing here is real time: everything queued on the microtask chain
  // above (close, resolve, openSession, createWorkspace, renameTab, run)
  // settles before liveSession blocks on its next intent.
  await flushMicrotasks();
  const e = r.entries[0]!;
  expect(e.paneId).toBe("wX:p1");

  // The shell has reclaimed the foreground and left a clean-exit sentinel.
  engine.running.delete(e.paneId!);
  engine.text.set(e.paneId!, "line a\n__rt_exit 0\n");
  time += 1000; // clears LAUNCH_GRACE_MS so pollLiveness reads the sentinel
  await __test__.pollLiveness(r);
  expect(e.state).toBe("stopped");
  expect(e.exitCode).toBe(0);

  // A later command in the same pane exits nonzero.
  engine.text.set(e.paneId!, "line b\n__rt_exit 1\n");
  time += 1000;
  await __test__.pollLiveness(r);
  expect(e.state).toBe("crashed");
  expect(e.exitCode).toBe(1);

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});

// Counts reads per pane so a test can assert the url-scan read fires once
// then stops once an entry latches; production code has no such counter.
class UrlFakeEngine extends FakeEngine {
  readCounts = new Map<string, number>();
  override async read(paneId: string): Promise<string> {
    this.readCounts.set(paneId, (this.readCounts.get(paneId) ?? 0) + 1);
    return this.text.get(paneId) ?? "starting dev server...\n  > Local: http://localhost:5173/\n";
  }
}

test("pollLiveness latches a url from pane output and does not rescan once found", async () => {
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  const engine = new UrlFakeEngine();
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const d = deps({
    sessions: [addSession, liveSession],
    engine,
    now: () => new Date(time),
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  const finished = r.run();
  await flushMicrotasks();
  const e = r.entries[0]!;
  time += 1000; // clears LAUNCH_GRACE_MS so pollLiveness reads this entry

  await __test__.pollLiveness(r);
  expect(e.url).toBe("http://localhost:5173/");
  expect(engine.readCounts.get(e.paneId!)).toBe(1);

  await __test__.pollLiveness(r);
  expect(engine.readCounts.get(e.paneId!)).toBe(1);

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});

// Tags reads by their requested line count (URL_SCAN_LINES=800 vs the
// small liveness-sentinel read=50) so a test can isolate the url-scan read
// from the sentinel read that still happens every tick regardless of state.
class ScopedReadEngine extends FakeEngine {
  scanReads = 0;
  override async read(paneId: string, lines?: number): Promise<string> {
    if (lines === 800) this.scanReads++;
    return this.text.get(paneId) ?? "line a\nline b\n";
  }
}

test("pollLiveness does not url-scan a crashed entry", async () => {
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  const engine = new ScopedReadEngine();
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const d = deps({
    sessions: [addSession, liveSession],
    engine,
    now: () => new Date(time),
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  const finished = r.run();
  await flushMicrotasks();
  const e = r.entries[0]!;
  time += 1000; // clears LAUNCH_GRACE_MS so pollLiveness reads this entry

  // The shell reclaims the foreground with a nonzero exit sentinel: the entry crashes.
  engine.running.delete(e.paneId!);
  engine.text.set(e.paneId!, "line a\n__rt_exit 1\n");
  await __test__.pollLiveness(r);
  expect(e.state).toBe("crashed");
  expect(e.url).toBeNull();
  expect(engine.scanReads).toBe(0);

  // A later tick against the same crashed entry must not scan either.
  time += 1000;
  await __test__.pollLiveness(r);
  expect(engine.scanReads).toBe(0);

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});

test("pollLiveness scans only the current run, ignoring a stale port left in scrollback by a restart", async () => {
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  const engine = new UrlFakeEngine();
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const d = deps({
    sessions: [addSession, liveSession],
    engine,
    now: () => new Date(time),
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  const finished = r.run();
  await flushMicrotasks();
  const e = r.entries[0]!;
  time += 1000; // clears LAUNCH_GRACE_MS so pollLiveness reads this entry

  // Scrollback still holds the previous run's banner ahead of the exit
  // sentinel; only the text after it belongs to the new run.
  engine.text.set(e.paneId!, "> Local: http://localhost:3000/\n__rt_exit 0\n> Local: http://localhost:5173/\n");
  await __test__.pollLiveness(r);
  expect(e.url).toBe("http://localhost:5173/");

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});

test("open intent calls openUrl with the entry's latched url", async () => {
  const opened: string[] = [];
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const d = deps({
    sessions: [addSession, liveSession],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
    openUrl: async (url: string) => { opened.push(url); },
  });
  const r = new Runner(d);
  const finished = r.run();
  await flushMicrotasks();
  r.entries[0]!.url = "http://localhost:5173/";

  liveSession.send({ t: "intent", name: "open", entryId: "e1" });
  await flushMicrotasks();
  expect(opened).toEqual(["http://localhost:5173/"]);

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});

test("open intent does nothing when the entry has no url", async () => {
  const opened: string[] = [];
  const s = new FakeSession([{ t: "intent", name: "add" }]);
  const s2 = new FakeSession([{ t: "intent", name: "open", entryId: "e1" }, { t: "intent", name: "quit" }]);
  const d = deps({
    sessions: [s, s2],
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
    openUrl: async (url: string) => { opened.push(url); },
  });
  const r = new Runner(d);
  await r.run();
  expect(opened).toEqual([]);
});

test("restart clears a latched url so a new port is re-detected", async () => {
  let time = new Date("2026-08-30T00:00:00Z").getTime();
  const engine = new UrlFakeEngine();
  const addSession = new FakeSession([{ t: "intent", name: "add" }]);
  const liveSession = new QueueSession();
  const d = deps({
    sessions: [addSession, liveSession],
    engine,
    now: () => new Date(time),
    resolve: async () => ({ kind: "resolved", result: { targetDir: "/repo/web", packageLabel: "web", worktree: "/repo", branch: "main", commandTemplate: "bun run dev", script: "dev" } }),
  });
  const r = new Runner(d);
  const finished = r.run();
  await flushMicrotasks();
  const e = r.entries[0]!;
  time += 1000; // clears LAUNCH_GRACE_MS so pollLiveness reads this entry
  await __test__.pollLiveness(r);
  expect(e.url).toBe("http://localhost:5173/");

  liveSession.send({ t: "intent", name: "restart", entryId: "e1" });
  await flushMicrotasks();
  expect(e.url).toBeNull();

  liveSession.send({ t: "intent", name: "quit" });
  await finished;
});
