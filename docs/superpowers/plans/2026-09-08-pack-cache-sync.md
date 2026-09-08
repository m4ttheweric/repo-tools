# Pack Cache Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Claude Code's plugin cache with the team clone after a pull that moves HEAD, so team pack releases reach members without a hand step, and settle every team pack to installed-and-disabled or not installed.

**Architecture:** A new `lib/setup/pack-cache.ts` owns the per-pack sequence (read-only listing, then `update`, then an install/disable/uninstall settlement) and is called from two places: the team-snapshot daemon via a new `onPulled` hook on `SnapshotSpec.pull`, and `plugins.install`, which stops calling `claude plugin install` unconditionally. `rt setup status` grows a row per team-served pack.

**Tech Stack:** Bun + TypeScript, `bun:test`, the `claude` CLI (2.1.263), the existing `Probes` exec seam.

**Spec:** `docs/superpowers/specs/2026-09-07-pack-cache-sync-design.md`

## Global Constraints

- No em dashes or en dashes in any file. Use "..." or rephrase.
- Clean-code comments only: a comment states a constraint the code cannot show. No narration, no review-facing notes, no task numbers.
- The TS CLI is UI-free: no JSX, no `.tsx`, no UI frameworks under `lib/` or `commands/`.
- Timeout constants, exact values: `SETTLE_EXEC_TIMEOUT_MS = 30_000`, `PACK_EXEC_TIMEOUT_MS = 60_000`, `SETTLEMENT_MAX_MS = 90_000`, `CONVERGE_BUDGET_MS = 120_000`.
- `CONVERGE_BUDGET_MS` may never be raised past 150_000 total round trip against `PULL_TIMEOUT_MS` 180_000 (`commands/team.ts:164`) without raising that first.
- A settlement is atomic with respect to the budget: check before it starts, never between its steps.
- rt disables only what it installed in that same run. Never disable on uncertainty.
- Every `claude` exec passes an explicit `timeoutMs`. `execWithTimeout` with no `timeoutMs` waits forever (`lib/setup/probes.ts:118-122`).
- Exit-code vocabulary from `Probes.exec`: 127 = binary missing, 124 = timed out.
- No new settings keys. `rt.teamSnapshot.enabled` is the kill switch.
- Verification gate for the whole branch: `bun run test:all`, `bunx tsc --noEmit`, `bun run docs:check`, `bun run picker:check`, `bash scripts/repo-purity.sh`.

---

### Task 1: `pack-cache.ts` foundations: the shared listing parser and `readServedPacks`

**Files:**
- Create: `lib/setup/pack-cache.ts`
- Modify: `lib/setup/validators/tools.ts` (delete the local `parsePluginList` / `isPluginListElement` / `PluginListEntry`, import them instead)
- Test: `lib/setup/__tests__/pack-cache.test.ts`

**Interfaces:**
- Consumes: `Probes` from `../setup/probes.ts`, `stripJsonc` from `../jsonc.ts`.
- Produces: `ServedPack`, `ServedPacks`, `InstalledPack`, `readServedPacks(p, slug)`, `parsePluginList(stdout)`.

- [ ] **Step 1: Write the failing tests**

Create `lib/setup/__tests__/pack-cache.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "./fakes.ts";
import { parsePluginList, readServedPacks } from "../pack-cache.ts";

const home = "/fake-home";
const clone = join(home, ".mattstack", "teams", "acme");
const marketplacePath = join(clone, ".claude-plugin", "marketplace.json");

describe("parsePluginList", () => {
  test("keeps id, version and enabled", () => {
    const out = JSON.stringify([{ id: "a@m", version: "1.2.0", enabled: true }]);
    expect(parsePluginList(out)).toEqual([{ id: "a@m", version: "1.2.0", enabled: true }]);
  });

  test("a missing string id rejects the WHOLE payload, not just that element", () => {
    const out = JSON.stringify([{ id: "a@m", enabled: true }, { enabled: false }]);
    expect(parsePluginList(out)).toBeNull();
  });

  test("a missing enabled normalizes to false; a missing version to null", () => {
    expect(parsePluginList(JSON.stringify([{ id: "a@m" }]))).toEqual([{ id: "a@m", version: null, enabled: false }]);
  });

  test("unparsable or non-array output is null", () => {
    expect(parsePluginList("not json")).toBeNull();
    expect(parsePluginList(JSON.stringify({ id: "a@m" }))).toBeNull();
  });
});

describe("readServedPacks", () => {
  test("an absent marketplace.json is not an error", () => {
    const p = fakeProbes({ home });
    expect(readServedPacks(p, "acme")).toEqual({ packs: [], error: null });
  });

  test("an unparsable marketplace.json reports an error rather than vanishing", () => {
    const p = fakeProbes({ home, files: { [marketplacePath]: "{ broken" } });
    const result = readServedPacks(p, "acme");
    expect(result.packs).toEqual([]);
    expect(result.error).toContain(marketplacePath);
  });

  test("a string source resolves the served version from the pack's plugin.json", () => {
    const p = fakeProbes({
      home,
      files: {
        [marketplacePath]: JSON.stringify({ name: "assured", plugins: [{ name: "claimview", source: "./packs/claimview" }] }),
        [join(clone, "packs", "claimview", ".claude-plugin", "plugin.json")]: JSON.stringify({ version: "0.5.28" }),
      },
    });
    expect(readServedPacks(p, "acme")).toEqual({
      packs: [{ id: "claimview@assured", name: "claimview", servedVersion: "0.5.28" }],
      error: null,
    });
  });

  test("an object-form source is listed with a null served version", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ name: "assured", plugins: [{ name: "remote", source: { source: "github", repo: "o/r" } }] }) },
    });
    expect(readServedPacks(p, "acme")).toEqual({
      packs: [{ id: "remote@assured", name: "remote", servedVersion: null }],
      error: null,
    });
  });

  test("a missing or unparsable plugin.json yields a null served version, not a dropped pack", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ name: "assured", plugins: [{ name: "claimview", source: "./packs/claimview" }] }) },
    });
    expect(readServedPacks(p, "acme").packs).toEqual([{ id: "claimview@assured", name: "claimview", servedVersion: null }]);
  });

  test("the marketplace name falls back to the slug when the file omits it", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ plugins: [{ name: "p", source: { source: "url" } }] }) },
    });
    expect(readServedPacks(p, "acme").packs[0]!.id).toBe("p@acme");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/pack-cache.test.ts`
Expected: FAIL, cannot resolve `../pack-cache.ts`.

- [ ] **Step 3: Write `lib/setup/pack-cache.ts`**

```ts
/**
 * The team-pack half of Claude Code plugin management: what the team clone
 * serves, what is installed, and the per-pack sequence that converges one to
 * the other. Lives apart from `steps/plugins.ts` so the daemon and the status
 * validator can both use it without importing a setup step.
 */

import { join } from "path";
import { stripJsonc } from "../jsonc.ts";
import type { Probes } from "./probes.ts";

export interface ServedPack {
  id: string;
  name: string;
  servedVersion: string | null;
}

/** `error` is non-null only for a marketplace.json that exists and did not parse. */
export interface ServedPacks {
  packs: ServedPack[];
  error: string | null;
}

export interface InstalledPack {
  id: string;
  version: string | null;
  enabled: boolean;
}

interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parse boundary: any element missing a string `id` rejects the whole
 * payload, rather than dropping just that element. A schema violation anywhere
 * means the shape cannot be trusted, so the honest answer is "could not be
 * read", not a silently incomplete list. A missing `enabled` or `version` is
 * not such a violation: both are normalized.
 */
export function parsePluginList(stdout: string): InstalledPack[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: InstalledPack[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.id !== "string") return null;
    entries.push({
      id: item.id,
      version: typeof item.version === "string" ? item.version : null,
      enabled: item.enabled === true,
    });
  }
  return entries;
}

function teamCloneDir(home: string, slug: string): string {
  return join(home, ".mattstack", "teams", slug);
}

function readVersion(p: Pick<Probes, "readFile">, pluginDir: string): string | null {
  const raw = p.readFile(join(pluginDir, ".claude-plugin", "plugin.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(stripJsonc(raw)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * A null `servedVersion` means rt cannot read a version for that pack (an
 * object-form source, or an unreadable plugin.json). Callers must treat that
 * as "outside the converge", never as a version mismatch.
 */
export function readServedPacks(p: Pick<Probes, "readFile" | "home">, slug: string): ServedPacks {
  const clone = teamCloneDir(p.home, slug);
  const path = join(clone, ".claude-plugin", "marketplace.json");
  const raw = p.readFile(path);
  if (raw === null) return { packs: [], error: null };

  let parsed: { name?: unknown; plugins?: unknown };
  try {
    parsed = JSON.parse(stripJsonc(raw)) as { name?: unknown; plugins?: unknown };
  } catch {
    return { packs: [], error: `${path} did not parse` };
  }

  const marketplace = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : slug;
  const entries = Array.isArray(parsed.plugins) ? (parsed.plugins as MarketplaceEntry[]) : [];
  const packs: ServedPack[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    const servedVersion = typeof entry.source === "string" ? readVersion(p, join(clone, entry.source)) : null;
    packs.push({ id: `${entry.name}@${marketplace}`, name: entry.name, servedVersion });
  }
  return { packs, error: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/pack-cache.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Point `validators/tools.ts` at the shared parser**

In `lib/setup/validators/tools.ts`, delete the local `PluginListEntry` interface, `isPluginListElement`, and `parsePluginList` (the block around lines 459-497), and add to the imports:

```ts
import { parsePluginList } from "../pack-cache.ts";
```

The call sites in `packRow` and `pluginsRow` are unchanged: `parsePluginList` still returns `null` on a rejected payload and entries carrying `id` and `enabled`. The added `version` field is ignored by both until Task 7.

- [ ] **Step 6: Run the validator tests to verify nothing regressed**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/pack-cache.test.ts`
Expected: PASS, no change in the validator suite's count.

