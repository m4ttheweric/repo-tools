/**
 * e2e: the herd round trip against a real daemon under a test HOME. A
 * worker's `rt herd ask` opens a gate that pushes to the shepherd's
 * subscription inbox; the shepherd's answer nudges the worker's own inbox.
 *
 * herdr is faked on both of its transports, because the daemon reaches it
 * two ways: the unix socket (`session.snapshot`, `events.subscribe`, via
 * herdrRequest) and the CLI binary (`agent:start`'s workspace/tab/pane
 * calls, via defaultHerdrRunner). The inboxes are real unix sockets the
 * daemon's own claude-registry resolver finds under the test HOME, as in
 * e2e/tests/chat-inbox-delivery.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../lib/herdr/__tests__/fake-herdr.ts";

/**
 * The herdr CLI shim from e2e/tests/agent.test.ts. It journals every argv to
 * FAKE_HERDR_LOG and tracks a synthetic workspace/tab table under
 * FAKE_HERDR_STATE, so the workspace the herd creates on its first spawn is
 * still there for the next one. Both env vars ride the DAEMON's spawn env:
 * agent-herdr.ts reads them from the daemon's own process.env.
 */
const FAKE_HERDR = `#!/bin/bash
echo "$@" >> "$FAKE_HERDR_LOG"

STATE="$FAKE_HERDR_STATE"
mkdir -p "$STATE"

find_flag() {
  local flag="$1"; shift
  local i n
  for ((i = 1; i <= $#; i++)); do
    if [ "\${!i}" = "$flag" ]; then
      n=$((i + 1))
      printf '%s' "\${!n}"
      return 0
    fi
  done
}

case "$1 $2" in
  "workspace list")
    if [ -f "$STATE/ws_label" ]; then
      label=$(cat "$STATE/ws_label")
      printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"%s"}]}}' "$label"
    else
      printf '{"result":{"workspaces":[]}}'
    fi
    ;;
  "workspace create")
    label=$(find_flag --label "$@")
    printf '%s' "$label" > "$STATE/ws_label"
    echo 2 > "$STATE/seq"
    : > "$STATE/tabs"
    printf '{"result":{"root_pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1"}}}'
    ;;
  "tab rename")
    printf '%s|%s\\n' "$3" "$4" >> "$STATE/tabs"
    printf '{}'
    ;;
  "tab list")
    entries=""
    if [ -f "$STATE/tabs" ]; then
      while IFS='|' read -r tid tlabel; do
        [ -z "$tid" ] && continue
        if [ -n "$entries" ]; then entries="$entries,"; fi
        entries="$entries{\\"tab_id\\":\\"$tid\\",\\"label\\":\\"$tlabel\\"}"
      done < "$STATE/tabs"
    fi
    printf '{"result":{"tabs":[%s]}}' "$entries"
    ;;
  "tab create")
    label=$(find_flag --label "$@")
    n=$(cat "$STATE/seq" 2>/dev/null || echo 2)
    echo $((n + 1)) > "$STATE/seq"
    tab_id="w1:t$n"
    pane_id="w1:p$n"
    printf '%s|%s\\n' "$tab_id" "$label" >> "$STATE/tabs"
    printf '{"result":{"root_pane":{"pane_id":"%s","tab_id":"%s","workspace_id":"w1"}}}' "$pane_id" "$tab_id"
    ;;
  *)
    printf '{}'
    ;;
esac
`;

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
  runRt(["--daemon"], homeDir, extraEnv);
  await waitForSocket(join(homeDir, ".mattstack", "rt", "rt.sock"));
}

// ─── fakes ───────────────────────────────────────────────────────────────────

/** Socket-side herdr fake: only what the daemon reaches through herdrRequest.
    The events.subscribe reply closes with the connection, so the lifecycle
    stream reconnects on backoff for the life of the test. */
