# rt runner Cloudflare tunnel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `rt runner` publish each lane's canonical port to the internet via a single shared `cloudflared` tunnel using the user's existing Cloudflare auth, so `lane :4000` becomes `p4000.m4tthew.dev`. Per-lane toggle in the runner TUI.

**Architecture:** One global config picks the user's existing cloudflared tunnel + base domain. Per-lane `tunnel.enabled` flag lives on `LaneConfig` (persisted in the runner config file). A new `TunnelManager` in the daemon generates a `cloudflared` ingress config from the lanes' state, spawns one shared `cloudflared` child via `ProcessManager`, and SIGHUPs it to reload when toggles change. A new `tunnel-scope` keymap (entered with `[u]`) drives toggle / setup / copy-URL.

**Tech Stack:** Bun, TypeScript, Rezi (TUI), `cloudflared` (external binary), Cloudflare DNS wildcard CNAME.

---

## Config story (read this before starting)

Three pieces of state, three separate files, each owned by one component:

| File | Owner | Mutability | Purpose |
|---|---|---|---|
| `~/.rt/tunnels/config.json` | setup picker | user-edited via picker | Global: which cloudflared tunnel + base domain + port prefix |
| `~/.rt/runners/<name>.json` (existing, new `tunnel` field per lane) | runner | runner save path | Per-lane `enabled: boolean` |
| `~/.rt/tunnels/runtime-<board>.yml` | TunnelManager | regenerated on every change | Generated cloudflared ingress; never user-edited |

**Why three files instead of one:**
- Global config is shared across every runner board (`rt runner --runner=assured`, `--runner=foo`, etc.) — putting it inside one board's runner file would force duplication or coupling.
- Per-lane toggle co-locates with the lane it owns (just like `mode`, `canonicalPort`). Round-trips through the existing compact format.
- Generated YAML is a runtime artifact — colocating it with the user-editable config invites confusion. Name prefix `runtime-` makes it obviously machine-owned.

**Global config shape (`~/.rt/tunnels/config.json`):**
```json
{
  "tunnelId": "7c3e9b4a-...",
  "tunnelName": "matt-laptop",
  "credentialsFile": "/Users/matt/.cloudflared/7c3e9b4a-....json",
  "baseDomain": "m4tthew.dev",
  "hostnamePrefix": "p"
}
```
- `tunnelId` is the canonical reference (UUIDs are stable; names can be reused).
- `credentialsFile` captured at setup time so the daemon doesn't have to re-resolve `~/.cloudflared/<id>.json`.
- `hostnamePrefix` lets the user pick `""`, `"p"`, `"port-"`, etc. Defaults to `"p"` so the resulting subdomain is always a valid DNS label (pure-numeric labels like `4000.m4tthew.dev` are valid but some old resolvers misbehave).

**Per-lane field on `LaneConfig`:**
```ts
tunnel?: { enabled: boolean };
```
Optional so existing configs round-trip without modification. Absence == disabled.

**Generated YAML (`~/.rt/tunnels/runtime-<board>.yml`):**
```yaml
tunnel: 7c3e9b4a-...
credentials-file: /Users/matt/.cloudflared/7c3e9b4a-....json
ingress:
  - hostname: p4000.m4tthew.dev
    service: http://localhost:4000
  - hostname: p4001.m4tthew.dev
    service: http://localhost:4001
  - service: http_status:404
```
Note: ingress points at the **canonicalPort**, not the ephemeralPort. The existing `ProxyManager` is already listening on the canonical port and forwarding to whichever entry is active — cloudflared just rides on top. Active-entry swaps remain a daemon-internal concern; the tunnel doesn't need to know.

**DNS:** One-time, done by the user (or by setup picker as a convenience): a wildcard CNAME `*.m4tthew.dev → <tunnelId>.cfargotunnel.com`. Setup picker prints the exact `cloudflared tunnel route dns <tunnel> "*.m4tthew.dev"` command but does not run it without confirmation.

---

## File Structure

**Created:**
- `lib/tunnel-config.ts` — global config types, load/save, hostname computation
- `lib/tunnel-ingress.ts` — pure function: `(globalConfig, lanes) → yaml string`
- `lib/daemon/tunnel-manager.ts` — wraps `ProcessManager` for the cloudflared child, owns generated-YAML path + SIGHUP
- `lib/daemon/handlers/tunnel.ts` — IPC handlers
- `lib/runner/keys/tunnel.ts` — `tunnel-scope` keymap
- `commands/pick-tunnel.ts` — setup picker (selects cloudflared tunnel, prompts for base domain + prefix)
- Tests for each of the above, mirroring existing `__tests__/` placement

**Modified:**
- `lib/runner-store.ts` — add `tunnel?` to `LaneConfig`, persist in `saveRunnerConfig`
- `lib/runner-store/compact.ts` — round-trip `tunnel` through compact form
- `lib/daemon.ts` — instantiate `TunnelManager`, register tunnel handlers, add to shutdown
- `lib/daemon/handlers/types.ts` — add `tunnelManager` to `HandlerContext`
- `lib/runner/keys/normal.ts` — add `u: enterScope("tunnel-scope")`
- `commands/runner.tsx` — register `tunnel-scope` in `app.modes(...)`, wire setup picker command
- `lib/runner/components/LaneCard.tsx` — render `🌐 <hostname>` line when `lane.tunnel?.enabled`
- `cli.ts` — register `pick-tunnel` subcommand for the picker

---

## Task 1: Global tunnel config module

**Files:**
- Create: `lib/tunnel-config.ts`
- Test: `lib/__tests__/tunnel-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/__tests__/tunnel-config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-tunnel-cfg-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("tunnel-config", () => {
  test("loadTunnelConfig returns null when file missing", async () => {
    const { loadTunnelConfig } = await import("../tunnel-config.ts");
    expect(loadTunnelConfig()).toBeNull();
  });

  test("saveTunnelConfig then loadTunnelConfig round-trips", async () => {
    const { saveTunnelConfig, loadTunnelConfig } = await import("../tunnel-config.ts");
    saveTunnelConfig({
      tunnelId: "abc-123",
      tunnelName: "matt-laptop",
      credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
      baseDomain: "m4tthew.dev",
      hostnamePrefix: "p",
    });
    expect(loadTunnelConfig()).toEqual({
      tunnelId: "abc-123",
      tunnelName: "matt-laptop",
      credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
      baseDomain: "m4tthew.dev",
      hostnamePrefix: "p",
    });
  });

  test("hostnameFor composes prefix + port + baseDomain", async () => {
    const { hostnameFor } = await import("../tunnel-config.ts");
    expect(hostnameFor({ baseDomain: "m4tthew.dev", hostnamePrefix: "p" } as any, 4000))
      .toBe("p4000.m4tthew.dev");
    expect(hostnameFor({ baseDomain: "m4tthew.dev", hostnamePrefix: "" } as any, 4000))
      .toBe("4000.m4tthew.dev");
  });

  test("loadTunnelConfig throws on malformed JSON instead of silently returning null", async () => {
    const dir = join(tmp, ".rt", "tunnels");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    const { loadTunnelConfig } = await import("../tunnel-config.ts");
    expect(() => loadTunnelConfig()).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/tunnel-config.test.ts`
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 3: Implement `lib/tunnel-config.ts`**

