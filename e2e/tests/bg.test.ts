/**
 * e2e: the background server's lifecycle, refs, focus-as-attend, and
 * claim-gated stop, against a real daemon under a test HOME. Follows
 * e2e/tests/herd.test.ts's fake-herdr recipe (a CLI-shim binary that
 * journals every argv), extended with a `server` mode: the same fake
 * binary, invoked by lib/daemon/bg-service.ts's own nohup mechanics, execs
 * a tiny Bun script that opens a REAL unix socket at the bg session's fixed
 * path and answers the herdr JSON-RPC methods the daemon needs (see
 * docs/superpowers/specs/2026-09-09-background-server-design.md).
 *
 * There is no `rt bg` CLI verb (spec: "no compatibility shims beyond
 * bare-ref backcompat"), so the claim-gated stop scenario drives `bg:stop`
 * / `bg:release` through the rt-client wrappers directly against the
 * daemon's own socket, the same transport `rt` itself uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { bgRelease, bgStop, formatPaneRef } from "../../packages/rt-client/src/index.ts";

/**
 * The fake herdr binary: a bash shim, same journal/state convention as
 * herd.test.ts's FAKE_HERDR, extended with `pane get` (attend's terminal-id
 * lookup) and `session stop`, plus a `server` branch bg-service.ts's own
 * nohup mechanics invoke -- it snapshots the spawn's own $PATH (the
 * login-shell probe result, not the daemon's) to FAKE_HERDR_SERVER_ENV_FILE,
 * then execs into __SERVER_JS__ (a separate Bun script, kept as plain JS so
 * there is no extension-based loader ambiguity) to open the real bg socket.
 * __BUN_BIN__ is substituted with this test process's own `process.execPath`
 * at write time: the spawn's seeded env is a REAL zsh -lc login-shell
 * capture, not the test's synthetic PATH, so resolving `bun` by shebang PATH
 * lookup would be at the mercy of the operator's own shell rc files. Baking
 * in an absolute bun path sidesteps that -- it tests the daemon's own
 * seeding logic, not bun's discoverability.
 */
const FAKE_HERDR_TEMPLATE = `#!/bin/bash
echo "$@" >> "$FAKE_HERDR_LOG"

if [ "$1" = "server" ]; then
  if [ -n "$FAKE_HERDR_SERVER_ENV_FILE" ]; then
    printf '%s\\n' "$PATH" > "$FAKE_HERDR_SERVER_ENV_FILE"
  fi
  exec "__BUN_BIN__" "__SERVER_JS__"
fi

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
  "pane get")
    pane_id="$3"
    printf '{"result":{"pane":{"terminal_id":"term-%s"}}}' "$pane_id"
    ;;
  "session stop")
    printf '{"result":{"stopped":true}}'
    ;;
  *)
    printf '{}'
    ;;
esac
`;

/**
 * The bg session's socket fake: a real unix-socket JSON-RPC server (herdr's
 * wire contract -- one newline-delimited request per connection, the server
 * closes after replying), bound to the FIXED path bg-service.ts computes
 * (passed in via FAKE_HERDR_BG_SOCK, known ahead of time by the test).
 * Kept as plain JS (no TS syntax) since it is invoked by an absolute-path
 * shebang exec, not `bun run`, so there is no build step to strip types.
 */
