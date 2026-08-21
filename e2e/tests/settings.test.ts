/**
 * RT-47 e2e — four authored stores, one resolver, end to end against a real
 * compiled binary and a real foreground daemon.
 *
 * Everything runs inside one hermetic test HOME with its own daemon on a
 * per-run free `RT_API_PORT` (the RT-45/RT-28 pattern from `events.test.ts` and
 * `endpoint.test.ts`, copied deliberately: freePort(), child tracking, reaping
 * in afterAll, `/usr/sbin` on the child PATH for `lsof`).
 *
 * The scenario is the whole RT-47 contract in one file:
 *
 *   three seeded stores (user + team + machine) → `rt settings get/list/explain`
 *   report the resolved value, the multi-scope provenance of the deep-merge
 *   key, migrated:false labeling and an unregistered team key → `rt settings
 *   set` at user scope changes the answer while every comment in the file
 *   survives → `rt intercept install` builds the shim from the stores' own
 *   roles/intercepts and the intercepted command comes back with the port the
 *   team store's role pool declares AND env from a hook whose path was
 *   written as `${team:e2eteam}` → the staleness probe fires when a store
 *   file is newer than the rules cache and `rt intercept install` clears it.
 *
 * The load-bearing step is the intercept one: it is the only place where the
 * whole chain (store file → resolver → identity → intercepts.json → shim →
 * daemon claim → role hook → child env) has to agree, and no unit test can
 * reach it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

// ─── Shared helpers (mirroring e2e/tests/endpoint.test.ts) ───────────────────

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
 * The role pool has to be a block of ports genuinely free on THIS machine or
 * the allocator's bind-probe would (correctly) skip past the first one and the
 * "first port in the pool" assertion would fail for a reason that has nothing
 * to do with the settings resolver. 42500 keeps clear of endpoint.test.ts's
 * 42100-42400 window so the two suites cannot fight over a port.
 */
function findFreePoolBase(size = 6): number {
  for (let base = 42500; base <= 42800; base += 10) {
    let ok = true;
    for (let p = base; p < base + size; p++) {
      if (!canBind(p)) { ok = false; break; }
    }
    if (ok) return base;
  }
  throw new Error("no free block of pool ports in 42500-42800 — something local is squatting the range");
}

/** rt renders unconditional ANSI (lib/ansi.ts has no TTY check), so human-output assertions strip it. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Test state ──────────────────────────────────────────────────────────────

let apiPort = 0;
let home = "";
let cleanup: () => void = () => {};
let tmpBin = "";
let repoPath = "";
let poolBase = 0;
let daemon: ReturnType<typeof Bun.spawn>;

const REPO_NAME = "settings-repo";
const REMOTE_URL = "git@github.com:rt-test/settings-repo.git";
const IDENTITY = "github.com/rt-test/settings-repo";
const TEAM = "e2eteam";

/** Store paths inside the test HOME (mirroring lib/rt-paths.ts). */
let userStore = "";
let teamStore = "";
let machineStore = "";
let hookStub = "";

const children: Array<ReturnType<typeof Bun.spawn>> = [];