```ts
/**
 * Global Cloudflare tunnel config.
 *
 * Stored at ~/.rt/tunnels/config.json. Shared across all runner boards —
 * one tunnel + base domain serves every lane that wants publishing.
 *
 * On-disk shape is the user-edited source of truth. The generated cloudflared
 * ingress YAML (runtime-<board>.yml) is derived from this plus the runner's
 * LaneConfig[] — see lib/tunnel-ingress.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface TunnelConfig {
  /** Stable cloudflared tunnel UUID. */
  tunnelId: string;
  /** Human-readable tunnel name (display only). */
  tunnelName: string;
  /** Absolute path to the cloudflared credentials JSON. */
  credentialsFile: string;
  /** Apex domain whose wildcard CNAME points at the tunnel. */
  baseDomain: string;
  /**
   * Prefix on the port label, e.g. "p" → "p4000.m4tthew.dev".
   * Empty string yields a pure-numeric subdomain.
   */
  hostnamePrefix: string;
}

function tunnelsDir(): string {
  return join(homedir(), ".rt", "tunnels");
}

function configPath(): string {
  return join(tunnelsDir(), "config.json");
}

/**
 * Load global tunnel config. Returns null when not yet set up.
 * Throws on malformed JSON so callers can surface a clear error instead of
 * silently treating the user's broken file as "not set up".
 */
export function loadTunnelConfig(): TunnelConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    tunnelId:        String(raw.tunnelId ?? ""),
    tunnelName:      String(raw.tunnelName ?? ""),
    credentialsFile: String(raw.credentialsFile ?? ""),
    baseDomain:      String(raw.baseDomain ?? ""),
    hostnamePrefix:  String(raw.hostnamePrefix ?? "p"),
  };
}

export function saveTunnelConfig(cfg: TunnelConfig): void {
  mkdirSync(tunnelsDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

/** Compute the public hostname for a given canonical port. */
export function hostnameFor(cfg: TunnelConfig, port: number): string {
  return `${cfg.hostnamePrefix}${port}.${cfg.baseDomain}`;
}

/** Absolute path to the generated ingress YAML for a given runner board. */
export function runtimeYamlPath(boardName: string): string {
  return join(tunnelsDir(), `runtime-${boardName}.yml`);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test lib/__tests__/tunnel-config.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tunnel-config.ts lib/__tests__/tunnel-config.test.ts
git commit -m "feat(tunnel): add global Cloudflare tunnel config module"
```

---

## Task 2: Add `tunnel` field to `LaneConfig` (round-trip)

**Files:**
- Modify: `lib/runner-store.ts:110-117` (interface), `lib/runner-store.ts:224-258` (normalizeLane), `lib/runner-store.ts:317-346` (saveRunnerConfig)
- Test: `lib/__tests__/runner-store-tunnel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/__tests__/runner-store-tunnel.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-runner-tunnel-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("LaneConfig tunnel round-trip", () => {
  test("absent tunnel field round-trips as undefined", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toBeUndefined();
  });

  test("tunnel.enabled=true survives save/load", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
      tunnel: { enabled: true },
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toEqual({ enabled: true });
  });

  test("tunnel.enabled=false also persists (explicitly disabled)", async () => {
    const { saveRunnerConfig, loadRunnerConfig } = await import("../runner-store.ts");
    saveRunnerConfig("test", [{
      id: "1", canonicalPort: 4000, entries: [], repoName: "repo-a", mode: "warm",
      tunnel: { enabled: false },
    }]);
    const loaded = loadRunnerConfig("test");
    expect(loaded[0]!.tunnel).toEqual({ enabled: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/runner-store-tunnel.test.ts`
Expected: FAIL (TypeScript error or undefined field).

- [ ] **Step 3: Add the field to the interface**

In `lib/runner-store.ts`, modify the `LaneConfig` interface (around line 110):

```ts
export interface LaneConfig {
  id: string;
  canonicalPort: number;
  entries: LaneEntry[];
  activeEntryId?: string;
  repoName: string;
  mode: LaneMode;
  /**
   * Cloudflare tunnel publishing. Absent ≡ disabled.
   * When enabled the daemon's TunnelManager includes this lane's
   * canonicalPort in the generated cloudflared ingress for the active board.
   */
  tunnel?: { enabled: boolean };
}
```

- [ ] **Step 4: Update `normalizeLane` to read it**

In `lib/runner-store.ts`, inside `normalizeLane` (around line 250), add the tunnel field to the return:

```ts
  return {
    id:            String(raw.id ?? ""),
    canonicalPort: Number(raw.canonicalPort ?? 0),
    entries,
    activeEntryId,
    repoName:      String(raw.repoName ?? ""),
    mode,
    ...(raw.tunnel && typeof raw.tunnel === "object"
      ? { tunnel: { enabled: Boolean(raw.tunnel.enabled) } }
      : {}),
  };
```

- [ ] **Step 5: Update `saveRunnerConfig` write path**

In `lib/runner-store.ts`, the existing destructure pattern in `saveRunnerConfig` (around line 332) already spreads `laneRest`, so `tunnel` will be included automatically as long as it's part of the in-memory shape. **Verify by inspection** — no code change should be needed if the destructure is `{ activeEntryId: _id, entries: _entries, ...laneRest }`.

- [ ] **Step 6: Run tests, expect PASS**

Run: `bun test lib/__tests__/runner-store-tunnel.test.ts`
Expected: 3 tests pass.

- [ ] **Step 7: Run the full existing test suite to confirm no regression**

Run: `bun test`
Expected: all existing tests still pass (the new field is optional).

- [ ] **Step 8: Commit**

```bash
git add lib/runner-store.ts lib/__tests__/runner-store-tunnel.test.ts
git commit -m "feat(tunnel): add optional tunnel field to LaneConfig"
```