- [ ] **Step 7: Commit**

```bash
git add lib/setup/pack-cache.ts lib/setup/__tests__/pack-cache.test.ts lib/setup/validators/tools.ts
git commit -m "pack-cache: shared plugin-list parser and readServedPacks"
```

---

### Task 2: `settlePack`, the install/disable/uninstall settlement

**Files:**
- Modify: `lib/setup/pack-cache.ts`
- Test: `lib/setup/__tests__/pack-cache-settle.test.ts`

**Interfaces:**
- Consumes: `ExecResult` from `./probes.ts`.
- Produces: `ClaudeRunner`, `SettleOutcome`, `settlePack(run, id, opts)`, and the constants `SETTLE_EXEC_TIMEOUT_MS`, `SETTLEMENT_MAX_MS`, `PACK_EXEC_TIMEOUT_MS`, `CONVERGE_BUDGET_MS`.

- [ ] **Step 1: Write the failing tests**

Create `lib/setup/__tests__/pack-cache-settle.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { settlePack, type ClaudeRunner } from "../pack-cache.ts";
import type { ExecResult } from "../probes.ts";

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

/** Records argv verbs in order and replies from a per-verb script. */
function runner(script: Partial<Record<string, ExecResult>>): ClaudeRunner & { verbs: string[] } {
  const verbs: string[] = [];
  return {
    verbs,
    async run(args: string[]): Promise<ExecResult> {
      const verb = args[1]!;
      verbs.push(verb);
      return script[verb] ?? ok;
    },
  };
}

describe("settlePack", () => {
  test("install then disable leaves the pack installed and disabled", async () => {
    const r = runner({ install: ok, disable: ok });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "disable"]);
  });

  test("a disable that reports already-disabled is done, not a rollback", async () => {
    const r = runner({ install: ok, disable: fail('Plugin "p@m" is already disabled') });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "disable"]);
  });

  test("a failed disable rolls the install back", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: ok });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome.kind).toBe("rolledBack");
    expect(r.verbs).toEqual(["install", "disable", "uninstall"]);
  });

  test("an unknown disable subcommand rolls back rather than leaving the pack enabled", async () => {
    const r = runner({ install: ok, disable: fail("unknown command"), uninstall: ok });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("rolledBack");
  });

  test("a rollback whose uninstall reports already-gone still counts as rolled back", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: fail('Plugin "p@m" not found in installed plugins') });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("rolledBack");
  });

  test("a rollback that genuinely fails is recorded failed", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: fail("permission denied") });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.detail).toContain("permission denied");
    expect(outcome.kind === "failed" && outcome.stage).toBe("rollback");
  });

  test("a clean install failure is terminal, and carries the stage and code plugins.install reports", async () => {
    const r = runner({ install: fail("network refused", 3) });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome).toEqual({ kind: "failed", id: "p@m", detail: "network refused", stage: "install", code: 3 });
    expect(r.verbs).toEqual(["install"]);
  });

  test("a timed-out install is ambiguous, so it uninstalls before recording failed and never disables", async () => {
    const r = runner({ install: fail("timeout", 124), uninstall: ok });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("failed");
    expect(r.verbs).toEqual(["install", "uninstall"]);
  });

  test("an already-installed pack is pre-existing: recorded current, enablement untouched", async () => {
    const r = runner({ install: fail("Plugin already installed") });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "current", id: "p@m" });
    expect(r.verbs).toEqual(["install"]);
  });

  test("a trusted (non-team) pack is enabled instead of disabled", async () => {
    const r = runner({ install: ok, enable: ok });
    expect(await settlePack(r, "p@m", { teamAuthored: false })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "enable"]);
  });

  test("a trusted pack whose enable fails is NOT rolled back", async () => {
    const r = runner({ install: ok, enable: fail("boom") });
    expect(await settlePack(r, "p@m", { teamAuthored: false })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "enable"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/pack-cache-settle.test.ts`
Expected: FAIL, `settlePack` is not exported.

- [ ] **Step 3: Implement `settlePack` in `lib/setup/pack-cache.ts`**

Append:

Add `ExecResult` to the existing `./probes.ts` type import at the top of the file, then append:

```ts
/** Measured against the real ClaimView pack (1.1 MB, 106 files): install 0.86s, disable 0.40s, uninstall 0.41s. */
export const SETTLE_EXEC_TIMEOUT_MS = 30_000;
/** Three settlement execs. A settlement never starts without this much budget left, so it can never abort part-way and strand a pack installed-and-enabled. */
export const SETTLEMENT_MAX_MS = 3 * SETTLE_EXEC_TIMEOUT_MS;
export const PACK_EXEC_TIMEOUT_MS = 60_000;
/** 30s fetch + this must stay under commands/team.ts PULL_TIMEOUT_MS (180_000). */
export const CONVERGE_BUDGET_MS = 120_000;

export interface ClaudeRunner {
  run(args: string[], timeoutMs: number): Promise<ExecResult>;
}

export type SettleOutcome =
  | { kind: "installed"; id: string }
  | { kind: "current"; id: string }
  | { kind: "rolledBack"; id: string; detail: string }
  /** `stage` and `code` let plugins.install keep its exact contract wording for a clean install failure. Only these two stages can fail terminally: a failed `disable` becomes a rollback, never a failure of its own. */
  | { kind: "failed"; id: string; detail: string; stage: "install" | "rollback"; code: number };

function isAlready(res: ExecResult): boolean {
  return /already (installed|added|exists)/i.test(res.stderr);
}

function isAlreadyDisabled(res: ExecResult): boolean {
  return /already disabled/i.test(res.stderr);
}

/** `claude plugin uninstall` on an absent pack says "not found in installed plugins", which this matches. */
function isAlreadyGone(res: ExecResult): boolean {
  return /not installed|not found/i.test(`${res.stdout}\n${res.stderr}`);
}

/**
 * Installs a pack and settles its enable state, undoing the install rather than
 * leaving a team pack enabled. The invariant every branch preserves: on return
 * the pack is installed-and-settled or not installed, never installed-and-enabled
 * for a team-authored pack.
 */
export async function settlePack(runner: ClaudeRunner, id: string, opts: { teamAuthored: boolean }): Promise<SettleOutcome> {
  const install = await runner.run(["plugin", "install", id], SETTLE_EXEC_TIMEOUT_MS);

  if (install.code !== 0) {
    // A pack that already exists appeared underneath this run, so rt did not
    // install it and does not get to change its enablement.
    if (isAlready(install)) return { kind: "current", id };
    // SIGKILL can land after the install wrote its records, so a timeout cannot
    // be read as "nothing happened"; undo it before reporting failure.
    if (install.code === 124) {
      const undo = await runner.run(["plugin", "uninstall", id], SETTLE_EXEC_TIMEOUT_MS);
      const detail = `install timed out; rollback ${undo.code === 0 || isAlreadyGone(undo) ? "ok" : `failed: ${undo.stderr.trim()}`}`;
      return { kind: "failed", id, detail, stage: "install", code: install.code };
    }
    return { kind: "failed", id, detail: install.stderr.trim() || `install exited ${install.code}`, stage: "install", code: install.code };
  }

  if (!opts.teamAuthored) {
    // Enable is best-effort for rt's own baseline: an older claude without the
    // subcommand must not fail an otherwise-good install.
    await runner.run(["plugin", "enable", id], SETTLE_EXEC_TIMEOUT_MS);
    return { kind: "installed", id };
  }

  const disable = await runner.run(["plugin", "disable", id], SETTLE_EXEC_TIMEOUT_MS);
  if (disable.code === 0 || isAlreadyDisabled(disable)) return { kind: "installed", id };

  const undo = await runner.run(["plugin", "uninstall", id], SETTLE_EXEC_TIMEOUT_MS);
  const why = disable.stderr.trim() || `disable exited ${disable.code}`;
  if (undo.code === 0 || isAlreadyGone(undo)) return { kind: "rolledBack", id, detail: why };
  return { kind: "failed", id, detail: `${why}; rollback failed: ${undo.stderr.trim()}`, stage: "rollback", code: undo.code };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/pack-cache-settle.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/pack-cache.ts lib/setup/__tests__/pack-cache-settle.test.ts
git commit -m "pack-cache: settle enablement by rolling back a failed disable"
```

---

### Task 3: `convergePackCache`, the per-pack sequence and the budget

**Files:**
- Modify: `lib/setup/pack-cache.ts`
- Test: `lib/setup/__tests__/pack-cache-converge.test.ts`

**Interfaces:**
- Consumes: `readServedPacks`, `parsePluginList`, `settlePack` from Task 1 and 2; `resolveTool` from `../deps/resolve.ts`; `claudeConfigDirs` from `./tools-install.ts`.
- Produces: `ConvergeResult`, `convergePackCache(p, slug, log, opts?)`.

- [ ] **Step 1: Write the failing tests**

