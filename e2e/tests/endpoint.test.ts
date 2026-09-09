/**
 * RT-28 e2e — the just-works loop, end to end against a real compiled daemon.
 *
 * Everything here runs inside one hermetic test HOME with its own foreground
 * daemon on a per-run free `RT_API_PORT` (the RT-45 pattern from
 * `events.test.ts`, copied deliberately: freePort(), child tracking, reaping
 * in afterAll).
 *
 * The scenario is the whole RT-28 contract in one file:
 *
 *   install shims → intercepted `fakestart go` in worktree A gets a port and
 *   an injected `--keep` flag → a SECOND worktree of the same repo (matched by
 *   remote, not by index membership) gets the NEXT port while A's server is
 *   genuinely LISTENING → re-running in A is sticky → with the daemon dead the
 *   command still runs, unmodified, with a stderr passthrough notice → after a
 *   restart the claim is still readable via `rt endpoint lookup` → and
 *   `rt intercept status` / `rt verify` both report the shim installed and
 *   current.
 *
 * The "second worktree while A is listening" step is load-bearing: it drives
 * the live-listener branch of `defaultProbes` (a claim whose owning process is
 * long gone but whose port is still bound), which no unit test can reach.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";
import { machineSettingsPath } from "../../lib/rt-paths.ts";

/**
 * The intercepts cache moved off `intercepts.json` onto state.db's `kv`
 * table (ns='intercepts', k='rules') — the daemon/CLI subprocess under test
 * is the sole writer, so this test process only ever reads.
 */
function readInterceptRulesRow(testHome: string): { rules: { command: string; repo: string; repoRemote: string | null }[] } | null {
  const db = new Database(join(testHome, ".mattstack", "rt", "state.db"));
  try {
    const row = db.query("SELECT v FROM kv WHERE ns = 'intercepts' AND k = 'rules'").get() as { v: string } | null;
    return row ? JSON.parse(row.v) : null;
  } finally {
    db.close();
  }
}

// ─── Shared helpers (mirroring e2e/tests/events.test.ts) ─────────────────────

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

/**
 * The bunfig preload (test-setup.ts) already repointed THIS process's HOME to
 * its own throwaway temp dir before any module loaded, so machineSettingsPath()
 * needs a further, temporary swap to `fakeHome` to compute the path for the
 * fixture under test rather than that preload dir. try/finally so a throwing
 * constructor can't leave later tests in this same process running against
 * the fixture's HOME; `delete` (not `= undefined`) because an unset
 * `outerHome` must not stringify back in as `"undefined"`.
 */
function withHome<T>(fakeHome: string, fn: () => T): T {
  const outerHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn();
  } finally {
    if (outerHome === undefined) delete process.env.HOME;
    else process.env.HOME = outerHome;
  }
}

/** Bind-probe, same shape as the allocator's real `canBind`. */
function canBind(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * The role pool has to be a block of ports that are genuinely free on THIS
 * machine, or the allocator's bind-probe would (correctly) skip past the first
 * one and the "first port in the pool" assertions would fail for a reason that
 * has nothing to do with rt. 42100 is the spec's example base; if something
 * local already owns part of that block we walk up rather than fail.
 */
function findFreePoolBase(size = 6): number {
  for (let base = 42100; base <= 42400; base += 10) {
    let ok = true;
    for (let p = base; p < base + size; p++) {
      if (!canBind(p)) { ok = false; break; }
    }
    if (ok) return base;
  }
  throw new Error("no free block of pool ports in 42100-42400 — something local is squatting the range");
}

/** True once something answers HTTP on `port` (the fake server replies "ok"). */
async function isServing(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForServing(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await isServing(port))) {
    if (Date.now() > deadline) throw new Error(`nothing started serving on port ${port} within ${timeoutMs}ms`);
    await Bun.sleep(150);
  }
}

// ─── Test state ──────────────────────────────────────────────────────────────

let apiPort = 0;
let home = "";
let cleanup: () => void = () => {};
let tmpBin = "";
let repoMain = "";
let repoB = "";
let poolBase = 0;
let daemon: ReturnType<typeof Bun.spawn>;

const REPO_NAME = "endpoint-repo";
const REMOTE_URL = "git@github.com:rt-test/endpoint-repo.git";
// What buildInterceptRules bakes into rule.repo — the serialized identity the
// remote normalizes to, which endpoint:claim's payload requires verbatim.
const REPO_RULE_KEY = "remote:github.com%2Frt-test%2Fendpoint-repo";

/** Every spawned child, reaped in afterAll even if an assertion aborts mid-test. */
const children: Array<ReturnType<typeof Bun.spawn>> = [];
/** Background fake servers (backgrounded by the fakestart script, so not our children). */
const serverPids: number[] = [];