---

## Task 3: Pure ingress YAML generator

**Files:**
- Create: `lib/tunnel-ingress.ts`
- Test: `lib/__tests__/tunnel-ingress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/__tests__/tunnel-ingress.test.ts
import { describe, test, expect } from "bun:test";
import { generateIngressYaml } from "../tunnel-ingress.ts";
import type { LaneConfig } from "../runner-store.ts";
import type { TunnelConfig } from "../tunnel-config.ts";

const cfg: TunnelConfig = {
  tunnelId: "abc-123",
  tunnelName: "matt-laptop",
  credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
  baseDomain: "m4tthew.dev",
  hostnamePrefix: "p",
};

function lane(id: string, port: number, enabled?: boolean): LaneConfig {
  return {
    id, canonicalPort: port, entries: [], repoName: "r", mode: "warm",
    ...(enabled === undefined ? {} : { tunnel: { enabled } }),
  };
}

describe("generateIngressYaml", () => {
  test("emits header + catch-all even with zero enabled lanes", () => {
    const yaml = generateIngressYaml(cfg, []);
    expect(yaml).toContain("tunnel: abc-123");
    expect(yaml).toContain("credentials-file: /Users/matt/.cloudflared/abc-123.json");
    expect(yaml).toContain("ingress:");
    expect(yaml).toContain("- service: http_status:404");
  });

  test("includes one rule per enabled lane, in lane.id order", () => {
    const yaml = generateIngressYaml(cfg, [
      lane("2", 4001, true),
      lane("1", 4000, true),
      lane("3", 4002, false), // disabled — must be skipped
    ]);
    // Order is by lane.id ascending (display order)
    const i1 = yaml.indexOf("p4000.m4tthew.dev");
    const i2 = yaml.indexOf("p4001.m4tthew.dev");
    const i3 = yaml.indexOf("p4002.m4tthew.dev");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBe(-1);
  });

  test("each rule maps hostname → http://localhost:<canonicalPort>", () => {
    const yaml = generateIngressYaml(cfg, [lane("1", 4000, true)]);
    expect(yaml).toMatch(/- hostname: p4000\.m4tthew\.dev\s+service: http:\/\/localhost:4000/);
  });

  test("absent tunnel field ≡ disabled (no rule emitted)", () => {
    const yaml = generateIngressYaml(cfg, [lane("1", 4000)]);
    expect(yaml).not.toContain("p4000.m4tthew.dev");
  });

  test("empty prefix yields pure-numeric subdomain", () => {
    const yaml = generateIngressYaml({ ...cfg, hostnamePrefix: "" }, [lane("1", 4000, true)]);
    expect(yaml).toContain("4000.m4tthew.dev");
    expect(yaml).not.toContain("p4000.m4tthew.dev");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/tunnel-ingress.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `lib/tunnel-ingress.ts`**

```ts
/**
 * Pure transform: (global tunnel config, lanes) → cloudflared ingress YAML.
 *
 * The output is hand-written YAML (no library) because the schema is tiny and
 * fully under our control. Lanes are emitted in lane.id ascending order so
 * `cloudflared` always sees a deterministic ingress — useful for diffing the
 * generated file when debugging.
 */

import type { LaneConfig } from "./runner-store.ts";
import type { TunnelConfig } from "./tunnel-config.ts";
import { hostnameFor } from "./tunnel-config.ts";

