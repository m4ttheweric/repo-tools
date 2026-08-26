import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

/**
 * rt agent e2e ... compiled binary, daemon, and state.db against a fake
 * herdr shim (no real herdr socket, no real claude process).
 *
 * The shim journals every argv to FAKE_HERDR_LOG and tracks a synthetic
 * workspace/tab table under FAKE_HERDR_STATE so the SAME workspace and tab
 * list persist across the file's calls, the way a real herdr daemon would
 * across `rt agent start` then `rt agent resume`. Both env vars ride the
 * DAEMON's spawn env (agent-herdr.ts reads them from the daemon's own
 * process.env, not the client's) ... only the daemon ever shells out to herdr.
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

let apiPort = 0;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

/** Hermetic env mirroring e2e/harness.ts run() ... never ...process.env. */
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

/** Last journaled call whose argv starts with the given herdr subcommand. */
function lastCall(log: string, prefix: string): string | undefined {
  return log.split("\n").filter((l) => l.startsWith(prefix)).pop();
}

describe("rt agent (handoff e2e)", () => {
  let home: string;
  let cleanup: () => void;
  let herdrLog: string;
  let daemon: ReturnType<typeof runRt>;

  beforeAll(async () => {
    ({ path: home, cleanup } = createTestHome());
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const herdrBin = join(binDir, "herdr");
    writeFileSync(herdrBin, FAKE_HERDR, { mode: 0o755 });
    herdrLog = join(home, "herdr.log");
    writeFileSync(herdrLog, "");
    const herdrState = join(home, "herdr-state");
    mkdirSync(herdrState, { recursive: true });

    apiPort = freePort();
    daemon = runRt(["--daemon"], home, {
      HERDR_BIN: herdrBin,
      FAKE_HERDR_LOG: herdrLog,
      FAKE_HERDR_STATE: herdrState,
    });
    await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(`daemon process exited (code ${daemon.exitCode}) right after creating its socket`);
    }
  });

  afterAll(async () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    cleanup();
  });

  test("agent start records a handoff and drives fake herdr", async () => {
    const start = await finished(runRt(["agent", "start", "--repo", home, "--prompt", "hello", "--json"], home));
    expect(start.exitCode).toBe(0);
    const parsed = JSON.parse(start.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.agent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.agent.paneId).toBe("w1:p1");

    const log = readFileSync(herdrLog, "utf8");
    expect(log).toContain("pane run w1:p1");
    expect(log).toContain(`'--session-id' '${parsed.agent.sessionId}'`);

    const show = await finished(runRt(["agent", "show", parsed.agent.id, "--json"], home));
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(show.stdout.trim());
    expect(shown.agent.sessionId).toBe(parsed.agent.sessionId);

    const list = await finished(runRt(["agent", "list", "--repo", home, "--json"], home));
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(list.stdout.trim());
    expect(listed.agents.some((a: { id: string }) => a.id === parsed.agent.id)).toBe(true);
  }, 30_000);

  test("agent resume uses --resume and the ↺ tab", async () => {
    const start = await finished(runRt(["agent", "start", "--repo", home, "--prompt", "hi again", "--json"], home));
    expect(start.exitCode).toBe(0);
    const started = JSON.parse(start.stdout.trim());

    const resume = await finished(runRt(["agent", "resume", started.agent.id, "--json"], home));
    expect(resume.exitCode).toBe(0);
    const resumed = JSON.parse(resume.stdout.trim());
    expect(resumed.agent.sessionId).toBe(started.agent.sessionId);
    // A fresh pane, never the still-open launch tab (the ↺ prefix's guarantee).
    expect(resumed.agent.paneId).not.toBe(started.agent.paneId);

    const log = readFileSync(herdrLog, "utf8");
    const paneRun = lastCall(log, "pane run ");
    const tabCreate = lastCall(log, "tab create ");
    expect(paneRun).toContain(`'--resume' '${started.agent.sessionId}'`);
    expect(paneRun).not.toContain("--session-id");
    expect(tabCreate).toContain("↺ ");
  }, 30_000);

  test("agent start --surface headless without prompt exits 1", async () => {
    const p = await finished(runRt(["agent", "start", "--repo", home, "--surface", "headless"], home));
    expect(p.exitCode).toBe(1);
  }, 15_000);
});
