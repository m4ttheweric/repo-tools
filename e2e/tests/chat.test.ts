import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

// Built on e2e/tests/events.test.ts. A tail never exits on its own, so tests
// read LINES from a live process rather than awaiting an exit code, and every
// long-lived child lands in children[] so afterEach reaps a tail orphaned by a
// mid-test assertion failure. Every daemon-touching helper takes `home` FIRST
// — including waitUntilArmed, which reaches the daemon without spawning and so
// is invisible to a Bun.spawn sweep, yet still needs `home` or defaultSock()
// resolves the test process's own HOME and polls the wrong socket.

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

/** Grab a free TCP port by binding port 0 and releasing it. */
function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

// Per-test daemon + home (fresh chat state each test); assigned in beforeEach.
let home = "";
let cleanupHome: () => void = () => {};
let apiPort = 0;
let currentDaemon: ReturnType<typeof Bun.spawn> | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

/**
 * Spawn `[RT_BINARY, ...args]` with a HERMETIC env (never ...process.env — that
 * leak is what caused the original port-9401 collision), push it into
 * children[], and RETURN the process. A tail test needs the handle while the
 * process still runs, so a helper that spawns AND awaits cannot serve it.
 * RT_CHAT_BACKOFF_MS is short so the daemon-down path exits 69 quickly.
 */
function runRt(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const bunDir = join(process.execPath, "..");
  const proc = Bun.spawn([RT_BINARY, ...args], {
    env: {
      HOME: home,
      PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
      TERM: "xterm-256color",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_API_PORT: String(apiPort),
      RT_CHAT_BACKOFF_MS: "1500",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
}

async function finished(proc: ReturnType<typeof runRt>) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

async function startDaemonForHome(home: string): Promise<void> {
  apiPort = freePort();
  currentDaemon = runRt(["--daemon"], home);
  await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
}

async function stopDaemonForHome(_home: string): Promise<void> {
  if (!currentDaemon) throw new Error("stopDaemonForHome: no daemon running for this home");
  currentDaemon.kill();
  await currentDaemon.exited;
  currentDaemon = null;
}

/** Poll a pure predicate to a deadline (no daemon, no env). */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until: predicate never became true");
    await Bun.sleep(25);
  }
}

/**
 * Poll `chat who` until every handle is armed — never a fixed sleep, which
 * makes the wake tests flaky under load. Takes `home` because it reaches the
 * daemon (over the socket at that home) even though it spawns no long-lived
 * child of its own.
 */
async function waitUntilArmed(home: string, room: string, ...handles: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { stdout } = await finished(runRt(["chat", "who", room, "--json"], home));
    try {
      const parsed = JSON.parse(stdout);
      const members: Array<{ handle: string; armedAt?: number }> = parsed.rooms?.[0]?.members ?? [];
      const armed = new Set(members.filter((m) => m.armedAt != null).map((m) => m.handle));
      if (handles.every((h) => armed.has(h))) return;
    } catch { /* daemon not ready / partial output */ }
    await Bun.sleep(100);
  }
  throw new Error(`waitUntilArmed: [${handles.join(", ")}] never armed in #${room}`);
}

// ─── per-process stdout line reader ─────────────────────────────────────────
// A tail streams one line per wake; nextLine resolves the next stdout line or
// rejects on timeout. Each process gets one pump that survives across calls.

interface Pump {
  queue: string[];
  waiters: Array<(line: string | null) => void>;
  ended: boolean;
}
const pumps = new WeakMap<object, Pump>();

function pumpFor(proc: ReturnType<typeof runRt>): Pump {
  let p = pumps.get(proc as object);
  if (p) return p;
  p = { queue: [], waiters: [], ended: false };
  pumps.set(proc as object, p);
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    const emit = (line: string) => {
      if (line.length === 0) return; // blank lines aren't notifications
      const w = p!.waiters.shift();
      if (w) w(line);
      else p!.queue.push(line);
    };
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          emit(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
    } catch { /* stream torn down on kill */ }
    if (buf.length) emit(buf);
    p!.ended = true;
    for (const w of p!.waiters.splice(0)) w(null);
  })();
  return p;
}

function nextLine(proc: ReturnType<typeof runRt>, ms: number): Promise<string> {
  const p = pumpFor(proc);
  return new Promise<string>((resolve, reject) => {
    const ready = p.queue.shift();
    if (ready !== undefined) return resolve(ready);
    if (p.ended) return reject(new Error("nextLine: stream already ended"));
    let settled = false;
    const onLine = (line: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (line === null) reject(new Error("nextLine: stream ended"));
      else resolve(line);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = p.waiters.indexOf(onLine);
      if (i >= 0) p.waiters.splice(i, 1);
      reject(new Error(`nextLine: timed out after ${ms}ms`));
    }, ms);
    p.waiters.push(onLine);
  });
}