export function generateIngressYaml(cfg: TunnelConfig, lanes: LaneConfig[]): string {
  const enabled = lanes
    .filter((l) => l.tunnel?.enabled === true && l.canonicalPort > 0)
    .sort((a, b) => {
      const na = Number(a.id), nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.id.localeCompare(b.id);
    });

  const lines: string[] = [
    `tunnel: ${cfg.tunnelId}`,
    `credentials-file: ${cfg.credentialsFile}`,
    `ingress:`,
  ];
  for (const lane of enabled) {
    lines.push(`  - hostname: ${hostnameFor(cfg, lane.canonicalPort)}`);
    lines.push(`    service: http://localhost:${lane.canonicalPort}`);
  }
  lines.push(`  - service: http_status:404`);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test lib/__tests__/tunnel-ingress.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tunnel-ingress.ts lib/__tests__/tunnel-ingress.test.ts
git commit -m "feat(tunnel): pure ingress YAML generator"
```

---

## Task 4: TunnelManager (daemon)

**Files:**
- Create: `lib/daemon/tunnel-manager.ts`
- Test: `lib/daemon/__tests__/tunnel-manager.test.ts`

The TunnelManager wraps the existing `ProcessManager` for the cloudflared child. It is responsible for:
- Writing the generated YAML to disk
- Spawning `cloudflared tunnel --config <yaml> run` exactly once per board
- Sending SIGHUP to the running cloudflared after rewriting the YAML
- Reporting status (running / not-running, last error)
- Stopping cloudflared when the runner board exits

It does **not** own:
- The global `TunnelConfig` (that's on disk; TunnelManager just reads it on each operation)
- Lane state (passed in fresh on each call from the runner via the handler)

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/tunnel-manager.test.ts
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-tunnel-mgr-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

function fakeProcessManager() {
  const calls: any[] = [];
  return {
    calls,
    async spawn(id: string, cmd: string, opts: any) { calls.push({ kind: "spawn", id, cmd, opts }); },
    async kill(id: string) { calls.push({ kind: "kill", id }); },
    getProcess(_id: string) { return { pid: 12345 } as any; },
    getSpawnConfig(_id: string) { return calls.some((c) => c.kind === "spawn") ? { cmd: "x", cwd: "y" } : undefined; },
  };
}

const cfg = {
  tunnelId: "abc-123",
  tunnelName: "m",
  credentialsFile: "/cred/abc-123.json",
  baseDomain: "m4tthew.dev",
  hostnamePrefix: "p",
};

describe("TunnelManager", () => {
  test("apply with no enabled lanes does not spawn cloudflared", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any, log: () => {} });
    await mgr.apply("board1", []);
    expect(pm.calls.find((c) => c.kind === "spawn")).toBeUndefined();
  });

  test("apply with one enabled lane writes YAML and spawns cloudflared", async () => {
    const { saveTunnelConfig, runtimeYamlPath } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any, log: () => {} });
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } },
    ] as any);

    const yamlPath = runtimeYamlPath("board1");
    expect(existsSync(yamlPath)).toBe(true);
    const yaml = readFileSync(yamlPath, "utf8");
    expect(yaml).toContain("p4000.m4tthew.dev");

    const spawn = pm.calls.find((c) => c.kind === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn.cmd).toContain("cloudflared");
    expect(spawn.cmd).toContain("--config");
    expect(spawn.cmd).toContain(yamlPath);
    expect(spawn.cmd).toContain("run");
  });

  test("apply twice with same set rewrites YAML and SIGHUPs instead of respawning", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const killSignals: NodeJS.Signals[] = [];
    const origKill = process.kill;
    (process as any).kill = (pid: number, sig: NodeJS.Signals) => {
      killSignals.push(sig);
    };
    try {
      const mgr = new TunnelManager({ processManager: pm as any, log: () => {} });
      const lanes = [{ id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } }] as any;
      await mgr.apply("board1", lanes);
      await mgr.apply("board1", lanes);
      const spawnCount = pm.calls.filter((c) => c.kind === "spawn").length;
      expect(spawnCount).toBe(1);
      expect(killSignals).toContain("SIGHUP");
    } finally {
      (process as any).kill = origKill;
    }
  });

  test("apply with all lanes disabled after previously enabled stops cloudflared", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any, log: () => {} });
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } } as any,
    ]);
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: false } } as any,
    ]);
    expect(pm.calls.find((c) => c.kind === "kill")).toBeDefined();
  });

  test("apply throws when global tunnel config is missing", async () => {
    // Do NOT save config first
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any, log: () => {} });
    await expect(mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } } as any,
    ])).rejects.toThrow(/not configured/i);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `bun test lib/daemon/__tests__/tunnel-manager.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/daemon/tunnel-manager.ts`**

```ts
/**
 * TunnelManager — owns the single cloudflared child per runner board.
 *
 * Lifecycle is driven entirely by `apply(boardName, lanes)`:
 *   - any enabled lane && no running cloudflared  → write YAML, spawn
 *   - any enabled lane && already running         → rewrite YAML, SIGHUP
 *   - no enabled lanes && already running         → kill (stop sharing)
 *   - no enabled lanes && not running             → no-op
 *
 * SIGHUP relies on cloudflared's documented graceful-reload behavior; on reload
 * cloudflared re-reads --config and applies new ingress rules without dropping
 * connections to unchanged hostnames.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ProcessManager } from "./process-manager.ts";
import type { LaneConfig } from "../runner-store.ts";
import { loadTunnelConfig, runtimeYamlPath } from "../tunnel-config.ts";
import { generateIngressYaml } from "../tunnel-ingress.ts";

export type TunnelStatus =
  | { state: "stopped" }
  | { state: "running"; hostnames: string[]; yamlPath: string };

export interface TunnelManagerDeps {
  processManager: Pick<ProcessManager, "spawn" | "kill" | "getProcess" | "getSpawnConfig">;
  log: (msg: string) => void;
}

/** Daemon process id used to register the cloudflared child for a board. */
export function tunnelProcessId(boardName: string): string {
  return `tunnel-${boardName}`;
}

export class TunnelManager {
  private deps: TunnelManagerDeps;
  private lastHostnames = new Map<string, string[]>();

  constructor(deps: TunnelManagerDeps) {
    this.deps = deps;
  }

  /** Bring cloudflared's running state into agreement with `lanes`. */
  async apply(boardName: string, lanes: LaneConfig[]): Promise<void> {
    const enabledLanes = lanes.filter((l) => l.tunnel?.enabled === true);

    if (enabledLanes.length === 0) {
      // Nothing should be published. Tear down if currently running.
      const id = tunnelProcessId(boardName);
      if (this.deps.processManager.getSpawnConfig(id)) {
        await this.deps.processManager.kill(id);
        this.deps.log(`tunnel: stopped cloudflared for board ${boardName} (no lanes enabled)`);
      }
      this.lastHostnames.delete(boardName);
      return;
    }

    const cfg = loadTunnelConfig();
    if (!cfg || !cfg.tunnelId) {
      throw new Error("Cloudflare tunnel not configured — run setup first (rt pick-tunnel)");
    }

    const yamlPath = runtimeYamlPath(boardName);
    const yaml = generateIngressYaml(cfg, lanes);
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, yaml);

    const id = tunnelProcessId(boardName);
    const running = this.deps.processManager.getProcess(id);
    if (running) {
      // Hot reload — SIGHUP picks up new ingress rules.
      try { process.kill(running.pid as number, "SIGHUP"); } catch (err) {
        this.deps.log(`tunnel: SIGHUP failed for board ${boardName}: ${err}`);
      }
      this.deps.log(`tunnel: reloaded cloudflared for board ${boardName}`);
    } else {
      const cmd = `cloudflared tunnel --no-autoupdate --config ${shellEscape(yamlPath)} run`;
      await this.deps.processManager.spawn(id, cmd, { cwd: process.env.HOME ?? "/" });
      this.deps.log(`tunnel: spawned cloudflared for board ${boardName}`);
    }

    this.lastHostnames.set(boardName, enabledLanes.map((l) =>
      `${cfg.hostnamePrefix}${l.canonicalPort}.${cfg.baseDomain}`));
  }

  status(boardName: string): TunnelStatus {
    const id = tunnelProcessId(boardName);
    const running = this.deps.processManager.getProcess(id);
    if (!running) return { state: "stopped" };
    return {
      state: "running",
      hostnames: this.lastHostnames.get(boardName) ?? [],
      yamlPath: runtimeYamlPath(boardName),
    };
  }

  async stop(boardName: string): Promise<void> {
    const id = tunnelProcessId(boardName);
    if (this.deps.processManager.getSpawnConfig(id)) {
      await this.deps.processManager.kill(id);
    }
    this.lastHostnames.delete(boardName);
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test lib/daemon/__tests__/tunnel-manager.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/tunnel-manager.ts lib/daemon/__tests__/tunnel-manager.test.ts
git commit -m "feat(tunnel): TunnelManager owns cloudflared child + SIGHUP reload"
```

---

## Task 5: Daemon IPC handlers

**Files:**
- Create: `lib/daemon/handlers/tunnel.ts`
- Modify: `lib/daemon/handlers/types.ts:66-112` (add `tunnelManager` to `HandlerContext`)
- Test: `lib/daemon/__tests__/tunnel-handlers.test.ts`

Handlers exposed:
- `tunnel:apply` — payload `{ boardName: string, lanes: LaneConfig[] }` → idempotent reconcile
- `tunnel:status` — payload `{ boardName: string }` → `TunnelStatus`
- `tunnel:stop` — payload `{ boardName: string }` → kill cloudflared for board
- `tunnel:list-cf-tunnels` — payload `{}` → shell out to `cloudflared tunnel list --output json` so the setup picker can show options

- [ ] **Step 1: Add `tunnelManager` to HandlerContext**

In `lib/daemon/handlers/types.ts`, add to imports:

```ts
import type { TunnelManager } from "../tunnel-manager.ts";
```

And to the `HandlerContext` interface:

```ts
  /** Cloudflare tunnel lifecycle (one cloudflared child per runner board). */
  tunnelManager: TunnelManager;
```

- [ ] **Step 2: Write the failing handler test**

```ts
// lib/daemon/__tests__/tunnel-handlers.test.ts
import { describe, test, expect } from "bun:test";
import { createTunnelHandlers } from "../handlers/tunnel.ts";

function fakeCtx() {
  const calls: any[] = [];
  return {
    calls,
    tunnelManager: {
      async apply(boardName: string, lanes: any[]) { calls.push({ kind: "apply", boardName, lanes }); },
      async stop(boardName: string) { calls.push({ kind: "stop", boardName }); },
      status(boardName: string) { return { state: "stopped" as const }; },
    },
    log: () => {},
  };
}

describe("tunnel handlers", () => {
  test("tunnel:apply forwards to tunnelManager", async () => {
    const ctx = fakeCtx();
    const handlers = createTunnelHandlers(ctx as any);
    const res = await handlers["tunnel:apply"]({ boardName: "b1", lanes: [] });
    expect(res).toEqual({ ok: true });
    expect(ctx.calls).toContainEqual({ kind: "apply", boardName: "b1", lanes: [] });
  });

  test("tunnel:apply rejects missing boardName", async () => {
    const handlers = createTunnelHandlers(fakeCtx() as any);
    const res = await handlers["tunnel:apply"]({ lanes: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boardName/);
  });

  test("tunnel:status returns manager status", async () => {
    const handlers = createTunnelHandlers(fakeCtx() as any);
    const res = await handlers["tunnel:status"]({ boardName: "b1" });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ state: "stopped" });
  });

  test("tunnel:stop forwards to tunnelManager.stop", async () => {
    const ctx = fakeCtx();
    const handlers = createTunnelHandlers(ctx as any);
    await handlers["tunnel:stop"]({ boardName: "b1" });
    expect(ctx.calls).toContainEqual({ kind: "stop", boardName: "b1" });
  });
});
```

- [ ] **Step 3: Run test, expect FAIL**

Run: `bun test lib/daemon/__tests__/tunnel-handlers.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `lib/daemon/handlers/tunnel.ts`**

```ts
/**
 * Cloudflare tunnel IPC handlers.
 *
 *   tunnel:apply              — reconcile cloudflared state with the supplied lanes
 *   tunnel:status             — running/stopped + active hostnames
 *   tunnel:stop               — tear down cloudflared for a board
 *   tunnel:list-cf-tunnels    — shell out to `cloudflared tunnel list --output json`
 */

import type { HandlerContext, HandlerMap } from "./types.ts";
import type { LaneConfig } from "../../runner-store.ts";

export function createTunnelHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "tunnel:apply": async (payload) => {
      const { boardName, lanes } = payload as { boardName?: string; lanes?: LaneConfig[] };
      if (!boardName) return { ok: false, error: "missing boardName" };
      if (!Array.isArray(lanes)) return { ok: false, error: "missing lanes array" };
      try {
        await ctx.tunnelManager.apply(boardName, lanes);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    "tunnel:status": async (payload) => {
      const { boardName } = payload as { boardName?: string };
      if (!boardName) return { ok: false, error: "missing boardName" };
      return { ok: true, data: ctx.tunnelManager.status(boardName) };
    },

    "tunnel:stop": async (payload) => {
      const { boardName } = payload as { boardName?: string };
      if (!boardName) return { ok: false, error: "missing boardName" };
      try {
        await ctx.tunnelManager.stop(boardName);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    "tunnel:list-cf-tunnels": async () => {
      try {
        const proc = Bun.spawn(["cloudflared", "tunnel", "list", "--output", "json"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const [stdout, code] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (code !== 0) return { ok: false, error: `cloudflared exited with ${code}` };
        return { ok: true, data: JSON.parse(stdout) };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  };
}
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `bun test lib/daemon/__tests__/tunnel-handlers.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/handlers/tunnel.ts lib/daemon/__tests__/tunnel-handlers.test.ts lib/daemon/handlers/types.ts
git commit -m "feat(tunnel): IPC handlers for apply/status/stop/list"
```

---

## Task 6: Wire TunnelManager into the daemon

**Files:**
- Modify: `lib/daemon.ts` (imports near line 73, instantiation near line 114, handlerCtx near line 620, routedHandlers near line 638, cleanup near line 852)

- [ ] **Step 1: Add import**

In `lib/daemon.ts`, add to the handler-factory import block (~line 73):

```ts
import { createTunnelHandlers }    from "./daemon/handlers/tunnel.ts";
```

And to the manager-class import block elsewhere in the file (search for `import { ProxyManager }` and add nearby):

```ts
import { TunnelManager } from "./daemon/tunnel-manager.ts";
```

- [ ] **Step 2: Instantiate the manager**

In `lib/daemon.ts`, after the `proxyManager` instantiation (~line 114), add:

```ts
const tunnelManager  = new TunnelManager({ processManager, log });
```

(Order matters: must be after `processManager` is defined.)

- [ ] **Step 3: Add to handlerCtx**

In `lib/daemon.ts` (~line 620), add `tunnelManager` to the context object:

```ts
const handlerCtx: HandlerContext = {
  processManager, stateStore, remedyEngine, suspendManager, proxyManager,
  attachServer, logBuffer, exclusiveGroup,
  tunnelManager,  // ← add this line
  cache, refreshCache, loadCache, flushCache, remedyEvents: remedyEventQueue,
  // ...
};
```

- [ ] **Step 4: Register handler factory**

In the `routedHandlers` map (~line 638), add:

```ts
  ...createTunnelHandlers(handlerCtx),
```

- [ ] **Step 5: Tear down on shutdown**

In the `cleanup` function (search for `proxyManager.stopAll()` near line 852), add a parallel block:

```ts
  // Stop cloudflared tunnels for every active board before we exit so we don't
  // leave orphans bound to remote ingress.
  try {
    for (const { id } of processManager.list()) {
      if (id.startsWith("tunnel-")) {
        const boardName = id.slice("tunnel-".length);
        void tunnelManager.stop(boardName);
      }
    }
  } catch { /* */ }
```

- [ ] **Step 6: Smoke-build the daemon**

Run: `bun --bun lib/daemon.ts --check` (or whatever the project uses; if no such command, just `bun build lib/daemon.ts --target bun --outfile /tmp/daemon-check.js` to confirm it type-checks at the entrypoint level).

If you don't have a build/check command, run the existing test suite which exercises the daemon imports indirectly:

Run: `bun test`
Expected: all tests pass; no missing-import errors.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon.ts
git commit -m "feat(tunnel): wire TunnelManager into daemon"
```

---

## Task 7: Tunnel setup picker command

**Files:**
- Create: `commands/pick-tunnel.ts`
- Modify: `cli.ts` (register subcommand)

The setup picker is a small interactive flow (similar to the existing `pick-lane`) launched as a tmux popup from inside `rt runner`. It writes its result to a temp file the caller polls.

Steps inside the picker:
1. List Cloudflare tunnels: shell out to `cloudflared tunnel list --output json`. Surface a clear error if `cloudflared` isn't on PATH or isn't logged in (`cloudflared tunnel login`).
2. Prompt user to pick one (single-key picker if only one, otherwise arrow-key select).
3. Prompt for base domain (default value: pre-fill from existing config if present).
4. Prompt for hostname prefix (default `"p"`).
5. Print the wildcard-DNS command (`cloudflared tunnel route dns <name> "*.<domain>"`) and offer to run it. Always show; never silently run.
6. Write `~/.rt/tunnels/config.json` via `saveTunnelConfig`.

- [ ] **Step 1: Implement the picker**

Create `commands/pick-tunnel.ts`. Use `readline/promises` for prompts and `Bun.spawn` to invoke `cloudflared`. Bun's `console.write` plus ANSI codes for an arrow-key select is overkill here — keep it numbered-input simple:

```ts
/**
 * Interactive setup picker for the global Cloudflare tunnel config.
 *
 * Launched as a tmux popup from inside `rt runner` via the tunnel-scope
 * [s] hotkey. Writes the chosen config to ~/.rt/tunnels/config.json via
 * saveTunnelConfig; emits nothing to stdout so the caller doesn't need to
 * parse output.
 *
 * Failure modes:
 *   - cloudflared not on PATH → print install hint, exit 1
 *   - `cloudflared tunnel list` empty → print "rt assumes you have an
 *     existing tunnel — run `cloudflared tunnel create <name>` first",
 *     exit 1
 *   - user aborts (Ctrl-C / EOF) → exit 130, do not write config
 */

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTunnelConfig, saveTunnelConfig, type TunnelConfig } from "../lib/tunnel-config.ts";

interface CFTunnel {
  id:   string;
  name: string;
  // cloudflared output also has created_at, connections, etc.
}

async function listTunnels(): Promise<CFTunnel[]> {
  const proc = Bun.spawn(["cloudflared", "tunnel", "list", "--output", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error("cloudflared tunnel list failed — are you logged in? Run: cloudflared tunnel login");
  const raw = JSON.parse(stdout) as Array<Record<string, any>>;
  return raw.map((t) => ({ id: String(t.id), name: String(t.name) }));
}

/** Resolve the credentials file cloudflared installs at `tunnel create` time. */
function defaultCredsPath(tunnelId: string): string {
  return join(homedir(), ".cloudflared", `${tunnelId}.json`);
}

export async function showPickTunnel(): Promise<void> {
  console.log("\n  rt tunnel setup\n");

  let tunnels: CFTunnel[];
  try {
    tunnels = await listTunnels();
  } catch (err) {
    console.error(`  ✗  ${(err as Error).message}`);
    process.exit(1);
  }
  if (tunnels.length === 0) {
    console.error("  ✗  No Cloudflare tunnels found. Create one first:\n      cloudflared tunnel create matt-laptop");
    process.exit(1);
  }

  const existing = loadTunnelConfig();

  console.log("  Cloudflare tunnels:");
  tunnels.forEach((t, i) => {
    const marker = existing?.tunnelId === t.id ? " ← currently selected" : "";
    console.log(`    ${i + 1}. ${t.name} (${t.id})${marker}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const idxRaw = await rl.question(`\n  pick tunnel [1-${tunnels.length}]: `);
  const idx = Number(idxRaw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= tunnels.length) {
    console.error("  ✗  invalid choice");
    rl.close();
    process.exit(1);
  }
  const chosen = tunnels[idx]!;

  const domainDefault = existing?.baseDomain ?? "";
  const domain = (await rl.question(`  base domain${domainDefault ? ` [${domainDefault}]` : ""}: `)).trim() || domainDefault;
  if (!domain) {
    console.error("  ✗  base domain required");
    rl.close();
    process.exit(1);
  }

  const prefixDefault = existing?.hostnamePrefix ?? "p";
  const prefix = (await rl.question(`  hostname prefix [${prefixDefault}] (empty for pure-numeric): `));
  // Empty input keeps default; user typing a single space means "no prefix".
  const finalPrefix = prefix === "" ? prefixDefault : prefix.trim();

  const credsPath = defaultCredsPath(chosen.id);
  if (!existsSync(credsPath)) {
    console.error(`\n  ✗  credentials file not found at ${credsPath}`);
    console.error(`     Re-create the tunnel or copy the credentials JSON to that path.`);
    rl.close();
    process.exit(1);
  }

  const cfg: TunnelConfig = {
    tunnelId:        chosen.id,
    tunnelName:      chosen.name,
    credentialsFile: credsPath,
    baseDomain:      domain,
    hostnamePrefix:  finalPrefix,
  };
  saveTunnelConfig(cfg);

  console.log(`\n  ✓ saved to ~/.rt/tunnels/config.json`);
  console.log(`\n  Next: ensure DNS routes *.${domain} → this tunnel:`);
  console.log(`      cloudflared tunnel route dns ${chosen.name} "*.${domain}"`);
  console.log(`  (run that once if you haven't already.)\n`);

  rl.close();
}
```

- [ ] **Step 2: Register the subcommand in `cli.ts`**

Find the existing subcommand registrations near line 270 (where `runner` is registered). Add an entry for `pick-tunnel` following the same pattern:

```ts
// Look at how `pick-lane` is registered (grep for it) and add `pick-tunnel`
// in the exact same shape, importing showPickTunnel from "./commands/pick-tunnel.ts".
```

(If `pick-lane` lives at `commands/pick-lane.ts`, mirror its registration verbatim.)

- [ ] **Step 3: Verify**

Run: `rt pick-tunnel` in a shell with at least one cloudflared tunnel.
Expected: interactive prompt walks through the choices and writes `~/.rt/tunnels/config.json`.

- [ ] **Step 4: Commit**

```bash
git add commands/pick-tunnel.ts cli.ts
git commit -m "feat(tunnel): rt pick-tunnel interactive setup command"
```

---

## Task 8: tunnel-scope keymap

**Files:**
- Create: `lib/runner/keys/tunnel.ts`
- Modify: `lib/runner/keys/normal.ts` (add `u` scope gate)
- Modify: `commands/runner.tsx` (register `tunnel-scope` in `app.modes(...)`)

- [ ] **Step 1: Implement `lib/runner/keys/tunnel.ts`**

```ts
/**
 * Tunnel-scope keymap (entered with [u] from normal mode).
 *
 * t[u]nnel — toggle Cloudflare tunnel publishing for lanes.
 *
 * Bindings:
 *   [t] — toggle focused lane
 *   [a] — toggle all lanes (if any are off, turn all on; otherwise turn all off)
 *   [s] — open setup picker (pick-tunnel)
 *   [c] — copy focused lane's public URL to clipboard
 *   [esc] — leave scope
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { daemonQuery } from "../../daemon-client.ts";
import { hostnameFor, loadTunnelConfig } from "../../tunnel-config.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";
import type { LaneConfig } from "../../runner-store.ts";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

/** Board name = the runner config name; passed in by runner.tsx at wire time. */
export function createTunnelKeymap(
  ctx: KeymapContext,
  opts: { boardName: string },
): KeymapHandlers {
  const exitScope = (update: StateUpdater) => {
    update((s) => ({ ...s, mode: { type: "normal" } }));
    ctx.setMode("default");
  };

  async function applyTunnels(lanes: LaneConfig[]): Promise<void> {
    const res = await daemonQuery("tunnel:apply", { boardName: opts.boardName, lanes });
    if (!res?.ok) {
      ctx.showToast(`tunnel: ${res?.error ?? "daemon unavailable"}`);
    }
  }

  function focusedLane(state: RunnerUIState): LaneConfig | undefined {
    return state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
  }

  return {
    escape: ({ update }) => exitScope(update),

    // [t] toggle focused lane
    t: ({ state, update }) => {
      const lane = focusedLane(state);
      if (!lane) { exitScope(update); return; }

      // Guard: warn (but allow) when global config is missing — the daemon will
      // error on apply anyway, but a local toast is friendlier.
      const cfg = loadTunnelConfig();
      if (!cfg && !lane.tunnel?.enabled) {
        ctx.showToast("no tunnel configured — press [u][s] to set up");
        exitScope(update);
        return;
      }

      ctx.safeUpdate((s) => {
        const next = s.lanes.map((l) =>
          l.id === lane.id ? { ...l, tunnel: { enabled: !(l.tunnel?.enabled === true) } } : l);
        ctx.saveCurrent(next);
        void applyTunnels(next);
        return { ...s, lanes: next };
      });
      const newState = !(lane.tunnel?.enabled === true);
      if (cfg) ctx.showToast(newState ? `🌐 ${hostnameFor(cfg, lane.canonicalPort)}` : `tunnel off for lane ${lane.id}`);
      exitScope(update);
    },

    // [a] toggle all
    a: ({ state, update }) => {
      const cfg = loadTunnelConfig();
      const anyOff = state.lanes.some((l) => !(l.tunnel?.enabled === true));
      const turnOn = anyOff;
      if (turnOn && !cfg) {
        ctx.showToast("no tunnel configured — press [u][s] to set up");
        exitScope(update);
        return;
      }
      ctx.safeUpdate((s) => {
        const next = s.lanes.map((l) => ({ ...l, tunnel: { enabled: turnOn } }));
        ctx.saveCurrent(next);
        void applyTunnels(next);
        return { ...s, lanes: next };
      });
      ctx.showToast(turnOn ? "all tunnels on" : "all tunnels off");
      exitScope(update);
    },

    // [s] setup picker
    s: ({ update }) => {
      const cmd = `${ctx.rtShell} pick-tunnel`;
      ctx.openPopup(cmd, { title: "tunnel setup", width: "80", height: "20" });
      exitScope(update);
    },

    // [c] copy URL
    c: ({ state, update }) => {
      const lane = focusedLane(state);
      if (!lane) { exitScope(update); return; }
      if (!(lane.tunnel?.enabled === true)) {
        ctx.showToast("lane has tunnel disabled — press [t] first");
        exitScope(update);
        return;
      }
      const cfg = loadTunnelConfig();
      if (!cfg) {
        ctx.showToast("no tunnel configured");
        exitScope(update);
        return;
      }
      const url = `https://${hostnameFor(cfg, lane.canonicalPort)}`;
      // macOS pbcopy; falls back silently if it isn't present.
      try {
        const r = spawnSync("pbcopy", { input: url });
        if (r.status !== 0) throw new Error();
        ctx.showToast(`copied ${url}`);
      } catch {
        ctx.showToast(url);
      }
      exitScope(update);
    },
  };
}
```

- [ ] **Step 2: Add `u` to normal keymap**

In `lib/runner/keys/normal.ts`, inside the returned handlers object next to the other scope gates (lines 65-67):

```ts
    // Scope gates — enter sub-mode to show scoped key hints
    l: enterScope("lane-scope"),
    p: enterScope("process-scope"),
    o: enterScope("open-scope"),
    u: enterScope("tunnel-scope"),  // ← add this line
