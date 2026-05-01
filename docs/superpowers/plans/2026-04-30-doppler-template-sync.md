# Doppler template + auto-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `make initDoppler`-style per-worktree Doppler bring-up with a single per-repo template (`~/.rt/<repo>/doppler-template.yaml`) plus a daemon reconciler that keeps `~/.doppler/.doppler.yaml` in sync across all worktrees.

**Architecture:** A small typed reader/writer for `~/.rt/<repo>/doppler-template.yaml` (the source of truth), a typed reader/writer for `~/.doppler/.doppler.yaml` (the cache Doppler reads at runtime), and a reconciler in the daemon that runs on the existing 5-min cache-refresh tick. The reconciler walks each repo's worktrees, computes absolute per-app paths, and additively writes missing entries to the global Doppler config — never overwriting existing entries (which preserves user overrides). A new `rt doppler` command exposes `init`, `sync`, `status`, and `edit`.

**Tech Stack:** TypeScript, Bun, `yaml` (npm package, new dependency), bun:test.

---

## Files

| File | Change |
|---|---|
| `package.json` | Add `yaml` dependency |
| `lib/doppler-template.ts` | NEW — types + read/write `~/.rt/<repo>/doppler-template.yaml`, plus `captureFromActualConfig` for `rt doppler init` |
| `lib/doppler-config.ts` | NEW — types + read/write `~/.doppler/.doppler.yaml` with atomic write, plus pure `addScopedEntry`/`getScopedEntry` helpers |
| `lib/daemon/doppler-sync.ts` | NEW — reconciler: walk worktrees, compute wanted entries, apply additively, return `{ wrote, overridden }` summary |
| `lib/daemon/handlers/doppler.ts` | NEW — IPC handlers for `doppler:sync` and `doppler:status` |
| `commands/doppler.ts` | NEW — top-level `rt doppler` subcommands (`init`, `sync`, `status`, `edit`) |
| `lib/daemon.ts` | Wire reconciler into `refreshCacheImpl` so it runs every cache-refresh tick |
| `cli.ts` | Add `doppler` subcommand tree to the TREE constant |
| `lib/__tests__/doppler-template.test.ts` | NEW — tests for template I/O |
| `lib/__tests__/doppler-config.test.ts` | NEW — tests for global config I/O + pure helpers |
| `lib/daemon/__tests__/doppler-sync.test.ts` | NEW — tests for the reconciler |

---

### Task 1: Add `yaml` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd /Users/matt/Documents/GitHub/repo-tools
bun add yaml
```

Expected: `yaml` appears under `"dependencies"` in `package.json` (current latest is `^2.x`); `bun.lock` is updated.

- [ ] **Step 2: Verify install**

Run:
```bash
bun -e 'import { parse } from "yaml"; console.log(parse("a: 1").a)'
```

Expected output: `1`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add yaml package for Doppler config read/write"
```

---

### Task 2: `lib/doppler-template.ts` — types + load/save

**Files:**
- Create: `lib/doppler-template.ts`
- Test: `lib/__tests__/doppler-template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/doppler-template.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Pin HOME to a tmpdir BEFORE importing the module under test, since
// daemon-config.ts reads RT_DIR at import time from the user's home.
const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-template-"));
process.env.HOME = tmpHome;

const { loadTemplate, saveTemplate, templatePath } =
  await import("../doppler-template.ts");

describe("doppler-template I/O", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", repo), { recursive: true, force: true }); } catch { /* */ }
  });

  test("templatePath is ~/.rt/<repo>/doppler-template.yaml", () => {
    expect(templatePath(repo)).toBe(join(tmpHome, ".rt", repo, "doppler-template.yaml"));
  });

  test("loadTemplate returns null when the file is missing", () => {
    expect(loadTemplate(repo)).toBeNull();
  });

  test("loadTemplate returns null on malformed YAML", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(templatePath(repo), "this: is: not: valid: yaml::");
    expect(loadTemplate(repo)).toBeNull();
  });

  test("saveTemplate then loadTemplate round-trips entries", () => {
    const entries = [
      { path: "apps/backend",  project: "backend",  config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ];
    saveTemplate(repo, entries);
    expect(loadTemplate(repo)).toEqual(entries);
  });

  test("saveTemplate creates the parent directory if missing", () => {
    saveTemplate(repo, [{ path: "apps/x", project: "x", config: "dev" }]);
    const raw = readFileSync(templatePath(repo), "utf8");
    expect(raw).toContain("project: x");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/doppler-template.test.ts`
Expected: FAIL with "Cannot find module '../doppler-template.ts'"

- [ ] **Step 3: Implement the module**

Create `lib/doppler-template.ts`:

```typescript
/**
 * Per-repo Doppler template — the source of truth for which app subdir of a
 * worktree maps to which Doppler project + config.
 *
 * Path: ~/.rt/<repo>/doppler-template.yaml. Format is a flat list of objects:
 *   - { path: apps/backend,  project: backend,  config: dev }
 *   - { path: apps/frontend, project: frontend, config: dev }
 *
 * The reconciler reads this and writes corresponding entries to
 * ~/.doppler/.doppler.yaml so Doppler CLI works in any worktree without
 * `make initDoppler`. See docs/superpowers/specs/2026-04-30-doppler-template-sync-design.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import { RT_DIR } from "./daemon-config.ts";

export interface DopplerTemplateEntry {
  /** Path relative to the worktree root (e.g. "apps/backend"). */
  path: string;
  /** Doppler project name. */
  project: string;
  /** Doppler config name (almost always "dev"). */
  config: string;
}

export function templatePath(repoName: string): string {
  return join(RT_DIR, repoName, "doppler-template.yaml");
}

/** Load the template. Returns `null` if missing or malformed. */
export function loadTemplate(repoName: string): DopplerTemplateEntry[] | null {
  const path = templatePath(repoName);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries: DopplerTemplateEntry[] = [];
    for (const item of parsed) {
      if (
        item && typeof item === "object" &&
        typeof item.path    === "string" &&
        typeof item.project === "string" &&
        typeof item.config  === "string"
      ) {
        entries.push({ path: item.path, project: item.project, config: item.config });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Persist entries to disk. Creates the parent directory if needed. */
export function saveTemplate(
  repoName: string,
  entries: DopplerTemplateEntry[],
): void {
  const path = templatePath(repoName);
  mkdirSync(join(RT_DIR, repoName), { recursive: true });
  const yaml = stringify(entries);
  writeFileSync(path, yaml);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/doppler-template.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/doppler-template.ts lib/__tests__/doppler-template.test.ts
git commit -m "feat(doppler): add per-repo template reader/writer"
```

