/**
 * The runner's brain. Owns every entry, every herdr call, and the poll
 * timers; the view owns nothing but pixels. Every dependency is injected so
 * the loop runs under test with no herdr, no rt-ui, and no clock.
 */
import { basename } from "path";
import type { RunResolution } from "../../commands/run.ts";
import type { SessionHandle } from "../ui/spawn.ts";
import type { SessionIntent } from "../ui/protocol.ts";
import { EngineError, type Engine } from "./engine.ts";
import { deriveState, filterTail, isRunning, newEntry, toModel, type Entry } from "./state.ts";

export interface SeedEntry {
  name: string;
  command: string;
  cwd: string;
  pkg: string;
  repo: string;
}

export interface RunnerDeps {
  engine: Engine;
  openSession: (view: string, model: unknown) => Promise<SessionHandle>;
  resolve: () => Promise<RunResolution>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  workspaceLabel: string;
  seed?: SeedEntry[];
}

const LIVENESS_MS = 1500;
const TAIL_MS = 1000;
const TAIL_LINES = 200;
const RESTART_WAIT_MS = 5000;
const LAUNCH_GRACE_MS = 500;

export class SessionDied extends Error {
  constructor(code: number) {
    super(`rt-ui session died (exit ${code})`);
    this.name = "SessionDied";
  }
}

export class Runner {
  readonly entries: Entry[] = [];
  private workspaceId: string | null = null;
  private seq = 0;
  private session: SessionHandle | null = null;
  private tailFor: string | null = null;
  private lastPushed = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private tornDown = false;
  private polling: { liveness: boolean; tail: boolean } = { liveness: false, tail: false };

  constructor(private readonly deps: RunnerDeps) {}

  async run(): Promise<void> {
    try {
      await this.openBoard();
      for (const s of this.deps.seed ?? []) await this.launchResolved(s);
      this.push();
      while (this.session) {
        const s = this.session;
        for await (const intent of s.intents) {
          const again = await this.handle(intent);
          if (again === "reopen") break;
          if (again === "done") {
            await this.closeSession(s);
            return;
          }
        }
        if (this.session === s) {
          const end = await this.closeSession(s);
          if (end.reason === "quit" || end.reason === "closed") return;
        }
      }
    } finally {
      await this.teardown();
    }
  }

  // died and error are the same thing to the runner: the view is gone for a
  // reason that was not ours, so the board ends with a message, not silently.
  private async closeSession(s: SessionHandle) {
    this.stopTimers();
    const end = await s.close();
    this.session = null;
    if (end.reason === "died" || end.reason === "error") throw new SessionDied(end.code);
    return end;
  }

  private async openBoard(): Promise<void> {
    this.session = await this.deps.openSession("board", this.model());
    this.lastPushed = JSON.stringify(this.model());
    this.startTimers();
  }

  private model() {
    return toModel(this.deps.workspaceLabel, this.entries);
  }

  private push(): void {
    if (!this.session) return;
    const m = this.model();
    const json = JSON.stringify(m);
    if (json === this.lastPushed) return;
    this.lastPushed = json;
    this.session.push(m);
  }

  private startTimers(): void {
    this.timers.push(setInterval(() => void this.guarded("liveness", () => this.pollLiveness()), LIVENESS_MS));
    this.timers.push(setInterval(() => void this.guarded("tail", () => this.pollTail()), TAIL_MS));
  }

