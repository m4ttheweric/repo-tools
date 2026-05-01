/**
 * rt runner — PTY-based end-to-end smoke test.
 *
 * Drives the compiled TUI via a real pseudo-terminal and asserts what actually
 * renders into @xterm/headless. Replaces the manual "tmux session" smoke test.
 *
 * Why this design — not ink-testing-library:
 *   The runner renders through @rezi-ui/* (a native NAPI addon), not Ink, so
 *   ink-testing-library can't introspect its output. @rezi-ui/node's own tests
 *   use node-pty + @xterm/headless — we mirror that setup.
 *
 * Why a Node helper — not direct node-pty from bun:test:
 *   node-pty's native addon spawns a PTY master fd that needs to be wired into
 *   libuv's event loop. Bun's libuv shim doesn't do that the same way Node
 *   does, so pty.onData never fires under bun. We work around this by having
 *   bun:test spawn a small CJS bridge (`smoke.pty.helper.cjs`) under `node`
 *   that owns the PTY and forwards bytes over its own stdin/stdout.
 *
 * Environment isolation:
 *   Scratch HOME via mkdtempSync. All rt state (~/.rt, runner configs, daemon
 *   socket, pid file) lives under that HOME. A fresh `rt --daemon` is spawned
 *   into it and torn down in afterAll. Tests never touch the real ~/.rt.
 *
 * Golden path:
 *   pre-seed lane + entry → start runner → observe rendered lane card →
 *   press [s] to start → assert daemon state becomes "running" →
 *   press [x] to stop → assert daemon state becomes non-running →
 *   press [q] to quit → PTY exits cleanly (exitCode 0).
 *
 * Gating:
 *   - Skipped when SKIP_PTY_TESTS=1 (CI opt-out).
 *   - Skipped when node-pty, @xterm/headless, or the `node` binary aren't
 *     available — this is a native-build dependency, so silent skip is
 *     preferred over a fatal harness error.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn as cpSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const CLI_PATH = join(REPO_ROOT, "cli.ts");
const PTY_HELPER = join(HERE, "smoke.pty.helper.cjs");

// ─── Skip gates ──────────────────────────────────────────────────────────────

/**
 * Daemon strategy the test will use.
 *
 * - `spawn`: start a fresh daemon in the scratch HOME (CI-friendly default).
 *   Requires port 9401 to be free, since the daemon hardcodes it for its
 *   HTTP/WS API and aborts on EADDRINUSE.
 *
 * - `reuse-real`: the user already has a daemon running (macOS LaunchAgent
 *   loop reinstates it on death, so locally it is effectively always up).
 *   We symlink `scratchHome/.rt/rt.sock` → the real socket so the runner
 *   under test still uses its scratch config directory for everything except
 *   daemon IPC. The real daemon's in-memory process map picks up our
 *   `smoke-<pid>-a` entry; afterAll kills it. Opt-in via
 *   RT_PTY_TEST_ALLOW_REAL_DAEMON=1.
 */
type DaemonMode =
  | { kind: "skip"; reason: string }
  | { kind: "spawn" }
  | { kind: "reuse-real"; realSockPath: string };

function decideDaemonMode(): DaemonMode {
  const realSock = join(process.env.HOME || "/", ".rt", "rt.sock");
  const portBusy = (() => {
    const res = spawnSync("sh", ["-c", "lsof -nP -iTCP:9401 -sTCP:LISTEN 2>/dev/null | tail -n +2"], { encoding: "utf8" });
    return (res.stdout ?? "").trim().length > 0;
  })();
  if (!portBusy) return { kind: "spawn" };
  // Port busy — likely the user's real daemon. Opt-in to reuse it.
  if (process.env.RT_PTY_TEST_ALLOW_REAL_DAEMON === "1" && existsSync(realSock)) {
    return { kind: "reuse-real", realSockPath: realSock };
  }
  return {
    kind: "skip",
    reason:
      "port 9401 in use (real daemon running). Either stop it (`rt daemon stop`) " +
      "or rerun with RT_PTY_TEST_ALLOW_REAL_DAEMON=1 to target the live daemon.",
  };
}

