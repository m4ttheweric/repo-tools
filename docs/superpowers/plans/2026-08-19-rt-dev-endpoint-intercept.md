# rt dev-endpoint + command interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rt daemon allocates per-worktree dev-server ports from repo-declared role pools and answers `endpoint:*` queries; a generic rt-materialized PATH shim intercepts declared commands so `pnpm start` just works with the right ports and env.

**Architecture:** Two new read-only keys (`roles`, `intercepts`) in the per-repo config document feed a daemon-owned claims store (`endpoints.json` per repo, atomic writes, epoch-guarded). A 3-line sh shim at `~/.local/bin/<command>` execs `rt intercept run`, which matches locally (no daemon hop on passthrough), claims via the daemon on match, renders env, and execs the real binary in the caller's process. `worktree:disposed` releases claims; probing is the crash backstop.

**Tech Stack:** Bun + TypeScript, bun:test, existing daemon handler/command-tree seams. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-rt-dev-endpoint-intercept-design.md` (concrete shapes) + Linear RT-28 (requirements/AC).

## Global Constraints

- Every new CLI module MUST get BOTH edits in `lib/module-registry.ts` (static import + `MODULE_REGISTRY` entry) — the compiled binary has no dynamic import; `lib/__tests__/module-registry.test.ts` enforces it.
- The daemon must be restarted before new handlers exist; e2e spawns its own daemon.
- Never sync-exec on the daemon thread (MAT-222); handlers use async spawn helpers only.
- No outcome logging in handlers — `handleCommand` in `lib/daemon.ts` already logs; feature code logs domain events only via `ctx.log`.
- All state paths go through `lib/rt-paths.ts` helpers (`rtDir()`, `repoDataDir()`); the source-guard test bans `.rt` literals and `join(RT_DIR, repoName, ...)`.
- JSON state uses `lib/json-store.ts` `readJson`/`writeJson` (atomic write-then-rename).
- Any load→`await`→save of the claims file must be epoch-guarded (see `lib/worktree/registry.ts:40-57` for why).
- Do NOT touch `lib/repo-config.ts` (its save path drops unknown keys). New config keys get their own read-only module, per `lib/worktree/config.ts`.
- Interception must fail open: daemon down, no rules, no match, hook failure → the real command runs untouched (stderr notice where relevant).
- `~/.local/bin/rt` belongs to dev mode — never materialize a shim named `rt`.
- Unit tests run under the bunfig HOME-isolation preload; never bypass it.
- After changing `lib/command-tree-def.ts`, run `bun run docs:gen` and commit the regenerated reference docs (`scripts/check-docs.ts` fails CI on drift).
- Commit messages: `RT-28: <lowercase imperative>` with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: endpoint config module (`roles` + `intercepts` keys)

**Files:**
- Create: `lib/endpoint/config.ts`
- Test: `lib/endpoint/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `repoDataDir(repoName)` from `lib/rt-paths.ts`, `readJson` from `lib/json-store.ts`.
- Produces (later tasks rely on these exact names):

```ts
export interface RoleConfig {
  pool: number[];                       // flattened, ascending, deduped; [] = non-allocating
  fixedPort?: number;                   // non-allocating role (frontend)
  needs: string[];                      // role references, default []
  preserveEnv: string[];                // caller env vars to protect; trailing * = prefix match
  env: Record<string, string>;          // templates: ${port}, ${roles.<name>.port}
  hook?: string;                        // command string, run by the interceptor, fail-open
}
export interface ArgInject { afterArg: string; template: string; skipIfArgPresent: string }
export interface InterceptMatch { cwdGlob: string; argPattern?: string; role: string; argInject?: ArgInject }
export interface InterceptConfig { command: string; matches: InterceptMatch[] }
export interface EndpointRepoConfig { roles: Record<string, RoleConfig>; intercepts: InterceptConfig[] }
export function loadEndpointRepoConfig(repoName: string): EndpointRepoConfig
```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/endpoint/__tests__/config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoDataDir } from "../../rt-paths.ts";
import { loadEndpointRepoConfig } from "../config.ts";

