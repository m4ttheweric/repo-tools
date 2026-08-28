# Phase 6 · Someone else's Mac (p6-portability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rt daemon survive a machine that is not the author's ... a fish shell, a blocking `.zshrc`, a renamed Mac, a foreign `~/.local/bin/rt`, no home repo, no git identity, an Intel Mac, and a locked keychain.

**Architecture:** Nine bounded units over three subsystems: (1) rebuild `resolveUserPath` as an async, killable, fish-aware PATH probe with an `rt.daemonPath` override; (2) stabilize machine identity and dev-mode detection; (3) first-run honesty in home-snapshot, secrets, setup, and the branch cache. Each unit is independently testable; task 10 (the branch-cache key flip) is the one atomic multi-file change.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test`, `@mattstack/rt-client` settings registry, pino logger.

**Spec:** `docs/superpowers/specs/2026-08-28-p6-portability-design.md` (read it alongside this plan; the plan argues from it).

## Global Constraints

- **No `SCHEMA_VERSION` bump.** Every fix here is code-only; S069 reuses the existing `branch TEXT PRIMARY KEY` column with no DDL change. If a bump ever looks unavoidable, STOP and ask through the shepherd channel first.
- **Never start a daemon or run `dist/rt` against the real machine.** Any daemon or compiled-binary invocation runs under `env -i HOME=<temp dir>`. Tests use injected seams and never spawn a real login shell.
- **Do not edit `rt-tray/`.**
- **Write fence:** work only inside this worktree. These files are the sibling p2-health lane's and MUST NOT be modified: `lib/daemon.ts` (EXCEPT the single `resolveUserPath` call statement at `lib/daemon.ts:163`, which the shepherd granted for Task 3 ... await the async result, change nothing else in the file), `lib/daemon-logger.ts`, `lib/daemon-status.ts`, `lib/daemon/supervision-state.ts`, `lib/daemon/handlers/status.ts`, `commands/daemon.ts`, `lib/daemon/command-router.ts`, `lib/daemon/api-server.ts`, `lib/daemon/socket-server.ts`, `lib/log-janitor.ts`, `lib/daemon/safe-timers.ts`.
- **`packages/rt-client` is touched (Task 1).** After any change under it, run `bun run build` inside `packages/rt-client` (the `dist/` that `file:` consumers copy). `packages/rt-client/test/dist-freshness.test.ts` is the guard.
- **The daemon sync-exec gate.** `lib/__tests__/no-daemon-sync-exec.test.ts` forbids `execSync(`/`spawnSync(`/`Bun.spawnSync(`/`Bun.sleepSync(` in any daemon-reachable module. All new subprocess use is async `Bun.spawn`. Remove the `user-path.ts` allowlist entry once Task 2 lands (Task 3).
- **Comments:** clean-code only (state a constraint the code cannot show; no narration, no task numbers in source). Never use em dashes; use "..." or rephrase.
- **Serialized repo identity:** per `docs/repo-identity.md`, state.db tables (branch_cache) key on the serialized wire identity (`remote:host%2Fpath` / `path:%2F…`). In the daemon, the variable `repoName` and `CacheEntry.repoName` already hold that serialized identity.

---

## Task 1: `rt.daemonPath` settings registry key

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts` (add one row to the `REGISTRY` array)
- Test: `packages/rt-client/test/registry-defs.test.ts` (or the existing registry test file; add a case)
- Build: `packages/rt-client` (`bun run build`)

**Interfaces:**
- Produces: the registered key `"rt.daemonPath"` (type `string`, scope `machine`), readable via `getSetting<string>("rt.daemonPath")` (sync; returns `undefined` when unset; throws only on an unregistered key).

- [ ] **Step 1: Write the failing test**

Add to the registry test (mirror how existing keys are asserted):

```ts
import { getDef } from "../src/settings/registry-machinery.ts";

test("rt.daemonPath is a machine-scoped string key with no default", () => {
  const def = getDef("rt.daemonPath");
  expect(def).toBeDefined();
  expect(def!.type).toBe("string");
  expect(def!.scopes).toEqual(["machine"]);
  expect(def!.default).toBeUndefined();
  expect(def!.pathGuardFields).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rt-client && bun test test/registry-defs.test.ts -t "rt.daemonPath"`
Expected: FAIL (`def` is undefined).

- [ ] **Step 3: Add the registry row**

In `packages/rt-client/src/settings/registry-defs.ts`, add to the `REGISTRY` array (place it near `rt.apiPort`, the other machine-scoped daemon key):

```ts
{
  key: "rt.daemonPath",
  type: "string",
  scopes: ["machine"],
  merge: "replace",
  description:
    "Absolute colon-separated PATH the daemon uses for every child it spawns, instead of probing your login shell. Set this when the daemon can't find node/git/bun/pnpm (e.g. a fish shell, a blocking .zshrc, or PATH exports that live only in .zshrc). Machine-scoped: it never travels to another machine.",
},
```

No `default` (absent means "probe the shell"); no `pathGuardFields` (the value is itself a PATH literal, and machine scope is exempt from the path-literal guard).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rt-client && bun test test/registry-defs.test.ts -t "rt.daemonPath"`
Expected: PASS.

- [ ] **Step 5: Rebuild rt-client dist and verify freshness**

Run: `cd packages/rt-client && bun run build && bun test test/dist-freshness.test.ts`
Expected: PASS (dist regenerated).

- [ ] **Step 6: Commit**

```bash
git add packages/rt-client/src/settings/registry-defs.ts packages/rt-client/test packages/rt-client/dist
git commit -m "rt-client: register rt.daemonPath machine setting (6.1)"
```

---

## Task 2: Rebuild `resolveUserPath` (S013, S014, S062)

**Files:**
- Modify: `lib/daemon/user-path.ts` (rewrite `resolveUserPath`; keep `probeTools` exported; drop both `execSync` calls)
- Test: `lib/daemon/__tests__/user-path.test.ts`

**Interfaces:**
- Consumes: `getSetting<string>("rt.daemonPath")` from Task 1.
- Produces: `export async function resolveUserPath(log: Logger, probe?: ProbeFn): Promise<string>` (was sync). `ProbeFn = (argv: [string, ...string[]], opts: { timeoutMs: number; env?: Record<string, string | undefined> }) => Promise<string | null>` (resolves the child's stdout, or `null` on spawn failure / timeout / kill). `probeTools(pathValue, names)` unchanged.

- [ ] **Step 1: Write the failing tests**

Replace/extend `lib/daemon/__tests__/user-path.test.ts`. Use an injected `probe` seam so no real shell is spawned. `makeLog()` returns a pino-shaped stub capturing `warn`/`info` calls.

```ts
import { resolveUserPath } from "../user-path.ts";

function makeLog() {
  const warns: any[] = []; const infos: any[] = [];
  return { log: { warn: (...a: any[]) => warns.push(a), info: (...a: any[]) => infos.push(a) } as any, warns, infos };
}

test("fish-style space-separated base output is rejected, baseline kept + warn", async () => {
  const { log, warns } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async () => "/opt/homebrew/bin /usr/bin /bin"; // spaces = fish-unsplit
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/usr/bin:/bin");
  expect(warns.some((w) => JSON.stringify(w).includes("whitespace"))).toBe(true);
});

test("a hanging probe returns baseline within the timeout", async () => {
  const { log } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async () => null; // seam models kill/timeout as null
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/usr/bin:/bin");
});

test("base equal to launchd baseline is treated as silent fallback (S062)", async () => {
  const { log, warns } = makeLog();
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  const probe = async (argv: any) => (argv[1] === "-lc" ? "/usr/bin:/bin:/usr/sbin:/sbin" : null);
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  expect(warns.some((w) => JSON.stringify(w).includes("equals-baseline"))).toBe(true);
});

test("rt.daemonPath override skips both probes", async () => {
  const { log } = makeLog();
  let called = false;
  const probe = async () => { called = true; return "x"; };
  // Point HOME at a scratch machine store that sets rt.daemonPath, OR stub getSetting.
  // (Executor: use the repo's settings test harness to set rt.daemonPath = "/over/bin:/x/bin" at machine scope.)
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/over/bin:/x/bin");
  expect(called).toBe(false);
});

test("valid base accepted; interactive overlay appends a .zshrc-only dir after base", async () => {
  const { log } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async (argv: any) =>
    argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : "/opt/homebrew/bin:/usr/bin:/bin:/Users/x/.nvm/versions/node/v22/bin";
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin:/Users/x/.nvm/versions/node/v22/bin");
});

test("overlay timeout is skipped with a warn; base kept unchanged", async () => {
  const { log, warns } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async (argv: any) => (argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : null);
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(warns.some((w) => JSON.stringify(w).includes("overlay"))).toBe(true);
});

test("garbage overlay (non-null, no absolute dirs) is skipped with a warn", async () => {
  const { log, warns } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async (argv: any) => (argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : "not-a-path:also-not");
  const out = await resolveUserPath(log, probe);
  expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(warns.some((w) => JSON.stringify(w).includes("overlay"))).toBe(true);
});

test("missing-tool warn fires when node is absent", async () => {
  const { log, warns } = makeLog();
  process.env.PATH = "/usr/bin:/bin";
  const probe = async () => "/usr/bin:/bin"; // no node
  await resolveUserPath(log, probe);
  expect(warns.some((w) => JSON.stringify(w).includes("missing"))).toBe(true);
});
```

Keep the existing `probeTools` tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/user-path.test.ts`
Expected: FAIL (resolveUserPath is still sync / no override / no overlay).

- [ ] **Step 3: Rewrite `lib/daemon/user-path.ts`**

Replace the module (keep `probeTools` as-is; remove `import { execSync }`):

```ts
import { basename } from "path";
import type { Logger } from "pino";
import { getSetting } from "@mattstack/rt-client";

export type ProbeFn = (
  argv: [string, ...string[]],
  opts: { timeoutMs: number; env?: Record<string, string | undefined> },
) => Promise<string | null>;

const BASE_TIMEOUT_MS = 5_000;
const OVERLAY_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 500;

/** Default probe: a detached (own process-group) Bun.spawn whose whole group is
 *  SIGTERM'd then SIGKILL'd at the deadline, raced so a hung shell (or a hung
 *  grandchild it spawned) can never block boot past the timeout. */
const runProbe: ProbeFn = async (argv, opts) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      detached: true,
      env: opts.env ?? { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  proc.unref();
  const pid = proc.pid;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    try { process.kill(-pid, "SIGTERM"); } catch { /* group already gone */ }
    killTimer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, KILL_GRACE_MS);
    killTimer.unref?.();
  }, opts.timeoutMs);
  const captured: Promise<string | null> = (async () => {
    try {
      const [out] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      return out;
    } catch {
      return null;
    }
  })();
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const deadline: Promise<null> = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), opts.timeoutMs + KILL_GRACE_MS + 250);
  });
  try {
    return await Promise.race([captured, deadline]);
  } finally {
    clearTimeout(term);
    if (killTimer) clearTimeout(killTimer);
    clearTimeout(deadlineTimer!);
  }
};

function validateBase(raw: string | null, baseline: string): { path: string; source: "probe" | "baseline"; reason?: string } {
  if (raw === null) return { path: baseline, source: "baseline", reason: "killed-or-empty" };
  const v = raw.trim();
  if (v.length === 0) return { path: baseline, source: "baseline", reason: "empty" };
  if (/\s/.test(v)) return { path: baseline, source: "baseline", reason: "whitespace" };
  if (v.split(":").filter(Boolean).length < 2) return { path: baseline, source: "baseline", reason: "too-few-segments" };
  if (v === baseline) return { path: baseline, source: "baseline", reason: "equals-baseline" };
  return { path: v, source: "probe" };
}

/** Overlay contributes only well-formed absolute dirs; anything else yields []. */
function absoluteDirsOf(raw: string | null): string[] {
  if (raw === null) return [];
  const v = raw.trim();
  if (v.length === 0 || /\s/.test(v)) return [];
  return v.split(":").filter((d) => d.startsWith("/"));
}

function unionAppend(base: string, extra: string[]): string {
  const have = new Set(base.split(":").filter(Boolean));
  const add = extra.filter((d) => !have.has(d));
  return add.length === 0 ? base : [base, ...add].join(":");
}

export function probeTools(pathValue: string, names: string[]): Record<string, boolean> {
  const entries = pathValue.split(":").filter((p) => p.length > 0);
  const probed: Record<string, boolean> = {};
  for (const name of names) {
    probed[`has${name[0]!.toUpperCase()}${name.slice(1)}`] = entries.some((p) => {
      try { return Bun.file(`${p}/${name}`).size > 0; } catch { return false; }
    });
  }
  return probed;
}

export async function resolveUserPath(log: Logger, probe: ProbeFn = runProbe): Promise<string> {
  const baseline = process.env.PATH ?? "";

  const override = getSetting<string>("rt.daemonPath");
  let result: string;
  let source: string;

  if (typeof override === "string" && override.trim().length > 0) {
    result = override.trim();
    source = "override";
  } else {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const isFish = basename(shell) === "fish";
    const baseArgv: [string, ...string[]] = isFish
      ? [shell, "-lc", "string join : $PATH"]
      : [shell, "-lc", `{ [ -s "${'${NVM_DIR:-$HOME/.nvm}'}/nvm.sh" ] && . "${'${NVM_DIR:-$HOME/.nvm}'}/nvm.sh" >/dev/null 2>&1; }; printf %s "$PATH"`];
    const base = validateBase(await probe(baseArgv, { timeoutMs: BASE_TIMEOUT_MS }), baseline);
    result = base.path;
    source = base.source;
    if (base.reason) log.warn({ reason: base.reason }, "PATH base probe unusable; kept baseline");

    const ovArgv: [string, ...string[]] = isFish
      ? [shell, "-ilc", "string join : $PATH"]
      : [shell, "-ilc", "echo $PATH"];
    const ovRaw = await probe(ovArgv, { timeoutMs: OVERLAY_TIMEOUT_MS, env: { ...process.env, TERM: "dumb" } });
    const extra = absoluteDirsOf(ovRaw);
    if (extra.length === 0) {
      // Warn on BOTH timeout (null) and garbage (non-null but no usable
      // absolute dirs) ... the ruling says timeout OR garbage.
      log.warn("PATH interactive overlay skipped (timed out or no usable dirs)");
    } else {
      const before = result;
      result = unionAppend(result, extra);
      if (result !== before) source += "+overlay";
    }
  }

  const probed = probeTools(result, ["node", "git", "bun", "pnpm"]);
  const missing = Object.entries(probed).filter(([, v]) => !v).map(([k]) => k.replace(/^has/, "").toLowerCase());
  if (missing.length > 0) log.warn({ missing }, "PATH missing required tools; set rt.daemonPath to override");
  log.info({ source, entries: result.split(":").length, ...probed }, "PATH resolved");
  return result;
}
```

(The `${'${NVM_DIR...}'}` fragments above are a template-literal escape so the literal `${NVM_DIR:-$HOME/.nvm}` survives into the shell body ... the executor writes the shell string so `$NVM_DIR`/`$HOME` expand in the child shell, not in TS.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/user-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/user-path.ts lib/daemon/__tests__/user-path.test.ts
git commit -m "user-path: async fish-aware killable PATH probe + rt.daemonPath override (S013/S014/S062)"
```

---

## Task 3: Await the async resolver in `daemon.ts`; drop the gate allowlist entry

**Files:**
- Modify: `lib/daemon.ts:163` (the single granted statement only)
- Modify: `lib/__tests__/no-daemon-sync-exec.test.ts` (remove the `user-path.ts` allowlist line)

**Interfaces:**
- Consumes: `resolveUserPath` (now async) from Task 2.

- [ ] **Step 1: Make the one-line daemon.ts change**

At `lib/daemon.ts:163`, change only:

```ts
  const resolvedPath = resolveUserPath(log);
```
to:
```ts
  const resolvedPath = await resolveUserPath(log);
```

Do not touch anything else in `lib/daemon.ts` (the surrounding block, line 164's `if (resolvedPath) process.env.PATH = resolvedPath;`, and the prefix block at 167-183 stay exactly as they are). Module-scope `await` is already used in this file (lines 119, 145).

- [ ] **Step 2: Remove the allowlist entry**

In `lib/__tests__/no-daemon-sync-exec.test.ts`, delete this line from the `ALLOWLIST` set:

```ts
  "lib/daemon/user-path.ts",        // Phase 6 PATH rebuild (S013/S014/S062)
```

- [ ] **Step 3: Run the gate + type-check**

Run: `bun test lib/__tests__/no-daemon-sync-exec.test.ts && bunx tsc --noEmit`
Expected: PASS, zero errors. (If the gate fails naming `user-path.ts`, a stray sync-exec remains in Task 2 ... fix there.)

- [ ] **Step 4: Commit**

```bash
git add lib/daemon.ts lib/__tests__/no-daemon-sync-exec.test.ts
git commit -m "daemon: await async resolveUserPath; drop user-path sync-exec allowlist (6.1)"
```

---

## Task 4: Stable machine-key at setup (S071)

**Files:**
- Create: `lib/home/machine-id.ts` (`stableMachineId`, `resolveInitialMachineKey`)
- Modify: `commands/home.ts:552` (use `resolveInitialMachineKey`)
- Test: `lib/home/__tests__/machine-id.test.ts`

**Interfaces:**
- Consumes: `machineKey()`, `isSafeMachineKeySegment` from `lib/rt-paths.ts`; `HomeProbes` (has `listProfiles(userLocalDir)`, `exists`).
- Produces: `export async function stableMachineId(exec?: (argv: string[]) => Promise<string | null>): Promise<string | null>`; `export async function resolveInitialMachineKey(home: string, probes: HomeProbes, deps?: {...}): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { stableMachineId, resolveInitialMachineKey } from "../machine-id.ts";

const IOREG_FIXTURE = `  "IOPlatformUUID" = "D9E8F7A6-1234-5678-9ABC-DEF012345678"`;

test("stableMachineId parses IOPlatformUUID and slugs it", async () => {
  const id = await stableMachineId(async () => IOREG_FIXTURE);
  expect(id).toBe("d9e8f7a6-1234-5678-9abc-def012345678");
});

test("stableMachineId returns null when ioreg fails", async () => {
  expect(await stableMachineId(async () => null)).toBeNull();
  expect(await stableMachineId(async () => "no uuid here")).toBeNull();
});

test("resolveInitialMachineKey: existing pin file is returned unchanged", async () => {
  const probes = { exists: (p: string) => p.endsWith("machine-key"), listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => "pinned-key", stableId: async () => "uuid-x" });
  expect(key).toBe("pinned-key");
});

test("resolveInitialMachineKey: existing non-empty hostname-slug store freezes the slug", async () => {
  const probes = { exists: () => false, listProfiles: () => ["myhost"] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => "uuid-x" });
  expect(key).toBe("myhost"); // frozen, data preserved, no move
});

test("resolveInitialMachineKey: fresh machine gets the stable id", async () => {
  const probes = { exists: () => false, listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => "uuid-x" });
  expect(key).toBe("uuid-x");
});

test("resolveInitialMachineKey: fresh machine, ioreg fails -> hostname slug", async () => {
  const probes = { exists: () => false, listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => null });
  expect(key).toBe("myhost");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/home/__tests__/machine-id.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/home/machine-id.ts`**

```ts
import { hostname } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { isSafeMachineKeySegment, machineKey } from "../rt-paths.ts";
import type { HomeProbes } from "../../commands/home.ts";

/** IOPlatformUUID via ioreg, slugged; null on any failure (non-mac, CI, no match). */
export async function stableMachineId(
  exec: (argv: string[]) => Promise<string | null> = defaultIoreg,
): Promise<string | null> {
  const out = await exec(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
  if (!out) return null;
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!m) return null;
  const slug = m[1]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return isSafeMachineKeySegment(slug) ? slug : null;
}

const defaultIoreg = async (argv: [string, ...string[]] | string[]): Promise<string | null> => {
  try {
    const proc = Bun.spawn(argv as string[], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const term = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, 3_000);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      return code === 0 ? out : null;
    } finally { clearTimeout(term); }
  } catch { return null; }
};

interface InitKeyDeps {
  readPin?: () => string | null;
  hostnameSlug?: () => string;
  stableId?: () => Promise<string | null>;
}

/** Establishes the machine key at `rt home init`. Data-preserving + idempotent:
 *  an existing pin is kept; a machine with existing data freezes its current
 *  slug (zero move); only a genuinely fresh machine gets the stable id. */
export async function resolveInitialMachineKey(home: string, probes: HomeProbes, deps: InitKeyDeps = {}): Promise<string> {
  const readPin = deps.readPin ?? (() => { try { const v = readFileSync(join(home, "machine-key"), "utf8").trim(); return v || null; } catch { return null; } });
  const hostnameSlug = deps.hostnameSlug ?? (() => machineKey()); // machineKey() with no pin returns the hostname slug
  const stableId = deps.stableId ?? (() => stableMachineId());

  const pinned = readPin();
  if (pinned && isSafeMachineKeySegment(pinned)) return pinned;

  const slug = hostnameSlug();
  const profiles = probes.listProfiles(join(home, "user", "local")); // dirs carrying settings.local.jsonc
  if (profiles.includes(slug)) return slug; // freeze existing non-empty store

  return (await stableId()) ?? slug;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/home/__tests__/machine-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `rt home init`**

In `commands/home.ts:552`, change:

```ts
  const key = seams.key ?? machineKey();
```
to:
```ts
  const key = seams.key ?? (await resolveInitialMachineKey(mattstackHome(), probes));
```

Add `import { resolveInitialMachineKey } from "../lib/home/machine-id.ts";` at the top. `homeInit` is already `async`.

- [ ] **Step 6: Run the home command tests + type-check**

Run: `bun test commands/__tests__/home.test.ts && bunx tsc --noEmit`
Expected: PASS (existing tests pass `seams.key`, so they bypass the new path; zero type errors).

- [ ] **Step 7: Commit**

```bash
git add lib/home/machine-id.ts lib/home/__tests__/machine-id.test.ts commands/home.ts
git commit -m "home: stable machine-key at init, data-preserving freeze of existing stores (S071)"
```

---

## Task 5: Dev-mode wrapper marker (S020, S067)

**Files:**
- Modify: `commands/settings.ts` (`renderDevModeWrapper`: add marker line 2)
- Modify: `lib/dev-mode.ts` (`currentMode`: bounded-prefix read + delegate; export `isDevModeWrapperContent`, `DEV_MODE_TAG`)
- Modify: `lib/deps/links.ts` (`isDevModeWrapper`: bounded-prefix read + delegate)
- Test: `lib/__tests__/dev-mode.test.ts` (or the existing dev-mode test file)

**Interfaces:**
- Produces: `export const DEV_MODE_TAG = "# mattstack-dev-mode";` and `export function isDevModeWrapperContent(prefix: string): boolean` in `lib/dev-mode.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { isDevModeWrapperContent, DEV_MODE_TAG } from "../dev-mode.ts";

test("new marked wrapper is recognized", () => {
  expect(isDevModeWrapperContent(`#!/bin/zsh\n${DEV_MODE_TAG}\nexport PATH=...\n`)).toBe(true);
});
test("legacy markerless wrapper (RT_LAUNCH_CWD tell) is recognized", () => {
  expect(isDevModeWrapperContent(`#!/bin/zsh\nexport PATH="x"\nexport RT_LAUNCH_CWD="$PWD"\n`)).toBe(true);
});
test("foreign #! script is not a dev wrapper", () => {
  expect(isDevModeWrapperContent(`#!/bin/sh\necho hi\n`)).toBe(false);
});
test("a mattstack-link file is not a dev wrapper", () => {
  expect(isDevModeWrapperContent(`#!/bin/sh\n# mattstack-link: rt\nexec ...\n`)).toBe(false);
});
test("non-shebang content is not a dev wrapper", () => {
  expect(isDevModeWrapperContent(`ELF\x00binary`)).toBe(false);
});
```

Plus a `currentMode()` test: write a symlink at `devModeWrapperPath()` to a >4KB binary-shaped file and assert `currentMode() === "prod"` (and that it does not throw / read the whole file). Use the existing dev-mode test's HOME-scratch pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/__tests__/dev-mode.test.ts`
Expected: FAIL (`isDevModeWrapperContent` missing).

- [ ] **Step 3: Add the marker to the emitted wrapper**

In `commands/settings.ts renderDevModeWrapper`, insert the marker as line 2:

```ts
  return [
    `#!/bin/zsh`,
    `# mattstack-dev-mode`,
    `export PATH="${bunDir}:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `export RT_LAUNCH_CWD="$PWD"`,
    `cd "${sourcePath}" || { echo "rt: dev-mode source checkout missing: ${sourcePath}" >&2; exit 1; }`,
    `exec "${bunPath}" run --preload="${DEV_MODE_PRELOAD}" "${sourcePath}/cli.ts" "$@"`,
  ].join("\n") + "\n";
```

- [ ] **Step 4: Add the shared detector + bounded read in `lib/dev-mode.ts`**

Add:

```ts
export const DEV_MODE_TAG = "# mattstack-dev-mode";

/** A recognized dev-mode wrapper: our new marker on line 2, OR a legacy
 *  markerless wrapper (its RT_LAUNCH_CWD line is our unique tell). A foreign
 *  #! script has neither. `prefix` is a bounded head of the file, never the
 *  whole file: in prod this path is a symlink to the compiled binary. */
export function isDevModeWrapperContent(prefix: string): boolean {
  if (!prefix.startsWith("#!")) return false;
  const line2 = prefix.split("\n")[1] ?? "";
  return line2.startsWith(DEV_MODE_TAG) || prefix.includes("RT_LAUNCH_CWD");
}

/** A bounded head of the file (never the whole file: in prod the wrapper path
 *  is a symlink to the multi-MB compiled binary). Exported so links.ts shares
 *  the same real bounded read. */
export function readWrapperPrefix(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      return buf.toString("latin1", 0, n);
    } finally { closeSync(fd); }
  } catch { return null; }
}
```

Rewrite `currentMode()` to use them:

```ts
export function currentMode(): "dev" | "prod" {
  const path = devModeWrapperPath();
  if (!existsSync(path)) return "prod";
  const prefix = readWrapperPrefix(path);
  return prefix !== null && isDevModeWrapperContent(prefix) ? "dev" : "prod";
}
```

(Keep the existing `openSync`/`readSync`/`closeSync` imports; add `Buffer` if not already available via global.)

- [ ] **Step 5: Delegate from `lib/deps/links.ts` via a REAL bounded read**

`p.readFile` is `readFileSync`, which in prod follows the `~/.local/bin/rt`
symlink into the multi-MB compiled binary ... a whole-file read. Slicing its
result does NOT deliver the bounded-read ruling (the whole file is already in
memory). Use the exported bounded `readWrapperPrefix` (openSync + readSync
4096) instead, so no whole-file read ever happens:

```ts
import { isDevModeWrapperContent, readWrapperPrefix } from "../dev-mode.ts";

function isDevModeWrapper(path: string): boolean {
  const prefix = readWrapperPrefix(path);
  return prefix !== null && isDevModeWrapperContent(prefix);
}
```

Drop the now-unused `p: Pick<Probes, "readFile">` parameter and update
`isDevModeWrapper`'s single call site in `links.ts` to pass just the path.
Any `links.ts` test that drove this through an injected `readFile` switches to
writing a real temp file at `path` (the detector reads the actual symlink
target's head on the real fs, by design).

- [ ] **Step 6: Run tests + type-check**

Run: `bun test lib/__tests__/dev-mode.test.ts lib/deps/__tests__/links.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add commands/settings.ts lib/dev-mode.ts lib/deps/links.ts lib/__tests__/dev-mode.test.ts
git commit -m "dev-mode: marker-based wrapper detection, bounded read, legacy fallback (S020/S067)"
```

---

## Task 6: Unsupported-platform row at setup (R051)

**Files:**
- Modify: `lib/setup/validators/mac.ts` (add `archRow`, include in `macRows`)
- Test: `lib/setup/validators/__tests__/mac.test.ts` (or the existing mac validator test)

**Interfaces:**
- Consumes: `Probes` (`p.exec(argv)` → `{ stdout, code }`), `row()` from `lib/setup/contract.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { macRows } from "../mac.ts";

function probes(uname: { stdout: string; code: number }) {
  return { exec: async (argv: string[]) => (argv[0] === "uname" ? uname : { stdout: "", code: 0 }), exists: () => false, readFile: () => null, env: {}, home: "/h" } as any;
}

test("arm64 -> ready", async () => {
  const rows = await macRows(probes({ stdout: "arm64", code: 0 }));
  const arch = rows.find((r) => r.id === "tool.arch")!;
  expect(arch.status).toBe("ready");
});
test("x86_64 -> invalid", async () => {
  const rows = await macRows(probes({ stdout: "x86_64", code: 0 }));
  expect(rows.find((r) => r.id === "tool.arch")!.status).toBe("invalid");
});
test("probe failure -> error, not invalid", async () => {
  const rows = await macRows(probes({ stdout: "", code: 127 }));
  expect(rows.find((r) => r.id === "tool.arch")!.status).toBe("error");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/setup/validators/__tests__/mac.test.ts -t arch`
Expected: FAIL (no `tool.arch` row).

- [ ] **Step 3: Add `archRow` and include it**

In `lib/setup/validators/mac.ts`:

```ts
async function archRow(p: Probes): Promise<Row> {
  const base = { id: "tool.arch", kind: "tool" as const, title: "Processor",
    why: "mattstack ships an Apple-silicon (arm64) build; Intel Macs are not supported.", required: true };
  const res = await p.exec(["uname", "-m"]);
  const arch = res.stdout.trim();
  if (res.code !== 0 || !arch) return row({ ...base, status: "error", detail: "Could not determine your processor" });
  if (arch === "arm64") return row({ ...base, status: "ready", detail: "Apple silicon (arm64)" });
  return row({ ...base, status: "invalid", detail: `${arch}: Apple silicon (arm64) required` });
}
```

And change `macRows`:

```ts
export async function macRows(p: Probes): Promise<Row[]> {
  const [macos, clt, arch] = await Promise.all([macosVersionRow(p), cltRow(p), archRow(p)]);
  return [macos, clt, arch, pathRow(p)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/setup/validators/__tests__/mac.test.ts`
Expected: PASS. (Note: an existing "macRows returns N rows" count assertion may need +1 ... update it.)

- [ ] **Step 5: Commit**

```bash
git add lib/setup/validators/mac.ts lib/setup/validators/__tests__/mac.test.ts
git commit -m "setup: arm64/unsupported-arch row at setup (R051)"
```

---

## Task 7: Home-repo first-run honesty (S090, R043)

**Files:**
- Modify: `lib/daemon/home-snapshot.ts` (init `existsSync` check; identity check before commit; new SkipReason values)
- Modify: `lib/home/init-exec.ts` (identity check before the initial commit)
- Test: `lib/daemon/__tests__/home-snapshot.test.ts` (or the existing home-snapshot test)

**Interfaces:**
- Consumes: `deps.exec` (async runCapture-shaped: `{ exitCode, stdout, stderr }`), `deps.repoDir`, `deps.log`.

- [ ] **Step 1: Write the failing tests**

For S090 (init) and R043 (identity), use the home-snapshot test's fake `exec`/`deps`:

```ts
test("S090: missing repoDir is diagnosed not-provisioned, names rt home init", async () => {
  // deps.repoDir points at a path that does not exist; exec is never reached for rev-parse.
  const snap = makeSnapshot({ repoDir: "/does/not/exist" });
  await snap.init();
  expect(snap.__disabledReason()).toBe("not-provisioned");
  expect(warnsInclude(snap, "rt home init")).toBe(true);
});

test("R043: missing git identity blocks the commit with an actionable reason", async () => {
  const exec = fakeExec({
    "git rev-parse --is-inside-work-tree": { exitCode: 0, stdout: "true" },
    "git config user.name": { exitCode: 1, stdout: "" },
    "git config user.email": { exitCode: 1, stdout: "" },
  });
  const snap = makeSnapshot({ repoDir: existingRepoDir, exec });
  await snap.init();
  const r = await snap.snapshot("watch");
  expect(r.skipped ?? snap.__disabledReason()).toBe("no-git-identity");
  expect(execCalled(exec, "git ... commit")).toBe(false); // never attempted
});
```

(Executor: adapt to the test file's real seam names; the assertions ... `not-provisioned`, the `rt home init` string, `no-git-identity`, and "commit never attempted" ... are the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts -t "S090\|R043"`
Expected: FAIL.

- [ ] **Step 3: Add the new SkipReason values**

In `lib/daemon/home-snapshot.ts`, extend the `SkipReason` union (lines 46-55):

```ts
export type SkipReason =
  | "disabled"
  | "not-a-repo"
  | "not-provisioned"
  | "no-git-identity"
  | "init-failed"
  | "detached"
  | "merge-in-progress"
  | "owners-read-error"
  | "index-locked"
  | "add-failed"
  | "no-changes";
```

Also widen the local `disabledReason` declaration ... it is currently narrowed
(`let disabledReason: "not-a-repo" | "init-failed" | null;` around
`lib/daemon/home-snapshot.ts:281`), so assigning `"not-provisioned"` /
`"no-git-identity"` fails `tsc`. Change it to:

```ts
  let disabledReason: SkipReason | null = null;
```

- [ ] **Step 4: S090 ... existsSync guard in `init()`**

In `init()` (around line 357), before the `git rev-parse` spawn:

```ts
  async function init(): Promise<void> {
    try {
      if (!existsSync(deps.repoDir)) {
        disabledReason = "not-provisioned";
        deps.log.warn({ repoDir: deps.repoDir }, "home-snapshot: home repo not provisioned; run `rt home init`; inert");
        return;
      }
      const check = await deps.exec(["git", "rev-parse", "--is-inside-work-tree"], { /* unchanged */ });
      // ... existing exitCode === -1 / not-a-repo branches unchanged ...
```

(`existsSync` is already imported at line 24.)

- [ ] **Step 5: R043 ... identity check before the snapshot commit**

In the snapshot path, immediately before the commit spawn (line 692), gate once:

```ts
      const name = await deps.exec(["git", "config", "user.name"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      const email = await deps.exec(["git", "config", "user.email"], { cwd: deps.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
      if (name.exitCode !== 0 || !name.stdout.trim() || email.exitCode !== 0 || !email.stdout.trim()) {
        disabledReason = "no-git-identity";
        if (lastLoggedCommitError !== "no-git-identity") {
          deps.log.warn("home-snapshot: no git identity; run `git config --global user.name` and `git config --global user.email`; snapshots inert");
          lastLoggedCommitError = "no-git-identity";
        }
        return { committed: false, sha: null, paths: [], reason, skipped: "no-git-identity" };
      }
      const message = /* unchanged */;
      const commitResult = await deps.exec(["git", "-c", "commit.gpgsign=false", "commit", ...]);
```

(Return shape mirrors the existing skipped-return objects in this function ... executor matches the actual local return type; the contract is: identity missing → skip with `no-git-identity`, commit never attempted, logged once.)

- [ ] **Step 6: R043 companion ... initial commit in `init-exec.ts`**

In `lib/home/init-exec.ts commitInitialUserRepo` (line 82), before the `commit`:

```ts
    case "commitInitialUserRepo": {
      log("committing the initial user/ tree");
      await run(exec, ["git", "-C", "user", "add", "-A"]);
      const name = await exec.run(["git", "-C", "user", "config", "user.name"]);
      const email = await exec.run(["git", "-C", "user", "config", "user.email"]);
      if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
        throw new StepFailed("no git identity: run `git config --global user.name` and `git config --global user.email`, then re-run `rt home init`");
      }
      const result = await exec.run(["git", "-c", "commit.gpgsign=false", "-C", "user", "commit", "-m", "initial home repo"]);
      // ... existing nothing-to-commit tolerance unchanged ...
```

- [ ] **Step 7: Run tests + type-check**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts lib/home/__tests__/init-exec.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/home/init-exec.ts lib/daemon/__tests__/home-snapshot.test.ts lib/home/__tests__
git commit -m "home-snapshot: diagnose not-provisioned and missing git identity (S090/R043)"
```

---

## Task 8: Timeout on the sops secrets spawn (S070, sops half)

**Files:**
- Modify: `lib/secrets/store.ts` (`createRealSecretsExecSeam`: add timeout/kill + `SecretsTimeoutError`)
- Test: `lib/secrets/__tests__/store.test.ts`

**Interfaces:**
- Produces: `export class SecretsTimeoutError extends Error`.

- [ ] **Step 1: Write the failing test**

Do NOT spawn a real `trap '' TERM; sleep 60` process: the seam's kill is
SIGTERM-only (mirroring age-key), so a SIGTERM-immune child would hang the
test (`proc.exited` never resolves). Instead inject a fake spawn whose child
resolves `exited` only when `kill()` is called (a killable process), so the
timeout timer fires, kills it, and the seam throws:

```ts
import { createRealSecretsExecSeam, SecretsTimeoutError } from "../store.ts";

test("a hanging sops spawn times out with SecretsTimeoutError, does not hang", async () => {
  let resolveExit: (code: number) => void = () => {};
  const fakeProc = {
    pid: 1,
    stdout: new Response("").body,
    stderr: new Response("").body,
    exited: new Promise<number>((r) => { resolveExit = r; }),
    kill: () => resolveExit(143), // killable: kill resolves exit, no real process
  };
  const seam = createRealSecretsExecSeam(undefined, () => fakeProc as any);
  await expect(seam.run(["sops", "-d", "x"], { timeoutMs: 50 } as any))
    .rejects.toBeInstanceOf(SecretsTimeoutError);
}, 2_000);
```

(The contract: a child that does not exit on its own rejects with
`SecretsTimeoutError` within the timeout, and the timer's `kill()` terminates
it. The fake models a real killable process without one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/secrets/__tests__/store.test.ts -t "times out"`
Expected: FAIL (`SecretsTimeoutError` undefined; the call hangs).

- [ ] **Step 3: Add the error + timeout, mirroring `age-key.ts`**

In `lib/secrets/store.ts`, add near the other error classes (after `InvalidSecretsSegmentError`):

```ts
/** Thrown when a sops/keychain spawn does not exit in time (a locked keychain pops a GUI dialog and blocks until clicked). */
export class SecretsTimeoutError extends Error {}

const DEFAULT_SECRETS_TIMEOUT_MS = 30_000;
```

Make the spawn injectable (mirroring how age-key isolates its raw seam for
testability) and wrap the await with the same timer pattern `age-key.ts` uses.
Change the factory signature to accept an optional spawn seam:

```ts
type SecretsSpawn = (argv: string[], opts: any) => {
  stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number>; kill: (sig?: number | string) => void;
};

export function createRealSecretsExecSeam(cwd?: string, spawn: SecretsSpawn = Bun.spawn as unknown as SecretsSpawn): SecretsExecSeam {
  return {
    async run(cmd, opts) {
      debugLog(cmd, opts?.sensitive);
      const [bin, ...args] = cmd;
      const resolved = bin === undefined ? cmd : [resolveBundledTool(bin), ...args];
      const proc = spawn(resolved, buildSecretsSpawnOptions({ env: opts?.env, cwd }));
      const timeoutMs = (opts as { timeoutMs?: number } | undefined)?.timeoutMs ?? DEFAULT_SECRETS_TIMEOUT_MS;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already exited */ } }, timeoutMs);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (timedOut) throw new SecretsTimeoutError(`${cmd[0]}: did not exit within ${timeoutMs}ms (keychain prompt pending?)`);
        return { code, stdout, stderr };
      } finally { clearTimeout(timer); }
    },
    // ... fileExists / listDir / the rest of the seam unchanged ...
  };
}
```

(If `SecretsExecSeam.run`'s opts type has no `timeoutMs`, add it to the interface as optional. The default `spawn` is the real `Bun.spawn`, so production behavior is unchanged; only tests inject a fake.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/secrets/__tests__/store.test.ts -t "times out"`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `bunx tsc --noEmit`

```bash
git add lib/secrets/store.ts lib/secrets/__tests__/store.test.ts
git commit -m "secrets: timeout + SecretsTimeoutError on the sops spawn (S070 sops half)"
```

---

## Task 9: Branch-cache key helpers (S069, part 1 of 2)

**Files:**
- Modify: `lib/state/branch-cache.ts` (add pure helpers + `get`/`getByBranch`; store still bare-keyed here)
- Test: `lib/state/__tests__/branch-cache.test.ts`

**Interfaces:**
- Produces: `export function composeKey(identity: string | undefined, branch: string): string`; `export function branchOf(key: string): string`; `export function identityOf(key: string): string | undefined`; store methods `get(identity: string | undefined, branch: string): CacheEntry | undefined` and `getByBranch(branch: string): CacheEntry | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
import { composeKey, branchOf, identityOf } from "../branch-cache.ts";

test("composeKey/branchOf/identityOf round-trip with a serialized identity", () => {
  const id = "remote:gitlab.com%2Facme%2Facme-dev";
  const k = composeKey(id, "feature/x");
  expect(k).toBe(`${id}:feature/x`);
  expect(branchOf(k)).toBe("feature/x");
  expect(identityOf(k)).toBe(id);
});
test("bare key (no identity) degrades gracefully", () => {
  expect(composeKey(undefined, "main")).toBe("main");
  expect(branchOf("main")).toBe("main");
  expect(identityOf("main")).toBeUndefined();
});
test("branch never contains a colon, so lastIndexOf split is unambiguous", () => {
  const k = composeKey("path:%2FUsers%2Fdev%2Fscratch", "release");
  expect(branchOf(k)).toBe("release");
  expect(identityOf(k)).toBe("path:%2FUsers%2Fdev%2Fscratch");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/state/__tests__/branch-cache.test.ts -t "composeKey"`
Expected: FAIL (helpers missing).

- [ ] **Step 3: Add the helpers + accessors**

In `lib/state/branch-cache.ts`, add module-level:

```ts
/** state.db keys the branch cache on `${serializedIdentity}:${branch}`. Split
 *  on the LAST colon: git branch names contain none, serialized identities
 *  always carry their own (remote:/path:), so this is unambiguous. */
export function composeKey(identity: string | undefined, branch: string): string {
  return identity ? `${identity}:${branch}` : branch;
}
export function branchOf(key: string): string {
  const i = key.lastIndexOf(":");
  return i < 0 ? key : key.slice(i + 1);
}
export function identityOf(key: string): string | undefined {
  const i = key.lastIndexOf(":");
  return i < 0 ? undefined : key.slice(0, i);
}
```

In `createStore`, add to the returned object:

```ts
  function get(identity: string | undefined, branch: string): CacheEntry | undefined {
    return entries[composeKey(identity, branch)];
  }
  function getByBranch(branch: string): CacheEntry | undefined {
    const suffix = `:${branch}`;
    for (const [k, v] of Object.entries(entries)) if (k === branch || k.endsWith(suffix)) return v;
    return undefined;
  }
```

and include `get, getByBranch` in the returned store object and in the `BranchCacheStore` interface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/state/__tests__/branch-cache.test.ts && bunx tsc --noEmit`
Expected: PASS (helpers are additive; store behavior unchanged this task).

- [ ] **Step 5: Commit**

```bash
git add lib/state/branch-cache.ts lib/state/__tests__/branch-cache.test.ts
git commit -m "branch-cache: add composeKey/branchOf/identityOf + get/getByBranch (S069 part 1)"
```

---

## Task 10: Flip branch-cache to the composite key (S069, part 2 of 2) ... ATOMIC

This is the one multi-file atomic change: the store key becomes composite and every direct-lookup consumer switches in the same commit. Intermediate states are not green, so land it as one commit after the whole suite passes. Read contract: every by-branch lookup still resolves a bare branch, scoped to the caller's repo (exact key) or suffix-matched across repos when the repo is unknown; `cache:read`, CLI, board, and tray see bare branch names exactly as before.

**Files:**
- Modify: `lib/state/branch-cache.ts` (`put` keys off `entry.repoName`)
- Modify: `lib/enrich.ts` (cold-start sets `repoName` from identity; `allCached`/lookup use composeKey)
- Modify: `lib/notifier.ts` (loop var is the composite key; `branchOf` only for display)
- Modify: `lib/daemon/worktree-reconciler.ts` (`branchOf(key)` for the bare branch)
- Modify: `lib/daemon/freshness.ts` (direct lookups compose; iterations use `branchOf`)
- Modify: `lib/daemon/handlers/cache.ts` (`cache:read` returns bare-branch keys via suffix-match; optional `repoIdentity`)
- Modify: `commands/status/data.ts` (display `branchOf(row.branch)`)
- Test: add cases to `branch-cache.test.ts`, `enrich` test, `notifier` test, `worktree-reconciler` test, `freshness` test, `cache` handler test.

**Interfaces:**
- Consumes: `composeKey/branchOf/identityOf/getByBranch` (Task 9); `serializeIdentity`, `identityFromRemote` from `lib/settings/identity.ts`.

- [ ] **Step 1: Write the failing tests (collision-safety across all sites)**

```ts
// branch-cache: two repos, same branch, coexist
test("put keys by entry.repoName so same-name branches in two repos coexist", () => {
  const s = makeStore(); // over a temp db
  s.put("main", { repoName: "remote:host%2Fa", ticket: null, linearId: "", mr: null, fetchedAt: 1 });
  s.put("main", { repoName: "remote:host%2Fb", ticket: null, linearId: "", mr: null, fetchedAt: 2 });
  expect(s.get("remote:host%2Fa", "main")!.fetchedAt).toBe(1);
  expect(s.get("remote:host%2Fb", "main")!.fetchedAt).toBe(2);
  expect(Object.keys(s.entries).length).toBe(2);
});

// cache:read returns bare-branch keys
test("cache:read returns bare branch names (suffix match), never composite keys", async () => {
  // seed ctx.cache with a composite-keyed entry, call the handler with branches:["main"]
  const res = await handler["cache:read"]({ branches: ["main"] });
  expect(Object.keys(res.data)).toEqual(["main"]);
});

// notifier: same branch, two repos, independent fired-state
test("evicting one repo's branch does not prune the other repo's fired key", () => {
  // build cacheEntries with composeKey("remote:host%2Fa","main") and ...b/main
  // fire on a's main, then run checkAndNotify with only b/main present
  // assert a's fired key survives (it is keyed by the composite branch var)
});

// reconciler: mrState only from the reconciled repo
test("reactor builds mrState only from the reconciled repo's entries", async () => {
  // cacheEntries has ${A}:main (opened->merged) and ${B}:main (opened)
  // run for repo A; assert only A:main transitions, B untouched
});

// freshness: a branch in two repos resolves to the right repo's entry
test("updateEntry composes the repo-scoped key", () => {
  // seed ${A}:main and ${B}:main; updateEntry(env, A, "main", pr)
  // assert only ${A}:main.mr changed
});
```

(These are the acceptance contracts; the executor fills fixtures using each test file's existing helpers.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/state/__tests__/branch-cache.test.ts lib/daemon/__tests__ lib/__tests__/notifier.test.ts`
Expected: FAIL (collisions overwrite; composite keys not yet used).

- [ ] **Step 3: `branch-cache.ts` ... `put` keys off `entry.repoName`**

In `createStore.put`, derive the key and use it for BOTH the row PK and the map (the `branch` column now stores the composite key; `repo` still stores the identity, so `gc`/`reload`/`delete` keep working transparently since they operate on the `branch` column value):

```ts
  function put(branch: string, entry: CacheEntry): void {
    const key = composeKey(entry.repoName, branch);
    persistOrWarn("branch-cache", () => {
      db.query(UPSERT_SQL).run(
        key,
        entry.repoName ?? null,
        entry.ticket !== null ? JSON.stringify(entry.ticket) : null,
        entry.linearId,
        entry.mr !== null ? JSON.stringify(entry.mr) : null,
        entry.fetchedAt,
      );
    }, { op: "put", branch: key });
    entries[key] = entry;
  }
```

`delete(branch)` callers pass a key that is already the map key; if any caller passes a bare branch, route it through `getByBranch`/`composeKey` at that call site. `gc` is unchanged (it deletes by the `branch` column value, which is now the composite key, and gates on `row.repo` = identity).

- [ ] **Step 4: `enrich.ts` ... cold-start sets identity; lookups compose**

In `fetchAndCache`, compute the identity once and set it on every entry it writes, and in `enrichBranches`'s cached path compose the key:

```ts
import { composeKey } from "./state/branch-cache.ts";
import { serializeIdentity, identityFromRemote } from "./settings/identity.ts";

// inside fetchAndCache: derive identity from remoteUrl (best-effort; undefined if no remote)
const identity = remoteUrl ? serializeIdentity(identityFromRemote(remoteUrl)) : undefined;
// ...when building each CacheEntry, set repoName: identity
// ...store.put(branch, { ...entry, repoName: identity })

// inside enrichBranches cached path:
const allCached = !options?.forceRefresh && willFetch
  && branches.every((b) => composeKey(identity, b.branch) in store.entries);
// ...
const entry = store.entries[composeKey(identity, b.branch)]!;
```

(`enrichBranches` must compute `identity` from its `remoteUrl` the same way, before the cached check.)

- [ ] **Step 5: `notifier.ts` ... composite key through, `branchOf` for display**

`detectBranchTransitions` and the `checkAndNotify` snapshot loop already key `state.branches`, `newBranches`, `firedKey`, and `pruneFiredForEvictedBranches` off the `cacheEntries` map keys. With composite keys those become repo-scoped automatically. The only change: wherever a human-readable branch name is put into a notification message, use `branchOf(key)`. Add `import { branchOf } from "../state/branch-cache.ts";` (adjust path) and apply it at the message-construction sites inside `detectBranchTransitions`.

- [ ] **Step 6: `worktree-reconciler.ts` ... `branchOf(key)` for the bare branch**

In the reactor loop (line 594 onward), the loop key is now the composite key. Derive the bare branch for registry lookups; keep the repo filter:

```ts
  for (const [key, entry] of Object.entries(cacheEntries)) {
    if (entry.repoName && entry.repoName !== repoName) continue;
    if (!entry.mr) continue;
    const branch = branchOf(key);
    // ... `const mrKey = prefix + branch;` (rename the local `key` used for mrState to `mrKey`
    //     to avoid colliding with the composite map key) ...
    // findByBranch(loadRegistry(repoName), branch) and resumeTrees(deps, branch) use the bare branch.
  }
```

Add `import { branchOf } from "../state/branch-cache.ts";`. Rename the existing local `const key = prefix + branch;` to `mrKey` and update its uses (`nextMrState[mrKey]`, `state.mrState[mrKey]`).

- [ ] **Step 7: `freshness.ts` ... compose direct lookups, `branchOf` iterations**

`repoName` here is the serialized identity, so:

```ts
import { composeKey, branchOf } from "../state/branch-cache.ts";

// line 505 branchByIid: iterate, filter entry.repoName !== repoName, store bare branch:
for (const [key, entry] of Object.entries(ctx.cache.entries)) {
  if (entry.repoName !== repoName) continue;
  if (typeof entry.mr?.iid === "number") branchByIid.set(entry.mr.iid, branchOf(key));
}

// line 545: `ctx.cache.entries[pr.sourceBranch]?.repoName === repoName`
//   -> `ctx.cache.entries[composeKey(repoName, pr.sourceBranch)] !== undefined`

// line 579: `const entry = ctx.cache.entries[k.ref];` then `entry.repoName === repoName`
//   -> `const entry = ctx.cache.entries[composeKey(repoName, k.ref)];` (the repoName check is then redundant)

// updateEntry (line 637): compose for both read and write
function updateEntry(env, repoName, branch, pr) {
  const key = composeKey(repoName, branch);
  const existing = env.ctx.cache.entries[key];
  if (!existing) return false;
  env.ctx.cache.put(branch, { ...existing, mr: pr ? toMRInfo(pr) : null, fetchedAt: Date.now(), repoName });
  // ...
}

// applyMRWriteback (657) + runGapFill (703): iterate, filter by entry.repoName, map keys via branchOf,
//   pass bare branch to updateEntry (which recomposes).
```

- [ ] **Step 8: `handlers/cache.ts` ... bare-branch output via suffix-match**

`cache:read` must return bare-branch keys. Accept an optional `repoIdentity` for exact scoping; otherwise suffix-match. Import `branchOf`/`getByBranch` semantics:

```ts
"cache:read": async (payload) => {
  const branches = payload?.branches as string[] | undefined;
  const repoIdentity = payload?.repoIdentity as string | undefined;
  const maxAgeMs = payload?.maxAgeMs as number | undefined;

  const lookup = (b: string): CacheEntry | undefined =>
    repoIdentity ? ctx.cache.entries[`${repoIdentity}:${b}`]
                 : Object.entries(ctx.cache.entries).find(([k]) => k === b || k.endsWith(`:${b}`))?.[1];

  if (typeof maxAgeMs === "number") {
    const pool = branches ?? Object.keys(ctx.cache.entries).map(branchOf);
    let oldest = 0;
    if (pool.length > 0) oldest = Math.min(...pool.map((b) => lookup(b)?.fetchedAt ?? 0));
    if (Date.now() - oldest >= maxAgeMs) await ctx.refreshCache();
  }

  if (!branches) {
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(ctx.cache.entries)) out[branchOf(k)] = v; // bare-branch keyed
    return { ok: true, data: out };
  }
  const filtered: Record<string, CacheEntry> = {};
  for (const b of branches) { const e = lookup(b); if (e) filtered[b] = e; }
  return { ok: true, data: filtered };
},
```

Add `import { branchOf } from "../../state/branch-cache.ts";` (adjust path). `branch:enrich`'s `ctx.cache.entries[branch]` lookups: compose with the payload's repo identity when present, else `getByBranch`-style suffix match.

- [ ] **Step 9: `commands/status/data.ts` ... display bare branch**

In `readBranchesFromStateDb`, key the returned dict by the bare branch:

```ts
import { branchOf } from "../../lib/state/branch-cache.ts";
// ...
for (const row of rows) {
  branches[branchOf(row.branch)] = {
    ticket: row.ticket !== null ? JSON.parse(row.ticket) : null,
    linearId: row.linear_id,
    mr: row.mr !== null ? JSON.parse(row.mr) : null,
    fetchedAt: row.fetched_at,
    repoName: row.repo ?? undefined,
  };
}
```

- [ ] **Step 10: Run the whole affected suite + type-check**

Run: `bun test lib commands packages scripts && bunx tsc --noEmit`
Expected: PASS, zero errors. Confirm `lib/daemon/discussions-poller.ts` needs no change (it iterates `Object.values`, self-healing).

- [ ] **Step 11: Commit (single atomic commit)**

```bash
git add lib/state/branch-cache.ts lib/enrich.ts lib/notifier.ts lib/daemon/worktree-reconciler.ts lib/daemon/freshness.ts lib/daemon/handlers/cache.ts commands/status/data.ts lib/state/__tests__ lib/daemon/__tests__ lib/__tests__/notifier.test.ts commands/__tests__
git commit -m "branch-cache: flip to composite ${identity}:${branch} key; scope all consumers (S069 part 2)"
```

---

## Final verification (run before the whole-branch review)

- [ ] `bun test lib commands packages scripts` green (worktree root).
- [ ] `bunx tsc --noEmit` reports zero errors.
- [ ] `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts e2e/tests/setup.test.ts e2e/tests/first-run.test.ts` green (run full `bun run test:e2e` if practical; record which was run).
- [ ] `lib/__tests__/no-daemon-sync-exec.test.ts` green with the `user-path.ts` allowlist entry removed.
- [ ] `cd packages/rt-client && bun run build && bun test test/dist-freshness.test.ts` green.

## Self-review (author checklist ... completed before saving)

- **Spec coverage:** every spec item maps to a task ... 6.1 → Tasks 1-3; S071 → Task 4; S020/S067 → Task 5; R051 → Task 6; S090/R043 → Task 7; S070 sops → Task 8; S069 → Tasks 9-10.
- **Placeholder scan:** no TBD/TODO; new code is inlined; edit sites carry before/after snippets and exact anchors.
- **Type consistency:** `composeKey/branchOf/identityOf` used identically in Tasks 9-10; `ProbeFn` signature consistent in Task 2; `SkipReason` additions consistent in Task 7.