type LiveDaemonMode = Exclude<DaemonMode, { kind: "skip" }>;

function canRunPtyTest(): { ok: true; daemon: LiveDaemonMode } | { ok: false; reason: string } {
  if (process.env.SKIP_PTY_TESTS === "1") return { ok: false, reason: "SKIP_PTY_TESTS=1" };

  // Need `node` on PATH (we spawn the pty bridge under it, not bun).
  const nodeCheck = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (nodeCheck.status !== 0) return { ok: false, reason: "node not on PATH" };

  // node-pty is a native build — silent skip if it didn't install cleanly.
  const ptyBuild = join(REPO_ROOT, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "pty.node");
  if (!existsSync(ptyBuild)) return { ok: false, reason: `node-pty prebuild missing at ${ptyBuild}` };

  // bun install on some systems drops executable bits on spawn-helper. Fix it
  // up idempotently — if we can't, skip. The helper lives next to pty.node.
  const spawnHelper = join(dirname(ptyBuild), "spawn-helper");
  if (existsSync(spawnHelper)) {
    try { chmodSync(spawnHelper, 0o755); } catch { /* ignore */ }
  }

  if (!existsSync(join(REPO_ROOT, "node_modules", "@xterm", "headless"))) {
    return { ok: false, reason: "@xterm/headless not installed" };
  }

  const daemon = decideDaemonMode();
  if (daemon.kind === "skip") return { ok: false, reason: daemon.reason };
  return { ok: true, daemon };
}

const SKIP = canRunPtyTest();

// ─── Test fixtures ───────────────────────────────────────────────────────────

let scratchHome: string;
let daemonProc: ChildProcess | null = null;

// Lane/entry IDs — derived from the test process's pid so that when this test
// is pointed at a live daemon (RT_PTY_TEST_ALLOW_REAL_DAEMON=1), it can't
// collide with any real lane the user happens to have.
const LANE_ID = `smk${process.pid}`;
const ENTRY_ID = "a";
const ENTRY_PROCESS_ID = `${LANE_ID}-${ENTRY_ID}`; // matches entryWindowName()
const PROXY_ID = `proxy-${LANE_ID}`;
// Canonical port — within the ephemeral range, pid-derived so concurrent
// runs of this test don't collide on it either.
const CANONICAL_PORT = 40000 + (process.pid % 10_000);

/**
 * Send a raw HTTP request to the daemon's Unix socket using Bun's fetch
 * `unix` option. Returns the parsed JSON response, or null on any error.
 */