/**
 * Hermetic child env. PATH order is the whole point: `~/.local/bin` (where
 * `rt intercept install` writes the shim) MUST come before `tmpBin` (where the
 * real `fakestart` lives) so the shim wins the invocation — and `resolveRealBinary`
 * must then find the real one behind it. The rt binary's own directory is on
 * PATH too because the generated shim execs a bare `rt`.
 *
 * `/usr/sbin` is not decoration: `lsof` lives there on macOS, and the
 * allocator's listener probe (and the whole port scanner) spawns a bare
 * `lsof`. Leaving it off would silently give the daemon an empty listener set
 * — every claim would look dead and the sticky/next-port behaviour would be
 * untestable. The real daemon runs under launchd, whose default PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) includes it.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const bunDir = join(process.execPath, "..");
  return {
    HOME: home,
    PATH: [join(home, ".local", "bin"), tmpBin, join(RT_BINARY, ".."), bunDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TERM: "xterm-256color",
    RT_SKIP_SETUP: "1",
    CI: "true",
    RT_API_PORT: String(apiPort),
    ...extra,
  };
}

function spawnTracked(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? childEnv(),
    cwd: opts.cwd ?? home,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
}

function runRt(args: string[], cwd?: string) {
  return spawnTracked([RT_BINARY, ...args], { cwd });
}

/**
 * Runs `fakestart <args>` through `/bin/sh` so the SHELL resolves the command
 * name against our PATH — spawning the shim by absolute path would prove
 * nothing about PATH order (and `Bun.spawn` resolves bare names against the
 * test runner's own start-time PATH, not the env we hand the child).
 */
function runFakestart(cwd: string, args: string, extraEnv: Record<string, string> = {}) {
  return spawnTracked(["/bin/sh", "-c", `fakestart ${args}`], { cwd, env: childEnv(extraEnv) });
}