function writeRepoConfig(repo: string, obj: unknown): void {
  const dir = repoDataDir(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

describe("loadEndpointRepoConfig", () => {
  test("missing file yields empty config", () => {
    const cfg = loadEndpointRepoConfig("no-such-repo");
    expect(cfg.roles).toEqual({});
    expect(cfg.intercepts).toEqual([]);
  });

  test("flattens ranges, sorts and dedupes pools, applies defaults", () => {
    writeRepoConfig("r1", {
      roles: { backend: { pool: [{ from: 10402, to: 10404 }, 10400, 10400] } },
    });
    const cfg = loadEndpointRepoConfig("r1");
    expect(cfg.roles.backend.pool).toEqual([10400, 10402, 10403, 10404]);
    expect(cfg.roles.backend.needs).toEqual([]);
    expect(cfg.roles.backend.preserveEnv).toEqual([]);
    expect(cfg.roles.backend.env).toEqual({});
  });

  test("drops malformed entries instead of throwing", () => {
    writeRepoConfig("r2", {
      roles: { ok: { fixedPort: 4002 }, bad: "nope" },
      intercepts: [{ command: "doppler", matches: [{ cwdGlob: "apps/x/**", role: "ok" }] }, { matches: [] }],
    });
    const cfg = loadEndpointRepoConfig("r2");
    expect(Object.keys(cfg.roles)).toEqual(["ok"]);
    expect(cfg.roles.ok.fixedPort).toBe(4002);
    expect(cfg.intercepts).toHaveLength(1);
    expect(cfg.intercepts[0].command).toBe("doppler");
  });

  test("coexists with other keys in the same document (worktrees, setup)", () => {
    writeRepoConfig("r3", { setup: [], worktrees: { onDeck: 2 }, roles: { web: { pool: [3000] } } });
    expect(loadEndpointRepoConfig("r3").roles.web.pool).toEqual([3000]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/endpoint/__tests__/config.test.ts`
Expected: FAIL — cannot resolve `../config.ts`.

- [ ] **Step 3: Implement `lib/endpoint/config.ts`**

Follow `lib/worktree/config.ts` verbatim in spirit: header comment stating this module reads ONLY the `roles`/`intercepts` keys of the shared per-repo config.json and never writes it. Shape:

```ts
import { join } from "node:path";
import { readJson } from "../json-store.ts";
import { repoDataDir } from "../rt-paths.ts";

interface RawRepoConfigFile { roles?: Record<string, unknown>; intercepts?: unknown[] }

function flattenPool(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const item of raw) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) out.add(item);
    else if (item && typeof item === "object") {
      const { from, to } = item as { from?: unknown; to?: unknown };
      if (typeof from === "number" && typeof to === "number" && to >= from) {
        for (let p = from; p <= to; p++) out.add(p);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}
```

`sanitizeRole(raw)` returns `RoleConfig | null` (null for non-objects; defaults `needs: []`, `preserveEnv: []`, `env: {}`; keep only string entries in arrays, only string values in `env`; `hook` only if non-empty string; `fixedPort` only positive integer). `sanitizeIntercept(raw)` requires non-empty string `command` and an array `matches`, each match requiring string `cwdGlob` and string `role`; `argPattern` kept if a string that compiles under `new RegExp` (wrap in try/catch, drop on error); `argInject` kept only with all three string fields. `loadEndpointRepoConfig` = `readJson<RawRepoConfigFile>(join(repoDataDir(repoName), "config.json"), {})`, then sanitize both keys.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test lib/endpoint/__tests__/config.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/endpoint/config.ts lib/endpoint/__tests__/config.test.ts
git commit -m "RT-28: endpoint config module — roles + intercepts keys of the repo config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: claims store with epoch guard

**Files:**
- Create: `lib/endpoint/store.ts`
- Test: `lib/endpoint/__tests__/store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface EndpointClaim { worktree: string; role: string; port: number; pid?: number; ts: string }
export function endpointsPath(repoName: string): string;           // join(repoDataDir(repoName), "endpoints.json")
export function loadClaims(repoName: string): EndpointClaim[];
export function saveClaims(repoName: string, claims: EndpointClaim[]): void;  // bumps epoch
export function claimsEpoch(repoName: string): number;
```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/endpoint/__tests__/store.test.ts
import { describe, expect, test } from "bun:test";
import { claimsEpoch, loadClaims, saveClaims } from "../store.ts";

describe("claims store", () => {
  test("load on missing file returns empty and tolerates junk", () => {
    expect(loadClaims("fresh-repo")).toEqual([]);
  });

  test("round-trips claims atomically and bumps the epoch", () => {
    const before = claimsEpoch("r1");
    const claim = { worktree: "/tmp/wt-a", role: "backend", port: 10400, pid: 123, ts: new Date().toISOString() };
    saveClaims("r1", [claim]);
    expect(loadClaims("r1")).toEqual([claim]);
    expect(claimsEpoch("r1")).toBe(before + 1);
  });

  test("epochs are per-repo", () => {
    const r2 = claimsEpoch("r2");
    saveClaims("r3", []);
    expect(claimsEpoch("r2")).toBe(r2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test lib/endpoint/__tests__/store.test.ts` fails on missing module.

- [ ] **Step 3: Implement `lib/endpoint/store.ts`**

Copy `lib/worktree/registry.ts`'s structure exactly (including its epoch rationale comment, adapted): file shape `{ claims: EndpointClaim[] }`, `readJson<Partial<{claims: EndpointClaim[]}>>(path, { claims: [] })` with an `Array.isArray` guard and per-entry shape filter (string worktree/role, integer port), `writeJson(path, { claims })`, module-level `const epochs = new Map<string, number>()` bumped in `saveClaims`, `claimsEpoch(repo) => epochs.get(repo) ?? 0`.

- [ ] **Step 4: Run tests** — PASS. Also run `bun test lib/__tests__/rt-paths.test.ts` (source guard) to confirm no banned path construction.

- [ ] **Step 5: Commit**

```bash
git add lib/endpoint/store.ts lib/endpoint/__tests__/store.test.ts
git commit -m "RT-28: endpoints claims store — atomic json, per-repo epoch guard

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: allocator (the dev-ports lessons, generically)

**Files:**
- Create: `lib/endpoint/allocator.ts`
- Test: `lib/endpoint/__tests__/allocator.test.ts`

**Interfaces:**
- Consumes: `EndpointClaim` (Task 2), `RoleConfig` (Task 1).
- Produces:

```ts
export interface Probes {
  listeners: Set<number>;                       // ports currently LISTENing
  pidAlive(pid: number | undefined): boolean;   // kill(0); EPERM counts alive
  canBind(port: number): boolean;               // bind-probe (DECK-9)
}
export function isLiveClaim(c: EndpointClaim, probes: Probes): boolean;
export function pruneDeadClaims(claims: EndpointClaim[], selfWorktree: string, probes: Probes): { claims: EndpointClaim[]; pruned: boolean };
export interface ClaimResult { port: number; claims: EndpointClaim[]; changed: boolean }
export function resolveClaim(
  claims: EndpointClaim[],
  role: string, roleCfg: RoleConfig,
  worktree: string, pid: number | undefined,
  probes: Probes,
): ClaimResult | { error: string };
export function releaseWorktree(claims: EndpointClaim[], worktree: string, role?: string): { claims: EndpointClaim[]; released: EndpointClaim[] };
export function defaultProbes(): Promise<Probes>;   // lsof listeners + kill(0) + real bind attempt
```

- [ ] **Step 1: Write the failing tests** — these encode the verbatim lessons; keep the comments:

```ts
// lib/endpoint/__tests__/allocator.test.ts
import { describe, expect, test } from "bun:test";
import type { EndpointClaim } from "../store.ts";
import { isLiveClaim, pruneDeadClaims, releaseWorktree, resolveClaim } from "../allocator.ts";

const role = { pool: [4001, 5001, 6001], needs: [], preserveEnv: [], env: {} };
const probes = (over: Partial<{ listeners: number[]; alive: number[]; unbindable: number[] }> = {}) => ({
  listeners: new Set(over.listeners ?? []),
  pidAlive: (pid?: number) => (over.alive ?? []).includes(pid ?? -1),
  canBind: (p: number) => !(over.unbindable ?? []).includes(p),
});
const claim = (worktree: string, port: number, pid?: number): EndpointClaim =>
  ({ worktree, role: "adjuster", port, pid, ts: "2026-08-19T00:00:00Z" });

describe("resolveClaim", () => {
  test("first worktree gets the lowest bindable pool port", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 111, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims[0]).toMatchObject({ worktree: "/wt/a", role: "adjuster", port: 4001, pid: 111 });
  });

  test("sticky: same worktree re-asks and gets its port back, pid re-stamped", () => {
    const existing = [claim("/wt/a", 4001, 111)];
    const r = resolveClaim(existing, "adjuster", role, "/wt/a", 222, probes({ alive: [111] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.find((c) => c.worktree === "/wt/a")?.pid).toBe(222);
  });

  test("second worktree skips a port owned by a LIVE claim (boot window: pid alive, port not listening yet)", () => {
    const existing = [claim("/wt/a", 4001, 111)];
    const r = resolveClaim(existing, "adjuster", role, "/wt/b", 222, probes({ alive: [111] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("a dead claim's port is reusable, and the dead OTHER-worktree row is pruned", () => {
    const existing = [claim("/wt/a", 4001, 111)]; // pid dead, port silent
    const r = resolveClaim(existing, "adjuster", role, "/wt/b", 222, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
    expect(r.claims.some((c) => c.worktree === "/wt/a")).toBe(false);
  });

  test("a foreign listener (no claim) blocks a port even when bindable-looking", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 1, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("own listening port is reusable on restart (self-claim survival)", () => {
    const existing = [claim("/wt/a", 4001)]; // no pid recorded, but the port listens = ours, live
    const r = resolveClaim(existing, "adjuster", role, "/wt/a", 9, probes({ listeners: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4001);
  });

  test("bind-probe veto: claimed-nothing, listening-nothing, but unbindable → skipped", () => {
    const r = resolveClaim([], "adjuster", role, "/wt/a", 1, probes({ unbindable: [4001] }));
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(5001);
  });

  test("pool exhaustion names the role", () => {
    const r = resolveClaim([], "adjuster", { ...role, pool: [4001] }, "/wt/b", 2, probes({ listeners: [4001] }));
    expect(r).toEqual({ error: 'no free port in pool for role "adjuster" (1 declared, 0 free)' });
  });

  test("fixedPort role allocates nothing and returns the fixed port", () => {
    const r = resolveClaim([], "frontend", { pool: [], fixedPort: 4002, needs: [], preserveEnv: [], env: {} }, "/wt/a", 1, probes());
    if ("error" in r) throw new Error(r.error);
    expect(r.port).toBe(4002);
    expect(r.claims).toEqual([]);
    expect(r.changed).toBe(false);
  });
});

describe("releaseWorktree", () => {
  test("releases all roles for a worktree, or one role when named", () => {
    const claims = [claim("/wt/a", 4001), { ...claim("/wt/a", 10400), role: "backend" }, claim("/wt/b", 5001)];
    const all = releaseWorktree(claims, "/wt/a");
    expect(all.released).toHaveLength(2);
    expect(all.claims).toHaveLength(1);
    const one = releaseWorktree(claims, "/wt/a", "backend");
    expect(one.released.map((c) => c.role)).toEqual(["backend"]);
  });
});

describe("liveness (verbatim lessons)", () => {
  test("no TTLs: an ancient claim with a live pid is live", () => {
    expect(isLiveClaim({ ...claim("/wt/a", 4001, 111), ts: "2020-01-01T00:00:00Z" }, probes({ alive: [111] }))).toBe(true);
  });
  test("pruneDeadClaims spares self even when dead-looking", () => {
    const { claims } = pruneDeadClaims([claim("/wt/a", 4001)], "/wt/a", probes());
    expect(claims).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `lib/endpoint/allocator.ts`**

Pure logic, probes injected. Port the shim's semantics: `isLiveClaim = listeners.has(port) || pidAlive(pid)`. `pruneDeadClaims` skips `selfWorktree`. `resolveClaim`: fixedPort roles return `{ port: fixedPort, claims, changed: false }` immediately. Otherwise prune, compute `blocked` = ports of OTHER worktrees' live claims ∪ listeners that are not the self-claim's own port ∪ pool ports failing `canBind` (only probe candidates actually considered, in pool order, stop at first success). Reuse the self claim's port when unblocked; else lowest available; always re-stamp `{ pid, ts }` on the winning claim (`changed: true`). Exhaustion error message exactly as tested. `defaultProbes()`: listeners via the exported `parseListeningLsof` from `lib/port-scanner.ts` over an async `lsof -nP -iTCP -sTCP:LISTEN` spawn (never sync); `pidAlive` via `process.kill(pid, 0)` catching EPERM-as-alive; `canBind` via a real `Bun.listen({ hostname: "127.0.0.1", port })` try/close/catch.

- [ ] **Step 4: Run tests** — `bun test lib/endpoint/` all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/endpoint/allocator.ts lib/endpoint/__tests__/allocator.test.ts
git commit -m "RT-28: allocator — sticky lowest-available claims, probe-verified, lessons preserved

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: daemon handlers + disposal release

**Files:**
- Create: `lib/daemon/handlers/endpoint.ts`
- Modify: `lib/daemon/command-router.ts` (spread new factory), `lib/daemon.ts` (extend the `emit` composite)
- Test: `lib/daemon/__tests__/endpoint-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 exports.
- Produces:

```ts
export function createEndpointHandlers(ctx: HandlerContext, deps?: { probes?: () => Promise<Probes> }): HandlerMap & {
  // exposed for the daemon's disposal fan-out:
  releaseForWorktree(repo: string, worktreePath: string): void;
};
// commands: endpoint:claim {repo, worktree, role, pid?} → { ok, data: { role, port, url, refs } }
//   refs: Record<string, { port: number; url: string; running: boolean }> for roleCfg.needs
//   (a needed role with no claim gets a claim allocated too — refs must be stable before env renders)
// endpoint:lookup {repo, worktree, role} → { ok, data: { claimed, port|null, url|null, running } }
// endpoint:release {repo, worktree, role?} → { ok, data: { released: number } }
// endpoint:status {repo?} → { ok, data: { repos: Record<string, Array<EndpointClaim & { running: boolean }>> } }
```

- [ ] **Step 1: Write the failing tests** — direct factory calls, stub ctx, fake probes (the `events-handlers.test.ts` pattern):

```ts
// lib/daemon/__tests__/endpoint-handlers.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { repoDataDir } from "../../rt-paths.ts";
import { loadClaims } from "../../endpoint/store.ts";
import { createEndpointHandlers } from "../handlers/endpoint.ts";
import type { HandlerContext } from "../handlers/types.ts";

const ctx = { log: pino({ level: "silent" }) } as unknown as HandlerContext;
const fakeProbes = async () => ({ listeners: new Set<number>(), pidAlive: () => true, canBind: () => true });

function declareRoles(repo: string): void {
  mkdirSync(repoDataDir(repo), { recursive: true });
  writeFileSync(join(repoDataDir(repo), "config.json"), JSON.stringify({
    roles: {
      backend: { pool: [{ from: 10400, to: 10402 }], env: { PORT: "${port}" } },
      adjuster: { pool: [4001, 5001], needs: ["backend"] },
    },
  }));
}

describe("endpoint handlers", () => {
  let handlers: ReturnType<typeof createEndpointHandlers>;
  beforeEach(() => { handlers = createEndpointHandlers(ctx, { probes: fakeProbes }); });

  test("claim allocates, lookup sees it, refs pull the needed role into existence", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "adjuster", pid: 7 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(4001);
    expect(r.data.url).toBe("http://localhost:4001");
    expect(r.data.refs.backend.port).toBe(10400);
    const lk = await handlers["endpoint:lookup"]({ repo: "repoA", worktree: "/wt/a", role: "backend" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10400 });
  });

  test("unknown role and unknown repo fail with named errors", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "nope" });
    expect(r).toMatchObject({ ok: false, error: 'role "nope" is not declared for repo "repoA"' });
  });

  test("release by worktree frees claims; releaseForWorktree does the same (disposal path)", async () => {
    declareRoles("repoB");
    await handlers["endpoint:claim"]({ repo: "repoB", worktree: "/wt/x", role: "backend", pid: 1 });
    handlers.releaseForWorktree("repoB", "/wt/x");
    expect(loadClaims("repoB")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`createEndpointHandlers(ctx, deps)`: probes resolver defaults to `defaultProbes`. `endpoint:claim` flow, epoch-guarded exactly like `patchTree`: `const epoch = claimsEpoch(repo)` AFTER `const probes = await probesFn()` and `const claims = loadClaims(repo)`... note the await must come FIRST, then load+epoch+mutate+save synchronously: reorder to (1) `await probesFn()`, (2) load claims + capture epoch, (3) run `resolveClaim` for the target role, then for each `needs` role not yet claimed by this worktree run `resolveClaim` against the accumulating claims array (all synchronous), (4) if epoch unchanged `saveClaims`, else reload and redo step 3 once (single retry is enough: same event loop). Build `refs` from the final claims + `probes.listeners` for `running`. URL = `http://localhost:${port}`. Domain log: `ctx.log.debug({ repo, worktree, role, port }, "endpoint claimed")` only on `changed`. `endpoint:release` uses `releaseWorktree`; `releaseForWorktree` is the same body with `{ ok }` swallowed (it's fire-and-forget from the disposal fan-out) but logs released counts at `info`. `endpoint:status` maps claims through `isLiveClaim`. Wire into `buildRoutedHandlers` in `command-router.ts`: `const endpointHandlers = createEndpointHandlers(ctx); return { ...existing, ...endpointHandlers }` — but `releaseForWorktree` must NOT enter the handler map: destructure it out and re-expose it on the return value of `buildRoutedHandlers` via a new field in its options/return plumbing; simplest: `command-router.ts` accepts nothing new, and `daemon.ts` creates the endpoint factory itself, passes its `HandlerMap` part into `buildRoutedHandlers` via a new `extraHandlers` option — NO. Keep it simple and explicit: `createEndpointHandlers` returns the map with `releaseForWorktree` attached as a non-enumerable property is too clever. Do this instead: export TWO functions from `handlers/endpoint.ts`:

```ts
export function createEndpointHandlers(ctx: HandlerContext, deps?): HandlerMap;
export function releaseEndpointsForWorktree(ctx: Pick<HandlerContext, "log">, repo: string, worktreePath: string): void;
```

(the release helper loads/saves the store directly; no shared instance state exists, the file is the state). In `daemon.ts`, extend the composite at the `emit` definition:

```ts
const emit: typeof broadcast = (type, data) => {
  broadcast(type, data);
  cron.onBroadcast(type, data);
  if (type === "worktree:disposed") {
    const d = data as { repo?: string; path?: string };
    if (d?.repo && d?.path) releaseEndpointsForWorktree({ log }, d.repo, d.path);
  }
};
```

Update the test to import `releaseEndpointsForWorktree` instead of a method.

- [ ] **Step 4: Run tests** — `bun test lib/daemon/__tests__/endpoint-handlers.test.ts` PASS, plus `bun test lib/daemon` (router exhaustiveness stays green: these are HandlerMap commands, not cataloged) and `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/handlers/endpoint.ts lib/daemon/command-router.ts lib/daemon.ts lib/daemon/__tests__/endpoint-handlers.test.ts
git commit -m "RT-28: endpoint:claim/lookup/release/status handlers; disposal frees claims

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: env rendering, preserveEnv, argInject, role hook

**Files:**
- Create: `lib/endpoint/env.ts`
- Test: `lib/endpoint/__tests__/env.test.ts`

**Interfaces:**
- Consumes: `RoleConfig`, `ArgInject` (Task 1).
- Produces:

```ts
export interface ResolvedAllocation { role: string; port: number; refs: Record<string, { port: number; url: string; running: boolean }> }
export function renderEnvTemplates(env: Record<string, string>, alloc: ResolvedAllocation): Record<string, string>;
export function collectPreservedKeys(preserveEnv: string[], callerEnv: Record<string, string | undefined>): string[];
export function applyArgInject(args: string[], inject: ArgInject | undefined, envKeys: string[]): string[];
export interface HookInput { worktree: string; role: string; port: number; refs: ResolvedAllocation["refs"]; env: Record<string, string> }
export async function runRoleHook(hook: string, input: HookInput, timeoutMs?: number): Promise<{ env?: Record<string, string> } | null>; // null on ANY failure (fail-open)
```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/endpoint/__tests__/env.test.ts
import { describe, expect, test } from "bun:test";
import { applyArgInject, collectPreservedKeys, renderEnvTemplates, runRoleHook } from "../env.ts";

const alloc = { role: "adjuster", port: 5001, refs: { backend: { port: 10400, url: "http://localhost:10400", running: true } } };

test("renders ${port} and ${roles.X.port}; unknown refs render empty and warn-free", () => {
  expect(renderEnvTemplates({ PORT: "${port}", EP: "http://localhost:${roles.backend.port}", BAD: "${roles.nope.port}" }, alloc))
    .toEqual({ PORT: "5001", EP: "http://localhost:10400", BAD: "" });
});

test("collectPreservedKeys keeps exact names and expands trailing-star prefixes, present-only", () => {
  const caller = { POSTGRES_URL: "x", FEATURE_FLAG_A: "1", FEATURE_FLAG_B: "", OTHER: "y" };
  expect(collectPreservedKeys(["POSTGRES_URL", "FEATURE_FLAG_*", "MISSING"], caller))
    .toEqual(["POSTGRES_URL", "FEATURE_FLAG_A", "FEATURE_FLAG_B"]);
});

test("applyArgInject inserts after the anchor arg unless the skip marker is present", () => {
  expect(applyArgInject(["run", "--", "pnpm", "start"], { afterArg: "run", template: "--preserve-env=${envKeys}", skipIfArgPresent: "--preserve-env" }, ["PORT", "POSTGRES_URL"]))
    .toEqual(["run", "--preserve-env=PORT,POSTGRES_URL", "--", "pnpm", "start"]);
  expect(applyArgInject(["run", "--preserve-env=X", "cmd"], { afterArg: "run", template: "--preserve-env=${envKeys}", skipIfArgPresent: "--preserve-env" }, ["PORT"]))
    .toEqual(["run", "--preserve-env=X", "cmd"]);
});

test("runRoleHook round-trips JSON and fails open on a broken hook", async () => {
  const echo = await runRoleHook(`bun -e 'const i=await new Response(Bun.stdin.stream()).json(); console.log(JSON.stringify({env:{HOOKED: String(i.port)}}))'`,
    { worktree: "/wt/a", role: "adjuster", port: 5001, refs: {}, env: {} });
  expect(echo).toEqual({ env: { HOOKED: "5001" } });
  expect(await runRoleHook("false", { worktree: "/w", role: "r", port: 1, refs: {}, env: {} })).toBeNull();
  expect(await runRoleHook("sleep 30", { worktree: "/w", role: "r", port: 1, refs: {}, env: {} }, 200)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `lib/endpoint/env.ts`**

`renderEnvTemplates`: single-pass `value.replace(/\$\{port\}|\$\{roles\.([A-Za-z0-9_-]+)\.port\}/g, ...)`. `collectPreservedKeys`: exact match on `callerEnv` own keys (value may be empty string, only `undefined` is absent); trailing `*` = prefix. `applyArgInject`: skip when any arg equals or starts with `skipIfArgPresent`; otherwise splice `template.replace("${envKeys}", envKeys.join(","))` after the first arg equal to `afterArg` (anchor absent → return args unchanged). `runRoleHook`: `Bun.spawn(["sh", "-c", hook], { stdin: JSON.stringify(input), stdout: "pipe", stderr: "pipe" })`, race against `timeoutMs` (default 5000, kill on timeout), parse stdout JSON, return `{ env }` only if it's an object of string values; ANY throw/nonzero/parse-fail → `null`.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/endpoint/env.ts lib/endpoint/__tests__/env.test.ts
git commit -m "RT-28: env templates, preserveEnv expansion, argInject, fail-open role hook

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: intercept rules file, shim render/install, matching

**Files:**
- Create: `lib/endpoint/shim.ts`
- Test: `lib/endpoint/__tests__/shim.test.ts`

**Interfaces:**
- Consumes: `loadEndpointRepoConfig` (Task 1), repo index via `readJson(join(rtDir(), "repos.json"), ...)` — mirror how `lib/port-scanner.ts:loadRepoIndex` reads it.
- Produces:

```ts
export interface InterceptRule { command: string; repo: string; repoRemote: string | null; matches: InterceptMatch[] }
export function interceptsPath(): string;                          // join(rtDir(), "intercepts.json")
export function buildInterceptRules(): InterceptRule[];            // repo index × per-repo config; skips repos with no intercepts
export function writeInterceptRules(rules: InterceptRule[]): void; // writeJson
export function loadInterceptRules(): InterceptRule[];
export function shimPath(command: string): string;                 // ~/.local/bin/<command>; throws on "rt" or path separators
export function renderInterceptShim(command: string): string;      // pure; unit-tested
export function installShims(): { installed: string[]; current: string[]; rules: number };
export function uninstallShims(): { removed: string[] };
export function matchInvocation(rules: InterceptRule[], inv: { command: string; args: string[]; cwd: string; toplevel: string | null; remote: string | null }):
  { rule: InterceptRule; match: InterceptMatch } | null;
export function shimReport(): Array<{ command: string; repo: string; installed: boolean; current: boolean }>; // verify probe
```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/endpoint/__tests__/shim.test.ts
import { describe, expect, test } from "bun:test";
import { matchInvocation, renderInterceptShim, shimPath } from "../shim.ts";

test("renderInterceptShim is a sh exec into rt intercept run with a bypass guard", () => {
  const s = renderInterceptShim("doppler");
  expect(s.startsWith("#!/bin/sh\n")).toBe(true);
  expect(s).toContain("# rt intercept shim — generated; do not edit (rt intercept install)");
  expect(s).toContain('[ -n "$RT_INTERCEPT_BYPASS" ]');
  expect(s).toContain('exec rt intercept run doppler -- "$@"');
});

test("shimPath refuses the rt name and path separators", () => {
  expect(() => shimPath("rt")).toThrow();
  expect(() => shimPath("a/b")).toThrow();
  expect(shimPath("doppler").endsWith("/.local/bin/doppler")).toBe(true);
});

const rules = [{
  command: "doppler", repo: "assured-dev", repoRemote: "git@x:assured/assured-dev.git",
  matches: [{ cwdGlob: "apps/backend{,/**}", argPattern: "src/app/server", role: "backend" }],
}];

describe("matchInvocation", () => {
  const base = { command: "doppler", args: ["run", "--", "bun", "src/app/server.ts"], cwd: "/wt/a/apps/backend", toplevel: "/wt/a", remote: "git@x:assured/assured-dev.git" };
  test("hits on cwdGlob + argPattern + remote", () => {
    expect(matchInvocation(rules, base)?.match.role).toBe("backend");
  });
  test("misses on wrong remote, no toplevel, wrong dir, non-matching args, unknown command", () => {
    expect(matchInvocation(rules, { ...base, remote: "git@x:other/repo.git" })).toBeNull();
    expect(matchInvocation(rules, { ...base, toplevel: null })).toBeNull();
    expect(matchInvocation(rules, { ...base, cwd: "/wt/a/apps/adjuster" })).toBeNull();
    expect(matchInvocation(rules, { ...base, args: ["run", "--", "jest"] })).toBeNull();
    expect(matchInvocation(rules, { ...base, command: "pnpm" })).toBeNull();
  });
  test("null repoRemote in the rule skips the remote check (repo never had one recorded)", () => {
    expect(matchInvocation([{ ...rules[0], repoRemote: null }], { ...base, remote: null })?.match.role).toBe("backend");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `lib/endpoint/shim.ts`**

`renderInterceptShim`:

```ts
export function renderInterceptShim(command: string): string {
  return [
    "#!/bin/sh",
    "# rt intercept shim — generated; do not edit (rt intercept install)",
    `[ -n "$RT_INTERCEPT_BYPASS" ] && exec ${realResolverLine(command)}`,
    `exec rt intercept run ${command} -- "$@"`,
    "",
  ].join("\n");
}
```

where `realResolverLine` inlines a POSIX loop over `$PATH` skipping the shim's own path (same trick as the old shim's `realDoppler`, but in sh; document it in the header comment). Actually simpler and sufficient: the bypass line execs `rt intercept run` too, and BYPASS handling lives in one place (TypeScript); the sh file stays 4 lines with no loop — adjust the test's third expectation to `expect(s).toContain('RT_INTERCEPT_BYPASS')` only if you take this route, and keep bypass semantics in `interceptRun` (Task 7). Prefer this route.

`buildInterceptRules`: read the repo index the way `lib/port-scanner.ts:loadRepoIndex` does, for each repo `loadEndpointRepoConfig(name)`, flatten each `intercepts[]` entry into an `InterceptRule` with `repoRemote` = `git -C <repoPath> config --get remote.origin.url` (async capture, trimmed, null on failure). `matchInvocation`: command equality; toplevel required; remote check only when the rule carries one (`rule.repoRemote && rule.repoRemote !== inv.remote → skip rule`); `cwdGlob` matched with `Bun.Glob` against `relative(toplevel, cwd)` (normalize `""` → `"."`); `argPattern` tested against `args.join(" ")` via `new RegExp`. `installShims`: build rules, `writeInterceptRules`, then for each distinct command `writeFileSync(shimPath(cmd), renderInterceptShim(cmd), { mode: 0o755 })` (mkdir `~/.local/bin` recursive first), classifying `installed` vs `current` (existing content already equal). `uninstallShims` removes only files whose content contains the generated marker line. `shimReport` compares on-disk content to the render for every rule command.

- [ ] **Step 4: Run tests** — PASS, plus source-guard suite.

- [ ] **Step 5: Commit**

```bash
git add lib/endpoint/shim.ts lib/endpoint/__tests__/shim.test.ts
git commit -m "RT-28: intercept rules file, shim render/install, invocation matching

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `rt intercept` + `rt endpoint` CLI verbs

**Files:**
- Create: `commands/intercept.ts`, `commands/endpoint.ts`
- Modify: `lib/command-tree-def.ts`, `lib/module-registry.ts` (BOTH edits × 2 modules)
- Test: `lib/endpoint/__tests__/intercept-run.test.ts` (the extracted core), existing `lib/__tests__/module-registry.test.ts` must stay green
- Modify: regenerate docs (`bun run docs:gen`)

**Interfaces:**
- Consumes: Tasks 1-6 exports, `daemonQuery` from `lib/daemon-client.ts` (returns `null` when the daemon is down — that IS the fail-open branch).
- Produces:

```ts
// commands/intercept.ts
export async function interceptRun(args: string[]): Promise<void>;      // hidden verb the shim execs
export async function interceptStatus(args: string[]): Promise<void>;   // human + --json
export async function interceptInstall(args: string[]): Promise<void>;
export async function interceptUninstall(args: string[]): Promise<void>;
// commands/endpoint.ts
export async function endpointLookup(args: string[]): Promise<void>;    // rt endpoint lookup <role> [--json]
// lib/endpoint/run.ts (extracted, testable core)
export interface RunDeps {
  rules: InterceptRule[];
  gitToplevel(cwd: string): Promise<string | null>;
  gitRemote(toplevel: string): Promise<string | null>;
  claim(payload: { repo: string; worktree: string; role: string; pid: number }): Promise<any | null>; // daemonQuery shape
  execReal(bin: string, args: string[], env: Record<string, string>): Promise<never>;
  resolveRealBinary(command: string): string | null;
  warn(msg: string): void;
}
export async function runInterception(deps: RunDeps, command: string, args: string[], cwd: string, callerEnv: Record<string, string | undefined>, pid: number): Promise<never>;
```

- [ ] **Step 1: Write the failing tests for the core**

```ts
// lib/endpoint/__tests__/intercept-run.test.ts
import { describe, expect, test } from "bun:test";
import { runInterception } from "../run.ts";

function harness(over: Partial<Parameters<typeof runInterception>[0]> = {}) {
  const calls: { exec?: { bin: string; args: string[]; env: Record<string, string> }; warned: string[] } = { warned: [] };
  const deps = {
    rules: [{ command: "fakecmd", repo: "r1", repoRemote: null,
      matches: [{ cwdGlob: ".", argPattern: "serve", role: "web",
        argInject: { afterArg: "run", template: "--keep=${envKeys}", skipIfArgPresent: "--keep" } }] }],
    gitToplevel: async () => "/wt/a",
    gitRemote: async () => null,
    claim: async () => ({ ok: true, data: { role: "web", port: 3000, url: "http://localhost:3000", refs: {} } }),
    execReal: async (bin: string, args: string[], env: Record<string, string>) => { calls.exec = { bin, args, env }; throw new Error("EXEC"); },
    resolveRealBinary: () => "/usr/bin/fakecmd",
    warn: (m: string) => calls.warned.push(m),
    ...over,
  };
  return { deps, calls };
}
const run = (deps: any, args: string[], env: Record<string, string | undefined> = {}) =>
  runInterception(deps, "fakecmd", args, "/wt/a", { PATH: "/usr/bin", ...env }, 42).catch((e) => { if (e.message !== "EXEC") throw e; });

// NOTE: repo config for role "web" is read via loadEndpointRepoConfig inside runInterception's env step —
// write it in the test HOME like Task 1's writeRepoConfig, with env: { PORT: "${port}" } and preserveEnv: ["KEEP_*"].

describe("runInterception", () => {
  test("match → claim → env rendered, preserveEnv expanded into argInject, exec real", async () => {
    // (declare repo r1 config first — see NOTE)
    const { deps, calls } = harness();
    await run(deps, ["run", "serve"], { KEEP_ME: "1" });
    expect(calls.exec!.bin).toBe("/usr/bin/fakecmd");
    expect(calls.exec!.args).toEqual(["run", "--keep=PORT,KEEP_ME", "serve"]);
    expect(calls.exec!.env.PORT).toBe("3000");
    expect(calls.exec!.env.KEEP_ME).toBe("1");
  });
  test("no match → exec real untouched, no claim call", async () => {
    let claimed = false;
    const { deps, calls } = harness({ claim: async () => { claimed = true; return null; } });
    await run(deps, ["run", "test"]);
    expect(claimed).toBe(false);
    expect(calls.exec!.args).toEqual(["run", "test"]);
  });
  test("daemon down (claim → null) → warn once and exec real untouched", async () => {
    const { deps, calls } = harness({ claim: async () => null });
    await run(deps, ["run", "serve"]);
    expect(calls.warned.some((w) => w.includes("passthrough"))).toBe(true);
    expect(calls.exec!.args).toEqual(["run", "serve"]);
  });
  test("real binary unresolvable → hard error (never exec the shim recursively)", async () => {
    const { deps } = harness({ resolveRealBinary: () => null });
    await expect(run(deps, ["run", "serve"])).rejects.toThrow(/real binary/);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`lib/endpoint/run.ts`: the pure-ish core per the test; env for the child = `{ ...callerEnv, ...rendered, ...(hookEnv ?? {}) }` (caller env is the base — inheritance is what preserves exported vars; `preserveEnv` keys additionally feed argInject's `${envKeys}` list along with the rendered env's keys). Hook (`roleCfg.hook`) runs via Task 5's `runRoleHook` with fail-open. `RT_INTERCEPT_DEBUG=1` → `warn` a one-line trace on match and on claim result. `commands/intercept.ts:interceptRun` wires real deps: rules from `loadInterceptRules()`, toplevel/remote via async `git` captures, `claim` via `daemonQuery("endpoint:claim", payload, 10_000)`, `resolveRealBinary` = scan `PATH` entries for an executable named `command` skipping `shimPath(command)` (and honoring `RT_INTERCEPT_REAL`), `execReal` = `Bun.spawn` inherit-stdio + SIGINT/SIGTERM/SIGHUP forwarding + `process.exit(await child.exited)` (port the old shim's `passthrough`, cite it in a comment). `RT_INTERCEPT_BYPASS=1` short-circuits before matching. `interceptStatus`: table (or `--json`) of `shimReport()` + rule counts per repo + whether the daemon answers `endpoint:status`. `interceptInstall`/`interceptUninstall` call Task 6 fns and print results. `commands/endpoint.ts:endpointLookup`: resolve repo+worktree from cwd (git toplevel + repo index match; error out if the repo is unregistered), `daemonQuery("endpoint:lookup", ...)`, print `{ url, running, port }` JSON or a plain line; `--json` always full. Tree entries in `lib/command-tree-def.ts` (copy the `events` family shape): `intercept` family (`status`, `install`, `uninstall`, and `run` with `hidden: true`), `endpoint` family (`lookup` with a Role text arg). BOTH module-registry edits for BOTH new command modules. Run `bun run docs:gen`.

- [ ] **Step 4: Run tests** — `bun test lib/endpoint lib/__tests__/module-registry.test.ts` PASS; `bunx tsc --noEmit` clean; `bun run docs:check` clean.

- [ ] **Step 5: Commit**

```bash
git add commands/intercept.ts commands/endpoint.ts lib/endpoint/run.ts lib/endpoint/__tests__/intercept-run.test.ts lib/command-tree-def.ts lib/module-registry.ts website/
git commit -m "RT-28: rt intercept run/status/install/uninstall + rt endpoint lookup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `rt verify` check

**Files:**
- Modify: `commands/verify.ts`
- Test: extend `lib/endpoint/__tests__/shim.test.ts` (the probe fn), e2e covers the verify line

**Interfaces:**
- Consumes: `shimReport()` from Task 6.

- [ ] **Step 1: Write the failing test** — add to `shim.test.ts`:

```ts
test("shimReport flags a declared intercept with no shim installed", () => {
  // declare a repo with an intercept (Task 1's writeRepoConfig helper) and a repos.json index entry,
  // call buildInterceptRules + writeInterceptRules, do NOT install shims:
  const report = shimReport();
  expect(report).toContainEqual(expect.objectContaining({ command: "doppler", installed: false, current: false }));
});
```

- [ ] **Step 2: Run to verify failure** (if `shimReport` from Task 6 already passes this, tighten: assert `current` flips true after `installShims()` and false again after appending a byte to the shim file).

- [ ] **Step 3: Implement the verify check** in `commands/verify.ts`, RT-46-check shape, after the legacy-dirs check:

```ts
// ── Intercept shims (RT-28) ────────────────────────────────────────────────
try {
  const { shimReport } = await import("../lib/endpoint/shim.ts");
  const report = shimReport();
  const missing = report.filter((r) => !r.installed);
  const stale = report.filter((r) => r.installed && !r.current);
  if (report.length === 0) results.push(skip("intercept shims", "no intercepts declared"));
  else if (missing.length > 0) results.push(warn("intercept shims", `declared but not installed: ${missing.map((r) => r.command).join(", ")} — run rt intercept install`));
  else if (stale.length > 0) results.push(warn("intercept shims", `stale shim content: ${stale.map((r) => r.command).join(", ")} — run rt intercept install`));
  else results.push(pass("intercept shims", `${report.length} installed and current`, "warning"));
} catch (err) {
  results.push(warn("intercept shims", `check failed: ${(err as Error).message}`));
}
```

- [ ] **Step 4: Run** — `bun test lib/endpoint` PASS; `bun run cli.ts verify` locally shows the new line (skip on this machine until an intercept is declared).

- [ ] **Step 5: Commit**

```bash
git add commands/verify.ts lib/endpoint/__tests__/shim.test.ts
git commit -m "RT-28: verify check — declared intercept shims installed and current

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: e2e — the just-works loop against a real daemon

**Files:**
- Create: `e2e/tests/endpoint.test.ts`
- Consumes: `e2e/harness.ts` (`createTestHome`, `rt`, `RT_BINARY`), the RT-45 `freePort()`/foreground-daemon pattern from `e2e/tests/events.test.ts` (copy its child-tracking and `RT_API_PORT` threading verbatim).

- [ ] **Step 1: Write the e2e test**

Scenario, all inside the hermetic test HOME with its own foreground daemon:

```ts
// e2e/tests/endpoint.test.ts — structure mirrors events.test.ts (freePort, daemon spawn, afterAll reaper)
// 1. scaffold two git "worktrees" (plain git init dirs are fine — worktree here is just a toplevel):
//    /repo-main (with remote.origin.url set) and /repo-b (same remote), register /repo-main in
//    ~/.mattstack/rt/repos.json the way harness fixtures do, and write repos/<name>/config.json with:
//    roles: { web: { pool: [{from: 42100, to: 42105}], env: { PORT: "${port}" }, preserveEnv: ["KEEP_*"] } }
//    intercepts: [{ command: "fakestart", matches: [{ cwdGlob: ".", role: "web",
//      argInject: { afterArg: "go", template: "--keep=${envKeys}", skipIfArgPresent: "--keep" } }] }]
// 2. create a real "fakestart" binary in a tmp bin dir on PATH: a sh script that prints "PORT=$PORT ARGS=$*"
//    and (when PORT is set) starts `bun -e 'Bun.serve({port: Number(process.env.PORT), fetch: () => new Response("ok")}); await new Promise(()=>{})'` — for the sticky/second-worktree assertions
// 3. rt intercept install → assert ~/.local/bin/fakestart exists and intercepts.json written
// 4. run the shim from /repo-main with KEEP_ME=1: `fakestart go` → stdout shows PORT=42100 and --keep=PORT,KEEP_ME
// 5. run from /repo-b → PORT=42101 (second worktree, next port; first server still listening)
// 6. re-run from /repo-main → PORT=42100 again (sticky)
// 7. kill the daemon, run again → stderr contains "passthrough", command still executes, PORT unset
// 8. restart daemon, `rt endpoint lookup web --json` from /repo-main → { port: 42100, ... }
// 9. `rt intercept status --json` lists the fakestart shim as installed+current
// 10. `rt verify` output contains "intercept shims"
```

Write it as real code following `events.test.ts`'s helpers (`runRt`, sock-wait, child reaping). Keep every spawned server in the reap list. The `fakestart` script must be found via PATH order test-bin AFTER `~/.local/bin` so the shim wins — set `PATH=${home}/.local/bin:${tmpBin}:/usr/bin:/bin` explicitly in the spawn env, plus `RT_API_PORT`.

- [ ] **Step 2: Run to verify it fails usefully** — `rm -f dist/rt && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/endpoint.test.ts` (fresh binary compile; failures should be assertion-level, not harness-level).

- [ ] **Step 3: Fix whatever reality disagrees with** — this task is the integration shakedown; expected friction points: PATH resolution of the real binary inside the shim's child env, repos.json registration shape (copy from an existing e2e fixture), remote-URL normalization. Fix in the source modules, keep unit tests green.

- [ ] **Step 4: Full gates**

Run: `bunx tsc --noEmit && bun test lib commands packages && rm -f dist/rt && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/endpoint.test.ts
git commit -m "RT-28: e2e — intercepted start allocates, sticky per worktree, fail-open without daemon

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Explicitly out of scope (follow-up ticket in claimview-tools)

The assured adapter: overlay config values for assured-dev (Auth0 pool, doppler matches, REACT_APP_* env templates), the pack hook script (config.js write + token-capture NODE_OPTIONS), migration from `~/.assured/dev-ports.state.json`, retiring the old `~/.local/bin/doppler` shim, and thinning `@assured/dev-ports`. rt ships generic; the e2e synthetic repo is the proof.

## Self-review notes

- Spec coverage: config keys (T1), allocation+lessons (T2/T3), daemon surface+disposal (T4), env/preserve/argInject/hook (T5), shim+rules+matching (T6), CLI+registry+docs (T7), verify (T8), just-works e2e incl. fail-open and sticky (T9). Overlay-only rule is structural (rules built from repoDataDir configs only). Consumers get `endpoint:lookup` + `rt endpoint lookup` (T4/T7).
- Type consistency: `EndpointClaim` (T2) consumed by T3/T4; `RoleConfig`/`InterceptMatch`/`ArgInject` (T1) consumed by T3/T5/T6; `ResolvedAllocation.refs` shape matches `endpoint:claim`'s `data.refs`; `RunDeps.claim` returns the daemonQuery envelope.