async function daemonCall(sockPath: string, cmd: string, payload?: Record<string, unknown>): Promise<any> {
  try {
    const hasBody = payload && Object.keys(payload).length > 0;
    const res = await fetch(`http://localhost/${cmd}`, {
      unix: sockPath,
      method: hasBody ? "POST" : "GET",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(2000),
    } as RequestInit);
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 10_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(!SKIP.ok)(`rt runner PTY smoke${SKIP.ok ? "" : ` (skipped: ${(SKIP as any).reason})`}`, () => {
  beforeAll(async () => {
    if (!SKIP.ok) return;

    scratchHome = mkdtempSync(join(tmpdir(), "rt-runner-pty-smoke-"));

    // ── Pre-seed repo index ───────────────────────────────────────────────
    // getKnownRepos() reads ~/.rt/repos.json. We write a fake entry so the
    // runner has a valid repoName to render against. The dataDir under the
    // repo doesn't need to exist for rendering — only for worktree walks,
    // which the smoke path doesn't touch.
    const rtDir = join(scratchHome, ".rt");
    mkdirSync(rtDir, { recursive: true });

    // ── Create a minimal git repo so the runner's initial enrichBranches
    //    walk doesn't blow up. It just needs a .git directory.
    const fakeRepoPath = join(scratchHome, "fake-repo");
    mkdirSync(fakeRepoPath, { recursive: true });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: fakeRepoPath, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "smoke@test.local");
    git("config", "user.name", "smoke");
    git("commit", "--allow-empty", "-m", "init", "-q");

    writeFileSync(join(rtDir, "repos.json"), JSON.stringify({
      "fake-repo": fakeRepoPath,
    }, null, 2));

    // ── Pre-seed runner config ───────────────────────────────────────────
    const runnersDir = join(rtDir, "runners");
    mkdirSync(runnersDir, { recursive: true });
    const smokeConfigPath = join(runnersDir, "smoke.json");
    // LaneConfig[] — one lane, one singular persisted entry. The commandTemplate runs
    // /bin/sleep so the daemon has a real long-lived process to manage.
    writeFileSync(smokeConfigPath, JSON.stringify([
      {
        id: LANE_ID,
        canonicalPort: CANONICAL_PORT,
        repoName: "fake-repo",
        mode: "warm",
        activeWorktree: fakeRepoPath,
        entry: {
          id: ENTRY_ID,
          targetDir: fakeRepoPath,
          packageLabel: "smoke",
          worktree: fakeRepoPath,
          branch: "main",
          ephemeralPort: 10000 + (process.pid % 1000),
          // The commandTemplate is what the daemon actually executes. /bin/sleep
          // is trivially reproducible — no package manager, no network, no disk.
          commandTemplate: "/bin/sleep 30",
        },
      },
    ], null, 2));

    // daemon.json so isDaemonInstalled() returns true (keeps rt from trying
    // to start the post-install flow).
    writeFileSync(join(rtDir, "daemon.json"), JSON.stringify({
      installed: true,
      installedAt: new Date().toISOString(),
      mode: "smappservice",
    }, null, 2));

    const daemon = SKIP.daemon;
    if (daemon.kind === "spawn") {
      daemonProc = cpSpawn(process.execPath, [CLI_PATH, "--daemon"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: scratchHome,
          RT_SKIP_SETUP: "1",
          CI: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const sockPath = join(rtDir, "rt.sock");
      await waitFor(
        "daemon socket ready",
        async () => {
          const res = await daemonCall(sockPath, "ping");
          return res?.ok ? res : null;
        },
        10_000,
      );
    } else {
      symlinkSync(daemon.realSockPath, join(rtDir, "rt.sock"));
      const ping = await daemonCall(join(rtDir, "rt.sock"), "ping");
      if (!ping?.ok) throw new Error("real daemon ping failed via symlink");
    }
  }, 20_000);

  afterAll(async () => {
    if (!SKIP.ok) return;

    // Drain any still-live daemon-managed processes we created.
    if (scratchHome) {
      const sockPath = join(scratchHome, ".rt", "rt.sock");
      if (existsSync(sockPath)) {
        try { await daemonCall(sockPath, "process:kill", { id: ENTRY_PROCESS_ID }); } catch { /* ignore */ }
        try { await daemonCall(sockPath, "proxy:kill", { id: PROXY_ID }); } catch { /* ignore */ }
        try { await daemonCall(sockPath, "group:remove", { id: LANE_ID }); } catch { /* ignore */ }
      }
    }

    if (daemonProc) {
      try { daemonProc.kill("SIGTERM"); } catch { /* ignore */ }
      await sleep(300);
      try { daemonProc.kill("SIGKILL"); } catch { /* ignore */ }
    }

    if (scratchHome) {
      try { rmSync(scratchHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test("start runner → assert rendered lane → start entry → stop entry → quit", async () => {
    // Dynamic imports so the module isn't loaded under skipped runs.
    const { Terminal } = await import("@xterm/headless");
    const sockPath = join(scratchHome, ".rt", "rt.sock");

    // ── Launch PTY helper ─────────────────────────────────────────────────
    const helper = cpSpawn("node", [PTY_HELPER], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Accumulate helper-side error chatter for diagnostics if the test fails.
    let helperStderr = "";
    helper.stderr!.setEncoding("utf8");
    helper.stderr!.on("data", (chunk: string) => { helperStderr += chunk; });

    // Fatal-error guard: if the helper exits before we're done, fail loudly
    // instead of leaving the test hanging at a later waitFor.
    let helperExited = false;
    let helperExitInfo: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    helper.on("exit", (code, signal) => {
      helperExited = true;
      helperExitInfo = { code, signal };
    });

    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });

    // Events from helper: line-delimited JSON. Buffer across chunk boundaries.
    type HelperEvent =
      | { ev: "spawned"; pid: number }
      | { ev: "data"; data: string } // base64
      | { ev: "exit"; code: number | null; signal: string | null }
      | { ev: "error"; message: string };

    let stdoutBuf = "";
    const queue: HelperEvent[] = [];
    const waiters: Array<(ev: HelperEvent) => void> = [];

    helper.stdout!.setEncoding("utf8");
    helper.stdout!.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as HelperEvent;
          if (ev.ev === "data") {
            // Feed pty bytes into xterm synchronously (write() is synchronous
            // in headless; the optional callback fires once writeBuffer drains).
            term.write(Buffer.from(ev.data, "base64"));
          }
          if (waiters.length > 0) {
            waiters.shift()!(ev);
          } else {
            queue.push(ev);
          }
        } catch { /* malformed frame — ignore */ }
      }
    });

    function nextEvent(predicate: (ev: HelperEvent) => boolean, timeoutMs = 5000): Promise<HelperEvent> {
      return new Promise((resolve, reject) => {
        // Drain queued events first — if any already satisfies the predicate
        // take it; otherwise keep them queued for later consumers.
        for (let i = 0; i < queue.length; i++) {
          if (predicate(queue[i]!)) {
            const [match] = queue.splice(i, 1);
            resolve(match!);
            return;
          }
        }
        // Re-insert the waiter on every event so subsequent non-matching frames
        // don't discard the pending resolver.
        const check = (ev: HelperEvent) => {
          if (predicate(ev)) resolve(ev);
          else waiters.push(check);
        };
        waiters.push(check);
        setTimeout(() => reject(new Error(`nextEvent timed out after ${timeoutMs}ms`)), timeoutMs);
      });
    }

    function sendHelper(op: object): void {
      helper.stdin!.write(JSON.stringify(op) + "\n");
    }

    // Read current terminal buffer as a newline-joined string (active only).
    // Trim trailing blank lines for readability in error messages.
    function bufferText(): string {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        const l = buf.getLine(i + buf.viewportY);
        lines.push(l ? l.translateToString(true) : "");
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n");
    }

    async function waitForBuffer(needle: string | RegExp, timeoutMs = 8000, label = String(needle)): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (helperExited) {
          throw new Error(
            `PTY helper exited early (code=${helperExitInfo.code} signal=${helperExitInfo.signal}) ` +
            `while waiting for ${label}\n` +
            `stderr: ${helperStderr}\n` +
            `buffer:\n${bufferText()}`,
          );
        }
        const text = bufferText();
        const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
        if (hit) return text;
        await sleep(150);
      }
      throw new Error(
        `waitForBuffer(${label}) timed out after ${timeoutMs}ms\n` +
        `stderr: ${helperStderr}\n` +
        `buffer:\n${bufferText()}`,
      );
    }

    try {
      // ── Spawn the runner inside the PTY ──────────────────────────────────
      // TMUX is set to a bogus value so the runner's auto-re-exec guard in
      // showRunner() doesn't try to spawn a real tmux session. The runner
      // will still try to call tmux for pane management, but those calls
      // fail silently via spawnSync and the UI renders regardless.
      sendHelper({
        op: "spawn",
        file: process.execPath, // bun
        args: [CLI_PATH, "runner", "--runner=smoke"],
        cwd: REPO_ROOT,
        cols: 120,
        rows: 40,
        env: {
          ...process.env,
          HOME: scratchHome,
          RT_SKIP_SETUP: "1",
          CI: "true",
          TMUX: "/tmp/fake-tmux-for-smoke-test", // bypass tmux re-exec guard
          TMUX_PANE: "%0",
          TERM: "xterm-256color",
          // Rezi is sensitive to stdout being a real TTY; the pty gives us that.
        },
      });

      const spawned = await nextEvent((ev) => ev.ev === "spawned" || ev.ev === "error", 5000);
      if (spawned.ev === "error") throw new Error(`helper failed to spawn rt: ${spawned.message}`);

      // ── Checkpoint 1: initial render shows the pre-seeded lane card ──────
      // Lane title format (runner.tsx:1268):
      //   ` LANE <id>  ·  fake-repo  ·  :<port>  ·  warm `
      // We match on loose regexes so padding / box-drawing doesn't break it.
      const laneRegex = new RegExp(`LANE\\s+${LANE_ID}`);
      const portRegex = new RegExp(`:${CANONICAL_PORT}`);
      await waitForBuffer(laneRegex, 10_000, `lane card with id ${LANE_ID}`);
      const initialText = bufferText();
      expect(initialText).toMatch(laneRegex);
      expect(initialText).toMatch(/fake-repo/);
      expect(initialText).toMatch(portRegex);
      // Entry label — EntryRow in "uniform" mode shows branchLabel (e.g. "main")
      // or the entry id. Default command label includes `smoke · ...` via
      // entryCommandLabel().
      expect(initialText).toMatch(/smoke/);

      // ── Checkpoint 2: entry starts as "stopped" per the daemon ───────────
      // The UI shows an icon (○), not the word — assert on daemon state
      // directly instead of scraping the icon.
      const initial = await daemonCall(sockPath, "process:states");
      expect(initial?.ok).toBe(true);
      // The entry either isn't in the map yet (daemon's default) or is stopped.
      const initialState = (initial?.data as Record<string, string>)?.[ENTRY_PROCESS_ID];
      expect(initialState === undefined || initialState === "stopped").toBe(true);

      // ── Checkpoint 3: [s] starts the entry ───────────────────────────────
      // Default-mode `s` for a stopped entry dispatches { type: "spawn" } →
      // daemonQuery("process:spawn", ...). Daemon state becomes "running"
      // within one poll cycle (~2s). We allow up to 10s for CI jitter.
      sendHelper({ op: "input", data: "s" });

      await waitFor(
        `entry ${ENTRY_PROCESS_ID} running`,
        async () => {
          const res = await daemonCall(sockPath, "process:states");
          const st = (res?.data as Record<string, string>)?.[ENTRY_PROCESS_ID];
          return st === "running" ? st : null;
        },
        10_000,
      );

      // ── Checkpoint 4: [x] stops the entry ────────────────────────────────
      // The daemon transitions through "stopping" → "stopped" (clean kill) or
      // "crashed" (non-zero exit from the signal). Either terminal state
      // satisfies the "process is no longer running" assertion.
      sendHelper({ op: "input", data: "x" });

      await waitFor(
        `entry ${ENTRY_PROCESS_ID} stopped or crashed`,
        async () => {
          const res = await daemonCall(sockPath, "process:states");
          const st = (res?.data as Record<string, string>)?.[ENTRY_PROCESS_ID];
          return st === "stopped" || st === "crashed" ? st : null;
        },
        10_000,
      );

      // ── Checkpoint 5: [q] quits cleanly ──────────────────────────────────
      sendHelper({ op: "input", data: "q" });

      const exitEv = await nextEvent((ev) => ev.ev === "exit", 10_000);
      if (exitEv.ev !== "exit") throw new Error("expected exit event");
      expect(exitEv.code).toBe(0);
    } finally {
      if (!helperExited) {
        // Hard kill in case q didn't propagate (e.g. test failed mid-flight).
        try { sendHelper({ op: "kill" }); } catch { /* ignore */ }
        try { helper.stdin!.end(); } catch { /* ignore */ }
        try { helper.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
  }, 60_000);
});