---

### Task 3: `lib/doppler-config.ts` — load global Doppler config

**Files:**
- Create: `lib/doppler-config.ts`
- Test: `lib/__tests__/doppler-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/doppler-config.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-config-"));
process.env.HOME = tmpHome;

const { loadDopplerConfig, dopplerConfigPath } =
  await import("../doppler-config.ts");

describe("loadDopplerConfig", () => {
  afterEach(() => {
    try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
  });

  test("dopplerConfigPath is ~/.doppler/.doppler.yaml", () => {
    expect(dopplerConfigPath()).toBe(join(tmpHome, ".doppler", ".doppler.yaml"));
  });

  test("returns empty scoped object when file is missing", () => {
    expect(loadDopplerConfig()).toEqual({ scoped: {} });
  });

  test("returns empty scoped object on malformed YAML", () => {
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), "[invalid yaml:::");
    expect(loadDopplerConfig()).toEqual({ scoped: {} });
  });

  test("parses an existing file with scoped entries", () => {
    const yaml = [
      "scoped:",
      "    /:",
      "        token: secret-aaa",
      "    /Users/matt/repo/apps/backend:",
      "        enclave.project: backend",
      "        enclave.config: dev",
      "",
    ].join("\n");
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), yaml);

    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/"]?.token).toBe("secret-aaa");
    expect(cfg.scoped["/Users/matt/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: FAIL with "Cannot find module '../doppler-config.ts'"

- [ ] **Step 3: Create the module skeleton with `loadDopplerConfig`**

Create `lib/doppler-config.ts`:

```typescript
/**
 * Read/write `~/.doppler/.doppler.yaml`, the global Doppler CLI config.
 *
 * Treated by rt as a cache: the reconciler keeps it in sync with each repo's
 * doppler-template.yaml. Doppler CLI reads this file at runtime, so any
 * process anywhere on the machine that calls `doppler` works as long as the
 * cache is up to date.
 *
 * Writes are atomic (write to .tmp, rename over original) so Doppler CLI
 * never sees a half-written file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse, stringify } from "yaml";

/** Per-path Doppler config (token + endpoints OR enclave.project + enclave.config). */
export interface DopplerScopedEntry {
  token?:             string;
  "api-host"?:        string;
  "dashboard-host"?:  string;
  "enclave.project"?: string;
  "enclave.config"?:  string;
}

export interface DopplerConfig {
  scoped: Record<string, DopplerScopedEntry>;
  /** `fallback:` and any unknown top-level keys preserved as-is for round-trip safety. */
  [other: string]: unknown;
}

export function dopplerConfigPath(): string {
  return join(homedir(), ".doppler", ".doppler.yaml");
}

/** Load `~/.doppler/.doppler.yaml`. Returns `{ scoped: {} }` if missing or malformed. */
export function loadDopplerConfig(): DopplerConfig {
  const path = dopplerConfigPath();
  if (!existsSync(path)) return { scoped: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    if (!parsed || typeof parsed !== "object") return { scoped: {} };
    if (!parsed.scoped || typeof parsed.scoped !== "object") {
      return { ...parsed, scoped: {} };
    }
    return parsed as DopplerConfig;
  } catch {
    return { scoped: {} };
  }
}
```

- [ ] **Step 4: Run the test to verify load tests pass**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/doppler-config.ts lib/__tests__/doppler-config.test.ts
git commit -m "feat(doppler): add loader for ~/.doppler/.doppler.yaml"
```

---

### Task 4: `lib/doppler-config.ts` — atomic write

**Files:**
- Modify: `lib/doppler-config.ts`
- Modify: `lib/__tests__/doppler-config.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `lib/__tests__/doppler-config.test.ts` (inside the same `describe` or as a sibling):

```typescript
const { writeDopplerConfig } = await import("../doppler-config.ts");

