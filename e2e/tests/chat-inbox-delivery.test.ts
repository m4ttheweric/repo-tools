/**
 * e2e: daemon-side pane sign-in and push delivery against a real socket
 * (RT-48 delivery-v2, Task 9). This is the fake-inbox e2e
 * e2e/tests/chat-presence-roster.test.ts's own header explicitly defers to
 * this file: a real unix-socket "Claude Code inbox" the daemon's own
 * registry resolver (lib/claude-registry.ts) can find under the test HOME,
 * plus a fake herdr server so `rt chat sign-in --pane` resolves a pane to a
 * session the same way a real herdr-managed pane would.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../lib/herdr/__tests__/fake-herdr.ts";

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
const stops: Array<() => void> = [];

function runRt(args: string[], homeDir: string, extraEnv: Record<string, string> = {}) {
  const bunDir = join(process.execPath, "..");
  const proc = Bun.spawn([RT_BINARY, ...args], {
    env: {
      HOME: homeDir,
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

async function startDaemonForHome(homeDir: string, extraEnv: Record<string, string> = {}): Promise<void> {
  apiPort = freePort();
  currentDaemon = runRt(["--daemon"], homeDir, extraEnv);
  await waitForSocket(join(homeDir, ".mattstack", "rt", "rt.sock"));
}

// ─── fakes: herdr, and a Claude Code inbox the real daemon's own registry resolver can find ──

/** A `session.snapshot` fake herdr server exposing one pane per (paneId, sessionId) pair, matching lib/daemon/__tests__/chat-handlers.test.ts's own paneSnapshotHandler shape. */
function fakeHerdrForPanes(panes: Array<{ paneId: string; sessionId: string }>) {
  const handler: FakeHerdrHandler = (method) => {
    if (method !== "session.snapshot") return new HerdrFakeError("invalid_request", method);
    return {
      snapshot: {
        workspaces: [],
        panes: panes.map(({ paneId, sessionId }) => ({
          pane_id: paneId,
          workspace_id: "w1",
          tab_id: `w1:${paneId}`,
          agent: "claude",
          agent_status: "idle",
          agent_session: { source: "claude", agent: "claude", kind: "id", value: sessionId },
        })),
      },
    };
  };
  return fakeHerdr(handler);
}

let registrySeq = 0;

/**
 * Writes a claude-registry entry (lib/claude-registry.ts) under the test
 * HOME, pointed at a fake inbox socket this test process owns. `process.pid`
 * is the e2e test process's own pid, alive for the whole run, which is what
 * `inboxAlive`'s `process.kill(pid, 0)` check needs.
 */
function registerFakeInbox(homeDir: string, sessionId: string, socketPath: string): void {
  const dir = join(homeDir, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${100000 + registrySeq++}.json`),
    JSON.stringify({ sessionId, pid: process.pid, messagingSocketPath: socketPath, status: "idle" }),
  );
}

/** A real unix-socket "Claude Code inbox": deliverToInbox (lib/daemon/inbox.ts) opens one connection per frame and writes one JSON line before closing, so each `data` chunk here is one frame. */
function startFakeInbox(): { socketPath: string; frames: Array<Record<string, unknown>>; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "e2e-inbox-"));
  const socketPath = join(dir, "s.sock");
  const frames: Array<Record<string, unknown>> = [];
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          try { frames.push(JSON.parse(line)); } catch { /* a split chunk: ignore, the whole line arrives eventually */ }
        }
      },
    },
  });
  return {
    socketPath,
    frames,
    stop: () => { server.stop(true); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function waitForFrame(
  frames: Array<Record<string, unknown>>,
  predicate: (f: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`waitForFrame: timed out waiting among ${frames.length} frame(s)`);
    await Bun.sleep(100);
  }
}

function frameContent(frame: Record<string, unknown>): string {
  const message = frame.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

// ─── chat CLI helpers ────────────────────────────────────────────────────────

interface SignInResult { ok: true; handle: string; room: string | null }

async function signIn(homeDir: string, sessionId: string, baseHandle: string, room: string): Promise<SignInResult> {
  const res = await finished(runRt(["chat", "sign-in", "--as", baseHandle, "--session", sessionId, "--room", room, "--json"], homeDir));
  if (res.exitCode !== 0) throw new Error(`sign-in(${sessionId}) failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout) as SignInResult;
}