Create `lib/setup/__tests__/pack-cache-converge.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "./fakes.ts";
import { convergePackCache } from "../pack-cache.ts";
import type { ExecResult } from "../probes.ts";

const home = "/fake-home";
const clone = join(home, ".mattstack", "teams", "acme");
const marketplacePath = join(clone, ".claude-plugin", "marketplace.json");

const quietLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

function served(plugins: { name: string; source?: unknown }[]): Record<string, string> {
  return { [marketplacePath]: JSON.stringify({ name: "assured", plugins }) };
}

function pluginJson(pack: string, version: string): Record<string, string> {
  return { [join(clone, "packs", pack, ".claude-plugin", "plugin.json")]: JSON.stringify({ version }) };
}

/** Builds probes whose exec answers `claude plugin ...` from a scripted table. */
function probesWith(files: Record<string, string>, reply: (argv: string[]) => ExecResult) {
  const execs: string[][] = [];
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", ...files },
    exec: async (argv: string[]) => {
      execs.push(argv);
      return reply(argv);
    },
  });
  return { p, execs };
}

const listing = (entries: unknown[]): ExecResult => ({ code: 0, stdout: JSON.stringify(entries), stderr: "" });

describe("convergePackCache", () => {
  test("a pack already at the served version issues no update", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      () => listing([{ id: "claimview@assured", version: "0.5.28", enabled: false }]),
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.current).toEqual(["claimview@assured"]);
    expect(execs.filter((a) => a.includes("update"))).toEqual([]);
  });

  test("a stale pack is updated", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) =>
        argv.includes("list")
          ? listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }])
          : { code: 0, stdout: "", stderr: "" },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.updated).toEqual([{ id: "claimview@assured", to: "0.5.28" }]);
    expect(execs.some((a) => a[1] === "plugin" && a[2] === "update")).toBe(true);
  });

  test("an unreadable listing records every pack failed and writes nothing", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      () => ({ code: 0, stdout: "not json", stderr: "" }),
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toHaveLength(1);
    expect(execs.every((a) => a[2] === "list")).toBe(true);
  });

  test("a pack the listing does not carry is installed, then disabled", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([]);
        if (argv.includes("update")) return { code: 1, stdout: "", stderr: 'Plugin "claimview" not found' };
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.installed).toEqual(["claimview@assured"]);
    const verbs = execs.filter((a) => a[1] === "plugin").map((a) => a[2]);
    expect(verbs).toEqual(["list", "update", "install", "disable"]);
  });

  test("a null served version is skipped whether or not it is listed", async () => {
    for (const entries of [[], [{ id: "remote@assured", version: "1.0.0", enabled: false }]]) {
      const { p, execs } = probesWith(served([{ name: "remote", source: { source: "github", repo: "o/r" } }]), () => listing(entries));
      const result = await convergePackCache(p, "acme", quietLog);
      expect(result.skipped).toEqual([{ id: "remote@assured", reason: "version unknown" }]);
      expect(execs.filter((a) => a[2] === "update" || a[2] === "install")).toEqual([]);
    }
  });

  test("a settlement that does not fit the remaining budget is skipped whole", async () => {
    let clock = 0;
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([]);
        clock += 100_000;
        return { code: 1, stdout: "", stderr: 'Plugin "claimview" not found' };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog, { now: () => clock });
    expect(result.skipped).toEqual([{ id: "claimview@assured", reason: "settlement did not fit the remaining budget" }]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("no claude on the machine is a skip, not a failure", async () => {
    const p = fakeProbes({ home, env: {}, files: served([{ name: "claimview", source: "./packs/claimview" }]) });
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.skipped).toEqual([{ id: "*", reason: "claude not found" }]);
  });

  test("a pack reached after the budget is spent is skipped as budget-exhausted", async () => {
    let clock = 0;
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) { clock += 200_000; return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]); }
        return { code: 0, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog, { now: () => clock });
    expect(result.skipped).toEqual([{ id: "claimview@assured", reason: "converge budget exhausted" }]);
    expect(execs.some((a) => a[2] === "update")).toBe(false);
  });

  test("an update failure that is not not-found never reaches install", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]);
        return { code: 1, stdout: "", stderr: "registry exploded" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toEqual([{ id: "claimview@assured", detail: "registry exploded" }]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("a timed-out update records failed, never 'not installed'", async () => {
    const { p, execs } = probesWith(
      { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
      (argv) => {
        if (argv.includes("list")) return listing([{ id: "claimview@assured", version: "0.5.18", enabled: false }]);
        return { code: 124, stdout: "", stderr: "" };
      },
    );
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed).toHaveLength(1);
    expect(result.installed).toEqual([]);
    expect(execs.some((a) => a[2] === "install")).toBe(false);
  });

  test("an unparsable marketplace.json is reported, not silently empty", async () => {
    const { p } = probesWith({ [marketplacePath]: "{ broken" }, () => listing([]));
    const result = await convergePackCache(p, "acme", quietLog);
    expect(result.failed[0]!.detail).toContain("did not parse");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/pack-cache-converge.test.ts`
Expected: FAIL, `convergePackCache` is not exported.

- [ ] **Step 3: Implement `convergePackCache` in `lib/setup/pack-cache.ts`**

Append, and add these three imports at the top of the file:

```ts
import { resolveTool } from "../deps/resolve.ts";
import { claudeConfigDirs } from "./tools-install.ts";
import type { Logger } from "pino";

export interface ConvergeResult {
  updated: { id: string; to: string | null }[];
  installed: string[];
  /** Installed, then disable failed, so the install was undone. */
  rolledBack: { id: string; detail: string }[];
  current: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; detail: string }[];
}

function emptyResult(): ConvergeResult {
  return { updated: [], installed: [], rolledBack: [], current: [], skipped: [], failed: [] };
}

function isNotFound(res: ExecResult): boolean {
  return /not found/i.test(res.stderr);
}

/**
 * Brings the Claude plugin cache in line with what the team clone serves.
 * Never installs a pack whose served version it cannot read: that version is
 * the only evidence the pack is a local directory copy, which is what the
 * settlement's timeouts were measured against.
 */
export async function convergePackCache(
  p: Probes,
  slug: string,
  log: Logger,
  opts: { now?: () => number } = {},
): Promise<ConvergeResult> {
  const now = opts.now ?? Date.now;
  const result = emptyResult();

  const claude = resolveTool(p, "claude");
  if (!claude.exec) {
    result.skipped.push({ id: "*", reason: "claude not found" });
    return result;
  }

  const servedPacks = readServedPacks(p, slug);
  if (servedPacks.error) {
    result.failed.push({ id: "*", detail: servedPacks.error });
    return result;
  }
  if (servedPacks.packs.length === 0) return result;

  const deadline = now() + CONVERGE_BUDGET_MS;

  for (const dir of claudeConfigDirs(p, [])) {
    const before = { updated: result.updated.length, installed: result.installed.length, rolledBack: result.rolledBack.length };
    const env = { CLAUDE_CONFIG_DIR: dir };
    const runner: ClaudeRunner = {
      run: (args, timeoutMs) => p.exec([...claude.exec!, ...args], { env, timeoutMs }),
    };

    const listed = await runner.run(["plugin", "list", "--json"], PACK_EXEC_TIMEOUT_MS);
    const installed = listed.code === 0 ? parsePluginList(listed.stdout) : null;
    if (!installed) {
      const detail = listed.code === 0 ? "claude plugin list --json could not be read" : `claude plugin list exited ${listed.code}`;
      for (const pack of servedPacks.packs) result.failed.push({ id: pack.id, detail });
      continue;
    }
    const byId = new Map(installed.map((entry) => [entry.id, entry]));

    for (const pack of servedPacks.packs) {
      if (pack.servedVersion === null) {
        result.skipped.push({ id: pack.id, reason: "version unknown" });
        continue;
      }
      const entry = byId.get(pack.id);
      if (entry && entry.version === null) {
        result.skipped.push({ id: pack.id, reason: "version unknown" });
        continue;
      }
      if (entry && entry.version === pack.servedVersion) {
        result.current.push(pack.id);
        continue;
      }
      if (now() >= deadline) {
        result.skipped.push({ id: pack.id, reason: "converge budget exhausted" });
        continue;
      }

      const updated = await runner.run(["plugin", "update", pack.id, "-y"], PACK_EXEC_TIMEOUT_MS);
      if (updated.code === 0) {
        result.updated.push({ id: pack.id, to: pack.servedVersion });
        continue;
      }
      if (!isNotFound(updated)) {
        result.failed.push({ id: pack.id, detail: updated.stderr.trim() || `update exited ${updated.code}` });
        continue;
      }

      // The settlement is atomic against the budget: start it only with room
      // for all three of its calls, so it can never stop after the install.
      if (deadline - now() < SETTLEMENT_MAX_MS) {
        result.skipped.push({ id: pack.id, reason: "settlement did not fit the remaining budget" });
        continue;
      }

      const outcome = await settlePack(runner, pack.id, { teamAuthored: true });
      if (outcome.kind === "installed") result.installed.push(outcome.id);
      else if (outcome.kind === "current") result.current.push(outcome.id);
      else if (outcome.kind === "rolledBack") result.rolledBack.push({ id: outcome.id, detail: outcome.detail });
      else result.failed.push({ id: outcome.id, detail: outcome.detail });
    }

    // Per dir, with that dir's own deltas: the config dir is the point of this
    // line. The daemon's env is launchd's, not the shell's, so which dir it
    // acted on is the only way to compare it with the dir the CLI manages.
    // Silent when nothing moved: a converging pull that changed nothing is not an event.
    const moved = result.updated.length - before.updated + result.installed.length - before.installed + result.rolledBack.length - before.rolledBack;
    if (moved > 0) {
      log.info(
        {
          slug,
          configDir: dir,
          updated: result.updated.length - before.updated,
          installed: result.installed.length - before.installed,
          rolledBack: result.rolledBack.length - before.rolledBack,
        },
        "pack cache converged",
      );
    }
  }

  // Outside the per-dir loop: the result accumulates, so warning inside it would
  // re-warn earlier dirs' entries on every iteration.
  for (const entry of result.rolledBack) log.warn({ slug, id: entry.id, detail: entry.detail }, "pack install rolled back");
  for (const entry of result.failed) log.warn({ slug, id: entry.id, detail: entry.detail }, "pack converge failed");

  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/pack-cache-converge.test.ts`