```

And widen the type union of `enterScope`:

```ts
  const enterScope = (scopeMode: "lane-scope" | "process-scope" | "open-scope" | "tunnel-scope")
    : KeymapHandlers[string] =>
```

- [ ] **Step 3: Register the mode in `commands/runner.tsx`**

In the `app.modes(...)` call (~line 1142), import and register the new keymap. First find where the runner board name (`name`) is in scope — it's the `--runner` argument. Then add:

```ts
import { createTunnelKeymap } from "../lib/runner/keys/tunnel.ts";
// ...
  app.modes({
    "lane-scope":      createLaneKeymap(keymapContext),
    "process-scope":   createProcessKeymap(keymapContext, { buildEditorCmd }),
    "open-scope":      createOpenKeymap(keymapContext),
    "port-input":      createPortKeymap(keymapContext),
    "entry-picker":    createPickerKeymap(keymapContext),
    "confirm-reset":   createConfirmResetKeymap(keymapContext),
    "confirm-spread":  createConfirmSpreadKeymap(keymapContext),
    "tunnel-scope":    createTunnelKeymap(keymapContext, { boardName: name }),  // ← add
  });
```

(`name` here is the existing runner-config name variable — confirm by grep that it's already in scope at that point.)

- [ ] **Step 4: Reconcile tunnels on runner startup**

Once the runner has loaded its lanes (search for the existing post-load reconcile, e.g. `void ensureProxy(...)` or similar), add a one-shot:

```ts
  // Kick the daemon to sync cloudflared with whatever lanes have tunnel.enabled
  // persisted from last session — restoring the previous session's published URLs.
  void daemonQuery("tunnel:apply", { boardName: name, lanes: currentLanes });
