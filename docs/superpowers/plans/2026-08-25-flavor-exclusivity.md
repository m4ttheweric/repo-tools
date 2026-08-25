# Flavor Exclusivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce "one intended flavor serves this machine" — a `mattstack.mode` setting, a daemon that parks instead of fighting for `rt.sock`, identity in every status surface, a toggle that repairs half-states, and a tray that stands down when it's the wrong flavor.

**Architecture:** One derivation seam (`resolveIntendedMode()` in `lib/dev-mode.ts`) feeds every consumer. The daemon decides park-vs-boot at the very top of `lib/daemon.ts` module scope (before any subsystem arms, before `evictStaleDaemon`, before `rt.pid`). Sockets are taken over by probe, never stolen. Swift tray reads mode through the CLI's new read-only verb and self-unregisters (login) or offers a switch (manual launch) when mismatched.

**Tech Stack:** Bun/TypeScript (rt CLI + daemon), Swift/AppKit (rt-tray), bun:test, XCTest.

**Spec:** `docs/superpowers/specs/2026-08-25-flavor-exclusivity-design.md` — read it before any task; it carries the ratified decisions and the incident this prevents.

## Global Constraints

- Never rebuild, re-sign, or touch the blessed bundles in place (`/Applications/mattstack.app`, `rt-tray/mattstack-dev.app`); Swift builds go to scratch (CLAUDE.md).
- Call-time HOME everywhere: never bake `process.env.HOME` at module load (`lib/dev-mode.ts` header comment shows the pattern).
- No new module-scope work in `lib/daemon.ts` beyond the park check itself; the park path must not write `rt.pid`, run `evictStaleDaemon`, or arm any interval.
- Flavor self-detection is `typeof RT_VERSION !== "undefined"` — never `import.meta.main`.
- A failed or ambiguous mode read means SERVE (TS: derive-from-wrapper; Swift: treat as match). Both flavors parked simultaneously must be unrepresentable.
- Clean-room invariant: compiled binary + no wrapper + unset setting ⇒ prod/prod ⇒ boots normally (`scripts/e2e-cleanroom.sh` and CI depend on it).
- Comments follow the clean-code rule: constraints the code can't show, never narration or review history.
- Run `bash scripts/repo-purity.sh` before every push.

---

### Task 1: `mattstack.mode` registry entry + `resolveIntendedMode()`

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts` (after the `mattstack.appPath` row, ~line 231)
- Modify: `lib/dev-mode.ts` (append)
- Test: `lib/__tests__/intended-mode.test.ts` (create)

**Interfaces:**
- Consumes: `currentMode(): "dev" | "prod"` (exists in `lib/dev-mode.ts`), `getSetting<T>(key)` from `packages/rt-client` (already imported repo-wide as `lib/settings` re-exports — check `lib/settings/index.ts` and import the same way `lib/rt-paths.ts:194` does).
- Produces: `resolveIntendedMode(): { mode: "dev" | "prod"; provenance: "setting" | "derived-from-wrapper" }` — Tasks 2, 5, 6, 7 all call exactly this.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/intended-mode.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveIntendedMode } from "../dev-mode.ts";
import { setSetting } from "../settings/write.ts";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-intent-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveIntendedMode", () => {
  test("setting present wins, provenance 'setting'", () => {
    setSetting("mattstack.mode", "dev", "machine");
    expect(resolveIntendedMode()).toEqual({ mode: "dev", provenance: "setting" });
  });

  test("unset: derives from wrapper — script at ~/.local/bin/rt means dev", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "rt"), "#!/bin/sh\necho dev\n");
    expect(resolveIntendedMode()).toEqual({ mode: "dev", provenance: "derived-from-wrapper" });
  });

  test("unset, no wrapper: prod (the fresh-machine / clean-room default)", () => {
    expect(resolveIntendedMode()).toEqual({ mode: "prod", provenance: "derived-from-wrapper" });
  });

  test("garbage setting value falls through to derivation, never throws", () => {
    setSetting("mattstack.mode", "chaos" as any, "machine");
    expect(resolveIntendedMode().provenance).toBe("derived-from-wrapper");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/__tests__/intended-mode.test.ts`