Expected: PASS, 11 tests (12 once Step 5 lands).

- [ ] **Step 5: Add the enablement-outcome test the spec's Testing section requires**

Written last but it must be seen to fail: before adding it, confirm it would go
red against an implementation that used `install` where the sequence says
`update` (that flips `enabled` to true and leaves `versions` at 0.5.18). A test
added straight to green proves only that it agrees with the code as written.

The tests above assert `ConvergeResult` against a scripted reply. The spec asks
for one that reads the resulting state ("Assertions read those files, so the
outcome is literal"), covering "a stale pack updates and keeps its disabled
state". Add it to the same file, with an exec that models the real claude:

```ts
test("a stale pack updates and keeps its disabled state", async () => {
  const enabled: Record<string, boolean> = { "claimview@assured": false };
  const versions: Record<string, string> = { "claimview@assured": "0.5.18" };
  const { p } = probesWith(
    { ...served([{ name: "claimview", source: "./packs/claimview" }]), ...pluginJson("claimview", "0.5.28") },
    (argv) => {
      const [, , verb, id] = argv;
      if (verb === "list") return listing(Object.keys(versions).map((k) => ({ id: k, version: versions[k], enabled: enabled[k] })));
      // update moves the version and leaves enablement alone; install would enable.
      if (verb === "update") { versions[id!] = "0.5.28"; return { code: 0, stdout: "", stderr: "" }; }
      if (verb === "install") { enabled[id!] = true; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    },
  );

  await convergePackCache(p, "acme", quietLog);

  expect(versions["claimview@assured"]).toBe("0.5.28");
  expect(enabled["claimview@assured"]).toBe(false);
});
```

- [ ] **Step 6: Commit**

```bash
git add lib/setup/pack-cache.ts lib/setup/__tests__/pack-cache-converge.test.ts
git commit -m "pack-cache: converge the cache against what the team clone serves"
```

---

### Task 4: the `onPulled` hook on the snapshot engine

**Files:**
- Modify: `lib/daemon/home-snapshot.ts` (the `HomeSnapshotHandle` interface at line 111, `SnapshotSpec.pull` near line 152, `teamSnapshotSpec` near line 352, `pullNow` near line 686, `doPushInner`'s two pull calls at lines 866 and 873)
- Test: `lib/daemon/__tests__/home-snapshot.test.ts` (extend the existing `describe("startSnapshot: pull", ...)` block at line 2157)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SnapshotSpec.pull.onPulled?: (outcome: "fast-forwarded" | "rebased") => Promise<void>`; `HomeSnapshotHandle.pullNow(opts?: { converge?: boolean })`; `teamSnapshotSpec(slug, repoDir, opts)` gains `opts.onPulled`.

**The boot pull is the trap in this task.** `init()` fires `void pullNow()` at
line 605 whenever the spec pulls, and `pullNow` opens with `await readyPromise`.
So after `await handle.ready` the boot pull's continuation runs before an
explicit `pullNow()` clears its own `await`, the boot pull sets `pullInFlight`,
and the explicit call returns that same promise through
`if (pullInFlight) return pullInFlight`. A test that does not account for this is
asserting the boot pull's hook call, not its own. Every test below flushes and
then resets the recorder, which is the idiom this file already uses (see the
`flushAsync()` calls around lines 2487, 2506 and 2525).

- [ ] **Step 1: Write the failing tests**

Add to the existing pull describe block:

```ts
/** Mirrors the idiom in this describe block. Returns `seen` so each test can reset it past the boot pull. */
function pullHarness(opts: { behind: number; ahead: number }) {
  const seen: ("fast-forwarded" | "rebased")[] = [];
  let throwNext = false;
  const { fn } = makeFakeExec([...pullResponders({ behind: opts.behind, ahead: opts.ahead }), ...defaultResponders()]);
  const { deps, timers } = baseDeps({ exec: fn });
  const { repoDir: _repoDir, ...specDeps } = deps;
  const spec = {
    ...teamSpecFor(),
    pull: {
      intervalSec: 300,
      onPulled: async (outcome: "fast-forwarded" | "rebased") => {
        if (throwNext) throw new Error("converge blew up");
        seen.push(outcome);
      },
    },
  };
  const handle = startSnapshot(spec, specDeps);
  return { handle, seen, timers, throwOnNext: () => { throwNext = true; } };
}

/** The boot pull at init() fires the hook before any test-driven pull; settle it, then start from a clean slate. */
async function pastBootPull(h: { handle: { ready: Promise<void> }; seen: unknown[] }): Promise<void> {
  await h.handle.ready;
  await flushAsync();
  h.seen.length = 0;
}

test("onPulled fires for a fast-forward, with the outcome", async () => {
  const h = pullHarness({ behind: 1, ahead: 0 });
  await pastBootPull(h);
  await h.handle.pullNow();
  h.handle.stop();
  expect(h.seen).toEqual(["fast-forwarded"]);
});

test("onPulled does not fire when HEAD did not move", async () => {
  const h = pullHarness({ behind: 0, ahead: 0 });
  await pastBootPull(h);
  await h.handle.pullNow();
  h.handle.stop();
  expect(h.seen).toEqual([]);
});

test("a throwing onPulled leaves the pull's own outcome intact", async () => {
  const h = pullHarness({ behind: 1, ahead: 0 });
  await pastBootPull(h);
  h.throwOnNext();
  const result = await h.handle.pullNow();
  h.handle.stop();
  expect(result.outcome).toBe("fast-forwarded");
});

test("pullNow({ converge: false }) skips the hook, which is how the push path opts out", async () => {
  const h = pullHarness({ behind: 1, ahead: 0 });
  await pastBootPull(h);
  await h.handle.pullNow({ converge: false });
  h.handle.stop();
  expect(h.seen).toEqual([]);
});

test("a push fires no converge, even though its pull moves HEAD", async () => {
  const seen: string[] = [];
  const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 0 }), ...defaultResponders({ statusZ: "?? mattstack/new.jsonc\0" })]);
  const { deps, timers } = baseDeps({ exec: fn });
  const { repoDir: _repoDir, ...specDeps } = deps;
  const handle = startSnapshot(
    { ...teamSpecFor(), pull: { intervalSec: 300, onPulled: async (o: string) => { seen.push(o); } } },
    specDeps,
  );
  await handle.ready;
  await flushAsync();
  seen.length = 0;

  await handle.runNow("manual");
  timers.fire((t) => t.ms === DEFAULT_SETTINGS.pushDelaySec * 1000);
  await flushAsync();
  handle.stop();

  expect(seen).toEqual([]);
});
```

`makeFakeExec` returns `{ fn, calls, optsLog }`, `makeFakeTimers` exposes
`fire(predicate)` and not a `fireAll`, and `baseDeps` supplies both. There is no
`harness()` helper in this file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts -t onPulled`
Expected: FAIL, the hook never fires and `pullNow` rejects the options argument.

Two caveats about what this RED run does and does not prove. The `-t onPulled`
filter does not select the push test or the re-arm test, whose names do not
contain it; run them by name too. And the push test is legitimately green before
Step 4, because the hook does not exist yet, so nothing can fire it: it only
becomes a guard once Step 4 lands. Do not "fix" it for passing early.

- [ ] **Step 3: Add the hook to the handle interface, the spec type, and `teamSnapshotSpec`**

Widen the handle's own method signature (line 111), or the Task 4 tests fail `tsc` with "Expected 0 arguments":

```ts
  /** Fetch, then fast-forward or rebase. A spec without a `pull` policy always skips. `converge:false` suppresses the post-pull hook. */
  pullNow(opts?: { converge?: boolean }): Promise<PullResult>;
```

Then the `pull` field on `SnapshotSpec`:

```ts
  /** Fetch + rebase policy; absent = never pull (the home repo is single-writer). */
  pull?: {
    intervalSec: number;
    /** Fired after a pull that moved HEAD, outside the git lock. */
    onPulled?: (outcome: "fast-forwarded" | "rebased") => Promise<void>;
  };
```

and `teamSnapshotSpec`, which accepts and forwards it:

```ts
export function teamSnapshotSpec(
  slug: string,
  repoDir: string,
  opts: {
    pullIntervalSec: number;
    originUrl: string;
    probes: Probes;
    readToken?: (p: Probes, remote: string) => Promise<string | null>;
    onPulled?: (outcome: "fast-forwarded" | "rebased") => Promise<void>;
  },
): SnapshotSpec {
  const readToken = opts.readToken ?? storedForgeToken;
  return {
    id: `team:${slug}`,
    repoDir,
    kvNamespace: `team-snapshot:${slug}`,
    eventPrefix: "team",
    scope: teamScope,
    pull: { intervalSec: opts.pullIntervalSec, onPulled: opts.onPulled },
    tokenFor: () => readToken(opts.probes, opts.originUrl),
  };
}
```

- [ ] **Step 4: Fire the hook from `pullNow`, outside the git lock**

