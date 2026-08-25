/**
 * e2e — presence sign-in/roster, against the compiled binary (RT-48 chat
 * presence). Built on e2e/tests/chat.test.ts's harness pattern; see that
 * file's header for the pump/nextLine idiom this one reuses verbatim.
 * e2e/tests/chat-presence.test.ts is plan 1's own suite (armed-clear on
 * restart) and is not touched here.
 *
 * startDaemonForHome takes an extraEnv second argument so a test can inject
 * RT_CHAT_TAIL_STALE_MS / RT_CHAT_SESSION_STALE_MS / RT_CHAT_PRUNE_MS into the
 * DAEMON's own process env — presenceThresholds() reads process.env in the
 * daemon, so handing shortened thresholds to CLI invocations alone would do
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { SCHEMA_VERSION } from "../../lib/state/db.ts";

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

let home = "";
let cleanupHome: () => void = () => {};
let apiPort = 0;
let currentDaemon: ReturnType<typeof Bun.spawn> | null = null;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

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

/** extraEnv lands in the DAEMON's spawn env — the thresholds' only route in. */
async function startDaemonForHome(home: string, extraEnv: Record<string, string> = {}): Promise<void> {
  apiPort = freePort();
  currentDaemon = runRt(["--daemon"], home, extraEnv);
  await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
}

async function stopDaemonForHome(_home: string): Promise<void> {
  if (!currentDaemon) throw new Error("stopDaemonForHome: no daemon running for this home");
  currentDaemon.kill();
  await currentDaemon.exited;
  currentDaemon = null;
}

async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until: predicate never became true");
    await Bun.sleep(25);
  }
}

// ─── per-process stdout line reader (copied from chat.test.ts) ─────────────

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
      if (line.length === 0) return;
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

// ─── presence-specific helpers ──────────────────────────────────────────────

interface SignInResult {
  ok: true;
  handle: string;
  room: string | null;
}