describe("writeDopplerConfig", () => {
  afterEach(() => {
    try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
  });

  test("creates the file when missing, including parent dir", () => {
    writeDopplerConfig({
      scoped: {
        "/Users/matt/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    });
    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/Users/matt/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });

  test("atomic-replaces an existing file (no .tmp left behind)", () => {
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), "scoped:\n  /:\n    token: old\n");

    writeDopplerConfig({
      scoped: {
        "/": { token: "new" },
      },
    });

    expect(loadDopplerConfig().scoped["/"]?.token).toBe("new");
    expect(existsSync(dopplerConfigPath() + ".tmp")).toBe(false);
  });

  test("preserves unknown top-level keys (e.g. fallback)", () => {
    const original: any = {
      scoped: { "/": { token: "abc" } },
      fallback: { foo: "bar" },
    };
    writeDopplerConfig(original);
    const reread = loadDopplerConfig();
    expect((reread as any).fallback).toEqual({ foo: "bar" });
  });
});
```

Also add `import { existsSync } from "fs";` at the top if not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: FAIL with "writeDopplerConfig is not a function" or similar.

- [ ] **Step 3: Implement `writeDopplerConfig`**

Append to `lib/doppler-config.ts`:

```typescript
/**
 * Write the config atomically: stringify, write to a `.tmp` sibling, then
 * `renameSync` over the destination. Doppler CLI never sees a half-written
 * file because rename is atomic on the same filesystem.
 *
 * Parent directory is created if missing.
 */
export function writeDopplerConfig(config: DopplerConfig): void {
  const path = dopplerConfigPath();
  const dir = join(homedir(), ".doppler");
  mkdirSync(dir, { recursive: true });

  const tmp = path + ".tmp";
  const yaml = stringify(config);
  writeFileSync(tmp, yaml);
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/doppler-config.ts lib/__tests__/doppler-config.test.ts
git commit -m "feat(doppler): atomic write for ~/.doppler/.doppler.yaml"
```

---

### Task 5: `lib/doppler-config.ts` — pure helpers `getScopedEntry` / `addScopedEntry`

**Files:**
- Modify: `lib/doppler-config.ts`
- Modify: `lib/__tests__/doppler-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/__tests__/doppler-config.test.ts`:

```typescript
const { getScopedEntry, addScopedEntry } = await import("../doppler-config.ts");

describe("getScopedEntry", () => {
  test("returns undefined when path is not present", () => {
    const cfg: any = { scoped: {} };
    expect(getScopedEntry(cfg, "/Users/matt/repo/apps/backend")).toBeUndefined();
  });

  test("returns the entry when present", () => {
    const cfg: any = {
      scoped: {
        "/Users/matt/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    };
    expect(getScopedEntry(cfg, "/Users/matt/repo/apps/backend")).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });
});

describe("addScopedEntry", () => {
  test("adds an entry when missing and returns 'wrote'", () => {
    const cfg: any = { scoped: {} };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("wrote");
    expect(cfg.scoped["/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });

  test("leaves existing matching entry alone and returns 'unchanged'", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("unchanged");
  });

  test("leaves a different existing entry alone and returns 'overridden'", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "staging", // user override — different config
        },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("overridden");
    // Must not have changed the entry
    expect(cfg.scoped["/repo/apps/backend"]["enclave.config"]).toBe("staging");
  });

  test("an entry with only a token (no enclave.*) counts as 'wrote' when we add", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": { token: "secret-xyz" },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    // Spec: only adds when missing. A token-only entry is "missing" the
    // enclave fields — we MUST NOT add (could be a deliberate user-only
    // token entry). Treated as 'overridden' since the entry exists.
    expect(result).toBe("overridden");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: FAIL — `addScopedEntry`/`getScopedEntry` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `lib/doppler-config.ts`:

```typescript
/** Read the scoped entry for a path, or `undefined` if absent. */
export function getScopedEntry(
  config: DopplerConfig,
  absolutePath: string,
): DopplerScopedEntry | undefined {
  return config.scoped[absolutePath];
}

/**
 * Result of attempting to add an entry:
 * - "wrote"      → entry was missing; we added it
 * - "unchanged"  → entry already exists with matching project + config
 * - "overridden" → entry exists but differs from what we wanted; we did NOT modify it
 *
 * Mutates `config.scoped` in place when result is "wrote". The caller must
 * call `writeDopplerConfig(config)` to persist.
 */
export type AddScopedResult = "wrote" | "unchanged" | "overridden";

export function addScopedEntry(
  config: DopplerConfig,
  absolutePath: string,
  project: string,
  configName: string,
): AddScopedResult {
  const existing = config.scoped[absolutePath];
  if (existing === undefined) {
    config.scoped[absolutePath] = {
      "enclave.project": project,
      "enclave.config":  configName,
    };
    return "wrote";
  }
  // Entry exists. Same enclave.project + enclave.config → no-op.
  if (
    existing["enclave.project"] === project &&
    existing["enclave.config"]  === configName
  ) {
    return "unchanged";
  }
  // Different entry (different project/config, or token-only). Do not
  // modify — could be a deliberate user override.
  return "overridden";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/doppler-config.test.ts`
Expected: PASS, all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/doppler-config.ts lib/__tests__/doppler-config.test.ts
git commit -m "feat(doppler): pure helpers for adding scoped entries"
```

---

### Task 6: `lib/doppler-template.ts` — `captureFromActualConfig` for `rt doppler init`

**Files:**
- Modify: `lib/doppler-template.ts`
- Modify: `lib/__tests__/doppler-template.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/doppler-template.test.ts`:

```typescript
const { captureFromActualConfig } = await import("../doppler-template.ts");

describe("captureFromActualConfig", () => {
  test("captures enclave entries under the given worktree path, relative-pathed", () => {
    const dopplerCfg: any = {
      scoped: {
        "/repo/primary": { token: "secret-xxx" },
        "/repo/primary/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
        "/repo/primary/apps/frontend": {
          "enclave.project": "frontend",
          "enclave.config":  "dev",
        },
        "/repo/primary/packages/sidekick": {
          "enclave.project": "adjuster",
          "enclave.config":  "dev",
        },
        // Entry from a different worktree — must not be captured
        "/repo/wktree-2/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    };
    const captured = captureFromActualConfig(dopplerCfg, "/repo/primary");
    expect(captured).toEqual([
      { path: "apps/backend",       project: "backend",  config: "dev" },
      { path: "apps/frontend",      project: "frontend", config: "dev" },
      { path: "packages/sidekick",  project: "adjuster", config: "dev" },
    ]);
  });

  test("ignores token-only entries (no enclave fields)", () => {
    const dopplerCfg: any = {
      scoped: {
        "/repo/primary": { token: "secret-xxx" },
        "/repo/primary/apps/x": {
          "enclave.project": "x",
          "enclave.config":  "dev",
        },
      },
    };
    expect(captureFromActualConfig(dopplerCfg, "/repo/primary")).toEqual([
      { path: "apps/x", project: "x", config: "dev" },
    ]);
  });

  test("returns empty array if no enclave entries exist under the worktree", () => {
    const dopplerCfg: any = { scoped: { "/": { token: "x" } } };
    expect(captureFromActualConfig(dopplerCfg, "/repo/primary")).toEqual([]);
  });

  test("returns entries sorted by path for deterministic output", () => {
    const dopplerCfg: any = {
      scoped: {
        "/repo/primary/zebra":  { "enclave.project": "z", "enclave.config": "dev" },
        "/repo/primary/alpha":  { "enclave.project": "a", "enclave.config": "dev" },
        "/repo/primary/middle": { "enclave.project": "m", "enclave.config": "dev" },
      },
    };
    const captured = captureFromActualConfig(dopplerCfg, "/repo/primary");
    expect(captured.map(e => e.path)).toEqual(["alpha", "middle", "zebra"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/doppler-template.test.ts`
Expected: FAIL — `captureFromActualConfig` not exported.

- [ ] **Step 3: Implement the helper**

Append to `lib/doppler-template.ts`:

```typescript
import type { DopplerConfig } from "./doppler-config.ts";

/**
 * Walk a loaded Doppler config and capture every `enclave.*` entry under the
 * given worktree path. Returns relative-pathed template entries, sorted by
 * path for deterministic output.
 *
 * Used by `rt doppler init` to bootstrap a template from whatever the user
 * already had set up via `make initDoppler` or `doppler setup`.
 */
export function captureFromActualConfig(
  dopplerCfg: DopplerConfig,
  worktreeRoot: string,
): DopplerTemplateEntry[] {
  const prefix = worktreeRoot.endsWith("/") ? worktreeRoot : worktreeRoot + "/";
  const out: DopplerTemplateEntry[] = [];
  for (const [absPath, entry] of Object.entries(dopplerCfg.scoped)) {
    if (!absPath.startsWith(prefix)) continue;
    const project = entry["enclave.project"];
    const config  = entry["enclave.config"];
    if (typeof project !== "string" || typeof config !== "string") continue;
    out.push({ path: absPath.slice(prefix.length), project, config });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/doppler-template.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/doppler-template.ts lib/__tests__/doppler-template.test.ts
git commit -m "feat(doppler): captureFromActualConfig for rt doppler init"
```

---

### Task 7: `lib/daemon/doppler-sync.ts` — reconciler

**Files:**
- Create: `lib/daemon/doppler-sync.ts`
- Test: `lib/daemon/__tests__/doppler-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/doppler-sync.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-sync-"));
process.env.HOME = tmpHome;

const { reconcileForRepo } = await import("../doppler-sync.ts");
const { saveTemplate } = await import("../../doppler-template.ts");
const { loadDopplerConfig, writeDopplerConfig } = await import("../../doppler-config.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt"),     { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
});

describe("reconcileForRepo", () => {
  test("returns wrote=0 when no template exists", async () => {
    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({ wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" });
  });

  test("writes per-app entries for each worktree × template entry", async () => {
    saveTemplate(REPO, [
      { path: "apps/backend",  project: "backend",  config: "dev" },
      { path: "apps/frontend", project: "frontend", config: "dev" },
    ]);

    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary", "/repo/wktree-2"],
    });

    expect(summary.wrote).toBe(4); // 2 worktrees × 2 entries
    expect(summary.overridden).toBe(0);

    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/repo/primary/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
    expect(cfg.scoped["/repo/wktree-2/apps/frontend"]).toEqual({
      "enclave.project": "frontend",
      "enclave.config":  "dev",
    });
  });

  test("is idempotent — second run reports unchanged", async () => {
    saveTemplate(REPO, [{ path: "apps/backend", project: "backend", config: "dev" }]);

    await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    const second = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });

    expect(second.wrote).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.overridden).toBe(0);
  });

  test("does not overwrite a user override (different config)", async () => {
    saveTemplate(REPO, [{ path: "apps/backend", project: "backend", config: "dev" }]);
    writeDopplerConfig({
      scoped: {
        "/repo/primary/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "staging", // user override
        },
      },
    });

    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary.wrote).toBe(0);
    expect(summary.overridden).toBe(1);
    expect(loadDopplerConfig().scoped["/repo/primary/apps/backend"]?.["enclave.config"])
      .toBe("staging");
  });

  test("returns skipped=malformed-template if template can't parse", async () => {
    mkdirSync(join(tmpHome, ".rt", REPO), { recursive: true });
    writeFileSync(
      join(tmpHome, ".rt", REPO, "doppler-template.yaml"),
      "[invalid yaml::",
    );

    const summary = await reconcileForRepo({
      repoName: REPO,
      worktreeRoots: ["/repo/primary"],
    });
    expect(summary).toEqual({
      wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/doppler-sync.test.ts`
Expected: FAIL with "Cannot find module '../doppler-sync.ts'"

- [ ] **Step 3: Implement the reconciler**

Create `lib/daemon/doppler-sync.ts`:

```typescript
/**
 * Doppler-sync reconciler — keeps `~/.doppler/.doppler.yaml` consistent with
 * each repo's `~/.rt/<repo>/doppler-template.yaml` across all worktrees.
 *
 * Called once per cache-refresh tick by the daemon (`refreshCacheImpl` in
 * `lib/daemon.ts`) and on demand by `rt doppler sync`. The reconciler is
 * additive — it only writes missing entries and never overwrites existing
 * ones, so user overrides via `doppler setup -p X -c Y` are preserved.
 */

import { join } from "path";
import { loadTemplate, type DopplerTemplateEntry } from "../doppler-template.ts";
import {
  loadDopplerConfig, writeDopplerConfig, addScopedEntry,
  type DopplerConfig,
} from "../doppler-config.ts";
import { existsSync, readFileSync } from "fs";
import { templatePath } from "../doppler-template.ts";

export interface ReconcileSummary {
  wrote:      number;
  overridden: number;
  unchanged:  number;
  /** Why the repo was skipped, if any. Absent when the reconciler ran normally. */
  skipped?:   "no-template" | "malformed-template";
}

export interface ReconcileOpts {
  repoName:      string;
  worktreeRoots: string[];
}

export async function reconcileForRepo(opts: ReconcileOpts): Promise<ReconcileSummary> {
  // 1. Distinguish "no template" (silent opt-out) from "malformed template" (error).
  const path = templatePath(opts.repoName);
  if (!existsSync(path)) {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" };
  }
  const template = loadTemplate(opts.repoName);
  if (template === null) {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template" };
  }
  if (template.length === 0) {
    return { wrote: 0, overridden: 0, unchanged: 0 };
  }

  // 2. Load the current Doppler config (or start from empty).
  const dopplerCfg = loadDopplerConfig();

  // 3. For each worktree × each template entry, attempt to add.
  let wrote = 0, overridden = 0, unchanged = 0;
  for (const root of opts.worktreeRoots) {
    for (const entry of template) {
      const absPath = join(root, entry.path);
      const result = addScopedEntry(dopplerCfg, absPath, entry.project, entry.config);
      if (result === "wrote")        wrote++;
      else if (result === "unchanged")  unchanged++;
      else if (result === "overridden") overridden++;
    }
  }

  // 4. Persist only if we changed anything.
  if (wrote > 0) {
    writeDopplerConfig(dopplerCfg);
  }

  return { wrote, overridden, unchanged };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/daemon/__tests__/doppler-sync.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/doppler-sync.ts lib/daemon/__tests__/doppler-sync.test.ts
git commit -m "feat(doppler): reconciler that syncs template into ~/.doppler/.doppler.yaml"
```

---

### Task 8: `commands/doppler.ts` — `init` subcommand

**Files:**
- Create: `commands/doppler.ts`

- [ ] **Step 1: Add the file with `initCommand`**

Create `commands/doppler.ts`:

```typescript
#!/usr/bin/env bun

/**
 * rt doppler — manage per-repo Doppler templates and sync them into
 * `~/.doppler/.doppler.yaml`.
 *
 * Usage:
 *   rt doppler init    → capture existing entries from ~/.doppler/.doppler.yaml
 *                         into ~/.rt/<repo>/doppler-template.yaml
 *   rt doppler sync    → reconcile ~/.doppler/.doppler.yaml against the template
 *                         + current worktrees
 *   rt doppler status  → show: which template entries are present, missing,
 *                         or overridden in ~/.doppler/.doppler.yaml
 *   rt doppler edit    → open the template in $EDITOR
 *
 * See docs/superpowers/specs/2026-04-30-doppler-template-sync-design.md.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  captureFromActualConfig, loadTemplate, saveTemplate, templatePath,
} from "../lib/doppler-template.ts";
import { loadDopplerConfig } from "../lib/doppler-config.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── rt doppler init ─────────────────────────────────────────────────────────

export async function initCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const repoRoot = ctx.identity!.repoRoot;

  const dopplerCfg = loadDopplerConfig();
  const captured = captureFromActualConfig(dopplerCfg, repoRoot);

  if (captured.length === 0) {
    console.log(`\n  ${yellow}no enclave entries found under${reset} ${dim}${repoRoot}${reset}`);
    console.log(`  ${dim}run \`make initDoppler\` (or your repo's equivalent) at least once first${reset}\n`);
    process.exit(1);
  }

  const path = templatePath(repoName);
  if (existsSync(path)) {
    const existing = loadTemplate(repoName) ?? [];
    if (JSON.stringify(existing) === JSON.stringify(captured)) {
      console.log(`\n  ${dim}template already up to date (${captured.length} entries)${reset}`);
      console.log(`  ${dim}${path}${reset}\n`);
      return;
    }
    console.log(`\n  ${yellow}template exists at${reset} ${dim}${path}${reset}`);
    console.log(`  ${yellow}overwriting with ${captured.length} captured entries${reset}\n`);
  }

  saveTemplate(repoName, captured);

  console.log(`\n  ${green}✓${reset} captured ${bold}${captured.length}${reset} entries into ${dim}${path}${reset}`);
  for (const e of captured) {
    console.log(`    ${cyan}${e.path}${reset}  ${dim}→${reset}  ${e.project}/${e.config}`);
  }
  console.log(`\n  ${dim}run${reset} ${bold}rt doppler sync${reset} ${dim}to apply across all worktrees${reset}\n`);
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `bun run cli.ts --help 2>&1 | head -5`
Expected: no syntax errors, just the help message (or the dispatcher's default behavior).

- [ ] **Step 3: Commit**

```bash
git add commands/doppler.ts
git commit -m "feat(doppler): rt doppler init captures existing entries into a template"
```

---

### Task 9: `commands/doppler.ts` — `sync` subcommand

**Files:**
- Modify: `commands/doppler.ts`

- [ ] **Step 1: Append `syncCommand`**

Append to `commands/doppler.ts`:

```typescript
import { execSync } from "child_process";

// ─── rt doppler sync ─────────────────────────────────────────────────────────

/**
 * Walk this repo's worktrees and apply the template to each. Identical logic
 * to the daemon's per-tick reconciliation, surfaced as a CLI command for
 * on-demand runs (e.g. just after `rt doppler init`, or when the daemon is
 * down).
 */
export async function syncCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const { reconcileForRepo } = await import("../lib/daemon/doppler-sync.ts");
  const repoName = ctx.identity!.repoName;
  const repoRoot = ctx.identity!.repoRoot;

  if (!existsSync(templatePath(repoName))) {
    console.log(`\n  ${red}no template at${reset} ${dim}${templatePath(repoName)}${reset}`);
    console.log(`  ${dim}run${reset} ${bold}rt doppler init${reset} ${dim}first${reset}\n`);
    process.exit(1);
  }

  const worktreeRoots = listWorktreeRoots(repoRoot);
  console.log(`\n  ${bold}${cyan}rt doppler sync${reset} ${dim}(${worktreeRoots.length} worktrees)${reset}`);
  for (const w of worktreeRoots) {
    console.log(`    ${dim}- ${w}${reset}`);
  }

  const summary = await reconcileForRepo({ repoName, worktreeRoots });

  if (summary.skipped === "malformed-template") {
    console.log(`\n  ${red}template is malformed — fix with rt doppler edit${reset}\n`);
    process.exit(1);
  }
  if (summary.skipped === "no-template") {
    // Already handled above; defensive.
    console.log(`\n  ${red}no template — run rt doppler init${reset}\n`);
    process.exit(1);
  }

  console.log(`\n  ${green}✓${reset} wrote ${bold}${summary.wrote}${reset} entries`);
  console.log(`    ${dim}${summary.unchanged} unchanged, ${summary.overridden} overridden${reset}\n`);
}

/**
 * Enumerate this repo's worktree roots via `git worktree list --porcelain`.
 * Returns absolute paths.
 */
function listWorktreeRoots(repoRoot: string): string[] {
  const out = execSync("git worktree list --porcelain", {
    cwd: repoRoot, encoding: "utf8", stdio: "pipe",
  });
  const roots: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      roots.push(line.slice("worktree ".length).trim());
    }
  }
  return roots;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run cli.ts --help 2>&1 | head -5`
Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add commands/doppler.ts
git commit -m "feat(doppler): rt doppler sync runs the reconciler on demand"
```

---

### Task 10: `commands/doppler.ts` — `status` subcommand

**Files:**
- Modify: `commands/doppler.ts`

- [ ] **Step 1: Append `statusCommand`**

Append to `commands/doppler.ts`:

```typescript
import { join } from "path";

// ─── rt doppler status ───────────────────────────────────────────────────────

interface StatusRow {
  path:      string;
  template:  string;          // "<project>/<config>"
  actual:    string | null;   // null = missing
  status:    "ok" | "missing" | "overridden";
}

export async function statusCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const repoRoot = ctx.identity!.repoRoot;

  const template = loadTemplate(repoName);
  if (template === null || template.length === 0) {
    console.log(`\n  ${red}no template at${reset} ${dim}${templatePath(repoName)}${reset}`);
    console.log(`  ${dim}run${reset} ${bold}rt doppler init${reset}\n`);
    process.exit(1);
  }

  const dopplerCfg = loadDopplerConfig();
  const worktreeRoots = listWorktreeRoots(repoRoot);

  console.log(`\n  ${bold}${cyan}rt doppler status${reset} ${dim}(${repoName})${reset}\n`);

  for (const root of worktreeRoots) {
    const rows: StatusRow[] = [];
    for (const entry of template) {
      const absPath = join(root, entry.path);
      const actual  = dopplerCfg.scoped[absPath];
      const wantStr = `${entry.project}/${entry.config}`;
      if (!actual) {
        rows.push({ path: entry.path, template: wantStr, actual: null, status: "missing" });
        continue;
      }
      const actStr = `${actual["enclave.project"] ?? "?"}/${actual["enclave.config"] ?? "?"}`;
      if (
        actual["enclave.project"] === entry.project &&
        actual["enclave.config"]  === entry.config
      ) {
        rows.push({ path: entry.path, template: wantStr, actual: actStr, status: "ok" });
      } else {
        rows.push({ path: entry.path, template: wantStr, actual: actStr, status: "overridden" });
      }
    }

    const widest = Math.max(...rows.map(r => r.path.length));
    console.log(`  ${bold}${root}${reset}`);
    for (const row of rows) {
      const icon = row.status === "ok"         ? `${green}✓${reset}`
                : row.status === "missing"     ? `${red}✗${reset}`
                : /* overridden */               `${yellow}~${reset}`;
      const label = row.status === "ok"         ? `${dim}${row.template}${reset}`
                  : row.status === "missing"     ? `${red}missing${reset} ${dim}(want ${row.template})${reset}`
                  : /* overridden */               `${yellow}override${reset} ${dim}(want ${row.template}, got ${row.actual})${reset}`;
      console.log(`    ${icon}  ${row.path.padEnd(widest)}  ${label}`);
    }
    console.log("");
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run cli.ts --help 2>&1 | head -5`
Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add commands/doppler.ts
git commit -m "feat(doppler): rt doppler status shows template vs. actual per worktree"
```

---

### Task 11: `commands/doppler.ts` — `edit` subcommand

**Files:**
- Modify: `commands/doppler.ts`

- [ ] **Step 1: Append `editCommand`**

Append to `commands/doppler.ts`:

```typescript
// ─── rt doppler edit ─────────────────────────────────────────────────────────

export async function editCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const path = templatePath(repoName);

  if (!existsSync(path)) {
    console.log(`\n  ${red}no template at${reset} ${dim}${path}${reset}`);
    console.log(`  ${dim}run${reset} ${bold}rt doppler init${reset} ${dim}first${reset}\n`);
    process.exit(1);
  }

  const editor = process.env.EDITOR || "vi";
  const result = spawnSync(editor, [path], { stdio: "inherit" });
  if (result.status !== 0) {
    console.log(`\n  ${yellow}editor exited with status ${result.status}${reset}\n`);
    process.exit(result.status ?? 1);
  }

  console.log(`\n  ${dim}run${reset} ${bold}rt doppler sync${reset} ${dim}to apply${reset}\n`);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run cli.ts --help 2>&1 | head -5`
Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add commands/doppler.ts
git commit -m "feat(doppler): rt doppler edit opens the template in EDITOR"
```

---

### Task 12: `lib/daemon/handlers/doppler.ts` — IPC handlers

**Files:**
- Create: `lib/daemon/handlers/doppler.ts`

- [ ] **Step 1: Create the handler module**

Create `lib/daemon/handlers/doppler.ts`:

```typescript
/**
 * Doppler IPC handlers.
 *
 *   doppler:sync   — run the reconciler for one repo (or all). Same logic
 *                    that runs on the daemon's cache-refresh tick.
 *   doppler:status — return the template + actual config view for the CLI's
 *                    `rt doppler status` to render. (Reserved for future use;
 *                    the CLI currently reads ~/.doppler/.doppler.yaml directly.)
 */

import { execSync } from "child_process";
import { reconcileForRepo, type ReconcileSummary } from "../doppler-sync.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

function listWorktreeRoots(repoPath: string): string[] {
  try {
    const out = execSync("git worktree list --porcelain", {
      cwd: repoPath, encoding: "utf8", stdio: "pipe",
    });
    const roots: string[] = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        roots.push(line.slice("worktree ".length).trim());
      }
    }
    return roots;
  } catch {
    return [];
  }
}

export function createDopplerHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "doppler:sync": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const repos = ctx.repoIndex();

      const targets = repoName
        ? (repos[repoName] ? [[repoName, repos[repoName]] as const] : [])
        : Object.entries(repos);

      if (targets.length === 0) {
        return { ok: false, error: repoName ? `unknown repo: ${repoName}` : "no repos registered" };
      }

      const results: Record<string, ReconcileSummary> = {};
      for (const [name, path] of targets) {
        const worktreeRoots = listWorktreeRoots(path);
        const summary = await reconcileForRepo({ repoName: name, worktreeRoots });
        results[name] = summary;
        ctx.log(`doppler:sync repo=${name} wrote=${summary.wrote} overridden=${summary.overridden} unchanged=${summary.unchanged}${summary.skipped ? ` skipped=${summary.skipped}` : ""}`);
      }

      return { ok: true, data: { results } };
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run -e 'import("./lib/daemon/handlers/doppler.ts").then(m => console.log(Object.keys(m)))'`
Expected output: `[ "createDopplerHandlers" ]`

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/handlers/doppler.ts
git commit -m "feat(doppler): IPC handler for daemon-side reconciliation"
```

---

### Task 13: Wire reconciler into daemon's cache-refresh tick

**Files:**
- Modify: `lib/daemon.ts:540-565`

- [ ] **Step 1: Read the section to confirm location**

Read `lib/daemon.ts` and locate two anchor points:
1. The `routedHandlers` object literal (search for `...createParkingLotHandlers(handlerCtx)`).
2. The block inside `refreshCacheImpl` that calls `checkAndPark` (search for `checkAndPark({ cache, repoIndex: loadRepoIndex, log })`).

These line numbers may have shifted since the spec was written; use the search anchors, not the line numbers.

- [ ] **Step 2: Add an import for the reconciler**

Add to the imports alongside the other `createXxxHandlers` imports (search for `import { createParkingLotHandlers }`):

```typescript
import { createDopplerHandlers } from "./daemon/handlers/doppler.ts";
import { reconcileForRepo } from "./daemon/doppler-sync.ts";
```

- [ ] **Step 3: Wire the handler into `routedHandlers`**

In the `routedHandlers` object literal (anchor: search for `...createParkingLotHandlers(handlerCtx)`), add the doppler handlers immediately after the parking-lot line:

```typescript
const routedHandlers: HandlerMap = {
  ...createCacheHandlers(handlerCtx),
  ...createRemedyHandlers(handlerCtx),
  ...createProxyHandlers(handlerCtx),
  ...createProcessHandlers(handlerCtx),
  ...createHooksHandlers(handlerCtx),
  ...createStatusHandlers(handlerCtx),
  ...createPortsHandlers(handlerCtx),
  ...createGroupsHandlers(handlerCtx),
  ...createWorkspaceHandlers(handlerCtx),
  ...createMRHandlers(),
  ...createParkingLotHandlers(handlerCtx),
  ...createDopplerHandlers(handlerCtx),     // ← add this line
  ...createDiscussionHandlers(handlerCtx, broadcast),
};
```

- [ ] **Step 4: Add the per-tick reconciliation in `refreshCacheImpl`**

In `refreshCacheImpl`, immediately after the `checkAndPark` try/catch block (anchor: search for `checkAndPark({ cache, repoIndex: loadRepoIndex, log })`) and BEFORE the `broadcast("status", …)` line, add:

```typescript
    // Doppler-template reconciliation: keeps ~/.doppler/.doppler.yaml in sync
    // with each repo's ~/.rt/<repo>/doppler-template.yaml. Cheap (file I/O
    // only) and additive — never overwrites existing entries.
    try {
      const repos = loadRepoIndex();
      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;
        try {
          const out = execSync("git worktree list --porcelain", {
            cwd: repoPath, encoding: "utf8", stdio: "pipe",
          });
          const worktreeRoots: string[] = [];
          for (const line of out.split("\n")) {
            if (line.startsWith("worktree ")) {
              worktreeRoots.push(line.slice("worktree ".length).trim());
            }
          }
          const summary = await reconcileForRepo({ repoName, worktreeRoots });
          if (summary.skipped) {
            if (summary.skipped === "malformed-template") {
              log(`doppler:sync repo=${repoName} skipped=${summary.skipped}`);
            }
            // "no-template" is the silent opt-out case; do not log.
            continue;
          }
          if (summary.wrote > 0 || summary.overridden > 0) {
            log(`doppler:sync repo=${repoName} wrote=${summary.wrote} overridden=${summary.overridden} unchanged=${summary.unchanged}`);
          }
        } catch (err) {
          log(`doppler:sync repo=${repoName} failed: ${err}`);
        }
      }
    } catch (err) {
      log(`doppler:sync failed: ${err}`);
    }
```

- [ ] **Step 5: Verify daemon still compiles**

Run: `bun build lib/daemon.ts --outdir /tmp/rt-build 2>&1 | tail -10`
Expected: build succeeds (or no TypeScript errors). Discard the output dir.

- [ ] **Step 6: Run all daemon tests to confirm nothing regressed**

Run: `bun test lib/daemon/__tests__`
Expected: PASS — including the new doppler-sync tests.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon.ts
git commit -m "feat(doppler): reconcile templates on every cache-refresh tick"
```

---

### Task 14: Wire `doppler` subcommand tree into `cli.ts`

**Files:**
- Modify: `cli.ts` — add the `doppler` entry to the TREE constant

- [ ] **Step 1: Locate where the `park` subcommand tree is defined**

In `cli.ts`, search for `park: {` — the block ends with the matching `},` after `pick: {…}`. The new `doppler` block follows the same shape.

- [ ] **Step 2: Add the `doppler` block**

Insert the following block in `cli.ts`'s `TREE` constant, immediately after the `park` block's closing `},`:

```typescript
  doppler: {
    description: "Per-repo Doppler template + sync into ~/.doppler/.doppler.yaml",
    subcommands: {
      init: {
        description: "Capture existing Doppler entries for this repo into a template",
        module: "./commands/doppler.ts",
        fn: "initCommand",
        context: "repo",
      },
      sync: {
        description: "Apply the template across all worktrees (manual trigger)",
        module: "./commands/doppler.ts",
        fn: "syncCommand",
        context: "repo",
      },
      status: {
        description: "Show template vs. actual config per worktree",
        module: "./commands/doppler.ts",
        fn: "statusCommand",
        context: "repo",
      },
      edit: {
        description: "Open the template in $EDITOR",
        module: "./commands/doppler.ts",
        fn: "editCommand",
        context: "repo",
        requiresTTY: true,
      },
    },
  },
```

- [ ] **Step 3: Verify the command appears in `rt --help`**

Run: `bun cli.ts --help 2>&1 | grep -A1 doppler | head -5`
Expected output: lines mentioning `doppler` and its subcommands (`init`, `sync`, `status`, `edit`).

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat(doppler): wire rt doppler subcommands into cli.ts tree"
```

---

### Task 15: Manual smoke test + final commit

**Files:**
- (No code changes — verification only.)

- [ ] **Step 1: Sanity-check the full test suite still passes**

Run: `bun test lib/daemon/__tests__ lib/__tests__/doppler-template.test.ts lib/__tests__/doppler-config.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 2: Smoke-test `rt doppler init` against the assured repo**

In the assured-primary worktree:
```bash
cd /Users/matt/Documents/GitHub/assured/assured-primary
bun /Users/matt/Documents/GitHub/repo-tools/cli.ts doppler init
```

Expected output:
- "captured N entries into ~/.rt/assured/doppler-template.yaml"
- A list of 10 entries (apps/adjuster, apps/backend, … packages/sidekick).

Verify the file:
```bash
cat ~/.rt/assured/doppler-template.yaml
```

Expected: a YAML list of 10 entries matching the spec example.

- [ ] **Step 3: Smoke-test `rt doppler status`**

Run:
```bash
bun /Users/matt/Documents/GitHub/repo-tools/cli.ts doppler status
```

Expected: each worktree section shows ✓ for entries already present (since we just captured them).

- [ ] **Step 4: Smoke-test `rt doppler sync`**

Run:
```bash
bun /Users/matt/Documents/GitHub/repo-tools/cli.ts doppler sync
```

Expected output:
- "wrote 0 entries" (everything is already there)
- "10 unchanged" or however many worktree×entry combinations exist

- [ ] **Step 5: Smoke-test the no-op idempotency**

Run `rt doppler sync` again. Expected: still 0 wrote, all unchanged.

- [ ] **Step 6: Smoke-test daemon-side sync via IPC**

If the daemon is running, run:
```bash
curl --unix-socket ~/.rt/rt.sock http://localhost/doppler:sync -X POST -H "Content-Type: application/json" -d '{"repoName":"assured"}'
```

Expected: `{"ok":true,"data":{"results":{"assured":{"wrote":0,"overridden":0,"unchanged":N}}}}`

- [ ] **Step 7: Final empty commit signaling completion**

If all smoke tests passed:
```bash
git commit --allow-empty -m "chore: doppler template + auto-sync verified end-to-end"
```

---

## Self-Review Checklist (run before claiming done)

- [ ] Every spec section in `2026-04-30-doppler-template-sync-design.md` has at least one task that implements it. (Scope: template format, reconciler behavior, atomic writes, override-safety, daemon tick integration, four CLI subcommands, IPC handler.)
- [ ] No placeholders, "TBD", or "implement later" anywhere in the plan.
- [ ] Type names and exports are consistent across tasks (`DopplerTemplateEntry`, `DopplerConfig`, `DopplerScopedEntry`, `ReconcileSummary`, `addScopedEntry`, etc.).
- [ ] Every code-changing step shows the actual code, not a description.
- [ ] All tests use `mkdtempSync` + `process.env.HOME` BEFORE importing modules that read `RT_DIR` at import time.
- [ ] `git commit` happens after each functional unit.
