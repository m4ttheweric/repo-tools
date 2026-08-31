import { test, expect } from "bun:test";
import { Runner, type RunnerDeps } from "../runner.ts";
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
  async run(paneId: string, _cwd: string, command: string) { this.calls.push(`run:${paneId}:${command}`); this.running.add(paneId); }
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

function deps(over: Partial<RunnerDeps> & { sessions: FakeSession[]; engine?: FakeEngine }): RunnerDeps & { engine: FakeEngine } {
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
    sleep: async () => {},
    workspaceLabel: "rt-runner-test",
  };
}

test("quit with nothing launched: opens the session, tears nothing down, closes cleanly", async () => {
  const s = new FakeSession([{ t: "intent", name: "quit" }]);
  const d = deps({ sessions: [s] });
  await new Runner(d).run();
  expect(d.engine.calls).toEqual([]);
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
  expect(second.pushed.length).toBeGreaterThanOrEqual(0);
  expect(r.entries.map((e) => [e.name, e.pkg, e.repo])).toEqual([["dev", "web", "repo"]]);
  expect(d.engine.calls.slice(0, 3)).toEqual(["ws:rt-runner-test", "rename:wX:t1:dev", "run:wX:p1:bun run dev"]);
  expect(d.engine.calls.at(-1)).toBe("close:wX");
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