const BG_SERVER_JS = `
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { dirname } from "path";

const sock = process.env.FAKE_HERDR_BG_SOCK;
const pidFile = process.env.FAKE_HERDR_SERVER_PID_FILE;
const socketLog = process.env.FAKE_HERDR_SOCKET_LOG;
const peekText = process.env.FAKE_HERDR_PEEK_TEXT || "bg peek content";

mkdirSync(dirname(sock), { recursive: true });
if (pidFile) writeFileSync(pidFile, String(process.pid));

function logMethod(method) {
  if (!socketLog) return;
  try { appendFileSync(socketLog, method + "\\n"); } catch {}
}

const buffers = new Map();

Bun.listen({
  unix: sock,
  socket: {
    data(socket, chunk) {
      const prev = buffers.get(socket) || "";
      const buf = prev + chunk.toString();
      const nl = buf.indexOf("\\n");
      if (nl < 0) { buffers.set(socket, buf); return; }
      buffers.delete(socket);
      const line = buf.slice(0, nl);
      let id = "";
      let reply;
      try {
        const req = JSON.parse(line);
        id = req.id;
        logMethod(req.method);
        if (req.method === "session.snapshot") {
          reply = JSON.stringify({ id, result: { snapshot: { workspaces: [], panes: [] } } });
        } else if (req.method === "events.subscribe") {
          reply = JSON.stringify({ id, result: { type: "subscribed" } });
        } else if (req.method === "agent.get" || req.method === "agent.wait") {
          reply = JSON.stringify({ id, result: { agent: { agent: "claude", agent_status: "idle", pane_id: "w1:p1" } } });
        } else if (req.method === "agent.prompt") {
          reply = JSON.stringify({ id, result: { type: "ok" } });
        } else if (req.method === "pane.read") {
          reply = JSON.stringify({ id, result: { read: { text: peekText } } });
        } else {
          reply = JSON.stringify({ id, result: {} });
        }
      } catch (err) {
        reply = JSON.stringify({ id, error: { code: "internal_error", message: String(err) } });
      }
      socket.write(reply + "\\n");
      socket.end();
    },
    close(socket) { buffers.delete(socket); },
    error() {},
  },
});
`;

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

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
let serverPidFile = "";

const bunDir = join(process.execPath, "..");
const daemonPath = `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`;