describe("rt chat tail (wake protocol e2e)", () => {
  beforeEach(async () => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
    await startDaemonForHome(home);
  });

  afterEach(async () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    children.length = 0;
    currentDaemon = null;
    cleanupHome();
  });

  test("a post emits one line on a running tail", async () => {
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    await waitUntilArmed(home, "r", "listener");
    await finished(runRt(["chat", "post", "r", "@listener ping", "--as", "poster"], home));
    const line = await nextLine(tail, 5_000);
    expect(line).toContain("#r");
    expect(line.split("\n")).toHaveLength(1);
    tail.kill();
  }, 30_000);

  test("THREE mentions arrive on ONE arming", async () => {
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    await waitUntilArmed(home, "r", "listener");
    for (const n of ["one", "two", "three"]) {
      await finished(runRt(["chat", "post", "r", `@listener ${n}`, "--as", "poster"], home));
      expect(await nextLine(tail, 5_000)).toContain("#r");
    }
    expect(tail.killed).toBe(false);
    tail.kill();
  }, 30_000);

  test("leaving one of several rooms keeps the tail running", async () => {
    await finished(runRt(["chat", "join", "a", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "b", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "b", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    await waitUntilArmed(home, "b", "listener");
    await finished(runRt(["chat", "leave", "a", "--as", "listener"], home));
    await finished(runRt(["chat", "post", "b", "@listener still here?", "--as", "poster"], home));
    expect(await nextLine(tail, 5_000)).toContain("#b");
    tail.kill();
  }, 30_000);

  test("leaving the last room ends the tail with exit 0, not 69", async () => {
    // Exit 0 so the daemon-down backoff cannot mask a deliberate shutdown.
    await finished(runRt(["chat", "join", "a", "--as", "listener"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    await waitUntilArmed(home, "a", "listener");
    await finished(runRt(["chat", "leave", "a", "--as", "listener"], home));
    expect((await finished(tail)).exitCode).toBe(0);
  }, 30_000);

  test("a post in the arm window is delivered ONCE, not twice", async () => {
    // The mirror hole the streaming transport opened. A message posted between
    // the step-1 head snapshot and step-3's unread read qualifies for BOTH
    // delivery paths; without step 4's watermark the agent wakes twice.
    const marker = join(tmpdir(), `chat-dup-${process.pid}`);
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home, { RT_CHAT_TEST_PRE_CATCHUP_MARKER: marker });
    await until(() => existsSync(marker));
    await finished(runRt(["chat", "post", "r", "@listener once", "--as", "poster"], home));
    rmSync(marker);
    expect(await nextLine(tail, 5_000)).toContain("#r");
    await expect(nextLine(tail, 2_000)).rejects.toThrow();
    tail.kill();
  }, 30_000);

  test("restart gap: a post with no tail running is emitted by the catch-up", async () => {
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    await finished(runRt(["chat", "post", "r", "@listener while you were out", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    expect(await nextLine(tail, 5_000)).toContain("1 new");
    tail.kill();
  }, 30_000);

  test("wake policy: mention emits only when named; all always; none never", async () => {
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    await finished(runRt(["chat", "join", "r", "--as", "m"], home));
    await finished(runRt(["chat", "join", "r", "--as", "a", "--wake-on", "all"], home));
    await finished(runRt(["chat", "join", "r", "--as", "n", "--wake-on", "none"], home));
    const mention = runRt(["chat", "tail", "--as", "m"], home);
    const all = runRt(["chat", "tail", "--as", "a"], home);
    const none = runRt(["chat", "tail", "--as", "n"], home);
    await waitUntilArmed(home, "r", "m", "a", "n");
    await finished(runRt(["chat", "post", "r", "no mention here", "--as", "poster"], home));
    await expect(nextLine(mention, 2_000)).rejects.toThrow();
    expect(await nextLine(all, 2_000)).toContain("#r");
    await expect(nextLine(none, 2_000)).rejects.toThrow();
    [mention, all, none].forEach((p) => p.kill());
  }, 30_000);

  test("a dead daemon ends the stream rather than going quiet", async () => {
    // Monitor reads silence as "nothing happened", so a tail that blocks on a
    // dead daemon is indistinguishable from a room with no traffic.
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home);
    await waitUntilArmed(home, "r", "listener");
    await stopDaemonForHome(home);
    expect((await finished(tail)).exitCode).toBe(69);
  }, 30_000);

  test("the arm race: a post landing between the catch-up and the stream is not lost", async () => {
    // Injection is AFTER step 3's catch-up and BEFORE the events:wait call —
    // injecting earlier proves nothing, since step 3 catches those even with
    // the step-1 cursor deleted. RT_CHAT_TEST_PRE_WAIT_MARKER names a FILE: the
    // CLI creates it and blocks until it is removed, so the test posts inside
    // the window.
    const marker = join(tmpdir(), `chat-race-${process.pid}`);
    await finished(runRt(["chat", "join", "r", "--as", "listener"], home));
    await finished(runRt(["chat", "join", "r", "--as", "poster"], home));
    const tail = runRt(["chat", "tail", "--as", "listener"], home, { RT_CHAT_TEST_PRE_WAIT_MARKER: marker });
    await until(() => existsSync(marker));
    await finished(runRt(["chat", "post", "r", "@listener raced", "--as", "poster"], home));
    rmSync(marker);
    expect(await nextLine(tail, 10_000)).toContain("#r");
    tail.kill();
  }, 30_000);
});
