import { afterAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { openStateDb } from "../../lib/state/db.ts";
import { armMember, joinRoom } from "../../lib/state/chat-store.ts";

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

// Every spawned child, so afterAll can reap a daemon orphaned by a mid-test
// assertion failure instead of leaving it to its own devices.
const children: Array<ReturnType<typeof Bun.spawn>> = [];

let currentDaemon: ReturnType<typeof Bun.spawn> | null = null;

async function startDaemonForHome(home: string): Promise<void> {
  const bunDir = join(process.execPath, "..");
  const proc = Bun.spawn([RT_BINARY, "--daemon"], {
    env: {
      HOME: home,
      PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
      TERM: "xterm-256color",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_API_PORT: String(freePort()),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  currentDaemon = proc;
  await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
}

async function stopDaemonForHome(_home: string): Promise<void> {
  if (!currentDaemon) throw new Error("stopDaemonForHome: no daemon running for this home");
  currentDaemon.kill();
  await currentDaemon.exited;
  currentDaemon = null;
}

afterAll(async () => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  await Promise.all(children.map((c) => c.exited));
});

test("a daemon restart clears every armed_at", async () => {
  const { path: home, cleanup } = createTestHome();
  const dbPath = join(home, ".mattstack", "rt", "state.db");
  const db = openStateDb(dbPath);
  joinRoom({ room: "r", handle: "listener" }, db);
  armMember(undefined, "listener", db);
  db.close();

  await startDaemonForHome(home);
  await stopDaemonForHome(home);
  await startDaemonForHome(home);

  const after = openStateDb(dbPath);
  const row = after.query("SELECT armed_at FROM chat_members WHERE handle = 'listener';").get() as { armed_at: number | null };
  expect(row.armed_at).toBeNull();
  after.close();
  cleanup();
}, 30_000);