async function signInPane(homeDir: string, paneId: string, baseHandle: string, room: string): Promise<SignInResult> {
  const res = await finished(runRt(["chat", "sign-in", "--pane", paneId, "--as", baseHandle, "--room", room, "--json"], homeDir));
  if (res.exitCode !== 0) throw new Error(`sign-in --pane(${paneId}) failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout) as SignInResult;
}

async function signOut(homeDir: string, sessionId: string): Promise<void> {
  const res = await finished(runRt(["chat", "sign-out", "--session", sessionId], homeDir));
  if (res.exitCode !== 0) throw new Error(`sign-out(${sessionId}) failed: ${res.stderr || res.stdout}`);
}

async function post(homeDir: string, room: string, body: string, sessionId: string): Promise<{ ok: true; id: number; recipients: string[] }> {
  const res = await finished(runRt(["chat", "post", room, body, "--session", sessionId, "--json"], homeDir));
  if (res.exitCode !== 0) throw new Error(`post failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout);
}

async function dm(homeDir: string, to: string, body: string, sessionId: string): Promise<{ ok: true; id: number }> {
  const res = await finished(runRt(["chat", "dm", to, body, "--session", sessionId, "--json"], homeDir));
  if (res.exitCode !== 0) throw new Error(`dm failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout);
}

// ─── suite ───────────────────────────────────────────────────────────────────

describe("rt chat inbox delivery (e2e)", () => {
  beforeEach(() => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    stops.length = 0;
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    children.length = 0;
    currentDaemon = null;
    cleanupHome();
  });

  test("daemon-side sign-in --pane delivers a post to the pane's real inbox socket", async () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const paneId = "w1:p1";
    const { sock: herdrSock, stop: stopHerdr } = fakeHerdrForPanes([{ paneId, sessionId }]);
    stops.push(stopHerdr);
    const inbox = startFakeInbox();
    stops.push(inbox.stop);
    registerFakeInbox(home, sessionId, inbox.socketPath);

    await startDaemonForHome(home, { HERDR_SOCKET_PATH: herdrSock });

    const signedIn = await signInPane(home, paneId, "recipient", "testroom");
    expect(signedIn.handle).toBe("recipient");
    expect(signedIn.room).toBe("testroom");

    // The welcome frame lands first; drain it before asserting on the post.
    await waitForFrame(inbox.frames, (f) => frameContent(f).includes("You're signed in to rt chat as recipient"));

    await signIn(home, "sess-poster", "poster", "testroom");
    // Default wake-on mode is "mention": an un-mentioned member gets no
    // recipient slot at all, so the post must name the recipient to be
    // delivered anywhere.
    const posted = await post(home, "testroom", "@recipient hello from e2e", "sess-poster");
    expect(posted.recipients).toContain("recipient");

    const frame = await waitForFrame(inbox.frames, (f) => frameContent(f).includes("hello from e2e"));
    expect(frame.type).toBe("user");
    expect(frameContent(frame)).toBe("[#testroom] poster: @recipient hello from e2e");
  }, 30_000);

  test("a DM lands only on its recipient's inbox, and stops once that recipient signs out", async () => {
    const sessionA = "22222222-2222-2222-2222-222222222222";
    const sessionB = "33333333-3333-3333-3333-333333333333";
    const paneA = "w1:pa";
    const paneB = "w1:pb";

    const { sock: herdrSock, stop: stopHerdr } = fakeHerdrForPanes([
      { paneId: paneA, sessionId: sessionA },
      { paneId: paneB, sessionId: sessionB },
    ]);
    stops.push(stopHerdr);

    const inboxA = startFakeInbox();
    stops.push(inboxA.stop);
    const inboxB = startFakeInbox();
    stops.push(inboxB.stop);
    registerFakeInbox(home, sessionA, inboxA.socketPath);
    registerFakeInbox(home, sessionB, inboxB.socketPath);

    await startDaemonForHome(home, { HERDR_SOCKET_PATH: herdrSock });

    const a = await signInPane(home, paneA, "a", "testroom");
    const b = await signInPane(home, paneB, "b", "testroom");
    expect(a.handle).toBe("a");
    expect(b.handle).toBe("b");
    await waitForFrame(inboxA.frames, (f) => frameContent(f).includes("You're signed in"));
    await waitForFrame(inboxB.frames, (f) => frameContent(f).includes("You're signed in"));

    await signIn(home, "sess-c", "c", "testroom");
    await dm(home, "a", "secret for a", "sess-c");

    const frame = await waitForFrame(inboxA.frames, (f) => frameContent(f).includes("secret for a"));
    expect(frameContent(frame)).toBe("[dm] c: secret for a");
    // b is not a participant of this DM: nothing about it ever reaches b's inbox.
    await Bun.sleep(300);
    expect(inboxB.frames.some((f) => frameContent(f).includes("secret for a"))).toBe(false);

    const beforeSignOut = inboxA.frames.length;
    await signOut(home, sessionA);
    await dm(home, "a", "are you still there", "sess-c");
    await Bun.sleep(500);
    expect(inboxA.frames.length).toBe(beforeSignOut);
  }, 30_000);
});