Expected: FAIL — `resolveIntendedMode` is not exported (and the setSetting call may reject the unregistered key — that's the registry half).

- [ ] **Step 3: Add the registry row**

In `packages/rt-client/src/settings/registry-defs.ts`, directly after the `mattstack.appPath` row:

```ts
  {
    key: "mattstack.mode",
    type: "string",
    scopes: ["machine"],
    merge: "replace",
    description: "The machine's intended flavor, \"dev\" or \"prod\". Normally written by `rt settings dev-mode` after a successful handoff; a manual `rt settings set` is the blessed repair escape hatch — the daemon park loop converges on whatever this says. Unset ⇒ derived from the dev wrapper's presence.",
  },
```

- [ ] **Step 4: Implement `resolveIntendedMode`**

Append to `lib/dev-mode.ts` (imports at top of file; follow its call-time-HOME idiom):

```ts
import { getSetting } from "../packages/rt-client/src/settings/resolve.ts"; // match the import path style used by lib/rt-paths.ts:194 — copy it exactly

export interface IntendedMode {
  mode: "dev" | "prod";
  provenance: "setting" | "derived-from-wrapper";
}

/**
 * The single seam every flavor decision reads. The generic settings read is
 * NOT equivalent: it reports store values only and drops an unset value, and
 * a consumer defaulting unset→prod would stand the dev pair down on a fresh
 * machine — the opposite of self-heal.
 */
export function resolveIntendedMode(): IntendedMode {
  try {
    const { value } = getSetting<string>("mattstack.mode");
    if (value === "dev" || value === "prod") return { mode: value, provenance: "setting" };
  } catch {
    // unreadable store: derivation below always yields a mode
  }
  return { mode: currentMode(), provenance: "derived-from-wrapper" };
}
```

(If the real `getSetting` import path differs, use whatever `lib/rt-paths.ts` line 194 uses — `installedTrayAppPath` already calls `getSetting("mattstack.appPath")` from lib/, so the correct path is on that line.)

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test lib/__tests__/intended-mode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Registry ripple + commit**

Run: `cd packages/rt-client && bun run build` (fail loudly — rt-client must be rebuilt after any registry change; `cd ../..` after).
Run: `bunx tsc --noEmit` — expect clean.

```bash
git add packages/rt-client/src/settings/registry-defs.ts lib/dev-mode.ts lib/__tests__/intended-mode.test.ts
git commit -m "feat(flavor): mattstack.mode setting + resolveIntendedMode seam"
```

---

### Task 2: Daemon park loop, placed where parking is inert

**Files:**
- Create: `lib/daemon/park.ts`
- Modify: `lib/daemon.ts` (immediately after the logger block that ends near line 90 — after `const log = loggerHandle.logger;` and the migration log lines, BEFORE `const systemProcessScanner = new SystemProcessScanner();`)
- Test: `lib/daemon/__tests__/park.test.ts` (create)

**Interfaces:**
- Consumes: `resolveIntendedMode()` from Task 1.
- Produces: `daemonFlavor(): "dev" | "prod"` and `parkUntilIntended(deps): Promise<void>` (exported from `lib/daemon/park.ts`); Task 4 reuses `daemonFlavor`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/daemon/__tests__/park.test.ts
import { describe, test, expect } from "bun:test";
import { parkUntilIntended, type ParkDeps } from "../park.ts";

function deps(overrides: Partial<ParkDeps> = {}): ParkDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    myFlavor: "dev",
    resolveIntent: () => ({ mode: "dev", provenance: "setting" as const }),
    probeHolder: async () => null,
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { info: (_o: unknown, m: string) => logs.push(`info:${m}`), warn: (_o: unknown, m: string) => logs.push(`warn:${m}`) },
    logs,
    sleeps,
    ...overrides,
  };
}