function herdrSocketFake(): ReturnType<typeof fakeHerdr> {
  const handler: FakeHerdrHandler = (method, params) => {
    if (method === "session.snapshot") {
      return { snapshot: { workspaces: [], panes: [{ pane_id: "w1:p1", agent_status: "idle" }] } };
    }
    if (method === "events.subscribe") return { type: "subscribed" };
    return new HerdrFakeError("invalid_request", `${method} ${JSON.stringify(params)}`);
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

// ─── suite ───────────────────────────────────────────────────────────────────

describe("rt herd (e2e)", () => {
  beforeEach(async () => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());
    const herdr = herdrSocketFake();
    stops.push(herdr.stop);

    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const herdrBin = join(binDir, "herdr");
    writeFileSync(herdrBin, FAKE_HERDR, { mode: 0o755 });
    const herdrLog = join(home, "herdr.log");
    writeFileSync(herdrLog, "");
    const herdrState = join(home, "herdr-state");
    mkdirSync(herdrState, { recursive: true });

    await startDaemonForHome(home, {
      HERDR_SOCKET_PATH: herdr.sock,
      HERDR_BIN: herdrBin,
      FAKE_HERDR_LOG: herdrLog,
      FAKE_HERDR_STATE: herdrState,
    });
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    stops.length = 0;
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    children.length = 0;
    cleanupHome();
  });

  test("a worker's ask pushes to the shepherd; the shepherd's answer nudges the worker", async () => {
    const shepherd = startFakeInbox();
    stops.push(shepherd.stop);
    const worker = startFakeInbox();
    stops.push(worker.stop);
    registerFakeInbox(home, "sess-shepherd", shepherd.socketPath);
    registerFakeInbox(home, "sess-worker", worker.socketPath);

    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });

    const started = await finished(runRt(["herd", "start", "--name", "e2e", "--repo", repo, "--json"], home, {
      CLAUDE_CODE_SESSION_ID: "sess-shepherd",
    }));
    expect(started.exitCode).toBe(0);
    const herd = JSON.parse(started.stdout) as { herd: string; room: string };

    // --dir skips provisioning: agent:start still runs, against the CLI shim.
    const brief = join(home, "brief.md");
    writeFileSync(brief, "# e2e brief");
    const spawned = await finished(runRt(
      ["herd", "spawn", "--herd", herd.herd, "--job", "cv-1", "--brief", brief, "--dir", repo, "--json"],
      home,
    ));
    expect(spawned.exitCode).toBe(0);
    expect(JSON.parse(spawned.stdout)).toMatchObject({ job: "cv-1", pane: "w1:p1" });

    // The spawned record minted its own session id; the nudge target is
    // whichever session runs `rt herd ask`, so the worker "is" sess-worker.
    const questions = JSON.stringify([{ id: "q", label: "Which?", multi: false, options: ["a", "b"] }]);
    const asked = await finished(runRt(["herd", "ask", "--questions", questions, "--json"], home, {
      HERD_ID: herd.herd,
      HERD_JOB: "cv-1",
      CLAUDE_CODE_SESSION_ID: "sess-worker",
    }));
    expect(asked.exitCode).toBe(0);
    const gate = (JSON.parse(asked.stdout) as { gate: string }).gate;

    const opened = await waitForFrame(shepherd.frames, (f) => frameContent(f).includes(`[gate] ${gate} is now open`), 10_000);
    expect(frameContent(opened)).toContain("re-read the gate registry");

    const answered = await finished(runRt(
      ["gate", "answer", gate, "--answers", JSON.stringify({ q: "b" }), "--by", "shepherd"],
      home,
    ));
    expect(answered.exitCode).toBe(0);

    await waitForFrame(worker.frames, (f) => frameContent(f).includes(`[gate] ${gate} answered elsewhere`), 10_000);

    const read = await finished(runRt(["herd", "answer", gate, "--json"], home));
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({ status: "answered", answer: { by: "shepherd", answers: { q: "b" } } });

    const status = await finished(runRt(["herd", "status", "--herd", herd.herd, "--json"], home));
    expect(status.exitCode).toBe(0);
    const statusData = JSON.parse(status.stdout) as { jobs: Array<Record<string, unknown>> };
    expect(statusData.jobs[0]).toMatchObject({ name: "cv-1", status: "active", pane: "w1:p1", paneStatus: "idle" });

    const listed = await finished(runRt(["herd", "list"], home));
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trim()).toBe(`${herd.herd}  active  room ${herd.room}  1 jobs`);

    // One active herd, so the id is a lookup the verb can do itself.
    const bare = await finished(runRt(["herd", "status", "--json"], home));
    expect(bare.exitCode).toBe(0);
    expect(JSON.parse(bare.stdout)).toMatchObject({ herd: { id: herd.herd } });
  }, 60_000);
});