```ts
  async function pullNow(opts: { converge?: boolean } = {}): Promise<PullResult> {
    await readyPromise;
    const blocked = disabledReason !== null && disabledReason !== "no-git-identity";
    if (!spec.pull || blocked || safeReadSettings().enabled === false) {
      return { outcome: "skipped", detail: "pull not enabled for this repo" };
    }
    // A caller that coalesces onto an in-flight pull inherits that pull's hook
    // decision: `converge:false` keeps this path from STARTING a converge, not
    // from waiting on one already running.
    if (pullInFlight) return pullInFlight;
    const p = withGitLock(() => doPull());
    pullInFlight = p;
    let result: PullResult;
    try {
      result = await p;
      lastPullSkipped = result.outcome === "skipped" ? result.detail : null;
    } finally {
      pullInFlight = null;
    }
    // Outside the lock: the hook shells out to another CLI, and holding the git
    // lock that long would block the commit cycle. Awaited so the pull loop's
    // re-arm waits for it, which is why the hook carries its own time budget.
    const moved = result.outcome === "fast-forwarded" || result.outcome === "rebased";
    if (moved && opts.converge !== false && spec.pull.onPulled) {
      try {
        await spec.pull.onPulled(result.outcome as "fast-forwarded" | "rebased");
      } catch (err) {
        deps.log.warn({ err, id: spec.id }, `${label}: post-pull hook failed; the pull itself stands`);
      }
    }
    return result;
  }
```

- [ ] **Step 5: Keep BOTH push-path pulls off the hook**

`doPushInner` pulls twice, and both run inside `pushInFlight`. The pre-push pull:

```ts
    if (spec.pull) {
      // converge:false: this pull exists to avoid diverging before a push, not
      // to react to content, and it runs inside pushInFlight.
      const pulled = await pullNow({ converge: false });
      if (pulled.outcome === "conflict" || conflicted) return;
    }
```

and the inline replay after a rejected push, a few lines below:

```ts
      await pullNow({ converge: false });
```

Missing either one puts a plugin install inside the push path, which is what this
split exists to prevent.

One honest limit on what `converge: false` buys: the `if (pullInFlight) return
pullInFlight` guard runs before the option is consulted, so a push that coalesces
onto an already-running converging pull still waits for that converge. The option
guarantees the push path never *starts* a converge, not that a push never waits
on one.

- [ ] **Step 6: Add the re-arm test, which is the reason the hook is bounded at all**

The spec lists "the budget cap returns and lets the pull loop re-arm" as a case
that must be covered. A hook that never returns would stop this clone's pull loop
for the life of the daemon, silently.

The test must drive the TIMER, not `pullNow`. `tryArm()` arms the pull timer at
boot (`home-snapshot.ts:548` says so in as many words), and an explicit
`pullNow()` never touches `pullTimer`: only the timer-driven path re-arms, in
`schedulePull`'s `.finally`. Asserting after an explicit `pullNow` would just be
observing the boot-armed timer and would pass even against a hook that hangs
forever, which is precisely the scenario this covers.

```ts
test("the timer-driven pull re-arms after its hook returns", async () => {
  const h = pullHarness({ behind: 1, ahead: 0 });
  await pastBootPull(h);

  // fire() deletes what it fires, so the boot-armed timer is consumed here and
  // any surviving 300s timer can only be schedulePull's .finally re-arm.
  h.timers.fire((t) => t.ms === 300 * 1000);
  await flushAsync();

  expect([...h.timers.pending.values()].some((t) => t.ms === 300 * 1000)).toBe(true);
  h.handle.stop();
});
```

The janitor (900s) and push (10s) timers do not match that predicate, so firing
it cannot trip an unrelated one.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts`
Expected: PASS, the whole file including the 6 new tests.

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot.test.ts
git commit -m "snapshot: fire an onPulled hook for a pull that moved HEAD"
```

---


### Task 5: wire the converge into the team-snapshot supervisor

**Files:**
- Modify: `lib/daemon/team-snapshots.ts` (the `teamSnapshotSpec` call inside `rescan`)
- Test: `lib/daemon/__tests__/team-snapshots.test.ts`

**Interfaces:**
- Consumes: `convergePackCache` (Task 3), `teamSnapshotSpec`'s `onPulled` (Task 4).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Add to `lib/daemon/__tests__/team-snapshots.test.ts`:

```ts
test("each clone's spec carries an onPulled that converges that slug's packs", async () => {
  const converged: string[] = [];
  const h = harness({
    converge: async (_p: unknown, slug: string) => {
      converged.push(slug);
      return { updated: [], installed: [], rolledBack: [], current: [], skipped: [], failed: [] };
    },
  });
  clone(h.root, "acme");
  const handle = startTeamSnapshots(h.deps);
  await handle.ready;

  // `SnapshotSpec` is already imported in this file, so no cast is needed.
  const spec = h.started[0]!.spec;
  expect(typeof spec.pull?.onPulled).toBe("function");
  await spec.pull!.onPulled!("fast-forwarded");
  expect(converged).toEqual(["acme"]);

  handle.stop();
  h.cleanup();
});
```

Three facts this test depends on, none of which hold today. `harness()` takes no
arguments, so give it an options object spread into the deps it builds. It
returns `{ root, started, deps, log, settings, watchCalls, pending, breakWatch,
emit, watchArmed, fireInterval, cleanup }` and no `handle`, so the handle comes
from `startTeamSnapshots(h.deps)` exactly as every other test in the file does.
And nothing is started unless a clone exists, so `clone(h.root, "acme")` must run
before the handle is built or `h.started[0]` is undefined. The stub returns a
full empty `ConvergeResult`, so it satisfies `typeof convergePackCache`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/team-snapshots.test.ts -t onPulled`
Expected: FAIL, `spec.pull.onPulled` is undefined.

- [ ] **Step 3: Supply the hook**

In `lib/daemon/team-snapshots.ts`, add the import and an injectable seam on `TeamSnapshotsDeps`:

```ts
import { convergePackCache } from "../setup/pack-cache.ts";
```

```ts
  /** Injectable so tests never shell out to a real claude. */
  converge?: typeof convergePackCache;
```

Resolve it beside the other deps in `startTeamSnapshots`:

```ts
  const converge = rawDeps.converge ?? convergePackCache;
```

and pass the hook when building each clone's spec:

```ts
      const spec = teamSnapshotSpec(slug, dir, {
        pullIntervalSec,
        originUrl,
        probes,
        onPulled: async () => {
          await converge(probes, slug, rawDeps.log.child({ team: slug }));
        },
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/daemon/__tests__/team-snapshots.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/team-snapshots.ts lib/daemon/__tests__/team-snapshots.test.ts
git commit -m "team-snapshots: converge the plugin cache after a converging pull"
```

---

### Task 6: `plugins.install` uses the shared sequence

**Files:**
- Modify: `lib/setup/steps/plugins.ts` (the install loop, roughly lines 168-200)
- Test: `lib/setup/__tests__/steps-c.test.ts` (the `describe("plugins.install", ...)` block from line 115)

**Interfaces:**
- Consumes: `parsePluginList`, `settlePack`, `PACK_EXEC_TIMEOUT_MS`, `SETTLE_EXEC_TIMEOUT_MS`, `ClaudeRunner` from `../pack-cache.ts`.
- Produces: no signature change. `installPlugins(ctx)` keeps its `StepOutcome` contract.

- [ ] **Step 1: Write the failing test**

`steps-c.test.ts` does not import `BASE_PLUGINS` today, so add it to the imports first:

```ts
import { BASE_PLUGINS } from "../base-plugins.ts";
```

Then delete the argv-absence assertions from the happy-path test (around `:163`).
The spec requires this specific deletion, because an argv assertion cannot fail
when the outcome is wrong, which is exactly how the current defect stayed green:

```ts
      expect(enables).toHaveLength(3);
      expect(enables.map((c) => c.argv.at(-1))).not.toContain("acme-skills@acme-market");
```

Delete those two lines and put nothing in their place. That test's exec keeps no
enablement record, and Step 4's rule for it is to change only the `list` reply,
so there is nothing there to assert against. The coverage those lines were
standing in for is asserted literally by the first new test below, which is the
entire point of the replacement. Now add to the `plugins.install` describe block:

```ts
test("a team-authored pack ends DISABLED, asserted on the resulting state rather than the argv", async () => {
  const teamDir = join(home, ".mattstack", "teams", "acme");
  const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
  // Models the real claude: install enables what it installs, disable turns it off.
  const enabled: Record<string, boolean> = {};
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
    exec: async (argv) => {
      const [, , verb, id] = argv;
      if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
      if (verb === "install") { enabled[id!] = true; return ok(""); }
      if (verb === "disable") { enabled[id!] = false; return ok(""); }
      if (verb === "enable") { enabled[id!] = true; return ok(""); }
      return ok("");
    },
  });
  const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

  const outcome = await pluginsInstallStep.run(ctx);

  expect(outcome.state).toBe("done");
  expect(enabled["acme-skills@acme-market"]).toBe(false);
  for (const base of BASE_PLUGINS) expect(enabled[base]).toBe(true);
});

test("apply does not re-enable a pack the member turned off, and does not disable one they turned on", async () => {
  // The spec Acceptance bullet: "A member who enables the pack, then runs
  // rt setup apply, still has it enabled afterwards." This is the only test that
  // enters the already-installed/update branch, so it also covers the restored
  // trusted enable.
  const teamDir = join(home, ".mattstack", "teams", "acme");
  const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
  const enabled: Record<string, boolean> = {
    "acme-skills@acme-market": true,   // the member enabled the team pack deliberately
    "mattstack@mattstack": false,      // a baseline plugin that drifted off
    "fast-browser@mattstack": true,
    "chat@mattstack": true,
  };
  const execCalls: string[][] = [];
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
    exec: async (argv) => {
      execCalls.push(argv);
      const [, , verb, id] = argv;
      if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
      if (verb === "update") return ok("");            // moves version, touches nothing else
      if (verb === "install") { enabled[id!] = true; return ok(""); }
      if (verb === "enable") { enabled[id!] = true; return ok(""); }
      if (verb === "disable") { enabled[id!] = false; return ok(""); }
      return ok("");
    },
  });
  const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

  const outcome = await pluginsInstallStep.run(ctx);

  expect(outcome.state).toBe("done");
  expect(enabled["acme-skills@acme-market"]).toBe(true);   // deliberate enable survives apply
  expect(enabled["mattstack@mattstack"]).toBe(true);       // trusted plugin got its enable back
  expect(execCalls.some((a) => a[2] === "install")).toBe(false);
});

