/**
 * e2e — presence sign-in/roster, against the compiled binary (RT-48 chat
 * presence; delivery-v2 hard cutover). Built on e2e/tests/chat.test.ts's
 * harness pattern before that suite was deleted with the tail; only the
 * doorbell-free scenarios from the original chat-presence-roster suite
 * survive here. e2e/tests/chat-presence.test.ts (armed_at-on-restart) was
 * deleted outright: that behavior no longer exists. The delivery-side
 * scenarios the deleted suite covered via a spawned tail (a DM waking only
 * its intended recipient, a reclaimed session's old inbox going quiet) have
 * no replacement here -- they need a fake inbox socket the daemon's real
 * registry resolver can find, which is Task 9's e2e (chat-inbox-delivery)
 * to build, not this file's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { SCHEMA_VERSION } from "../../lib/state/index.ts";

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

function statePath(homeDir: string): string {
  return join(homeDir, ".mattstack", "rt", "state.db");
}

interface PresenceDbRow {
  session_id: string;
  signed_out_at: number | null;
}

/** Direct db read, same pattern as endpoint.test.ts's readInterceptRulesRow — safe against a live WAL-mode daemon, since this test process only ever reads. */
function readPresenceRow(homeDir: string, handle: string): PresenceDbRow | null {
  const db = new Database(statePath(homeDir));
  try {
    return db.query("SELECT session_id, signed_out_at FROM chat_presence WHERE handle = ?;").get(handle) as
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

  test("two sign-ins from one worktree before either registers yield x/x-2", async () => {
    await startDaemonForHome(home);

    const a = await signIn(home, "sess-a1", "x");
    expect(a.handle).toBe("x");
    const b = await signIn(home, "sess-b1", "x");
    expect(b.handle).toBe("x-2");
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
    // The replay is IF NOT EXISTS everywhere — a data-preserving no-op, so
    // the row survives with its columns intact, not merely as a row.
    const preserved = readPresenceRow(home, "before-migration");
    expect(preserved?.session_id).toBe("sess-migrate");
    expect(preserved?.signed_out_at).toBeNull();

    const after = await signIn(home, "sess-post-migrate", "after-migration");
    expect(after.handle).toBe("after-migration");
  }, 30_000);
});