describe("parkUntilIntended", () => {
  test("matched flavor with free socket returns immediately, no sleep", async () => {
    const d = deps();
    await parkUntilIntended(d);
    expect(d.sleeps).toEqual([]);
  });

  test("mismatched flavor parks until the setting flips, then returns", async () => {
    let reads = 0;
    const d = deps({
      resolveIntent: () => (++reads < 3 ? { mode: "prod", provenance: "setting" } : { mode: "dev", provenance: "setting" }),
    });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(2);
    expect(d.logs.some((l) => l.includes("parked"))).toBe(true);
  });

  test("matched but a live wrong-flavor holder owns the socket: stands off until it drains", async () => {
    let probes = 0;
    const d = deps({
      probeHolder: async () => (++probes < 2 ? { flavor: "prod", pid: 999 } : null),
    });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(1);
    expect(d.logs.some((l) => l.includes("standoff"))).toBe(true);
  });

  test("a resolver that throws keeps the previous decision and logs warn, never crashes", async () => {
    let reads = 0;
    const d = deps({
      resolveIntent: () => {
        reads++;
        if (reads === 2) throw new Error("store hiccup");
        return reads < 4 ? { mode: "prod", provenance: "setting" } : { mode: "dev", provenance: "setting" };
      },
    });
    await parkUntilIntended(d);
    expect(d.logs.some((l) => l.startsWith("warn:"))).toBe(true);
  });

  test("a matched holder answering on the socket also blocks (never two binders)", async () => {
    let probes = 0;
    const d = deps({ probeHolder: async () => (++probes < 2 ? { flavor: "dev", pid: 111 } : null) });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/daemon/__tests__/park.test.ts`
Expected: FAIL — module `../park.ts` not found.

- [ ] **Step 3: Implement `lib/daemon/park.ts`**

```ts
/**
 * Flavor park (spec: flavor-exclusivity §2). Runs at the TOP of
 * lib/daemon.ts module scope: everything below it arms live subsystems
 * (cron, the home-snapshot auto-committer, sweeps) and startDaemon()
 * SIGTERMs the shared rt.pid — so a daemon that is not this machine's
 * intended flavor must never get past this function. Parking is a loop,
 * not an exit: KeepAlive={SuccessfulExit:false} on both flavor plists
 * means exiting would respawn-churn, and staying alive lets a toggle
 * flip convert this process into the serving daemon within one cycle.
 */
import type { IntendedMode } from "../dev-mode.ts";
import { resolveIntendedMode } from "../dev-mode.ts";
import { DAEMON_SOCK_PATH } from "../daemon-config.ts";

declare const RT_VERSION: string | undefined;

export function daemonFlavor(): "dev" | "prod" {
  return typeof RT_VERSION !== "undefined" ? "prod" : "dev";
}

export interface SocketHolder {
  flavor: string;
  pid: number | null;
}

export interface ParkDeps {
  myFlavor: "dev" | "prod";
  resolveIntent: () => IntendedMode;
  probeHolder: () => Promise<SocketHolder | null>;
  sleep: (ms: number) => Promise<void>;
  log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}

const PARK_INTERVAL_MS = 30_000;

export async function parkUntilIntended(deps: ParkDeps): Promise<void> {
  let intent: IntendedMode = { mode: deps.myFlavor, provenance: "derived-from-wrapper" };
  let announcedPark = false;
  let announcedStandoff = false;

  for (;;) {
    try {
      intent = deps.resolveIntent();
    } catch (err) {
      deps.log.warn({ err }, "intent read failed — keeping previous decision");
    }

    if (intent.mode !== deps.myFlavor) {
      if (!announcedPark) {
        deps.log.info(
          { myFlavor: deps.myFlavor, intended: intent.mode, provenance: intent.provenance },
          `parked: this machine's intended mode is ${intent.mode} — rechecking every ${PARK_INTERVAL_MS / 1000}s (flip with: rt settings dev-mode ${deps.myFlavor})`,
        );
        announcedPark = true;
      }
      await deps.sleep(PARK_INTERVAL_MS);
      continue;
    }

    const holder = await deps.probeHolder();
    if (holder) {
      if (!announcedStandoff) {
        deps.log.info(
          { holderFlavor: holder.flavor, holderPid: holder.pid },
          `standoff: rt.sock held by ${holder.flavor} pid ${holder.pid ?? "?"} — waiting for it to drain`,
        );
        announcedStandoff = true;
      }
      await deps.sleep(PARK_INTERVAL_MS);
      continue;
    }

    return;
  }
}

/** CONNECT to rt.sock and ask who answers. A dead/leaked socket file returns null (the boot path's unlink+bind handles it). */
export async function probeSocketHolder(sockPath: string = DAEMON_SOCK_PATH): Promise<SocketHolder | null> {
  try {
    const res = await fetch("http://localhost/ping", { unix: sockPath, signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { pid?: number; flavor?: string };
    return { flavor: body.flavor ?? "unknown flavor", pid: body.pid ?? null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test lib/daemon/__tests__/park.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into `lib/daemon.ts`**

Immediately after the `rtMigration` log lines (the `else if (rtMigration === "conflict")` block, before `// ─── Daemon units ───` / `const systemProcessScanner = ...`):

```ts
// Flavor gate — MUST stay above every subsystem below: module scope arms
// cron, the home-snapshot auto-committer, and sweep intervals, and
// startDaemon() SIGTERMs the shared rt.pid. A wrong-flavor daemon that got
// past this line would kill the serving daemon and double-commit the home
// repo. Both entry paths (cli.ts `rt --daemon` and the shim's
// `bun run lib/daemon.ts`) converge here.
import { parkUntilIntended, probeSocketHolder, daemonFlavor } from "./daemon/park.ts";
await parkUntilIntended({
  myFlavor: daemonFlavor(),
  resolveIntent: resolveIntendedMode,
  probeHolder: probeSocketHolder,
  sleep: (ms) => Bun.sleep(ms),
  log,
});
```

Add `resolveIntendedMode` to the existing `lib/dev-mode.ts` import in daemon.ts (or add the import if none exists). ESM hoists imports, so place the `import ... from "./daemon/park.ts"` statement with the other imports at the top of the file and only the `await parkUntilIntended(...)` call after the migration block.

- [ ] **Step 6: Full-file checks + commit**

Run: `bunx tsc --noEmit` — clean.
Run: `bun test lib/daemon/__tests__/ lib/__tests__/intended-mode.test.ts` — green.
Run: `bun test e2e/` is NOT required here (Task 10 runs it), but `bun test lib commands` must stay green.

```bash
git add lib/daemon/park.ts lib/daemon/__tests__/park.test.ts lib/daemon.ts
git commit -m "feat(flavor): daemon parks at module-scope top until it is the intended flavor"
```

---

### Task 3: Identity in the daemon's hello

**Files:**
- Modify: `lib/daemon/handlers/status.ts` (the `ping` and `status` handlers, lines ~23–40)
- Modify: `lib/daemon/handlers/types.ts` (HandlerContext — add `identity`)
- Modify: `lib/daemon.ts` (build the identity once, where `startedAt` and ctx are built)
- Test: extend the existing status handler test file (find it: `grep -rln '"ping"' lib/daemon/__tests__ lib/__tests__`; if none exists, create `lib/daemon/__tests__/status-identity.test.ts` driving `createStatusHandlers` with a fake ctx)

**Interfaces:**
- Consumes: `daemonFlavor()` from Task 2.
- Produces: `ping` response gains `{ flavor: string, version: string, sourceRev: string | null, startedAt: number }`; `status.data` gains the same `identity` object. Tasks 4, 5, 6 read `flavor` from `ping`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/status-identity.test.ts
import { describe, test, expect } from "bun:test";
import { createStatusHandlers } from "../handlers/status.ts";

function fakeCtx(): any {
  return {
    startedAt: 123,
    identity: { flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 },
    watchedConfigs: new Map(),
    cache: { entries: {} },
    portCacheRef: { ports: [], updatedAt: null },
  };
}

describe("daemon identity", () => {
  test("ping carries flavor/version/sourceRev", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = await h["ping"]!({}, undefined as any);
    expect(res).toMatchObject({ ok: true, flavor: "dev", version: "source", sourceRev: "abc1234" });
  });

  test("status.data carries the identity object", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["status"]!({}, undefined as any)) as any;
    expect(res.data.identity).toEqual({ flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 });
  });
});
```

(Adjust the handler invocation arity to match `HandlerMap`'s real signature — read `lib/daemon/handlers/types.ts` first and mirror how existing status tests call handlers if such tests exist.)

- [ ] **Step 2: Run to verify failure** — `bun test lib/daemon/__tests__/status-identity.test.ts` → FAIL (no `flavor` in ping).

- [ ] **Step 3: Implement**

`lib/daemon/handlers/types.ts` — add to HandlerContext:

```ts
  identity: { flavor: "dev" | "prod"; version: string; sourceRev: string | null; startedAt: number };
```

`lib/daemon/handlers/status.ts`:

```ts
    "ping": async () => {
      return { ok: true, uptime: Date.now() - ctx.startedAt, pid: process.pid, ...ctx.identity };
    },
```

and inside `status`'s `data`: add `identity: ctx.identity,`.

`lib/daemon.ts` — where ctx is assembled (near `const startedAt = Date.now();`):

```ts
declare const RT_VERSION: string | undefined;
const sourceRev = daemonFlavor() === "dev"
  ? (await runCapture(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir, timeoutMs: 5_000 }).then((r) => r.stdout.trim()).catch(() => null))
  : null;
const identity = {
  flavor: daemonFlavor(),
  version: typeof RT_VERSION !== "undefined" ? RT_VERSION : "source",
  sourceRev,
  startedAt,
} as const;
```

and pass `identity` into the HandlerContext where `startedAt` already goes. Use the repo's actual async subprocess helper (`runCapture` from `lib/subprocess.ts` — check its exact signature and adjust; never a sync exec on the daemon path, per the Bun sync-exec wedge rule).

- [ ] **Step 4: Run tests** — `bun test lib/daemon/__tests__/status-identity.test.ts` → PASS; `bunx tsc --noEmit` → clean (fake ctx uses `any` deliberately; real ctx type now requires `identity` — fix any other ctx constructors tsc flags, e.g. test fixtures).

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/handlers/status.ts lib/daemon/handlers/types.ts lib/daemon.ts lib/daemon/__tests__/status-identity.test.ts
git commit -m "feat(flavor): daemon ping/status carry flavor, version, sourceRev"
```

---

### Task 4: Flavor-aware `rt daemon` verbs

**Files:**
- Modify: `commands/daemon.ts` (`trayAppHintPath` ~line 47, `stop` ~189, `start` ~172, `restart` ~199, `status` output section)
- Test: `commands/__tests__/daemon-flavor-output.test.ts` (create — drive the pure helpers; the verbs' tray calls are not unit-testable without a tray, so extract and test the message-building functions)

**Interfaces:**
- Consumes: `resolveIntendedMode()` (Task 1), `probeSocketHolder()` (Task 2), ping's `flavor` field (Task 3), `devTrayAppPath` (exists, `lib/rt-paths.ts:219`).
- Produces: `describeTuple(): Promise<{ intended: IntendedMode; cliFlavor: "dev" | "prod"; daemon: { flavor: string; pid: number | null } | null }>` exported from `commands/daemon.ts` — Task 6 (verify row) and Task 5 (toggle) consume it.

- [ ] **Step 1: Write the failing test**

```ts
// commands/__tests__/daemon-flavor-output.test.ts
import { describe, test, expect } from "bun:test";
import { tupleWarning, flavorHintPath } from "../daemon.ts";

describe("flavor-aware daemon output", () => {
  test("agreeing tuple produces no warning", () => {
    expect(tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBeNull();
  });

  test("stale prod daemon under dev intent names the exact remedy", () => {
    const w = tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: { flavor: "prod", pid: 99 } });
    expect(w).toContain("prod");
    expect(w).toContain("rt settings dev-mode dev");
  });

  test("daemon down is not a mismatch", () => {
    expect(tupleWarning({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: null })).toBeNull();
  });

  test("hint path follows intended mode", () => {
    expect(flavorHintPath({ mode: "dev", provenance: "setting" })).toContain("mattstack-dev.app");
    expect(flavorHintPath({ mode: "prod", provenance: "setting" })).not.toContain("mattstack-dev.app");
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (not exported).

- [ ] **Step 3: Implement in `commands/daemon.ts`**

```ts
import { resolveIntendedMode, currentMode, type IntendedMode } from "../lib/dev-mode.ts";
import { probeSocketHolder } from "../lib/daemon/park.ts";
import { devTrayAppPath } from "../lib/rt-paths.ts";

export interface FlavorTuple {
  intended: IntendedMode;
  cliFlavor: "dev" | "prod";
  daemon: { flavor: string; pid: number | null } | null;
}

export async function describeTuple(): Promise<FlavorTuple> {
  const holder = await probeSocketHolder();
  return { intended: resolveIntendedMode(), cliFlavor: currentMode(), daemon: holder };
}

/** Null when coherent OR when no daemon answers — a down daemon is a liveness problem, not a flavor mismatch. */
export function tupleWarning(t: FlavorTuple): string | null {
  if (!t.daemon) return null;
  if (t.daemon.flavor === t.intended.mode && t.cliFlavor === t.intended.mode) return null;
  const legs = `intended ${t.intended.mode} (${t.intended.provenance}) · CLI ${t.cliFlavor} · daemon ${t.daemon.flavor}${t.daemon.pid ? ` (pid ${t.daemon.pid})` : ""}`;
  return `flavor mismatch — ${legs}. Fix: rt settings dev-mode ${t.intended.mode}`;
}

export function flavorHintPath(intended: IntendedMode): string {
  return intended.mode === "dev" ? devTrayAppPath() : trayAppHintPath();
}
```

Then wire the verbs:
- `status`: after printing the running block, `const t = await describeTuple();` — print the identity line (`flavor · version/sourceRev` from ping, which `isDaemonRunning`/status already fetches — extend whichever fetch it uses) and, when `tupleWarning(t)` is non-null, print it in yellow.
- `stop`: after the tray ack + sleep, `const holder = await probeSocketHolder(); if (holder) print yellow "⚠ a ${holder.flavor} daemon still holds rt.sock (pid ${holder.pid}) — the tray you reached manages the ${(await describeTuple()).cliFlavor} flavor. Fix: rt settings dev-mode ${...}"` instead of unconditional "✓ daemon stopped"; print "✓" only when the probe returns null.
- `start`/`restart`: replace both `trayAppHintPath()` hint sites (lines ~174, ~204) with `flavorHintPath(resolveIntendedMode())`, and prefix their first output line with the flavor being addressed: `restarting ${t.intended.mode} daemon via tray…`.

- [ ] **Step 4: Run tests + typecheck** — `bun test commands/__tests__/daemon-flavor-output.test.ts` PASS; `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add commands/daemon.ts commands/__tests__/daemon-flavor-output.test.ts
git commit -m "feat(flavor): daemon verbs name their flavor and never report a false stop"
```

---

### Task 5: Toggle repairs half-states + non-TTY read-only mode

**Files:**
- Modify: `commands/settings.ts` (`toggleDevMode` ~line 671; the guard at ~705–708; `handoffToFlavor` ~638)
- Modify: `lib/command-tree-def.ts` (the `requiresTTY` predicate at ~841)
- Test: `commands/__tests__/dev-mode-toggle.test.ts` (create; also check `lib/__tests__/dev-mode-handoff.test.ts` still passes)

**Interfaces:**
- Consumes: `describeTuple`/`tupleWarning` (Task 4), `resolveIntendedMode` (Task 1), `setSetting(key, value, "machine")` (rt-client), `launchdLabelFor(mode)` (exists in settings.ts's imports).
- Produces: bare `rt settings dev-mode` (no target) prints the tuple, exits 0, supports `--json` emitting `{ intended, cliFlavor, daemon }`; the Swift tray (Task 7) calls exactly `rt settings dev-mode --json`.

- [ ] **Step 1: Write the failing tests**

```ts
// commands/__tests__/dev-mode-toggle.test.ts
import { describe, test, expect } from "bun:test";
import { devModeGuardVerdict, renderTupleReadout } from "../settings.ts";

describe("dev-mode guard tuple", () => {
  const dev = { mode: "dev" as const, provenance: "setting" as const };

  test("all legs agree: no-op verdict", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBe("noop");
  });

  test("CLI dev but prod daemon serving: repair, not noop (the 2026-08-25 half-state)", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: { flavor: "prod", pid: 9 } })).toBe("repair");
  });

  test("daemon down counts as agreement for the guard (handoff will start it)", () => {
    expect(devModeGuardVerdict("dev", { intended: dev, cliFlavor: "dev", daemon: null })).toBe("noop");
  });

  test("different target is always a switch", () => {
    expect(devModeGuardVerdict("prod", { intended: dev, cliFlavor: "dev", daemon: { flavor: "dev", pid: 1 } })).toBe("switch");
  });
});

describe("read-only tuple output", () => {
  test("--json emits machine-readable tuple", () => {
    const out = renderTupleReadout({ intended: { mode: "dev", provenance: "setting" }, cliFlavor: "dev", daemon: null }, true);
    expect(JSON.parse(out)).toMatchObject({ intended: { mode: "dev" }, cliFlavor: "dev", daemon: null });
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (not exported).

- [ ] **Step 3: Implement**

In `commands/settings.ts`:

```ts
export type GuardVerdict = "noop" | "repair" | "switch";

/** "already in X mode" is earned only when every leg agrees; a serving daemon of the wrong flavor makes the toggle a repair even when the CLI already matches. */
export function devModeGuardVerdict(target: "dev" | "prod", t: FlavorTuple): GuardVerdict {
  if (target !== t.cliFlavor) return "switch";
  const daemonAgrees = t.daemon === null || t.daemon.flavor === target;
  const intentAgrees = t.intended.mode === target;
  return daemonAgrees && intentAgrees ? "noop" : "repair";
}

export function renderTupleReadout(t: FlavorTuple, json: boolean): string {
  if (json) return JSON.stringify(t);
  const lines = [
    `  intended: ${t.intended.mode} (${t.intended.provenance})`,
    `  cli:      ${t.cliFlavor}`,
    `  daemon:   ${t.daemon ? `${t.daemon.flavor} (pid ${t.daemon.pid})` : "not running"}`,
  ];
  const warning = tupleWarning(t);
  if (warning) lines.push(`  ⚠ ${warning}`);
  return lines.join("\n");
}
```

Rework `toggleDevMode`'s flow:
1. `const tuple = await describeTuple();`
2. **Bare invocation** (no positional target): print `renderTupleReadout(tuple, args.includes("--json"))` and return 0 — replace the current `✗ no target given` branch AND the interactive picker stays only for a TTY that wants to switch (keep the picker when stdin is a TTY and no `--json`).
3. With a target: `switch (devModeGuardVerdict(target, tuple))` — `"noop"` prints the current message; `"repair"` and `"switch"` both run the full flow (enable/disable + `handoffToFlavor`).
4. **Dead-tray bootout** in `handoffToFlavor`: when the retire POST comes back unreachable (`retire` falsy — the `${outgoing.name} not reachable` branch), add:

```ts
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${outgoingLabel}`], { stdio: "pipe", env: process.env });
    console.log(`  ${yellow}⚠${reset} ${outgoing.name} tray unreachable — booted out ${outgoingLabel} directly`);
```

5. **Write the setting** after a successful handoff (end of both toggle branches): `setSetting("mattstack.mode", target, "machine");` with the import matching Task 1's.

In `lib/command-tree-def.ts:841`, the predicate must also admit `--json` and bare reads:

```ts
        // A TTY is needed only to PROMPT for a target: an explicit target,
        // --json, and the bare read-only tuple print are all non-interactive.
        requiresTTY: () => false,
```

(The handler itself now owns the TTY decision: it prompts only when stdin is a TTY, a target is absent, and `--json` is absent.)

- [ ] **Step 4: Run tests** — `bun test commands/__tests__/dev-mode-toggle.test.ts lib/__tests__/dev-mode-handoff.test.ts` → PASS; `bunx tsc --noEmit` clean.

- [ ] **Step 5: Smoke the read (safe, read-only)**

Run: `bun run cli.ts settings dev-mode --json`
Expected: one JSON line with `intended/cliFlavor/daemon` keys, exit 0. (Do NOT run with a target — that would hand off the live machine.)

- [ ] **Step 6: Commit**

```bash
git add commands/settings.ts lib/command-tree-def.ts commands/__tests__/dev-mode-toggle.test.ts
git commit -m "feat(flavor): toggle repairs half-states; bare dev-mode is a read-only tuple print"
```

---

### Task 6: Verify row — `flavor coherence`

**Files:**
- Modify: `lib/setup/validators/rt-health.ts` (new row function + wire into `rtHealthRows`)
- Test: extend `lib/setup/__tests__/rt-health.test.ts` (find the existing row-test pattern in that file and mirror it; if the file has a different name, locate with `grep -rln rtHealthRows lib/setup/__tests__`)

**Interfaces:**
- Consumes: `resolveIntendedMode`, `currentMode` (lib/dev-mode.ts), and the daemon's ping flavor via the validator's existing daemon probe (`p.daemon("ping")` — the same seam `daemonRow` uses at rt-health.ts:298).
- Produces: row id `tool.flavor` titled "Flavor coherence", `required: true`.

- [ ] **Step 1: Write the failing tests** (mirror the file's existing fake-probe pattern; the essential cases)

```ts
// in lib/setup/__tests__/rt-health.test.ts (append)
describe("tool.flavor — flavor coherence", () => {
  test("live daemon of the wrong flavor: fail, names all three legs", async () => {
    // fake p.daemon("ping") → { ok: true, flavor: "prod", pid: 9 }; wrapper = dev; setting unset
    // expect status "invalid" (critical fail path), detail contains "prod" and "dev-mode"
  });

  test("daemon down: row passes with 'n/a' daemon leg (clean-room gate must survive)", async () => {
    // fake p.daemon("ping") → null; expect status "ready", detail contains "daemon: n/a"
  });

  test("all legs agree: ready", async () => {});
});
```

Flesh these against the file's real fake-probes helper — the tests must construct probes exactly the way the neighboring `daemonRow` tests do (read them first; no new fixture invention).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the row** in `rt-health.ts`:

```ts
async function flavorRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.flavor",
    kind: "tool" as const,
    title: "Flavor coherence",
    why: "One intended flavor serves this machine; a mismatched daemon means stale code answering fresh CLIs.",
    required: true,
    recheck: "on-activate" as const,
  };
  const intended = resolveIntendedMode();
  const cli = currentMode();
  const ping = await p.daemon("ping");
  const daemonFlavor = ping && (ping as any).flavor ? String((ping as any).flavor) : null;

  // A down daemon is tool.daemon's problem; this row only ever fails on a
  // LIVE mismatch — the clean-room gate runs verify with no daemon at all.
  if (daemonFlavor === null) {
    return row({ ...base, status: "ready", detail: `intended ${intended.mode} (${intended.provenance}) · cli ${cli} · daemon n/a` });
  }
  if (daemonFlavor === intended.mode && cli === intended.mode) {
    return row({ ...base, status: "ready", detail: `${intended.mode} everywhere (${intended.provenance})` });
  }
  return row({
    ...base,
    status: "invalid",
    detail: `intended ${intended.mode} (${intended.provenance}) · cli ${cli} · daemon ${daemonFlavor} — run: rt settings dev-mode ${intended.mode}`,
  });
}
```

Wire `flavorRow(p)` into `rtHealthRows`'s Promise.all alongside `daemonRow`. Check `commands/verify.ts:77-85`'s CI forgiveness table: `status: "invalid"` on a required row is fail/critical in and out of CI — correct here, BECAUSE the row can only be invalid with a live wrong-flavor daemon, which CI never has.

- [ ] **Step 4: Tests pass + `bunx tsc --noEmit` clean.**

- [ ] **Step 5: Commit**

```bash
git add lib/setup/validators/rt-health.ts lib/setup/__tests__/rt-health.test.ts
git commit -m "feat(flavor): verify gains a mismatch-only flavor-coherence row"
```

---

### Task 7: Swift — mode read + decision core (BundleFlavor)

**Files:**
- Modify: `rt-tray/Sources-core/Rt/RtBinaryLocator.swift` (dev must never fall back to the bundled shim for CLI calls)
- Create: `rt-tray/Sources-core/Flavor/FlavorGate.swift`
- Test: `rt-tray/Tests/FlavorGateTests.swift` (create; mirror the existing test target layout — `ls rt-tray/Tests` first and put the file where the other core tests live)

**Interfaces:**
- Consumes: `rt settings dev-mode --json` (Task 5's contract: `{"intended":{"mode":"dev"|"prod",...},"cliFlavor":...,"daemon":...}`).
- Produces: `FlavorGate.decide(myFlavorIsDev: Bool, modeReadResult: String?) -> FlavorGate.Action` where `Action` is `.serve` or `.standDown(intended: String)` — Task 8 branches on it.

- [ ] **Step 1: Write the failing tests**

```swift
// FlavorGateTests.swift
import XCTest
@testable import RtCore  // match the actual core module name — check Package.swift

final class FlavorGateTests: XCTestCase {
    func testMatchedFlavorServes() {
        XCTAssertEqual(FlavorGate.decide(myFlavorIsDev: true, modeReadResult: #"{"intended":{"mode":"dev","provenance":"setting"},"cliFlavor":"dev","daemon":null}"#), .serve)
    }
    func testMismatchStandsDown() {
        XCTAssertEqual(FlavorGate.decide(myFlavorIsDev: false, modeReadResult: #"{"intended":{"mode":"dev","provenance":"setting"},"cliFlavor":"dev","daemon":null}"#), .standDown(intended: "dev"))
    }
    func testFailedReadServes() {
        XCTAssertEqual(FlavorGate.decide(myFlavorIsDev: false, modeReadResult: nil), .serve)
    }
    func testGarbageReadServes() {
        XCTAssertEqual(FlavorGate.decide(myFlavorIsDev: true, modeReadResult: "not json"), .serve)
    }
    func testDevLocatorNeverFallsBackToBundledShim() {
        let loc = RtBinaryLocator.resolve(bundlePath: "/tmp/x.app", isDevBuild: true, isDebugBuild: false,
                                          environment: [:], home: "/tmp/nohome", fileExists: { $0.contains("Contents/MacOS/rt") })
        XCTAssertNil(loc)  // wrapper absent; bundled rt is the daemon shim — must NOT be offered as a CLI
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cd rt-tray && swift test --filter FlavorGateTests` (or the repo's test invocation — check how existing rt-tray tests run in CI/scripts). Expected: compile FAIL (FlavorGate missing).

- [ ] **Step 3: Implement**

`FlavorGate.swift`:

```swift
import Foundation

/// Decide serve-vs-stand-down from the CLI's read-only tuple. Failure means
/// SERVE: a tray that cannot read intent must never dismantle its own
/// registrations on a guess (spec §6).
public enum FlavorGate {
    public enum Action: Equatable {
        case serve
        case standDown(intended: String)
    }

    public static func decide(myFlavorIsDev: Bool, modeReadResult: String?) -> Action {
        guard let raw = modeReadResult,
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let intended = obj["intended"] as? [String: Any],
              let mode = intended["mode"] as? String,
              mode == "dev" || mode == "prod"
        else { return .serve }
        let myMode = myFlavorIsDev ? "dev" : "prod"
        return mode == myMode ? .serve : .standDown(intended: mode)
    }
}
```

`RtBinaryLocator.swift` — in the `isDevBuild` branch, return `nil` instead of falling through:

```swift
        if isDevBuild {
            let wrapper = "\(home)/.local/bin/rt"
            if fileExists(wrapper) {
                return RtLocation(executable: URL(fileURLWithPath: wrapper), argumentPrefix: [], source: .devWrapper)
            }
            // The dev bundle's Contents/MacOS/rt is the DAEMON SHIM — invoking
            // it as a CLI starts a rogue daemon. No wrapper ⇒ no CLI.
            return nil
        }
```

- [ ] **Step 4: Run Swift tests to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources-core/Flavor/FlavorGate.swift rt-tray/Sources-core/Rt/RtBinaryLocator.swift rt-tray/Tests/FlavorGateTests.swift
git commit -m "feat(flavor): tray flavor gate core — failed mode read means serve"
```

---

### Task 8: Swift — wire the gate: stand-down, alert, deference

**Files:**
- Modify: `rt-tray/Sources/main.swift` (gate before `exitIfAnotherTrayOwnsSocket`)
- Modify: `rt-tray/Sources/TrayServer.swift` (`/health` gains `"flavor"`; the socket guard learns to evict a wrong-flavor holder)
- Modify: `rt-tray/Sources/AppDelegate.swift` (login-item detection + notification + self-unregister; manual-launch alert)
- Test: manual smoke checklist in the PR (GUI + SMAppService are not unit-testable); the decision core is already covered by Task 7.

**Interfaces:**
- Consumes: `FlavorGate.decide` (Task 7), `BundleFlavor.isDevBuild` (exists), `RtBinaryLocator` (Task 7), `DaemonLifecycle.stopDaemon()` / `SMAppService.mainApp.unregister()` (exist — TrayServer.swift:251, DaemonLifecycle.swift:60), the toggle exec pattern from `GeneralPane.swift:38`.
- Produces: tray `/health` body `{"ok":true,"app":"mattstack","flavor":"dev"|"prod"}`.

- [ ] **Step 1: `/health` flavor + wrong-flavor eviction in TrayServer**

`/health` (TrayServer.swift ~205):

```swift
            } else if method == "GET" && path == "/health" {
                let flavor = BundleFlavor.isDevBuild ? "dev" : "prod"
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"app\":\"mattstack\",\"flavor\":\"\(flavor)\"}")
```

`exitIfAnotherTrayOwnsSocket` (TrayServer.swift ~47) becomes flavor-aware: parse the holder's `/health` body; if the holder's `flavor` equals ours (or is absent — an old tray), keep today's `exit(0)`. If it differs AND our flavor matches intent (main.swift only reaches this point when serving — see Step 2), POST `/flavor/retire` to the holder, wait for the socket to free (re-probe up to 10 × 500 ms), then take over; if it never frees, log and `exit(0)` as today.

- [ ] **Step 2: Gate in `main.swift`** — after the `TrayLog.info("tray launched", ...)` block, before `TrayServer.exitIfAnotherTrayOwnsSocket()`:

```swift
let gateAction = FlavorGate.decide(
    myFlavorIsDev: BundleFlavor.isDevBuild,
    modeReadResult: FlavorModeReader.readTuple()  // exec `rt settings dev-mode --json` via RtBinaryLocator; nil on any failure/timeout (2s)
)
```

`FlavorModeReader` is a small helper in `Sources/` (Process + pipe, 2-second timeout, returns the stdout string or nil — mirror how GeneralPane.swift:38 already execs the toggle and reuse its subprocess pattern). On `.standDown(intended:)`, do NOT exit here — hand the action to AppDelegate via a global (`FlavorGateState.action`) so it can branch login-vs-manual; the tray must also skip `exitIfAnotherTrayOwnsSocket`'s takeover path and never bind tray.sock while standing down (pass the action into TrayServer, or guard `setupTrayServer()` in AppDelegate).

- [ ] **Step 3: AppDelegate branch** in `applicationDidFinishLaunching`, after the existing translocation guard:

```swift
        if case .standDown(let intended) = FlavorGateState.action {
            if LaunchKind.isLoginItemLaunch(notification) && LaunchKind.isConfident {
                // Silent stand-down: this machine belongs to the other flavor.
                daemonLifecycle?.stopDaemon()               // service.unregister(), logs itself
                try? SMAppService.mainApp.unregister()
                postStandDownNotification(intended: intended)  // UNUserNotificationCenter, existing notification plumbing
                NSApp.terminate(nil)
                return
            }
            showFlavorMismatchAlert(intended: intended)     // manual launch, or uncertain detection
            return  // no tray server, no registrations while the alert decides
        }
```

`LaunchKind.isLoginItemLaunch` inspects the launch Apple Event for `keyAELaunchedAsLogInItem`; when the event is unavailable, `isConfident` is false and the alert path runs (never silent unregister on uncertainty). `showFlavorMismatchAlert` is an NSAlert: message "This Mac is in \(intended) mode", buttons **Switch to \(myFlavor) here** (exec the toggle with the explicit target via RtBinaryLocator — GeneralPane.swift:38's pattern — then proceed into the normal startup path: buildServices, setupTrayServer, registerAll) and **Quit** (`NSApp.terminate`).

- [ ] **Step 4: Build to scratch and run the smoke checklist** (goes in the PR body):

Run: `cd rt-tray && ./build.sh dev --out /tmp/rt-tray-scratch` (check build.sh's actual scratch-output flag first; NEVER write into `rt-tray/mattstack-dev.app`).

Checklist (executed by Matt at the blessing round, listed in the PR):
- [ ] wrong-flavor login launch → notification + label unregistered + app quit
- [ ] wrong-flavor manual launch → alert; Switch runs the handoff; Quit quits
- [ ] matched launch with old wrong-flavor tray on the socket → retire + takeover
- [ ] `/health` shows `"flavor"`
- [ ] mode-read failure (rename ~/.local/bin/rt temporarily) → tray serves normally

- [ ] **Step 5: Commit**

```bash
git add rt-tray/Sources/main.swift rt-tray/Sources/TrayServer.swift rt-tray/Sources/AppDelegate.swift rt-tray/Sources/FlavorModeReader.swift rt-tray/Sources/LaunchKind.swift
git commit -m "feat(flavor): tray stands down, alerts, and defers by intended mode"
```

---

### Task 9: Migration note + docs + RT-67

**Files:**
- Modify: `docs/release-and-distribution.md` (add a short "Flavor exclusivity" paragraph under Install-time product contracts pointing at the spec)
- Modify: `docs/settings-architecture.md` ONLY if its registry checklist enumerates keys (check first; if it lists keys, add `mattstack.mode`)
- Test: `bun run docs:check` stays green (regenerate via `bun scripts/gen-docs.ts` if the command tree changed help text)

- [ ] **Step 1: Docs paragraph** — three sentences: intent setting, park behavior, the one-time cleanup for machines already in a half-state (`rt settings dev-mode <mode>` once, or `launchctl bootout gui/$UID/<wrong-label>`).
- [ ] **Step 2: `bun scripts/gen-docs.ts && bun run docs:check`** — green (the dev-mode tree entry changed in Task 5, so the reference regenerates).
- [ ] **Step 3: Commit**

```bash
git add docs/ website/docs/reference
git commit -m "docs(flavor): exclusivity contract, migration one-time cleanup"
```

---

### Task 10: Full gates + PR

- [ ] **Step 1:** `bunx tsc --noEmit` — clean.
- [ ] **Step 2:** `bun test lib commands packages scripts` — 0 fail.
- [ ] **Step 3:** `bun run test:e2e` — 0 fail (the compiled-binary/no-wrapper invariant: everything boots prod/prod and never parks).
- [ ] **Step 4:** `cd rt-tray && swift test` (or the repo's Swift test invocation) — green.
- [ ] **Step 5:** `bash scripts/repo-purity.sh` — green.
- [ ] **Step 6:** Push branch, open the PR: title "flavor exclusivity: one intended mode, enforced everywhere (RT-67)", body = spec link, the incident one-liner, the Swift smoke checklist from Task 8, and the migration note. Do NOT merge; Matt reviews.

---

## Self-review notes (already applied)

- Spec §1–§6 each map to Tasks 1–8; §7 (deployment/migration) → Tasks 8–9; testing section → per-task steps + Task 10.
- Names used across tasks are consistent: `resolveIntendedMode`, `IntendedMode`, `daemonFlavor`, `parkUntilIntended`, `probeSocketHolder`, `describeTuple`, `FlavorTuple`, `tupleWarning`, `flavorHintPath`, `devModeGuardVerdict`, `renderTupleReadout`, `FlavorGate.decide`.
- Deliberate deviation from the spec's text: the socket probe-takeover lives in the park loop (`probeHolder` leg) rather than inside `startSocketServer` — same contract (probe live holder, log standoff, retry, dead socket falls to the existing unlink+bind), one seam fewer. The spec's `evictStaleDaemon` ordering concern is satisfied because eviction only runs after the park returns (holder drained or dead).