```

Place this near the existing `pollDaemon` / initial state-fetch block. Also add a matching `tunnel:stop` to the runner shutdown path (search for `proxyManager` cleanup in `runner.tsx`):

```ts
  // Tear down cloudflared so closing this runner board doesn't leave a stale
  // tunnel publishing dev URLs. (Other boards' tunnels keep running.)
  void daemonQuery("tunnel:stop", { boardName: name });
```

- [ ] **Step 5: Manual TUI smoke**

Run: `rt runner` against a config with at least one lane on a port that has a live server (`python3 -m http.server 4000` is fine).
- Press `[u][t]` — expect a toast confirming the URL.
- In another terminal: `curl https://p4000.<your-domain>` — expect the http.server response.
- Press `[u][t]` again — tunnel goes off; the curl should now hit cloudflared's 404 catch-all.

- [ ] **Step 6: Commit**

```bash
git add lib/runner/keys/tunnel.ts lib/runner/keys/normal.ts commands/runner.tsx
git commit -m "feat(tunnel): [u] tunnel-scope keymap (t/a/s/c) + reconcile on startup"
```

---

## Task 9: LaneCard tunnel indicator

**Files:**
- Modify: `lib/runner/components/LaneCard.tsx`

- [ ] **Step 1: Add the indicator line**