  // Skips a tick that would overlap a still-awaiting herdr round-trip from the
  // previous tick, rather than piling up concurrent polls of the same kind.
  private async guarded(key: "liveness" | "tail", fn: () => Promise<void>): Promise<void> {
    if (this.polling[key]) return;
    this.polling[key] = true;
    try {
      await fn();
    } finally {
      this.polling[key] = false;
    }
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async handle(intent: SessionIntent): Promise<"reopen" | "done" | "continue"> {
    switch (intent.name) {
      case "quit":
        return "done";
      case "add":
        await this.add();
        return "reopen";
      case "stop":
        await this.stop(intent.entryId);
        break;
      case "restart":
        await this.restart(intent.entryId);
        break;
      case "focus":
        await this.focus(intent.entryId);
        break;
      case "tail":
        this.tailFor = intent.open ? intent.entryId ?? null : null;
        for (const e of this.entries) if (e.id !== this.tailFor) e.tail = null;
        // Route through the same reentrancy guard the interval uses so a tail
        // intent landing mid-poll cannot start a second overlapping read.
        await this.guarded("tail", () => this.pollTail());
        break;
    }
    this.push();
    return "continue";
  }

  private find(id: string | undefined): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  private pin(e: Entry, err: unknown): void {
    e.error = err instanceof EngineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  }

  private async add(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.closeSession(s);

    // The picker runs in this process with the terminal to itself. A
    // "launched" result means the user picked a preset or queue, which
    // rt run launched into their own herdr panes; the board reopens
    // unchanged either way, as it does when the picker throws.
    let res: RunResolution;
    try {
      res = await this.deps.resolve();
    } catch (err) {
      process.stderr.write(`  rt runner: picker failed (${err instanceof Error ? err.message : String(err)})\n`);
      await this.openBoard();
      return;
    }
    if (res.kind !== "resolved") {
      await this.openBoard();
      return;
    }
    const r = res.result;
    await this.openBoard();
    await this.launchResolved({
      name: r.script || basename(r.targetDir),
      command: r.commandTemplate,
      cwd: r.targetDir,
      pkg: r.packageLabel,
      repo: basename(r.worktree),
    });
    this.push();
  }

  private async launchResolved(s: SeedEntry): Promise<void> {
    const entry = newEntry(++this.seq, s.name, s.command, s.cwd, s.pkg, s.repo);
    this.entries.push(entry);
    await this.launch(entry);
  }

  private async launch(entry: Entry): Promise<void> {
    try {
      if (!this.workspaceId) {
        const ws = await this.deps.engine.createWorkspace(this.deps.workspaceLabel);
        this.workspaceId = ws.workspaceId;
        await this.deps.engine.renameTab(ws.tabId, entry.name);
        entry.tabId = ws.tabId;
        entry.paneId = ws.paneId;
      } else {
        const tab = await this.deps.engine.createTab(this.workspaceId, entry.name);
        entry.tabId = tab.tabId;
        entry.paneId = tab.paneId;
      }
      await this.deps.engine.run(entry.paneId, entry.cwd, entry.command);
      entry.startedAt = this.deps.now();
      entry.state = "starting";
    } catch (err) {
      this.pin(entry, err);
      entry.state = "crashed";
    }
  }

  private async stop(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.paneId) return;
    e.state = "stopping";
    try {
      await this.deps.engine.interrupt(e.paneId);
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async restart(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.paneId) return;
    e.state = "starting";
    e.error = null;
    try {
      if (isRunning(await this.deps.engine.processInfo(e.paneId))) {
        await this.deps.engine.interrupt(e.paneId);
        const until = this.deps.now().getTime() + RESTART_WAIT_MS;
        while (isRunning(await this.deps.engine.processInfo(e.paneId))) {
          if (this.deps.now().getTime() >= until) {
            e.error = "did not stop";
            e.state = "running";
            return;
          }
          await this.deps.sleep(150);
        }
      }
      await this.deps.engine.run(e.paneId, e.cwd, e.command);
      e.startedAt = this.deps.now();
      e.exitCode = null;
      // A pollLiveness tick can land during the wait above and overwrite
      // e.state via deriveState; re-assert starting so the pushed model
      // never shows a stale running/stopped label right after a restart.
      e.state = "starting";
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async focus(id: string | undefined): Promise<void> {
    const e = this.find(id);
    if (!e?.tabId) return;
    try {
      await this.deps.engine.focusTab(e.tabId);
    } catch (err) {
      this.pin(e, err);
    }
  }

  private async pollLiveness(): Promise<void> {
    if (!this.session) return;
    for (const e of this.entries) {
      if (!e.paneId) continue;
      // The previous run's exit sentinel is still in the pane text until the
      // shell forks the new command; give a fresh launch a moment before
      // reading the sentinel as this run's verdict.
      if (e.startedAt && this.deps.now().getTime() - e.startedAt.getTime() < LAUNCH_GRACE_MS) continue;
      try {
        const info = await this.deps.engine.processInfo(e.paneId);
        const text = isRunning(info) ? "" : await this.deps.engine.read(e.paneId, 50);
        const next = deriveState(e, info, text);
        e.state = next.state;
        e.exitCode = next.exitCode;
      } catch (err) {
        this.pin(e, err);
      }
    }
    this.push();
  }

  private async pollTail(): Promise<void> {
    if (!this.session || !this.tailFor) return;
    const e = this.find(this.tailFor);
    if (!e?.paneId) return;
    try {
      e.tail = filterTail(await this.deps.engine.read(e.paneId, TAIL_LINES), this.deps.now());
    } catch (err) {
      this.pin(e, err);
    }
    this.push();
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.stopTimers();
    if (this.workspaceId) {
      try {
        await this.deps.engine.closeWorkspace(this.workspaceId);
      } catch (err) {
        process.stderr.write(
          `  rt runner: could not close workspace ${this.workspaceId} (${err instanceof Error ? err.message : String(err)})\n`,
        );
      }
    }
  }
}

/**
 * Test-only: run a single pollLiveness/pollTail pass on demand instead of
 * waiting on the real interval timers. Each hook calls the exact private
 * method the timer calls, so production polling behavior is unchanged.
 */
export const __test__ = {
  pollLiveness: (r: Runner): Promise<void> => (r as unknown as { pollLiveness(): Promise<void> }).pollLiveness(),
  pollTail: (r: Runner): Promise<void> => (r as unknown as { pollTail(): Promise<void> }).pollTail(),
};