function runRt(args: string[], homeDir: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([RT_BINARY, ...args], {
    env: {
      HOME: homeDir,
      PATH: daemonPath,
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

describe("rt background server (e2e)", () => {
  let herdrLog = "";
  let socketLog = "";
  let serverEnvFile = "";

  beforeEach(async () => {
    ({ path: home, cleanup: cleanupHome } = createTestHome());

    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const herdrBin = join(binDir, "herdr");
    herdrLog = join(home, "herdr.log");
    writeFileSync(herdrLog, "");
    const herdrState = join(home, "herdr-state");
    mkdirSync(herdrState, { recursive: true });

    const serverJsPath = join(home, "bg-server-fake.js");
    writeFileSync(serverJsPath, BG_SERVER_JS);
    serverEnvFile = join(home, "bg-server-env.txt");
    serverPidFile = join(home, "bg-server.pid");
    socketLog = join(home, "bg-socket.log");
    writeFileSync(socketLog, "");

    const fakeHerdrScript = FAKE_HERDR_TEMPLATE
      .replaceAll("__BUN_BIN__", process.execPath)
      .replaceAll("__SERVER_JS__", serverJsPath);
    writeFileSync(herdrBin, fakeHerdrScript, { mode: 0o755 });

    await startDaemonForHome(home, {
      HERDR_BIN: herdrBin,
      FAKE_HERDR_LOG: herdrLog,
      FAKE_HERDR_STATE: herdrState,
      FAKE_HERDR_BG_SOCK: join(home, ".config", "herdr", "sessions", "bg", "herdr.sock"),
      FAKE_HERDR_SERVER_ENV_FILE: serverEnvFile,
      FAKE_HERDR_SERVER_PID_FILE: serverPidFile,
      FAKE_HERDR_SOCKET_LOG: socketLog,
      FAKE_HERDR_PEEK_TEXT: "bg peek marker 7f3a",
    });
  });

  afterEach(async () => {
    // The bg "server" mode is nohup'd into its own process group by design
    // (it must survive a daemon restart) -- Bun.spawn's own child handle
    // never reaches it, so killing it back is only possible via the pid it
    // wrote for itself.
    if (serverPidFile && existsSync(serverPidFile)) {
      const raw = readFileSync(serverPidFile, "utf8").trim();
      const pid = Number(raw);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    children.length = 0;
    cleanupHome();
  });

  test("bg lifecycle: ensure via --bg, peek/send/focus, claim-gated stop", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });

    // --- 1: `rt agent start --bg` ensures the bg server and lands on it ---
    const started = await finished(runRt(
      ["agent", "start", "--repo", repo, "--prompt", "hello from bg e2e", "--bg", "--json"],
      home,
    ));
    expect(started.exitCode).toBe(0);
    const startData = JSON.parse(started.stdout) as { agent: { id: string; paneId?: string; sessionId: string } };
    const agentId = startData.agent.id;
    const bgRef = formatPaneRef("w1:p1", "bg");
    expect(startData.agent.paneId).toBe(bgRef);

    // The spawn's env is the login-shell probe result, not the PATH the
    // daemon itself runs under.
    expect(existsSync(serverEnvFile)).toBe(true);
    const spawnPath = readFileSync(serverEnvFile, "utf8").trim();
    expect(spawnPath.length).toBeGreaterThan(0);
    expect(spawnPath).not.toBe(daemonPath);

    // The journal's first entry is the server start itself: ensure() runs
    // before any workspace/tab CLI call in the herdr launch.
    const journalLines = readFileSync(herdrLog, "utf8").trim().split("\n");
    expect(journalLines[0]).toBe("server");

    // --- 5 (scoped to the agent record; a full hidden herd round trip is
    // out of scope here per the task brief): `rt agent show --json` echoes
    // the same bg: ref back on a fresh read, not just the start response. ---
    const shown = await finished(runRt(["agent", "show", agentId, "--json"], home));
    expect(shown.exitCode).toBe(0);
    const shownData = JSON.parse(shown.stdout) as { agent: { paneId?: string } };
    expect(shownData.agent.paneId).toBe(bgRef);

    // --- 2: peek and send resolve the bg: ref to the bg socket ---
    const peeked = await finished(runRt(["pane", "peek", bgRef, "--json"], home));
    expect(peeked.exitCode).toBe(0);
    const peekData = JSON.parse(peeked.stdout) as { lines: string[] };
    expect(peekData.lines.join("\n")).toContain("bg peek marker 7f3a");

    const sent = await finished(runRt(["pane", "send", bgRef, "--text", "hi there", "--json"], home));
    expect(sent.exitCode).toBe(0);
    const sendData = JSON.parse(sent.stdout) as { paneId: string; delivered: string };
    expect(sendData.paneId).toBe(bgRef);
    expect(sendData.delivered).toBe("accepted");

    // Both calls were answered over the bg socket specifically: no other
    // fake in this test speaks the herdr socket protocol at all, so a
    // successful reply is proof of the bg socket, not just "some socket".
    const socketMethods = readFileSync(socketLog, "utf8");
    expect(socketMethods).toContain("pane.read");
    expect(socketMethods).toContain("agent.get");
    expect(socketMethods).toContain("agent.prompt");

    // --- 3: focus on a bg: ref forks to the attend flow, never the tray ---
    const focused = await finished(runRt(
      ["pane", "focus", bgRef],
      home,
      { HERDR_WORKSPACE_ID: "w-caller" },
    ));
    expect(focused.exitCode).toBe(0);
    // Success here is itself proof the tray branch was never taken: this
    // test HOME has no tray socket, so falling through to the tray path
    // would fail with "tray unavailable" instead of the attend flow's own
    // ok result.
    expect(focused.stdout).toContain(`attached ${bgRef}`);
    expect(focused.stdout).toContain("ctrl+b q");

    const journalAfterFocus = readFileSync(herdrLog, "utf8");
    expect(journalAfterFocus).toContain("terminal attach");
    expect(journalAfterFocus).toContain("--takeover");

    // --- 4: bg:stop is refused while the agent's claim lives, naming it;
    // release clears it, then stop succeeds. No `rt bg` CLI verb exists
    // (spec: no shims beyond bare-ref backcompat), so this drives the
    // daemon socket directly through the same rt-client wrappers `rt`
    // itself is built on. ---
    const rtSock = join(home, ".mattstack", "rt", "rt.sock");
    const refused = await bgStop({ sockPath: rtSock });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`agent:${agentId}`);

    const released = await bgRelease({ claim: `agent:${agentId}` }, { sockPath: rtSock });
    expect(released.ok).toBe(true);
    expect(released.data?.released).toBe(true);

    const stopped = await bgStop({ sockPath: rtSock });
    expect(stopped.ok).toBe(true);
    expect(stopped.data?.stopped).toBe(true);
  }, 60_000);
});