In `LaneCard.tsx`, after the title row but before `entryElements` are rendered (around line 50), add a conditional row that renders the public URL when tunneling is enabled:

```tsx
import { loadTunnelConfig, hostnameFor } from "../../tunnel-config.ts";
// ... in the body, after computing `title`:

let tunnelUrlEl: any = null;
if (lane.tunnel?.enabled) {
  const cfg = loadTunnelConfig();
  if (cfg) {
    const host = hostnameFor(cfg, lane.canonicalPort);
    tunnelUrlEl = (
      <text key="tunnel" style={{ fg: C.cyan }}>{`  🌐 ${host}`}</text>
    );
  } else {
    tunnelUrlEl = (
      <text key="tunnel" style={{ fg: C.dim }}>{`  🌐 (not configured — [u][s] to set up)`}</text>
    );
  }
}
```

Then include `tunnelUrlEl` in the rendered output — find the existing JSX return and place it adjacent to the title, before `{entryElements}`.

- [ ] **Step 2: Visual check**

Run: `rt runner`. Enable a tunnel on a lane. Confirm the URL appears under the lane title.

- [ ] **Step 3: Commit**

```bash
git add lib/runner/components/LaneCard.tsx
git commit -m "feat(tunnel): show 🌐 hostname on LaneCard when publishing"
```