/**
 * Hermetic child env. PATH order is the whole point: `~/.local/bin` (where
 * `rt intercept install` writes the shim) MUST come before `tmpBin` (where the
 * real `fakestart` lives), and the rt binary's own directory has to be on PATH
 * because the generated shim execs a bare `rt`. `/usr/sbin` carries `lsof` on
 * macOS, which the allocator's listener probe spawns.
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
 * nothing about PATH order.
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

/** Runs an rt command and parses its `--json` stdout, failing loudly on a non-zero exit. */
async function rtJson(args: string[], cwd?: string): Promise<any> {
  const res = await finished(runRt(args, cwd));
  if (res.exitCode !== 0) {
    throw new Error(`rt ${args.join(" ")} exited ${res.exitCode}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`rt ${args.join(" ")} did not print JSON\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

// ─── Store fixtures ──────────────────────────────────────────────────────────

/**
 * The team store: the ONLY place `rt.roles`/`rt.intercepts` are declared for
 * this repo, plus a key this rt has never heard of (the version-skew degrade)
 * and the `onDeck`/`ready` half of the deep-merge proof case.
 *
 * `${team:e2eteam}` expands to the team ZONE ROOT (~/.mattstack/teams/e2eteam),
 * NOT to the mattstack/ subdirectory the settings file itself lives in — the
 * hook stub is placed accordingly.
 */
function teamStoreText(): string {
  return `// e2e team store for ${TEAM} — shared keys, committed to the team zone.
{
  // A key a NEWER rt would know and this one does not: warn + skip + label,
  // never a hard failure (spec: version-skewed binaries).
  "rt.e2eFutureKey": { "enabled": true },

  "repos": {
    "${IDENTITY}": {
      "rt.roles": {
        "web": {
          "pool": [{ "from": ${poolBase}, "to": ${poolBase + 5} }],
          "preserveEnv": ["KEEP_*"],
          "env": { "PORT": "\${port}" },
          // \${team:...} is closed-set and expands; \${port} is the
          // interceptor's own template and must pass through verbatim.
          "hook": "sh \${team:${TEAM}}/hook.sh"
        }
      },
      "rt.intercepts": [
        {
          "command": "fakestart",
          "matches": [
            {
              "cwdGlob": ".",
              "role": "web",
              "argInject": { "afterArg": "go", "template": "--keep=\${envKeys}", "skipIfArgPresent": "--keep" }
            }
          ]
        }
      ],
      "rt.worktrees": { "onDeck": 3, "ready": [{ "run": "echo team-ready" }] }
    }
  }
}
`;
}

/** The user store: the `namePool` half of the deep-merge case, plus the comments the write test asserts on. */
function userStoreText(): string {
  return `// e2e user store — this header comment must survive \`rt settings set\`.
{
  // KEEP-THIS-COMMENT: planted before the write, asserted after it.
  "repos": {
    "${IDENTITY}": {
      "rt.worktrees": { "namePool": ["alpha", "beta"] }
    }
  }
}
`;
}

/** The machine store: the strongest rung, and the one store where a path literal is legal. */
function machineStoreText(): string {
  return `// e2e machine store — local only, never travels. Path literals are legal here.
{
  "repos": {
    "${IDENTITY}": {
      "rt.worktrees": { "root": "~/machine-trees" }
    }
  }
}
`;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("rt settings (four stores, one resolver — e2e)", () => {
  beforeAll(async () => {
    apiPort = freePort();
    poolBase = findFreePoolBase();
    ({ path: home, cleanup } = createTestHome());

    // The intercepted "real" binary. It echoes both the role-rendered PORT and
    // the hook-contributed HOOKED_PORT, so one line proves the store's role
    // pool AND the ${team:...}-addressed hook both reached the child.
    tmpBin = join(home, "testbin");
    mkdirSync(tmpBin, { recursive: true });
    const fakestart = join(tmpBin, "fakestart");
    writeFileSync(
      fakestart,
      ["#!/bin/sh", 'echo "PORT=$PORT HOOKED_PORT=$HOOKED_PORT ARGS=$*"', ""].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(fakestart, 0o755);

    repoPath = join(home, REPO_NAME);
    mkdirSync(repoPath, { recursive: true });
    git(["init", "-q"], repoPath);
    git(["remote", "add", "origin", REMOTE_URL], repoPath);

    const rtDir = join(home, ".mattstack", "rt");
    mkdirSync(join(rtDir, "repos", REPO_NAME), { recursive: true });
    writeFileSync(join(rtDir, "repos.json"), JSON.stringify({ [REPO_NAME]: repoPath }, null, 2));

    userStore = join(home, ".mattstack", "user", "settings.jsonc");
    teamStore = join(home, ".mattstack", "teams", TEAM, "mattstack", "settings.jsonc");
    machineStore = join(home, ".mattstack", "settings.local.jsonc");
    // The ZONE ROOT, not the mattstack/ dir the settings file lives in.
    hookStub = join(home, ".mattstack", "teams", TEAM, "hook.sh");

    write(teamStore, teamStoreText());
    write(userStore, userStoreText());
    write(machineStore, machineStoreText());

    // A fail-open role hook: reads the HookInput JSON on stdin and hands back
    // the port it saw, so the child env proves the hook actually ran.
    write(
      hookStub,
      [
        "#!/bin/sh",
        "input=$(cat)",
        "port=$(printf '%s' \"$input\" | sed -n 's/.*\"port\":\\([0-9][0-9]*\\).*/\\1/p')",
        "printf '{\"env\":{\"HOOKED_PORT\":\"%s\"}}' \"$port\"",
        "",
      ].join("\n"),
    );
    chmodSync(hookStub, 0o755);

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
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    cleanup();
  });

  // ── 1. reads ───────────────────────────────────────────────────────────────

  test("get resolves a store-only key, expands ${team:...} and passes ${port} through", async () => {
    const out = await rtJson(["settings", "get", "rt.roles", "--repo", REPO_NAME, "--json"]);
    expect(out.ok).toBe(true);
    expect(out.migrated).toBe(true);
    expect(out.value.web.pool).toEqual([{ from: poolBase, to: poolBase + 5 }]);
    // Closed-set variable → the team ZONE ROOT, with no mattstack/ segment.
    expect(out.value.web.hook).toBe(`sh ${join(home, ".mattstack", "teams", TEAM)}/hook.sh`);
    // Domain template → untouched.
    expect(out.value.web.env.PORT).toBe("${port}");
    expect(out.provenance).toEqual([{ scope: "team.repo", file: teamStore }]);
  }, 30_000);

  test("get on a replace key reports exactly one provenance entry", async () => {
    const out = await rtJson(["settings", "get", "rt.intercepts", "--repo", REPO_NAME, "--json"]);
    expect(out.value).toHaveLength(1);
    expect(out.value[0].command).toBe("fakestart");
    expect(out.provenance).toEqual([{ scope: "team.repo", file: teamStore }]);
  }, 30_000);

  test("the deep-merge key merges team + user + machine with multi-scope provenance", async () => {
    const out = await rtJson(["settings", "get", "rt.worktrees", "--repo", REPO_NAME, "--json"]);
    expect(out.value).toEqual({
      onDeck: 3,                                  // team.repo
      ready: [{ run: "echo team-ready" }],        // team.repo
      namePool: ["alpha", "beta"],                // user.repo
      root: "~/machine-trees",                    // machine.repo (path literals are legal there)
    });
    expect(out.provenance).toEqual([
      { scope: "team.repo", file: teamStore },
      { scope: "user.repo", file: userStore },
      { scope: "machine.repo", file: machineStore },
    ]);
  }, 30_000);

  test("list reports migrated flags and labels the team store's unregistered key", async () => {
    const out = await rtJson(["settings", "list", "--repo", REPO_NAME, "--json"]);
    const byKey = new Map<string, any>(out.settings.map((s: any) => [s.key, s]));

    expect(byKey.get("rt.worktrees").migrated).toBe(true);
    expect(byKey.get("rt.worktrees").value.onDeck).toBe(3);
    expect(byKey.get("rt.hooks").migrated).toBe(false);

    const unknown = byKey.get("rt.e2eFutureKey");
    expect(unknown.unregistered).toBe(true);
    expect(unknown.value).toEqual({ enabled: true });
    expect(unknown.provenance).toEqual([{ scope: "team", file: teamStore }]);
  }, 30_000);

  test("explain (human output — the verb has no --json) shows every reachable rung", async () => {
    const res = await finished(runRt(["settings", "explain", "rt.worktrees", "--repo", REPO_NAME]));
    expect(res.exitCode).toBe(0);
    const out = stripAnsi(res.stdout);

    expect(out).toContain("rt.worktrees");
    expect(out).toContain("(registry default)");
    expect(out).toMatch(new RegExp(`team\\.repo\\s+${teamStore}\\s+\\{"onDeck":3`));
    expect(out).toMatch(new RegExp(`user\\.repo\\s+${userStore}\\s+\\{"namePool"`));
    expect(out).toMatch(new RegExp(`machine\\.repo\\s+${machineStore}\\s+\\{"root"`));
    // Rung ORDER is the contract: weakest first.
    expect(out.indexOf("team.repo")).toBeLessThan(out.indexOf("user.repo"));
    expect(out.indexOf("user.repo")).toBeLessThan(out.indexOf("machine.repo"));
  }, 30_000);

  // ── 2. writes ──────────────────────────────────────────────────────────────

  test("set at user scope changes the resolved value and every comment survives", async () => {
    const before = readFileSync(userStore, "utf8");
    expect(before).toContain("// KEEP-THIS-COMMENT");

    const res = await finished(
      runRt(["settings", "set", "rt.worktrees", '{"namePool":["gamma"]}', "--scope", "user", "--repo", REPO_NAME]),
    );
    expect(res.exitCode).toBe(0);
    expect(stripAnsi(res.stdout)).toContain("rt.worktrees set (user, settings-repo)");

    const after = readFileSync(userStore, "utf8");
    expect(after).toContain("// e2e user store — this header comment must survive");
    expect(after).toContain("// KEEP-THIS-COMMENT: planted before the write, asserted after it.");
    expect(after).toContain("gamma");

    const out = await rtJson(["settings", "get", "rt.worktrees", "--repo", REPO_NAME, "--json"]);
    expect(out.value.namePool).toEqual(["gamma"]);
    // The other scopes are untouched by a write that only owns namePool.
    expect(out.value.onDeck).toBe(3);
    expect(out.provenance.map((p: any) => p.scope)).toEqual([
      "team.repo",
      "user.repo",
      "machine.repo",
    ]);
  }, 40_000);

  test("a non-rt suite key (deck.access) round-trips end to end with provenance", async () => {
    const res = await finished(
      runRt(["settings", "set", "deck.access", '{"members":["alice"]}', "--scope", "user"]),
    );
    expect(res.exitCode).toBe(0);
    expect(stripAnsi(res.stdout)).toContain("deck.access set (user)");

    const out = await rtJson(["settings", "get", "deck.access", "--json"]);
    expect(out.ok).toBe(true);
    expect(out.migrated).toBe(true);
    expect(out.value).toEqual({ members: ["alice"] });
    expect(out.provenance).toEqual([{ scope: "user", file: userStore }]);
  }, 30_000);

  // ── 3. stores → shim → child ───────────────────────────────────────────────

  test("intercept install builds the rules and the shim from the stores alone", async () => {
    const out = await rtJson(["intercept", "install", "--json"]);
    expect(out.ok).toBe(true);
    expect(out.installed).toEqual(["fakestart"]);
    expect(out.rules).toBe(1);

    const shim = join(home, ".local", "bin", "fakestart");
    expect(existsSync(shim)).toBe(true);
    expect(readFileSync(shim, "utf8")).toContain("exec rt intercept run fakestart --");

    const rules = JSON.parse(readFileSync(join(home, ".mattstack", "rt", "intercepts.json"), "utf8"));
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0].repo).toBe(REPO_NAME);
    expect(rules.rules[0].repoRemote).toBe(REMOTE_URL);
  }, 40_000);

  test("the intercepted command gets the team store's port and the ${team:...} hook's env", async () => {
    const res = await finished(runFakestart(repoPath, "go", { KEEP_ME: "1" }));
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(
      `PORT=${poolBase} HOOKED_PORT=${poolBase} ARGS=go --keep=PORT,KEEP_ME,HOOKED_PORT`,
    );
  }, 40_000);

  test("rt endpoint lookup sees the claim made against the store-declared role", async () => {
    const out = await rtJson(["endpoint", "lookup", "web", "--json"], repoPath);
    expect(out.ok).toBe(true);
    expect(out.claimed).toBe(true);
    expect(out.port).toBe(poolBase);
  }, 40_000);

  // ── 4. staleness ───────────────────────────────────────────────────────────

  test("a store file newer than the rules cache reports stale, and install clears it", async () => {
    const cachePath = join(home, ".mattstack", "rt", "intercepts.json");
    const fresh = await rtJson(["intercept", "status", "--json"]);
    expect(fresh.stale.stale).toBe(false);

    // Explicit utimes, never a bare `touch`: same-tick mtimes flake, so the
    // store is pushed a full 2s past the CACHE's own mtime.
    const cacheSeconds = statSync(cachePath).mtimeMs / 1000;
    utimesSync(teamStore, cacheSeconds + 2, cacheSeconds + 2);

    const stale = await rtJson(["intercept", "status", "--json"]);
    expect(stale.stale.stale).toBe(true);
    expect(stale.stale.reason).toContain(teamStore);

    // The cache is rewritten at wall-clock time, so wait past the future mtime
    // we just stamped before regenerating — otherwise the fresh cache is still
    // "older" than the store and the probe would (correctly) stay stale.
    await Bun.sleep(2_500);
    const reinstall = await rtJson(["intercept", "install", "--json"]);
    expect(reinstall.ok).toBe(true);

    const cleared = await rtJson(["intercept", "status", "--json"]);
    expect(cleared.stale.stale).toBe(false);
  }, 60_000);
});
