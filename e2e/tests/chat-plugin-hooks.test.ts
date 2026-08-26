/**
 * e2e — the chat plugin's `pulse.sh` (UserPromptSubmit) hook against the
 * REAL compiled `rt`, not the stub `rt` from
 * plugins/chat/hooks/tests/test-pulse.sh. That stub proves the script's shell
 * logic against canned JSON; this suite is the one place the whole chain —
 * compiled rt, `rt chat pulse --json`'s actual output shape, pulse.sh's jq
 * parse of it, and the line it injects — runs for real, against a real
 * daemon, real sign-ins, and real posts.
 *
 * The plugin lives in a sibling repo (mattstack-marketplace), not this one.
 * resolvePluginDir() locates its checkout; when none is found this whole
 * file skips itself rather than failing CI on a machine that never cloned
 * it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

function resolvePluginDir(): string | null {
  const candidates = [
    process.env.RT_CHAT_PLUGIN_DIR,
    join(homedir(), "Documents", "GitHub", "mattstack-marketplace", "plugins", "chat"),
    join(homedir(), "Documents", "GitHub", "mattstack-marketplace-chat-wt", "plugins", "chat"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(join(p, "hooks", "pulse.sh"))) ?? null;
}

const PLUGIN_DIR = resolvePluginDir();
if (!PLUGIN_DIR) {
  console.log(
    "chat-plugin-hooks: skipping — no chat plugin checkout found. Set RT_CHAT_PLUGIN_DIR to " +
      "plugins/chat, or check out mattstack-marketplace (or its -chat-wt worktree) alongside this repo.",
  );
}
const PULSE_SH = PLUGIN_DIR ? join(PLUGIN_DIR, "hooks", "pulse.sh") : "";

let home = "";
let cleanupHome: () => void = () => {};
let apiPort = 0;
let rtBinDir = "";
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

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
      RT_CHAT_BACKOFF_MS: "1500",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
}

async function finished(proc: {
  exited: Promise<number>;
  stdout: ReadableStream;
  stderr: ReadableStream;
}) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

/** extraEnv lands in the DAEMON's spawn env — presenceThresholds() reads process.env in the daemon, so a threshold override only takes effect there, never via a CLI invocation's own env. */
async function startDaemonForHome(homeDir: string, extraEnv: Record<string, string> = {}): Promise<void> {
  apiPort = freePort();
  runRt(["--daemon"], homeDir, extraEnv);
  await waitForSocket(join(homeDir, ".mattstack", "rt", "rt.sock"));
}

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

function sessionFilePath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".mattstack", "rt", "chat", "sessions", `${sessionId}.json`);
}

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the real pulse.sh as a subprocess: bare `rt` on PATH resolves to RT_BINARY via rtBinDir's symlink, exactly as the plugin expects it installed. */
async function runPulseHook(homeDir: string, sessionId: string, cwd: string = homeDir): Promise<HookResult> {
  const bunDir = join(process.execPath, "..");
  const input = JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit", cwd });
  const proc = Bun.spawn([PULSE_SH], {
    env: {
      HOME: homeDir,
      PATH: `${rtBinDir}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
      TERM: "xterm-256color",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_API_PORT: String(apiPort),
      RT_CHAT_BACKOFF_MS: "1500",
    },
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return finished(proc);
}

describe.skipIf(!PLUGIN_DIR)("rt chat plugin — pulse.sh against a real compiled rt (e2e)", () => {
  beforeAll(() => {
    rtBinDir = mkdtempSync(join(tmpdir(), "rt-chat-plugin-bin-"));
    mkdirSync(rtBinDir, { recursive: true });
    symlinkSync(RT_BINARY, join(rtBinDir, "rt"));
  });

  afterAll(() => {
    rmSync(rtBinDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
  });

  afterEach(async () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    children.length = 0;
    cleanupHome();
  });

  test("no session file: exit 0, silent", async () => {
    await startDaemonForHome(home);

    const result = await runPulseHook(home, "sess-never-signed-in");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  }, 30_000);

  test("signed in, nothing waiting: exit 0, silent", async () => {
    await startDaemonForHome(home);

    await signIn(home, "sess-quiet", "quiet-one");
    const result = await runPulseHook(home, "sess-quiet");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  }, 30_000);

  test("signed in, a DM and a mention waiting, tail not armed: injects the exact README line", async () => {
    await startDaemonForHome(home);

    const signed = await signIn(home, "sess-waiting", "waiter", ["--room", "crew"]);
    expect(signed.handle).toBe("waiter");

    await finished(runRt(["chat", "dm", signed.handle, "first"], home));
    await finished(runRt(["chat", "dm", signed.handle, "second"], home));
    await finished(runRt(["chat", "post", "crew", `@${signed.handle} heads up`, "--as", "notifier"], home));

    const result = await runPulseHook(home, "sess-waiting");
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    // The literal line the plugin README documents as the waiting-line
    // example (2 DMs + 1 mention, rooms omitted since it's 0).
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "rt chat: 2 DMs, 1 mention are waiting — run rt chat read",
      },
    });
  }, 30_000);

  test("signed in with a live (armed) tail, something waiting: exit 0, silent — the tail is trusted to have delivered it", async () => {
    await startDaemonForHome(home);

    const signed = await signIn(home, "sess-live", "listener");
    const tail = runRt(["chat", "tail", "--session", "sess-live"], home);
    await waitForBuddyArmed(home, signed.handle);

    await finished(runRt(["chat", "dm", signed.handle, "are you there"], home));

    const result = await runPulseHook(home, "sess-live");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    tail.kill();
  }, 30_000);

  test("reclaimed handle: additionalContext carries the reclaimed notice, and pulse deletes the dead session file", async () => {
    await startDaemonForHome(home, {
      RT_CHAT_SESSION_STALE_MS: "50",
      RT_CHAT_TAIL_STALE_MS: "50",
    });

    const a = await signIn(home, "sess-reclaim-a", "x");
    expect(a.handle).toBe("x");
    expect(existsSync(sessionFilePath(home, "sess-reclaim-a"))).toBe(true);

    // Past both thresholds: A's row is now reclaimable (never armed, so its
    // tail heartbeat is already maximally stale — only the session heartbeat
    // needs to age out).
    await Bun.sleep(300);

    const b = await signIn(home, "sess-reclaim-b", "x");
    expect(b.handle).toBe("x"); // reclaimed, not suffixed to "x-2"

    const result = await runPulseHook(home, "sess-reclaim-a");
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "rt chat: your handle was reclaimed while you were away — run `rt chat sign-in` again.",
      },
    });

    expect(existsSync(sessionFilePath(home, "sess-reclaim-a"))).toBe(false);
  }, 30_000);
});