---

## Task 10: End-to-end verification

This isn't a code task — it's the manual check that proves the whole feature works against a real Cloudflare account.

- [ ] **Step 1: Pre-flight**

Confirm:
- `cloudflared --version` works
- `cloudflared tunnel list` shows at least one tunnel
- DNS: `dig p9999.<your-domain>` returns the tunnel's `*.cfargotunnel.com` (proves wildcard CNAME is live). If not, run `cloudflared tunnel route dns <name> "*.<domain>"` once.

- [ ] **Step 2: First-time setup from inside runner**

- Start `rt runner --runner=test`
- Add a lane on port 4000 (`[l][a]`), point it at any quick service
- Press `[u][s]` — setup picker should walk through tunnel + domain + prefix
- Press `[u][t]` — toast confirms publishing

- [ ] **Step 3: Live test**

From a *different network* (phone hotspot, friend's machine):
- Visit `https://p4000.<your-domain>`
- Confirm you reach the local service

- [ ] **Step 4: Toggle off**

- Press `[u][t]` again
- Re-visit the URL — expect the cloudflared 404 catch-all

- [ ] **Step 5: Multi-lane**

- Enable a second lane (`[u][a]`)
- Confirm both URLs work concurrently
- Tail `~/.rt/daemon.log` and verify cloudflared SIGHUP'd rather than respawning between toggles

- [ ] **Step 6: Persistence**

- Quit `rt runner`
- Restart `rt runner --runner=test`
- Confirm previously-enabled tunnels resume publishing automatically (the startup reconcile from Task 8 step 4)

- [ ] **Step 7: Commit a note**

Once the manual flow passes, append a short note to `README.md` (or a new `docs/runner-tunnel.md`) describing the one-time DNS step and how to use `[u]`. Keep it to one screen.

```bash
git add README.md   # or docs/runner-tunnel.md
git commit -m "docs(tunnel): runner tunnel usage + DNS prerequisite"
```

---

## Self-review notes

- **Config story:** Three files, three owners — global config (user via picker), per-lane flag (runner save path), generated YAML (TunnelManager). Each task explicitly says which file it touches.
- **No surprise DNS:** Setup picker prints the wildcard-DNS command but never runs it without user invocation. Documented in Task 7 step 1 and Task 10 step 1.
- **Backwards compatibility:** New `tunnel?` field on `LaneConfig` is optional; absence == disabled. Existing runner configs round-trip unchanged (covered in Task 2 first test).
- **Daemon lifecycle:** TunnelManager piggybacks on `ProcessManager` so cloudflared inherits the daemon's process-group semantics — when the daemon dies, the OS reaps cloudflared. Explicit `stop` on runner shutdown prevents stale publishing.
- **Multi-board safety:** Each `rt runner` board has its own cloudflared child (`tunnel-<board>`), its own YAML, and its own apply/stop cycle. Two boards can publish disjoint port sets simultaneously.
- **Tests cover:** config round-trip, compact-format round-trip for the new field, pure ingress generator (incl. ordering & disabled-skip), TunnelManager state machine (5 cases), handler error paths. UI keymap is verified manually in Task 8 step 5 + Task 10 because it requires a live tmux/Rezi session.