async function finished(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/** `git init` + a fake origin. Both worktrees share the remote; only one is indexed. */
function makeRepo(name: string): string {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  git(["init", "-q"], path);
  git(["remote", "add", "origin", REMOTE_URL], path);
  return path;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("rt endpoint / intercept (just-works e2e)", () => {
  beforeAll(async () => {
    apiPort = freePort();
    poolBase = findFreePoolBase();
    ({ path: home, cleanup } = createTestHome());

    // The intercepted "real" binary: prints what it was given, and (only when
    // handed a pidfile path) leaves a background HTTP server bound to $PORT so
    // a later allocation sees a genuinely LISTENING port.
    tmpBin = join(home, "testbin");
    mkdirSync(tmpBin, { recursive: true });
    const fakestart = join(tmpBin, "fakestart");
    writeFileSync(
      fakestart,
      [
        "#!/bin/sh",
        'echo "PORT=$PORT ARGS=$*"',
        'if [ -n "$PORT" ] && [ -n "$RT_FAKESTART_PIDFILE" ]; then',
        "  bun -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(\"ok\") })' >/dev/null 2>&1 &",
        '  echo $! > "$RT_FAKESTART_PIDFILE"',
        "fi",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakestart, 0o755);

    repoMain = makeRepo("repo-main");
    repoB = makeRepo("repo-b");

    const rtDir = join(home, ".mattstack", "rt");
    mkdirSync(join(rtDir, "repos", REPO_NAME), { recursive: true });
    // Only repo-main is indexed. repo-b is matched purely by remote URL —
    // that's the "any worktree of a registered repo" contract.
    writeFileSync(join(rtDir, "repos.json"), JSON.stringify({ [REPO_NAME]: repoMain }, null, 2));

    // rt.roles/rt.intercepts live in the machine store now, keyed by the
    // IDENTITY the remote normalizes to (repo-main and repo-b share one
    // remote, so they share one identity — the same "matched by remote, not
    // by index membership" contract as before, just resolved through the
    // settings resolver instead of the (now-gone) per-repo config.json).
    const identity = "github.com/rt-test/endpoint-repo";
    mkdirSync(join(home, ".mattstack"), { recursive: true });
    // Pin machineKey() before computing machineSettingsPath() — hostname
    // slugs vary per CI host, and this test's path must be deterministic.
    writeFileSync(join(home, ".mattstack", "machine-key"), "e2e-endpoint-machine");
    const machineStorePath = withHome(home, () => machineSettingsPath());
    mkdirSync(dirname(machineStorePath), { recursive: true });
    writeFileSync(
      machineStorePath,
      JSON.stringify(
        {
          repos: {
            [identity]: {
              "rt.roles": {
                web: {
                  pool: [{ from: poolBase, to: poolBase + 5 }],
                  env: { PORT: "${port}" },
                  preserveEnv: ["KEEP_*"],
                },
              },
              "rt.intercepts": [
                {
                  command: "fakestart",
                  matches: [
                    {
                      cwdGlob: ".",
                      role: "web",
                      argInject: { afterArg: "go", template: "--keep=${envKeys}", skipIfArgPresent: "--keep" },
                    },
                  ],
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    daemon = runRt(["--daemon"]);
    await waitForSocket(join(rtDir, "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${daemon.exitCode}) right after creating its socket — ` +
          `port ${apiPort} collision or daemon boot crash; check the daemon's stderr.`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const pid of serverPids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    cleanup();
  });

  test("rt intercept install writes the shim and the rules file", async () => {
    const res = await finished(runRt(["intercept", "install", "--json"]));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.installed).toEqual(["fakestart"]);
    expect(out.rules).toBe(1);

    const shim = join(home, ".local", "bin", "fakestart");
    expect(existsSync(shim)).toBe(true);
    expect(readFileSync(shim, "utf8")).toContain("exec rt intercept run fakestart --");

    const rules = readInterceptRulesRow(home);
    expect(rules?.rules).toHaveLength(1);
    expect(rules?.rules[0]?.command).toBe("fakestart");
    expect(rules?.rules[0]?.repo).toBe(REPO_RULE_KEY);
    expect(rules?.rules[0]?.repoRemote).toBe(REMOTE_URL);
  }, 30_000);

  test("intercepted run in the primary worktree gets the first pool port and the injected flag", async () => {
    const res = await finished(
      runFakestart(repoMain, "go", {
        KEEP_ME: "1",
        RT_FAKESTART_PIDFILE: join(home, "server-main.pid"),
      }),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(`PORT=${poolBase} ARGS=go --keep=PORT,KEEP_ME`);

    // The fake server outlives the interceptor; from here on the port is
    // genuinely LISTENING with no live claim pid behind it.
    await waitForServing(poolBase);
    serverPids.push(Number(readFileSync(join(home, "server-main.pid"), "utf8").trim()));
  }, 40_000);

  test("a second worktree of the same repo gets the next port while the first is live", async () => {
    // Precondition for this whole test: worktree A's port is actually bound.
    expect(await isServing(poolBase)).toBe(true);

    const res = await finished(runFakestart(repoB, "go", { KEEP_ME: "1" }));
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(`PORT=${poolBase + 1} ARGS=go --keep=PORT,KEEP_ME`);
  }, 40_000);

  test("re-running in the primary worktree is sticky", async () => {
    const res = await finished(runFakestart(repoMain, "go", { KEEP_ME: "1" }));
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(`PORT=${poolBase} ARGS=go --keep=PORT,KEEP_ME`);
  }, 40_000);

  test("with the daemon down the command still runs, untouched, with a passthrough notice", async () => {
    daemon.kill();
    await daemon.exited;

    const res = await finished(runFakestart(repoMain, "go", { KEEP_ME: "1" }));
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("passthrough");
    // No port claimed and no arg injection — the caller's invocation verbatim.
    expect(res.stdout.trim()).toBe("PORT= ARGS=go");
  }, 40_000);

  test("after a daemon restart the claim is still readable via rt endpoint lookup", async () => {
    daemon = runRt(["--daemon"]);
    await waitForSocket(join(home, ".mattstack", "rt", "rt.sock"));

    const res = await finished(runRt(["endpoint", "lookup", "web", "--json"], repoMain));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.claimed).toBe(true);
    expect(out.port).toBe(poolBase);
    expect(out.url).toBe(`http://localhost:${poolBase}`);
    expect(out.running).toBe(true);

    // RT-115 provenance, over the REAL probes: repoMain is the indexed
    // primary checkout (main:true, no registry name), and the fake server's
    // cwd is the claiming worktree, so the listener attributes as ours.
    expect(out.worktree).toEqual({ path: realpathSync(repoMain), name: null, main: true });
    expect(out.listener.pid).toBe(serverPids[0]);
    expect(out.listener.ownsClaim).toBe(true);
  }, 40_000);

  test("rt intercept status reports the shim installed and current", async () => {
    const res = await finished(runRt(["intercept", "status", "--json"]));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.daemonUp).toBe(true);
    expect(out.shims).toEqual([
      { command: "fakestart", repo: REPO_RULE_KEY, installed: true, current: true },
    ]);
    expect(out.rulesByRepo[REPO_RULE_KEY]).toBe(1);
  }, 30_000);

  test("rt verify reports the intercept shims check", async () => {
    const res = await finished(runRt(["verify", "--json"]));
    const out = JSON.parse(res.stdout);
    const check = out.checks.find((c: { name: string }) => c.name === "tool.intercepts");
    expect(check).toBeDefined();
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("1 installed and current");
  }, 60_000);
});