async function signIn(
  homeDir: string,
  sessionId: string,
  baseHandle: string,
  roomArgs: string[] = ["--no-room"],
): Promise<SignInResult> {
  const res = await finished(
    runRt(["chat", "sign-in", "--as", baseHandle, "--session", sessionId, ...roomArgs, "--json"], homeDir),
  );
  if (res.exitCode !== 0) throw new Error(`sign-in(${sessionId}) failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout) as SignInResult;
}

interface BuddyRow {
  handle: string;
  status: "live" | "idle" | "deaf" | "offline";
  armedAt?: number;
}

async function getBuddies(homeDir: string): Promise<BuddyRow[]> {
  const { stdout } = await finished(runRt(["chat", "buddies", "--json"], homeDir));
  return (JSON.parse(stdout).buddies ?? []) as BuddyRow[];
}

async function waitForBuddyArmed(homeDir: string, handle: string, timeoutMs = 15_000): Promise<BuddyRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await getBuddies(homeDir)).find((b) => b.handle === handle);
    if (row?.armedAt != null) return row;
    await Bun.sleep(100);
  }
  throw new Error(`waitForBuddyArmed: "${handle}" never armed`);
}

async function waitForBuddyStatus(
  homeDir: string,
  handle: string,
  status: BuddyRow["status"],
  timeoutMs = 15_000,
): Promise<BuddyRow> {
  const deadline = Date.now() + timeoutMs;
  let last: BuddyRow | undefined;
  while (Date.now() < deadline) {
    last = (await getBuddies(homeDir)).find((b) => b.handle === handle);
    if (last?.status === status) return last;
    await Bun.sleep(100);
  }
  throw new Error(`waitForBuddyStatus: "${handle}" never reached "${status}" (last: ${JSON.stringify(last)})`);
}

function statePath(homeDir: string): string {
  return join(homeDir, ".mattstack", "rt", "state.db");
}

interface PresenceDbRow {
  session_id: string;
  armed_at: number | null;
  signed_out_at: number | null;
}

/** Direct db read, same pattern as endpoint.test.ts's readInterceptRulesRow — safe against a live WAL-mode daemon, since this test process only ever reads. */
function readPresenceRow(homeDir: string, handle: string): PresenceDbRow | null {
  const db = new Database(statePath(homeDir));
  try {
    return db.query("SELECT session_id, armed_at, signed_out_at FROM chat_presence WHERE handle = ?;").get(handle) as
      | PresenceDbRow
      | null;
  } finally {
    db.close();
  }
}

interface NotifyEvent {
  title: string;
  message: string;
  category: string;
}

function readNotifyQueue(homeDir: string): NotifyEvent[] {
  const db = new Database(statePath(homeDir));
  try {
    const rows = db.query("SELECT event FROM notify_queue ORDER BY id;").all() as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as NotifyEvent);
  } finally {
    db.close();
  }
}

function readUserVersion(homeDir: string): number {
  const db = new Database(statePath(homeDir));
  try {
    return (db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function setUserVersion(homeDir: string, version: number): void {
  const db = new Database(statePath(homeDir));
  try {
    db.exec(`PRAGMA user_version = ${version};`);
  } finally {
    db.close();
  }
}

function tableExists(homeDir: string, name: string): boolean {
  const db = new Database(statePath(homeDir));
  try {
    return db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;").get(name) !== null;
  } finally {
    db.close();
  }
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("rt chat presence + roster (e2e)", () => {
  beforeEach(() => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
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

  test("two sign-ins from one worktree before either arms yield x/x-2; both tails arm; a DM to x-2 wakes only x-2", async () => {
    await startDaemonForHome(home);

    const a = await signIn(home, "sess-a1", "x");
    expect(a.handle).toBe("x");
    const b = await signIn(home, "sess-b1", "x");
    expect(b.handle).toBe("x-2");

    const tailX = runRt(["chat", "tail", "--session", "sess-a1"], home);
    const tailX2 = runRt(["chat", "tail", "--session", "sess-b1"], home);
    await waitForBuddyArmed(home, "x");
    await waitForBuddyArmed(home, "x-2");

    await finished(runRt(["chat", "dm", "x-2", "ping"], home, {}));

    expect(await nextLine(tailX2, 5_000)).toContain("new in #dm-");
    // Matches nextLine's own timeout message — a bare toThrow() would also
    // pass on "stream already ended" from a tail that died, making this
    // negative vacuous.
    await expect(nextLine(tailX, 2_000)).rejects.toThrow(/timed out/);

    tailX.kill();
    tailX2.kill();
  }, 30_000);

  test("a second sign-in after the first tail has already armed still yields x-2", async () => {
    await startDaemonForHome(home);

    const a = await signIn(home, "sess-a2", "x");
    expect(a.handle).toBe("x");
    const tailX = runRt(["chat", "tail", "--session", "sess-a2"], home);
    await waitForBuddyArmed(home, "x");

    const b = await signIn(home, "sess-b2", "x");
    expect(b.handle).toBe("x-2");

    const tailX2 = runRt(["chat", "tail", "--session", "sess-b2"], home);
    await waitForBuddyArmed(home, "x-2");

    tailX.kill();
    tailX2.kill();
  }, 30_000);

  test("a SIGKILLed tail reads deaf within the shortened threshold while its session keeps pulsing", async () => {
    await startDaemonForHome(home, { RT_CHAT_TAIL_STALE_MS: "400" });

    await signIn(home, "sess-deaf", "listener");
    const tail = runRt(["chat", "tail", "--session", "sess-deaf"], home);
    await waitForBuddyArmed(home, "listener");

    tail.kill("SIGKILL");
    await tail.exited;

    // Pulsing (as a hook would, on every prompt) refreshes the SESSION
    // heartbeat only — the armed row must still read deaf on the TAIL
    // heartbeat alone, or a live agent with a dead tail would look "idle".
    const deadline = Date.now() + 10_000;
    let lastPulse: { status?: string } | null = null;
    while (Date.now() < deadline) {
      const res = await finished(runRt(["chat", "pulse", "--json", "--session", "sess-deaf"], home));
      try { lastPulse = JSON.parse(res.stdout); } catch { lastPulse = null; }
      if (lastPulse?.status === "deaf") break;
      await Bun.sleep(100);
    }
    expect(lastPulse?.status).toBe("deaf");

    const buddy = await waitForBuddyStatus(home, "listener", "deaf");
    expect(buddy.armedAt).toBeDefined();
  }, 30_000);

  test("a reclaimed handle: the old tail exits with the reclaimed notice; the new session bounces once then re-arms clean", async () => {
    await startDaemonForHome(home, {
      RT_CHAT_SESSION_STALE_MS: "50",
      RT_CHAT_TAIL_STALE_MS: "50",
    });

    const a = await signIn(home, "sess-reclaim-a", "x");
    expect(a.handle).toBe("x");

    const markerA = join(tmpdir(), `chat-reclaim-${process.pid}`);
    const tailA = runRt(["chat", "tail", "--session", "sess-reclaim-a"], home, {
      RT_CHAT_TEST_PRE_WAIT_MARKER: markerA,
    });
    await until(() => existsSync(markerA));
    const t0 = Date.now();

    // Both thresholds are 50ms — this pushes A's row past both cutoffs
    // (session heartbeat AND tail heartbeat) while A's tail sits at the
    // marker, armed but never touching again.
    await Bun.sleep(300);

    const b = await signIn(home, "sess-reclaim-b", "x");
    expect(b.handle).toBe("x"); // reclaimed, not suffixed — A's row was stale enough

    // A's pidfile is still held by a live process (A's tail hasn't exited),
    // so B's first arm attempt must bounce off it.
    const bounced = await finished(runRt(["chat", "tail", "--session", "sess-reclaim-b"], home));
    expect(bounced.exitCode).toBe(3);
    expect(bounced.stderr).toContain("already armed");

    // A's blocked events:wait call needs a wake to notice the reclaim
    // quickly rather than sitting out its ~15s round — post it BEFORE
    // releasing the marker so the event already exists when A resumes.
    await finished(runRt(["chat", "dm", "x", "psst", "--as", "nudge"], home));

    // testMarkerPause (commands/chat.ts) self-expires at 2000ms without
    // deleting the file — an overrun here would let A resume on its own
    // before this rmSync ever runs, silently breaking the causal chain the
    // rest of this scenario depends on.
    expect(Date.now() - t0).toBeLessThan(2_000);
    rmSync(markerA);

    const aResult = await finished(tailA);
    expect(aResult.exitCode).toBe(0);
    expect(aResult.stdout).toContain("handle reclaimed — sign in again");

    const tailB = runRt(["chat", "tail", "--session", "sess-reclaim-b"], home);
    await waitForBuddyArmed(home, "x");
    tailB.kill();
  }, 30_000);

  test("SessionEnd-style sign-out clears armed_at, sets signed_out_at, and keeps room membership", async () => {
    await startDaemonForHome(home);

    const signed = await signIn(home, "sess-out", "roomie", ["--room", "crew"]);
    expect(signed.room).toBe("crew");

    const tail = runRt(["chat", "tail", "--session", "sess-out"], home);
    await waitForBuddyArmed(home, "roomie");

    const before = readPresenceRow(home, "roomie");
    expect(before).not.toBeNull(); // readPresenceRow returns null, not undefined, for a missing row
    expect(before?.armed_at).not.toBeNull();
    expect(before?.signed_out_at).toBeNull();

    const out = await finished(runRt(["chat", "sign-out", "--session", "sess-out", "--json"], home));
    expect(out.exitCode).toBe(0);
    expect((JSON.parse(out.stdout) as { ok: boolean }).ok).toBe(true);

    // sign-out SIGTERMs the handle's tail — a deliberate stop exits 0.
    const tailResult = await finished(tail);
    expect(tailResult.exitCode).toBe(0);

    const after = readPresenceRow(home, "roomie");
    expect(after).not.toBeNull();
    expect(after?.armed_at).toBeNull();
    expect(after?.signed_out_at).not.toBeNull();

    const who = await finished(runRt(["chat", "who", "crew", "--json"], home));
    const members = (JSON.parse(who.stdout).rooms[0]?.members ?? []) as Array<{ handle: string; status: string }>;
    const roomie = members.find((m) => m.handle === "roomie");
    expect(roomie).toBeDefined();
    expect(roomie?.status).toBe("offline");
  }, 30_000);

  test("a DM to matt produces a desk notification", async () => {
    await startDaemonForHome(home);

    const res = await finished(runRt(["chat", "dm", "matt", "hello from agent1", "--as", "agent1", "--json"], home));
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as { ok: boolean }).ok).toBe(true);

    const notice = readNotifyQueue(home).find((e) => e.category === "chat_mention" && e.title === "DM from agent1");
    expect(notice).toBeDefined();
    expect(notice?.message).toContain("hello from agent1");
  }, 30_000);

  test("downgrading user_version to 3 and restarting the daemon replays the schema without losing data", async () => {
    await startDaemonForHome(home);
    const seeded = await signIn(home, "sess-migrate", "before-migration");
    expect(seeded.handle).toBe("before-migration");
    await stopDaemonForHome(home);

    expect(readUserVersion(home)).toBe(SCHEMA_VERSION);
    setUserVersion(home, 3);
    expect(readUserVersion(home)).toBe(3);

    await startDaemonForHome(home);

    expect(readUserVersion(home)).toBe(SCHEMA_VERSION);
    for (const table of ["chat_presence", "chat_room_defaults", "chat_dms", "chat_rooms", "chat_members", "chat_messages"]) {
      expect(tableExists(home, table)).toBe(true);
    }
    // The replay is IF NOT EXISTS everywhere — a data-preserving no-op.
    expect(readPresenceRow(home, "before-migration")).not.toBeNull();

    const after = await signIn(home, "sess-post-migrate", "after-migration");
    expect(after.handle).toBe("after-migration");
  }, 30_000);
});