test("a team pack the member left disabled is still disabled after apply", async () => {
  const teamDir = join(home, ".mattstack", "teams", "acme");
  const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
  const enabled: Record<string, boolean> = {
    "acme-skills@acme-market": false,
    "mattstack@mattstack": true,
    "fast-browser@mattstack": true,
    "chat@mattstack": true,
  };
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
    exec: async (argv) => {
      const [, , verb, id] = argv;
      if (verb === "list") return ok(JSON.stringify(Object.keys(enabled).map((k) => ({ id: k, version: "1.0.0", enabled: enabled[k] }))));
      if (verb === "install") { enabled[id!] = true; return ok(""); }
      if (verb === "enable") { enabled[id!] = true; return ok(""); }
      if (verb === "disable") { enabled[id!] = false; return ok(""); }
      return ok("");
    },
  });
  const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

  await pluginsInstallStep.run(ctx);

  expect(enabled["acme-skills@acme-market"]).toBe(false);
});

test("a rolled-back pack is not recorded in setup-state as installed", async () => {
  const teamDir = join(home, ".mattstack", "teams", "acme");
  const marketplacePath = join(teamDir, ".claude-plugin", "marketplace.json");
  const p = fakeProbes({
    home,
    env: { PATH: "/usr/local/bin" },
    files: { "/usr/local/bin/claude": "bin", [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills" }] }) },
    exec: async (argv) => {
      const [, , verb] = argv;
      if (verb === "list") return ok("[]");
      if (verb === "disable") return { code: 1, stdout: "", stderr: "boom" };
      return ok("");
    },
  });
  const { ctx } = makeCtx(p, { team: { slug: "acme", name: "Acme", mode: "none" } });

  await pluginsInstallStep.run(ctx);

  expect(readSetupState(p).plugins).not.toContain("acme-skills@acme-market");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/steps-c.test.ts -t plugins.install`
Expected: FAIL, the team pack ends `true` (install enables and nothing disables it), and the rolled-back id is still recorded.

- [ ] **Step 3: Replace the install loop in `lib/setup/steps/plugins.ts`**

Swap the per-plugin body for the shared sequence:

```ts
  const settled: string[] = [];

  for (const dir of configDirs) {
    const env = { CLAUDE_CONFIG_DIR: dir };

    for (const src of marketplaces) {
      const res = await ctx.p.exec([...claude.exec, "plugin", "marketplace", "add", src], { env, timeoutMs: PLUGIN_EXEC_TIMEOUT_MS });
      if (res.code !== 0 && !isAlready(res)) {
        return { state: "failed", detail: `claude plugin marketplace add exited ${res.code}`, remedy: RETRY_REMEDY };
      }
    }

    const runner: ClaudeRunner = {
      run: (args, timeoutMs) => ctx.p.exec([...claude.exec!, ...args], { env, timeoutMs }),
    };
    const listed = await runner.run(["plugin", "list", "--json"], PACK_EXEC_TIMEOUT_MS);
    const installedBefore = listed.code === 0 ? parsePluginList(listed.stdout) : null;
    // Guessing "nothing is installed" here would send every plugin down the
    // install path, and install re-enables a pack the member disabled.
    // Consequence worth knowing: a `claude` too old for `plugin list --json`
    // now fails this step where it used to install. RETRY_REMEDY's "open Claude
    // Code once" is the wrong advice for that, hence a remedy of its own.
    if (!installedBefore) {
      return {
        state: "failed",
        detail: "claude plugin list --json could not be read",
        remedy: "Update Claude Code, then Retry.",
      };
    }
    const byId = new Map(installedBefore.map((e) => [e.id, e]));

    for (const plugin of allPlugins) {
      const teamAuthored = teamAuthoredPlugins.includes(plugin);

      // An already-installed plugin takes update, never install: install would
      // flip a deliberately disabled pack back on.
      if (byId.has(plugin)) {
        const updated = await runner.run(["plugin", "update", plugin, "-y"], PACK_EXEC_TIMEOUT_MS);
        if (updated.code !== 0 && !isNotFoundResult(updated)) {
          return { state: "failed", detail: `claude plugin update exited ${updated.code}`, remedy: RETRY_REMEDY };
        }
        if (updated.code === 0) {
          // Trusted plugins keep the best-effort re-enable they get today. The
          // `tool.plugins` needs-you row's action is `rt setup pack`, which
          // lands here: without this, the one command offered for an
          // installed-but-disabled baseline plugin does nothing.
          if (!teamAuthored) await enableTrusted(runner, plugin, dir);
          settled.push(plugin);
          continue;
        }
      }

      // `settled` accumulates across config dirs, so an id can repeat; the
      // dedupe below is what makes that harmless.
      const outcome = await settlePack(runner, plugin, { teamAuthored });

      // settlePack returns `current` before its enable when install reports
      // "already installed", which is right for a team pack (rt did not install
      // it, so it does not touch its enablement) and wrong for a trusted one,
      // which today falls through to the enable at plugins.ts:186. Reachable:
      // a plugin installed at another scope is absent from this scope's listing
      // while install still reports it already installed.
      if (outcome.kind === "current" && !teamAuthored) {
        await enableTrusted(runner, plugin, dir);
      }
      if (outcome.kind === "failed") {
        // The install-stage wording is the contract's documented example
        // (docs/superpowers/specs/2026-08-21-rt-setup-contract.md) and an
        // existing test asserts it verbatim.
        const detail = outcome.stage === "install" ? `claude plugin install exited ${outcome.code}` : `claude plugin ${plugin}: ${outcome.detail}`;
        return { state: "failed", detail, remedy: RETRY_REMEDY };
      }
      if (outcome.kind === "rolledBack") {
        ctx.log("plugins.install", `${plugin}: install rolled back (${outcome.detail})`);
        continue;
      }
      settled.push(plugin);
    }
  }

  updateSetupState(ctx.p, (s) => ({ ...s, marketplaces: [...s.marketplaces, ...marketplaces], plugins: [...s.plugins, ...new Set(settled)] }));
```

Add `isNotFoundResult` beside `isAlready` in the same file, and the enable helper
both branches use. The helper keeps the log line `plugins.ts:187-189` emits
today, which is the only signal a baseline plugin failed to enable:

```ts
function isNotFoundResult(res: { stderr: string }): boolean {
  return /not found/i.test(res.stderr);
}
```

```ts
  /** Best-effort, and logged: an older claude without the subcommand must never fail an otherwise-good install, but a silent failure leaves a disabled baseline plugin with no signal anywhere. */
  async function enableTrusted(runner: ClaudeRunner, plugin: string, dir: string): Promise<void> {
    const enable = await runner.run(["plugin", "enable", plugin], SETTLE_EXEC_TIMEOUT_MS);
    if (enable.code !== 0 && !isAlready(enable) && !isUnknownSubcommand(enable)) {
      ctx.log("plugins.install", `claude plugin enable ${plugin} (${dir}) exited ${enable.code} ... ignored`);
    }
  }
```

Declare it inside `pluginsInstallRun` so it closes over `ctx`.

Import the new symbols:

```ts
import { parsePluginList, settlePack, PACK_EXEC_TIMEOUT_MS, SETTLE_EXEC_TIMEOUT_MS, type ClaudeRunner } from "../pack-cache.ts";
```

Leave the `teamAuthoredPlugins.length > 0` log line and the `pendingNote` detail as they are: the wording still describes the outcome.

- [ ] **Step 4: Fix the two existing tests whose fake exec cannot answer the new listing**

The happy-path test (around :163) and the idempotent-re-run test (around :266)
use a blanket `ok("")` exec. `""` is not parsable JSON, so under the new loop
they would fail the step on an unreadable listing. Make their exec answer the
listing specifically, leaving every other verb as it was:

```ts
        exec: async (argv, opts) => {
          execCalls.push({ argv, env: opts?.env });
          return argv[2] === "list" ? ok("[]") : ok("");
        },
```

Two more tests in the same describe block use a blanket exec whose stdout is not
parsable JSON, and go red for the same reason. Both must answer the listing too:

- `:138` "a non-string claude.marketplaces/claude.plugins entry is dropped..."
  (`exec: async (argv) => { execCalls.push(argv); return ok(""); }`), which
  asserts `outcome.state === "done"`.
- the "runs materializeSkills AFTER a successful install..." test around `:220`
  (`exec: async () => ok("materialized")`), which also asserts `done`.

The `install exits non-zero` test at `:249` keeps its exact expected detail
(`"claude plugin install exited 3"`) and must still pass unchanged: that string
is the contract's documented example. Give its exec the same `list` answer.

The rule for all five: leave every other verb's reply exactly as it was, and add
only `argv[2] === "list" ? ok("[]") : <the existing reply>`.

One knock-on to expect at `:266` ("an unknown 'enable' subcommand ignored"): with
an empty listing and an "already installed" install, every plugin takes
`settlePack`'s `isAlready` return, and the `enable` fixture is reached again only
because of the trusted-enable fix in Step 3. If that test ever goes quiet about
`enable`, the fix has regressed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/steps-c.test.ts`
Expected: PASS, the whole file, including the unchanged contract-string test.

- [ ] **Step 6: Run the wider setup suite**

Run: `bun test lib/setup`
Expected: PASS. `uninstall.test.ts` still passes because `setup-state` records the same ids for a successful run.

- [ ] **Step 7: Keep `isUnknownSubcommand`**

Round 1 flagged it as dead once the old `enable` branch went away. It is not:
`enableTrusted` uses it for exactly the reason it was written, so leave it in
place. Nothing to do here beyond not deleting it.

- [ ] **Step 8: Commit**

```bash
git add lib/setup/steps/plugins.ts lib/setup/__tests__/steps-c.test.ts
git commit -m "plugins.install: update installed packs, settle new ones, never re-enable"
```

---

### Task 7: the pack rows in `rt setup status`

**Files:**
- Modify: `lib/setup/validators/tools.ts` (`toolRows` signature near line 611, `packRow` near line 506), `lib/setup/plan.ts:157`
- Test: `lib/setup/__tests__/validators-tools.test.ts`

**Interfaces:**
- Consumes: `readServedPacks`, `parsePluginList` from `../pack-cache.ts`.
- Produces: `toolRows(p, reqs, opts, seams)` where `opts` gains `teamSlug: string`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/setup/__tests__/validators-tools.test.ts`:

```ts
test("a team-served pack gets a row even with no requirements.jsonc, naming its version", async () => {
  const rows = await toolRowsFor({
    servedPacks: [{ id: "claimview@assured", name: "claimview", servedVersion: "0.5.28" }],
    pluginList: [{ id: "claimview@assured", version: "0.5.28", enabled: false }],
  });
  const row = rows.find((r) => r.id === "pack.claimview")!;
  expect(row.status).toBe("ready");
  expect(row.detail).toContain("0.5.28");
  expect(row.detail).toContain("claude plugin enable claimview@assured");
});

test("a stale pack is needs-you and names both versions, with no restart caveat", async () => {
  const rows = await toolRowsFor({
    servedPacks: [{ id: "claimview@assured", name: "claimview", servedVersion: "0.5.28" }],
    pluginList: [{ id: "claimview@assured", version: "0.5.18", enabled: false }],
  });
  const row = rows.find((r) => r.id === "pack.claimview")!;
  expect(row.status).toBe("needs-you");
  expect(row.detail).toContain("installed 0.5.18");
  expect(row.detail).toContain("team serves 0.5.28");
  expect(row.detail).not.toContain("restart");
});

test("the restart caveat sits on the converged row, where the cache has already moved", async () => {
  const rows = await toolRowsFor({
    servedPacks: [{ id: "claimview@assured", name: "claimview", servedVersion: "0.5.28" }],
    pluginList: [{ id: "claimview@assured", version: "0.5.28", enabled: true }],
  });
  expect(rows.find((r) => r.id === "pack.claimview")!.detail).toContain("restarts");
});

test("an object-form pack that is not installed says rt does not manage it, never 'installed by Install'", async () => {
  const rows = await toolRowsFor({
    servedPacks: [{ id: "remote@assured", name: "remote", servedVersion: null }],
    pluginList: [],
  });
  const row = rows.find((r) => r.id === "pack.remote")!;
  expect(row.status).toBe("skipped");
  expect(row.detail).toContain("rt does not manage this source");
});

test("an unparsable marketplace.json renders one error row, outside the pack namespace", async () => {
  const rows = await toolRowsFor({ servedError: "/x/marketplace.json did not parse", pluginList: [] });
  const errorRow = rows.find((r) => r.status === "error" && r.detail.includes("did not parse"))!;
  expect(errorRow.id).toBe("team.marketplace");
  // A "pack." id here would be flipped to required in status mode and could
  // never go ready, blocking Install forever for a member who cannot fix it.
  expect(errorRow.id.startsWith("pack.")).toBe(false);
});
```

Add this helper to that file. It must pass `NOOP_SEAMS` like all 85 existing
`toolRows` calls, or `REAL_SEAMS` runs `detectEditors()` against the real machine:

```ts
const TEAM_CLONE = "/fake-home/.mattstack/teams/acme";

async function toolRowsFor(opts: {
  servedPacks?: { id: string; name: string; servedVersion: string | null }[];
  servedError?: string;
  pluginList: unknown[];
}): Promise<Row[]> {
  const packs = opts.servedPacks ?? [];
  const files: Record<string, string> = {};
  if (opts.servedError) {
    files[`${TEAM_CLONE}/.claude-plugin/marketplace.json`] = "{ broken";
  } else {
    files[`${TEAM_CLONE}/.claude-plugin/marketplace.json`] = JSON.stringify({
      name: "assured",
      // A readable served version needs a string source with a plugin.json behind it;
      // a null one is expressed as the object form, exactly as a real marketplace would.
      plugins: packs.map((s) => (s.servedVersion === null ? { name: s.name, source: { source: "github", repo: "o/r" } } : { name: s.name, source: `./packs/${s.name}` })),
    });
    for (const s of packs) {
      if (s.servedVersion !== null) {
        files[`${TEAM_CLONE}/packs/${s.name}/.claude-plugin/plugin.json`] = JSON.stringify({ version: s.servedVersion });
      }
    }
  }
  const p = fakeProbes({
    home: "/fake-home",
    files,
    exec: async (argv) => (argv.includes("list") ? { code: 0, stdout: JSON.stringify(opts.pluginList), stderr: "" } : { code: 0, stdout: "", stderr: "" }),
  });
  return toolRows(p, [], { hasBrew: false, secrets: NO_SECRETS, teamSlug: "acme" }, NOOP_SEAMS);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts -t pack`
Expected: FAIL, `toolRows` takes no `teamSlug` and no `pack.claimview` row exists.

- [ ] **Step 3: Thread the slug and rebuild `packRow`**

Change the signature in `lib/setup/validators/tools.ts`:

```ts
export async function toolRows(
  p: Probes,
  reqs: PackRequirements[],
  // Optional, not required: 85 existing call sites in validators-tools.test.ts
  // pass only { hasBrew, secrets }, and tests are inside the root tsconfig, so a
  // required field turns `bunx tsc --noEmit` red while `bun test` stays green.
  opts: { hasBrew: boolean; secrets: SecretPresence; teamSlug?: string },
  seams: ToolsSeams = REAL_SEAMS,
): Promise<Row[]> {
```

and replace the pack-row emission at the end of that function:

```ts
  const pluginList = await exec(p, ["claude", "plugin", "list", "--json"]);
  rows.push(pluginsRow(pluginList));

  const served = opts.teamSlug ? readServedPacks(p, opts.teamSlug) : { packs: [], error: null };
  if (served.error) {
    // `team.marketplace`, NOT `pack.marketplace`: isInstallSatisfied matches any
    // id starting with "pack.", and an error row can never become ready, so a
    // pack-namespaced id would hold canInstall at false permanently. A member is
    // pull-only and cannot repair the team's marketplace.json, so they would
    // have no way out but --force.
    rows.push(row({ id: "team.marketplace", kind: "tool", title: "Team marketplace", why: "The team's marketplace.json lists the packs Install manages.", required: false, status: "error", detail: served.error }));
  }
  const byPack = new Map(served.packs.map((s) => [s.name, s]));
  const names = [...new Set([...reqs.map((r) => r.pack), ...served.packs.map((s) => s.name)])].sort();
  for (const name of names) {
    const req = reqs.find((r) => r.pack === name) ?? { pack: name, tools: [], integrations: [] };
    rows.push(packRow(req, pluginList, byPack.get(name)));
  }
```

Replace `packRow`'s tail (everything after the existing `entries` null-check) with:

```ts
  const entry = entries.find((e) => e.id === `${req.pack}@${served?.id.split("@")[1] ?? ""}`) ?? entries.find((e) => e.id.startsWith(`${req.pack}@`));

  if (served && served.servedVersion === null && !entry) {
    // optionalNote is dropped: base carries "Installed by Install", which
    // contradicts this row's own detail.
    return row({ ...base, optionalNote: null, status: "skipped", detail: "version unknown; rt does not manage this source" });
  }
  if (!entry) return row({ ...base, status: "missing", detail: "installed by Install (plugins.install)" });

  const installed = entry.version ?? "unknown";
  if (served && served.servedVersion !== null && entry.version !== null && entry.version !== served.servedVersion) {
    return row({ ...base, status: "needs-you", detail: `installed ${installed}, team serves ${served.servedVersion}`, action: INSTALL_PLUGINS_ACTION });
  }
  // No served pack AND no version to report: keep the pre-existing wording
  // exactly, or validators-tools.test.ts:801 ("-> ready, installed") goes red.
  if (!served && entry.version === null) return row({ ...base, status: "ready", detail: "installed" });
  if (!served || served.servedVersion === null) {
    return row({ ...base, status: "ready", detail: entry.version === null ? "installed version unknown, served version unknown" : `${installed} installed, served version unknown` });
  }
  if (entry.version === null) {
    return row({ ...base, status: "ready", detail: `installed version unknown, team serves ${served.servedVersion}` });
  }
  const caveat = "a Claude session started before this version landed uses the old cache until it restarts";
  const enablement = entry.enabled ? "installed and enabled" : `installed, not enabled ... claude plugin enable ${entry.id}`;
  return row({ ...base, status: "ready", detail: `${installed} ${enablement}; ${caveat}` });
```

Extend the import Task 1 already added (a second `import ... parsePluginList` would be a duplicate identifier):

```ts
import { parsePluginList, readServedPacks, type ServedPack } from "../pack-cache.ts";
```

and give `packRow` its third parameter: `function packRow(req: PackRequirements, pluginList: ExecResult, served?: ServedPack): Row`.

- [ ] **Step 4: Stop a `skipped` pack row from blocking Install forever**

`isInstallSatisfied` (`lib/setup/plan.ts:123`) matches every id starting with
`pack.`, and in status mode `applyInstallSatisfiedFlip` flips those to
`required: true`. `finalizePlan` then puts any non-`ready` required row into
`requiredMissing`, which sets `canInstall: false`. An object-form pack's
`skipped` row is never going to become `ready`, so it would block Install
permanently.

A row Install cannot satisfy must not be flipped to required:

```ts
/**
 * A row Install itself can make ready. A `skipped` row is by definition one it
 * cannot: the two that reach here are a pack whose source rt does not manage,
 * and (on a machine with no `claude` at all) every `pack.*` row plus
 * `tool.plugins`. Flipping any of those to required parks canInstall at false
 * with nothing the user can do about it.
 */
function isInstallSatisfied(r: Row): boolean {
  if (r.status === "skipped") return false;
  return INSTALL_SATISFIED_IDS.has(r.id) || r.id.startsWith("pack.");
}
```

and its call site becomes `if (!isInstallSatisfied(r)) return r;`.

Export it so the test can drive the flip directly, since `finalizePlan` is what
turns required rows into `requiredMissing`:

```ts
export function applyInstallSatisfiedFlip(groups: Group[], mode: "plan" | "status"): Group[] {
```

This is a deliberate change to shared plan semantics, so it gets its own test in
`lib/setup/__tests__/plan.test.ts` (not the validators file, which imports
neither symbol):

`plan.test.ts` imports nothing from `contract.ts` today, so the whole import line
is new, and it must include `row` because both tests below call it:

```ts
import { applyInstallSatisfiedFlip } from "../plan.ts";
import { finalizePlan, row, type Group, type Row } from "../contract.ts";

function statusPlan(rows: Row[]) {
  // Group requires a title as well as id and rows.
  const groups: Group[] = [{ id: "tools", title: "Tools", rows }];
  return finalizePlan({ slug: "acme", name: "Acme", mode: "none" }, applyInstallSatisfiedFlip(groups, "status"));
}

test("a skipped pack row never lands in requiredMissing, so it cannot block Install", () => {
  const plan = statusPlan([
    row({ id: "pack.remote", kind: "tool", title: "remote", why: "x", required: false, status: "skipped", detail: "version unknown; rt does not manage this source" }),
  ]);
  expect(plan.requiredMissing).not.toContain("pack.remote");
  expect(plan.canInstall).toBe(true);
});

test("on a machine with no claude, the skipped plugin rows do not block Install either", () => {
  const plan = statusPlan([
    row({ id: "tool.plugins", kind: "tool", title: "Claude plugins", why: "x", required: false, status: "skipped", detail: "claude not installed" }),
    row({ id: "pack.claimview", kind: "tool", title: "claimview", why: "x", required: false, status: "skipped", detail: "claude not installed" }),
  ]);
  expect(plan.requiredMissing).toEqual([]);
  expect(plan.canInstall).toBe(true);
});
```

The second case is the pre-existing behavior this guard also changes: today a
claude-less machine reports `canInstall: false` blocked by rows Install cannot
fix. That is the intended direction (`plugins.install` already skips honestly
when claude is absent), and no existing test asserts the old behavior. Say so in
the commit message rather than letting it look incidental.

- [ ] **Step 5: Update the only caller**

In `lib/setup/plan.ts:157`:

```ts
      const tools = await toolRows(i.p, reqs, { hasBrew, secrets: i.secrets, teamSlug: team.slug });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/plan.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/setup/validators/tools.ts lib/setup/plan.ts lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/plan.test.ts
git commit -m "setup status: a row per team-served pack with its installed and served versions"
```

---

### Task 8: the opt-in real-claude contract test

**Files:**
- Create: `e2e/tests/claude-plugin-contract.test.ts`

**Interfaces:**
- Consumes: `createTestHome` from `../harness.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
/**
 * The claude CLI behaviors pack-cache.ts is built on, asserted against the real
 * binary. Opt-in because no CI workflow installs claude: RT_CLAUDE_PLUGIN_E2E=1.
 * Every branch in settlePack keys off one of these, so a claude behavior change
 * must fail loudly here rather than silently in production.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { createTestHome } from "../harness.ts";

const enabled = process.env.RT_CLAUDE_PLUGIN_E2E === "1";

describe.skipIf(!enabled)("claude plugin contract", () => {
  let home: string;
  let market: string;
  const id = "demopack@probeorg";

  function claude(args: string[]): { code: number; out: string } {
    try {
      return { code: 0, out: execFileSync("claude", args, { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") } }) };
    } catch (err) {
      const e = err as { status: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  function version(): string {
    return JSON.parse(claude(["plugin", "list", "--json"]).out).find((p: { id: string }) => p.id === id).version;
  }

  function isEnabled(): boolean {
    return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).enabledPlugins[id] === true;
  }

  function setVersion(v: string): void {
    writeFileSync(join(market, "packs/demo/.claude-plugin/plugin.json"), JSON.stringify({ name: "demopack", version: v, skills: "./skills/" }));
  }

  let cleanup: () => void;

  afterAll(() => cleanup?.());

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    market = join(home, "market");
    mkdirSync(join(market, ".claude-plugin"), { recursive: true });
    mkdirSync(join(market, "packs/demo/.claude-plugin"), { recursive: true });
    mkdirSync(join(market, "packs/demo/skills/hello"), { recursive: true });
    writeFileSync(join(market, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "probeorg", plugins: [{ name: "demopack", source: "./packs/demo" }] }));
    writeFileSync(join(market, "packs/demo/skills/hello/SKILL.md"), "---\nname: hello\ndescription: probe\n---\nhi\n");
    setVersion("1.0.0");
    claude(["plugin", "marketplace", "add", market]);
  });

  test("install enables the plugin, which is why rt must disable a team pack", () => {
    expect(claude(["plugin", "install", id]).code).toBe(0);
    expect(isEnabled()).toBe(true);
  });

  test("disable then update preserves the disabled state", () => {
    expect(claude(["plugin", "disable", id]).code).toBe(0);
    setVersion("1.1.0");
    expect(claude(["plugin", "update", id, "-y"]).code).toBe(0);
    expect(version()).toBe("1.1.0");
    expect(isEnabled()).toBe(false);
  });

  test("disable on an already-disabled pack exits non-zero saying already disabled", () => {
    const res = claude(["plugin", "disable", id]);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/already disabled/i);
  });

  test("uninstall clears the plugin and its enabledPlugins entry", () => {
    expect(claude(["plugin", "uninstall", id]).code).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins[id]).toBeUndefined();
  });

  test("update on an uninstalled plugin exits non-zero with not found, which is how rt proves absence", () => {
    const res = claude(["plugin", "update", id, "-y"]);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/not found/i);
  });

  test("uninstall on an absent pack matches isAlreadyGone's phrasing", () => {
    const res = claude(["plugin", "uninstall", id]);
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/not installed|not found/i);
  });
});
```

- [ ] **Step 2: Run it opt-in to verify it passes against the real binary**

Run: `RT_CLAUDE_PLUGIN_E2E=1 bun test --preload ./e2e/setup.ts e2e/tests/claude-plugin-contract.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 3: Verify it is inert by default**

Run: `bun test --preload ./e2e/setup.ts e2e/tests/claude-plugin-contract.test.ts`
Expected: 0 tests run, 6 skipped.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/claude-plugin-contract.test.ts
git commit -m "e2e: pin the claude plugin behaviors pack-cache depends on"
```

---

### Task 9: whole-branch verification

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Run the full unit and e2e suites**

Run: `bun run test:all`
Expected: PASS. `bun run test` alone does not run e2e, and CI runs both.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Run the remaining repo gates**

Run: `bun run docs:check && bun run picker:check && bash scripts/repo-purity.sh`
Expected: all pass. No command was added, so `picker:check` is unaffected.

- [ ] **Step 4: Confirm no dash characters entered the diff**

Run: `git diff main...HEAD | grep -n "[—–]"`
Expected: no output.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "pack-cache: fixes from whole-branch verification"
```

---

## Self-Review

**Spec coverage:** trigger and push-path exclusion, both pull sites (Task 4); budget, settlement atomicity and the arithmetic (Tasks 2 and 3); the converge module, per-pack sequence, served-packs reader and null-version rule (Tasks 1 and 3); settlement with rollback (Task 2); shared parser (Task 1); wiring, and the config-dir named in the converge log, which is the whole mitigation for the launchd-vs-shell `CLAUDE_CONFIG_DIR` divergence (Tasks 3 and 5); status rows including the object-form row and the restart caveat placement (Task 7); install path and `SetupState.plugins` (Task 6); testing strategy (Tasks 1-8); verification gate (Task 9). The "no new setting" and "logging" sections are constraints honored inside Tasks 3 and 5 rather than tasks of their own.

Every case the spec's Testing section lists as must-cover now has a test: no
version change issues no update, unreadable listing writes nothing, stale pack
keeps its disabled state (Task 3 Step 5), served-but-absent installs disabled,
all three rollback outcomes, no-`disable`-subcommand rolls back, non-not-found
update never reaches install, timeout records failed, null served version skipped
listed or not, settlement that does not fit is skipped whole, budget cap lets the
pull loop re-arm (Task 4 Step 6), and a push-path pull fires no converge
(Task 4 Step 1's last test).

**Placeholder scan:** every code step carries real code; no TBD, no "similar to Task N", no "add error handling".

**Type consistency:** `ClaudeRunner.run(args, timeoutMs)` is used identically in Tasks 2, 3 and 6. `SettleOutcome`'s four kinds are consumed exactly in Tasks 3 and 6. `ServedPack` fields (`id`, `name`, `servedVersion`) match across Tasks 1, 3 and 7. `parsePluginList` returns `InstalledPack[] | null` and every caller null-checks it.
