# Auto-fix Pipeline Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a merge request the user owns has its pipeline transition to `failed`, the daemon provisions an ephemeral worktree, runs an agent to fix the failure, validates and commits the diff (under strict scope caps + denylist), pushes, and tears the worktree down — all without user attention.

**Architecture:** Most logic is decomposed into pure modules (config I/O, denylist matching, lockfile detection, eligibility evaluators, agent prompt assembly, RESULT parsing) so each piece is testable in isolation. The orchestrator in `lib/daemon/auto-fix.ts` ties them together and is the only "messy" file with side effects. The orchestrator is fired fire-and-forget from the same cache-refresh tick that already detects pipeline-failed transitions in `lib/notifier.ts`. Per-repo serialization uses an on-disk lock (against daemon restarts) plus an in-memory inflight/queue map (within one daemon process). Doppler env is provided automatically via the already-shipped `reconcileForRepo` helper.

**Tech Stack:** TypeScript, Bun, `claude` CLI (via existing `lib/agent-runner.ts`), bun:test.

**Prerequisites already shipped:** Doppler template + auto-sync (commits `8aa7f03`, `67de458`, `c27c973`). Specifically:
- `reconcileForRepo({ repoName, worktreeRoots })` from `lib/daemon/doppler-sync.ts` — call this on the new ephemeral worktree path so it inherits the user's Doppler env.
- `listWorktreeRoots(repoPath)` from `lib/git-worktrees.ts` — handles porcelain parsing + missing-dir filtering.

---

## Files

| File | Change |
|---|---|
| `lib/auto-fix-config.ts` | NEW — types + read/write `~/.rt/<repo>/auto-fix.json` (caps, denylist additions, enabled flag, optional `setupCommands`) |
| `lib/auto-fix-log.ts` | NEW — append/read `~/.rt/<repo>/auto-fix-log.json` (last 100 attempts, ring); read/write `auto-fix-notes/<branch>-<sha>.md` |
| `lib/auto-fix-lock.ts` | NEW — acquire/release per-repo lock at `~/.rt/<repo>/auto-fix.lock`; stale-PID detection |
| `lib/setup-commands.ts` | NEW — pure `detectInstallCommand(worktreePath)` from lockfiles |
| `lib/auto-fix-denylist.ts` | NEW — `DEFAULT_DENYLIST` + `matchesDenylist(path, patterns)` + `enforceScopeCaps({ files, lines, fileCap, lineCap })` |
| `lib/daemon/auto-fix-eligibility.ts` | NEW — pure gate evaluators returning `{ eligible: true } \| { eligible: false, reason: string }` |
| `lib/daemon/auto-fix-agent-protocol.ts` | NEW — `assembleAutoFixPrompt(...)` and `parseAgentResult(stdout)` (both pure) |
| `lib/daemon/auto-fix.ts` | NEW — engine orchestrator: provisioning, agent invocation, validation, commit/push, teardown, in-memory queue, stale-sweep |
| `lib/daemon/handlers/auto-fix.ts` | NEW — IPC handlers for `auto-fix:log:read`, `auto-fix:notes:read`, `auto-fix:status`, `auto-fix:config:get`, `auto-fix:config:set` |
| `commands/auto-fix.ts` | NEW — `enable`, `disable`, `log`, `notes`, `status` subcommands |
| `lib/notifier.ts` | Add 3 event keys (`auto_fix_pushed`, `auto_fix_skipped`, `auto_fix_rejected`); fire `runAutoFix` on pipeline-failed transition |
| `lib/daemon.ts` | Wire IPC handlers into `routedHandlers`; call `sweepStaleArtifacts` on startup |
| `cli.ts` | Add `auto-fix` subcommand tree to `TREE` |
| `lib/__tests__/auto-fix-config.test.ts` | NEW |
| `lib/__tests__/auto-fix-log.test.ts` | NEW |
| `lib/__tests__/auto-fix-lock.test.ts` | NEW |
| `lib/__tests__/setup-commands.test.ts` | NEW |
| `lib/__tests__/auto-fix-denylist.test.ts` | NEW |
| `lib/daemon/__tests__/auto-fix-eligibility.test.ts` | NEW |
| `lib/daemon/__tests__/auto-fix-agent-protocol.test.ts` | NEW |

---

### Task 1: `lib/auto-fix-config.ts` — types + load/save

**Files:**
- Create: `lib/auto-fix-config.ts`
- Test: `lib/__tests__/auto-fix-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/auto-fix-config.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-config-"));
process.env.HOME = tmpHome;

const { loadAutoFixConfig, saveAutoFixConfig, autoFixConfigPath, DEFAULTS } =
  await import("../auto-fix-config.ts");

describe("auto-fix-config", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", repo), { recursive: true, force: true }); } catch { /* */ }
  });

  test("autoFixConfigPath is ~/.rt/<repo>/auto-fix.json", () => {
    expect(autoFixConfigPath(repo)).toBe(join(tmpHome, ".rt", repo, "auto-fix.json"));
  });

  test("loadAutoFixConfig returns DEFAULTS when file is missing", () => {
    expect(loadAutoFixConfig(repo)).toEqual(DEFAULTS);
  });

  test("loadAutoFixConfig returns DEFAULTS on malformed JSON", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(autoFixConfigPath(repo), "{not json");
    expect(loadAutoFixConfig(repo)).toEqual(DEFAULTS);
  });

  test("saveAutoFixConfig then loadAutoFixConfig round-trips", () => {
    saveAutoFixConfig(repo, {
      enabled: false,
      fileCap: 10,
      lineCap: 500,
      additionalDenylist: ["src/legacy/**"],
      allowTestFixes: true,
      setupCommands: [["bun", "install"], ["bun", "run", "gen"]],
    });
    expect(loadAutoFixConfig(repo)).toEqual({
      enabled: false,
      fileCap: 10,
      lineCap: 500,
      additionalDenylist: ["src/legacy/**"],
      allowTestFixes: true,
      setupCommands: [["bun", "install"], ["bun", "run", "gen"]],
    });
  });

  test("loadAutoFixConfig fills missing fields with DEFAULTS", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(autoFixConfigPath(repo), JSON.stringify({ enabled: false }));
    const cfg = loadAutoFixConfig(repo);
    expect(cfg.enabled).toBe(false);
    expect(cfg.fileCap).toBe(DEFAULTS.fileCap);
    expect(cfg.lineCap).toBe(DEFAULTS.lineCap);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/auto-fix-config.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/auto-fix-config.ts`:

```typescript
/**
 * Per-repo auto-fix configuration.
 *
 * Path: ~/.rt/<repo>/auto-fix.json. Stores caps, denylist additions, the
 * enabled flag, and an optional explicit setupCommands override (otherwise
 * lockfile detection handles install).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AutoFixConfig {
  /** Master toggle. When false, the daemon will not attempt auto-fixes for this repo. */
  enabled: boolean;
  /** Max number of files the agent's diff may touch. */
  fileCap: number;
  /** Max number of insertions+deletions across the diff. */
  lineCap: number;
  /** Patterns appended to DEFAULT_DENYLIST. */
  additionalDenylist: string[];
  /** Whether the agent is allowed to attempt test failures (vs. only lint/types). */
  allowTestFixes: boolean;
  /** Optional explicit setup command override. When omitted, lockfile detection runs. */
  setupCommands?: string[][];
}

export const DEFAULTS: AutoFixConfig = {
  enabled:            true,
  fileCap:            5,
  lineCap:            200,
  additionalDenylist: [],
  allowTestFixes:     false,
};

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixConfigPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix.json");
}

/** Load the config. Missing fields are filled from DEFAULTS. Malformed JSON returns DEFAULTS. */
export function loadAutoFixConfig(repoName: string): AutoFixConfig {
  const path = autoFixConfigPath(repoName);
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...raw,
      // Defensive: if the user wrote a non-array for additionalDenylist, fall back.
      additionalDenylist: Array.isArray(raw.additionalDenylist)
        ? raw.additionalDenylist
        : DEFAULTS.additionalDenylist,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutoFixConfig(repoName: string, config: AutoFixConfig): void {
  const path = autoFixConfigPath(repoName);
  mkdirSync(join(rtDir(), repoName), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/auto-fix-config.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-fix-config.ts lib/__tests__/auto-fix-config.test.ts
git commit -m "feat(auto-fix): add per-repo config (caps, denylist, setupCommands)"
```

---

### Task 2: `lib/setup-commands.ts` — lockfile detection

**Files:**
- Create: `lib/setup-commands.ts`
- Test: `lib/__tests__/setup-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/setup-commands.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { detectInstallCommand } from "../setup-commands.ts";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "rt-setup-")); });
afterEach(()  => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

describe("detectInstallCommand", () => {
  test("returns null when no lockfile is present", () => {
    expect(detectInstallCommand(tmp)).toBeNull();
  });

  test("bun.lock → bun install", () => {
    writeFileSync(join(tmp, "bun.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });

  test("bun.lockb → bun install", () => {
    writeFileSync(join(tmp, "bun.lockb"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });

  test("pnpm-lock.yaml → pnpm install --frozen-lockfile", () => {
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    expect(detectInstallCommand(tmp)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  test("yarn.lock → yarn install --frozen-lockfile", () => {
    writeFileSync(join(tmp, "yarn.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });

  test("package-lock.json → npm ci", () => {
    writeFileSync(join(tmp, "package-lock.json"), "");
    expect(detectInstallCommand(tmp)).toEqual(["npm", "ci"]);
  });

  test("Gemfile.lock → bundle install", () => {
    writeFileSync(join(tmp, "Gemfile.lock"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bundle", "install"]);
  });

  test("go.sum → go mod download", () => {
    writeFileSync(join(tmp, "go.sum"), "");
    expect(detectInstallCommand(tmp)).toEqual(["go", "mod", "download"]);
  });

  test("requirements.txt → pip install -r requirements.txt", () => {
    writeFileSync(join(tmp, "requirements.txt"), "");
    expect(detectInstallCommand(tmp)).toEqual(["pip", "install", "-r", "requirements.txt"]);
  });

  test("multiple lockfiles → first match wins (bun.lock over pnpm-lock.yaml)", () => {
    writeFileSync(join(tmp, "bun.lock"), "");
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    expect(detectInstallCommand(tmp)).toEqual(["bun", "install"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/setup-commands.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/setup-commands.ts`:

```typescript
/**
 * Lockfile-driven install command detection.
 *
 * Used by the auto-fix engine when `setupCommands` isn't explicitly set in
 * `~/.rt/<repo>/auto-fix.json`. The first matching lockfile in priority order
 * wins. Returns `null` if no known lockfile is present — the agent will then
 * either bootstrap itself or report skipped if it can't proceed.
 */

import { existsSync } from "fs";
import { join } from "path";

interface Detector {
  lockfile: string;
  command:  string[];
}

// Order matters: priority is left-to-right when multiple lockfiles coexist.
const DETECTORS: Detector[] = [
  { lockfile: "bun.lock",          command: ["bun", "install"] },
  { lockfile: "bun.lockb",         command: ["bun", "install"] },
  { lockfile: "pnpm-lock.yaml",    command: ["pnpm", "install", "--frozen-lockfile"] },
  { lockfile: "yarn.lock",         command: ["yarn", "install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", command: ["npm", "ci"] },
  { lockfile: "Gemfile.lock",      command: ["bundle", "install"] },
  { lockfile: "go.sum",            command: ["go", "mod", "download"] },
  { lockfile: "requirements.txt",  command: ["pip", "install", "-r", "requirements.txt"] },
];

/** Returns the install command for the worktree, or null if no lockfile is detected. */
export function detectInstallCommand(worktreePath: string): string[] | null {
  for (const d of DETECTORS) {
    if (existsSync(join(worktreePath, d.lockfile))) return d.command;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/setup-commands.test.ts`
Expected: PASS, 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/setup-commands.ts lib/__tests__/setup-commands.test.ts
git commit -m "feat(auto-fix): detectInstallCommand from lockfiles"
```

---

### Task 3: `lib/auto-fix-denylist.ts` — patterns + scope caps

**Files:**
- Create: `lib/auto-fix-denylist.ts`
- Test: `lib/__tests__/auto-fix-denylist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/auto-fix-denylist.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DENYLIST,
  matchesDenylist,
  enforceScopeCaps,
} from "../auto-fix-denylist.ts";

describe("matchesDenylist", () => {
  test("matches exact filename", () => {
    expect(matchesDenylist("package.json", ["package.json"])).toBe(true);
  });

  test("matches glob with **", () => {
    expect(matchesDenylist("infra/k8s/deploy.yaml", ["infra/**"])).toBe(true);
  });

  test("does not match unrelated path", () => {
    expect(matchesDenylist("apps/backend/src/index.ts", ["infra/**"])).toBe(false);
  });

  test("matches lockfiles", () => {
    expect(matchesDenylist("bun.lock", ["bun.lock"])).toBe(true);
    expect(matchesDenylist("yarn.lock", ["yarn.lock"])).toBe(true);
  });

  test("multiple patterns: any match wins", () => {
    expect(matchesDenylist(".env.production", ["package.json", ".env*"])).toBe(true);
  });

  test("DEFAULT_DENYLIST blocks lockfiles, migrations, CI configs, env files", () => {
    expect(matchesDenylist("bun.lock", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("migrations/001_init.sql", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".gitlab-ci.yml", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("Dockerfile", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist("infra/terraform/main.tf", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".env", DEFAULT_DENYLIST)).toBe(true);
    expect(matchesDenylist(".env.local", DEFAULT_DENYLIST)).toBe(true);
  });

  test("DEFAULT_DENYLIST allows ordinary source files", () => {
    expect(matchesDenylist("apps/backend/src/index.ts", DEFAULT_DENYLIST)).toBe(false);
    expect(matchesDenylist("packages/sidekick/lib/foo.ts", DEFAULT_DENYLIST)).toBe(false);
  });
});

describe("enforceScopeCaps", () => {
  test("returns null (no violation) when within caps", () => {
    expect(enforceScopeCaps({ files: 3, lines: 50, fileCap: 5, lineCap: 200 })).toBeNull();
  });

  test("returns 'files' violation when fileCap exceeded", () => {
    expect(enforceScopeCaps({ files: 6, lines: 50, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "files", actual: 6, cap: 5 });
  });

  test("returns 'lines' violation when lineCap exceeded", () => {
    expect(enforceScopeCaps({ files: 3, lines: 250, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "lines", actual: 250, cap: 200 });
  });

  test("returns first violation (files) when both exceeded", () => {
    expect(enforceScopeCaps({ files: 10, lines: 500, fileCap: 5, lineCap: 200 }))
      .toEqual({ kind: "files", actual: 10, cap: 5 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/auto-fix-denylist.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/auto-fix-denylist.ts`:

```typescript
/**
 * Path denylist + scope caps for auto-fix.
 *
 * Pure helpers — no I/O. Used by the daemon's post-agent validation step
 * (and by the agent's prompt as the explicit list of paths it cannot touch).
 *
 * Pattern matching uses Bun's built-in Glob (same as elsewhere in rt).
 */

export const DEFAULT_DENYLIST: string[] = [
  // Lockfiles (deps must not be auto-modified)
  "package.json",         // covers root package.json; nested pkg manifests still OK
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  // Migrations
  "migrations/**",
  "db/migrate/**",
  // CI / build infra
  ".gitlab-ci.yml",
  ".github/workflows/**",
  "Dockerfile",
  "docker-compose*.yml",
  // Infra
  "infra/**",
  "terraform/**",
  // Env files
  ".env",
  ".env.*",
];

/**
 * Returns true if `path` matches any pattern in `patterns`. Patterns may
 * contain glob wildcards (`*`, `**`).
 */
export function matchesDenylist(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (new Bun.Glob(pattern).match(path)) return true;
  }
  return false;
}

export interface ScopeCapInputs {
  files:   number;
  lines:   number;   // total insertions+deletions
  fileCap: number;
  lineCap: number;
}

export type ScopeCapViolation =
  | { kind: "files"; actual: number; cap: number }
  | { kind: "lines"; actual: number; cap: number };

/** Returns null when no violation, or the first violation found. */
export function enforceScopeCaps(input: ScopeCapInputs): ScopeCapViolation | null {
  if (input.files > input.fileCap) {
    return { kind: "files", actual: input.files, cap: input.fileCap };
  }
  if (input.lines > input.lineCap) {
    return { kind: "lines", actual: input.lines, cap: input.lineCap };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/auto-fix-denylist.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-fix-denylist.ts lib/__tests__/auto-fix-denylist.test.ts
git commit -m "feat(auto-fix): denylist patterns + scope cap helpers"
```

---

### Task 4: `lib/auto-fix-log.ts` — log entries + notes files

**Files:**
- Create: `lib/auto-fix-log.ts`
- Test: `lib/__tests__/auto-fix-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/auto-fix-log.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-log-"));
process.env.HOME = tmpHome;

const {
  appendLogEntry, readLog, autoFixLogPath,
  writeNotes, readNotes, autoFixNotesPath, autoFixNotesDir,
  countAttemptsForSha,
} = await import("../auto-fix-log.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("auto-fix-log entries", () => {
  test("autoFixLogPath is ~/.rt/<repo>/auto-fix-log.json", () => {
    expect(autoFixLogPath(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix-log.json"));
  });

  test("readLog returns [] when file is missing", () => {
    expect(readLog(REPO)).toEqual([]);
  });

  test("appendLogEntry then readLog returns the entry", () => {
    const entry = {
      branch: "feat/x",
      sha: "abc123",
      attemptedAt: 1700000000000,
      outcome: "fixed" as const,
      durationMs: 30000,
      commitSha: "def456",
    };
    appendLogEntry(REPO, entry);
    expect(readLog(REPO)).toEqual([entry]);
  });

  test("appendLogEntry rings out at 100 entries", () => {
    for (let i = 0; i < 105; i++) {
      appendLogEntry(REPO, {
        branch: "feat/x", sha: `sha${i}`, attemptedAt: i,
        outcome: "skipped" as const, durationMs: 10,
      });
    }
    const log = readLog(REPO);
    expect(log.length).toBe(100);
    expect(log[0]?.sha).toBe("sha5");    // oldest 5 dropped
    expect(log[99]?.sha).toBe("sha104"); // most recent kept
  });

  test("countAttemptsForSha counts only counted outcomes (fixed/error/rejected_diff)", () => {
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 1, outcome: "fixed",         durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 2, outcome: "skipped",       durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 3, outcome: "error",         durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "abc", attemptedAt: 4, outcome: "rejected_diff", durationMs: 10 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "xyz", attemptedAt: 5, outcome: "fixed",         durationMs: 10 });
    expect(countAttemptsForSha(REPO, "feat/x", "abc")).toBe(3); // skipped doesn't count
    expect(countAttemptsForSha(REPO, "feat/x", "xyz")).toBe(1);
    expect(countAttemptsForSha(REPO, "feat/y", "abc")).toBe(0);
  });
});

describe("auto-fix-log notes", () => {
  test("autoFixNotesDir is ~/.rt/<repo>/auto-fix-notes/", () => {
    expect(autoFixNotesDir(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix-notes"));
  });

  test("autoFixNotesPath uses <branch>-<short-sha>.md (slashes in branch replaced)", () => {
    expect(autoFixNotesPath(REPO, "feat/x", "abc12345")).toBe(
      join(tmpHome, ".rt", REPO, "auto-fix-notes", "feat-x-abc12345.md"),
    );
  });

  test("writeNotes then readNotes round-trips", () => {
    writeNotes(REPO, "feat/x", "abc12345", "the agent said no\n");
    expect(readNotes(REPO, "feat/x", "abc12345")).toBe("the agent said no\n");
  });

  test("readNotes returns null when file missing", () => {
    expect(readNotes(REPO, "feat/x", "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/auto-fix-log.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/auto-fix-log.ts`:

```typescript
/**
 * Auto-fix log + notes file I/O.
 *
 * `~/.rt/<repo>/auto-fix-log.json` — append-only ring of last 100 attempts.
 * `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` — durable per-attempt notes
 * for skipped/error/rejected outcomes (so users can inspect why later).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type AttemptOutcome =
  | "fixed"          // commit pushed
  | "skipped"        // agent declined cleanly (does NOT count toward budget)
  | "error"          // agent erred (counts)
  | "rejected_diff"; // daemon rejected agent's diff for cap/denylist (counts)

export interface AutoFixLogEntry {
  branch:      string;
  sha:         string;          // failing pipeline's HEAD SHA at attempt time
  attemptedAt: number;          // unix-ms
  outcome:     AttemptOutcome;
  durationMs:  number;
  commitSha?:  string;          // present when outcome="fixed"
  reason?:     string;          // short one-liner for skipped/error/rejected_diff
}

const RING_MAX = 100;

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixLogPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-log.json");
}

export function autoFixNotesDir(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-notes");
}

export function autoFixNotesPath(repoName: string, branch: string, sha: string): string {
  // Slashes in branch names ("feat/x") would create accidental subdirs. Replace.
  const safeBranch = branch.replace(/\//g, "-");
  return join(autoFixNotesDir(repoName), `${safeBranch}-${sha}.md`);
}

export function readLog(repoName: string): AutoFixLogEntry[] {
  const path = autoFixLogPath(repoName);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function appendLogEntry(repoName: string, entry: AutoFixLogEntry): void {
  mkdirSync(join(rtDir(), repoName), { recursive: true });
  const log = readLog(repoName);
  log.push(entry);
  // Ring trim: keep only the last RING_MAX entries.
  const trimmed = log.length > RING_MAX ? log.slice(log.length - RING_MAX) : log;
  writeFileSync(autoFixLogPath(repoName), JSON.stringify(trimmed, null, 2));
}

/** Count attempts that count toward the budget (fixed, error, rejected_diff). Skipped does not. */
export function countAttemptsForSha(repoName: string, branch: string, sha: string): number {
  const log = readLog(repoName);
  return log.filter(e =>
    e.branch === branch &&
    e.sha    === sha    &&
    (e.outcome === "fixed" || e.outcome === "error" || e.outcome === "rejected_diff")
  ).length;
}

export function writeNotes(repoName: string, branch: string, sha: string, body: string): void {
  mkdirSync(autoFixNotesDir(repoName), { recursive: true });
  writeFileSync(autoFixNotesPath(repoName, branch, sha), body);
}

export function readNotes(repoName: string, branch: string, sha: string): string | null {
  const path = autoFixNotesPath(repoName, branch, sha);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/auto-fix-log.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-fix-log.ts lib/__tests__/auto-fix-log.test.ts
git commit -m "feat(auto-fix): log ring + notes file I/O"
```

---

### Task 5: `lib/auto-fix-lock.ts` — per-repo lock with stale-PID handling

**Files:**
- Create: `lib/auto-fix-lock.ts`
- Test: `lib/__tests__/auto-fix-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/auto-fix-lock.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-lock-"));
process.env.HOME = tmpHome;

const { acquireLock, releaseLock, autoFixLockPath, isLockHeld } =
  await import("../auto-fix-lock.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("auto-fix-lock", () => {
  test("autoFixLockPath is ~/.rt/<repo>/auto-fix.lock", () => {
    expect(autoFixLockPath(REPO)).toBe(join(tmpHome, ".rt", REPO, "auto-fix.lock"));
  });

  test("acquireLock succeeds when no lock exists", () => {
    const ok = acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    expect(ok).toBe(true);
    expect(isLockHeld(REPO)).toBe(true);
  });

  test("second acquireLock fails when first is held by a live PID", () => {
    expect(acquireLock(REPO, { branch: "feat/x", sha: "abc" })).toBe(true);
    expect(acquireLock(REPO, { branch: "feat/y", sha: "def" })).toBe(false);
  });

  test("releaseLock removes the file", () => {
    acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    releaseLock(REPO);
    expect(isLockHeld(REPO)).toBe(false);
  });

  test("acquireLock succeeds over a stale lock (dead PID)", () => {
    // Write a lock with a PID that doesn't exist.
    const lockPath = autoFixLockPath(REPO);
    require("fs").mkdirSync(require("path").dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      branch: "feat/old", sha: "old", pid: 999999, startedAt: Date.now(),
    }));
    // 999999 is almost certainly not a running process. acquireLock should
    // detect it's stale and replace it.
    const ok = acquireLock(REPO, { branch: "feat/x", sha: "abc" });
    expect(ok).toBe(true);
  });

  test("isLockHeld is false for a stale lock", () => {
    const lockPath = autoFixLockPath(REPO);
    require("fs").mkdirSync(require("path").dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      branch: "feat/old", sha: "old", pid: 999999, startedAt: Date.now(),
    }));
    expect(isLockHeld(REPO)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/auto-fix-lock.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/auto-fix-lock.ts`:

```typescript
/**
 * Per-repo on-disk lock for auto-fix.
 *
 * Path: ~/.rt/<repo>/auto-fix.lock. Holds the live attempt's metadata. If the
 * recorded PID is not alive (daemon was killed mid-run), the lock is treated
 * as stale and acquireLock will replace it.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface LockBody {
  branch:    string;
  sha:       string;
  pid:       number;
  startedAt: number;
}

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixLockPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix.lock");
}

function readLock(repoName: string): LockBody | null {
  const path = autoFixLockPath(repoName);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof raw?.branch === "string" &&
      typeof raw?.sha === "string" &&
      typeof raw?.pid === "number" &&
      typeof raw?.startedAt === "number"
    ) return raw;
    return null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  // process.kill(pid, 0) throws if the process doesn't exist; otherwise no-op.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if a non-stale lock currently exists (live PID). */
export function isLockHeld(repoName: string): boolean {
  const lock = readLock(repoName);
  if (!lock) return false;
  return pidIsAlive(lock.pid);
}

/**
 * Try to acquire the lock. Returns true on success, false if a live lock
 * already exists. Stale locks (dead PID) are silently replaced.
 */
export function acquireLock(
  repoName: string,
  meta: { branch: string; sha: string },
): boolean {
  const existing = readLock(repoName);
  if (existing && pidIsAlive(existing.pid)) return false;

  mkdirSync(join(rtDir(), repoName), { recursive: true });
  const body: LockBody = {
    branch:    meta.branch,
    sha:       meta.sha,
    pid:       process.pid,
    startedAt: Date.now(),
  };
  writeFileSync(autoFixLockPath(repoName), JSON.stringify(body, null, 2));
  return true;
}

/** Remove the lock file. Idempotent — silent if absent. */
export function releaseLock(repoName: string): void {
  const path = autoFixLockPath(repoName);
  if (!existsSync(path)) return;
  try { unlinkSync(path); } catch { /* */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/auto-fix-lock.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/auto-fix-lock.ts lib/__tests__/auto-fix-lock.test.ts
git commit -m "feat(auto-fix): per-repo lock with stale-PID handling"
```

---

### Task 6: `lib/daemon/auto-fix-eligibility.ts` — gate evaluators

**Files:**
- Create: `lib/daemon/auto-fix-eligibility.ts`
- Test: `lib/daemon/__tests__/auto-fix-eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/auto-fix-eligibility.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-elig-"));
process.env.HOME = tmpHome;

const { evaluateEligibility } = await import("../auto-fix-eligibility.ts");
const { appendLogEntry } = await import("../../auto-fix-log.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

// A minimal fake "MR cache entry" shape — enough to exercise the gates.
function fakeMR(opts: Partial<{
  authorIsMe: boolean;
  status: string;
  isApproved: boolean;
  changesRequested: boolean;
  pipelineStatus: string;
  pipelineSha: string;
  flakeRetriedAndPassed: boolean;
}>) {
  return {
    authorIsMe:            opts.authorIsMe            ?? true,
    status:                opts.status                ?? "opened",
    isApproved:            opts.isApproved            ?? true,
    changesRequested:      opts.changesRequested      ?? false,
    pipelineStatus:        opts.pipelineStatus        ?? "failed",
    pipelineSha:           opts.pipelineSha           ?? "deadbeef",
    flakeRetriedAndPassed: opts.flakeRetriedAndPassed ?? false,
  };
}

describe("evaluateEligibility", () => {
  const baseInput = {
    repoName: REPO,
    branch: "feat/x",
    headSha: "deadbeef",
    now: 1700000000000,
    cooldownMs: 5 * 60 * 1000,
    attemptCap: 2,
  };

  test("eligible for a clean approved failed pipeline", () => {
    expect(evaluateEligibility({ ...baseInput, mr: fakeMR({}) }))
      .toEqual({ eligible: true });
  });

  test("not eligible: not authored by me", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ authorIsMe: false }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("author");
  });

  test("not eligible: status=draft", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ status: "draft" }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("status");
  });

  test("not eligible: not approved", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ isApproved: false }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("approve");
  });

  test("not eligible: changes_requested pending", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ changesRequested: true }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("changes");
  });

  test("not eligible: pipeline not failed", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ pipelineStatus: "running" }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("pipeline");
  });

  test("not eligible: pipeline SHA doesn't match MR HEAD", () => {
    const r = evaluateEligibility({
      ...baseInput,
      mr: fakeMR({ pipelineSha: "stale" }),
    });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("HEAD");
  });

  test("not eligible: flake (retried-and-passed)", () => {
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({ flakeRetriedAndPassed: true }) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("flake");
  });

  test("not eligible: attempt cap reached for this SHA", () => {
    appendLogEntry(REPO, { branch: "feat/x", sha: "deadbeef", attemptedAt: 0, outcome: "error",         durationMs: 1 });
    appendLogEntry(REPO, { branch: "feat/x", sha: "deadbeef", attemptedAt: 0, outcome: "rejected_diff", durationMs: 1 });
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({}) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("attempt");
  });

  test("not eligible: cooldown active (last fixed commit too recent)", () => {
    appendLogEntry(REPO, {
      branch: "feat/x", sha: "older-sha",
      attemptedAt: baseInput.now - 60_000,  // 1 min ago
      outcome: "fixed", durationMs: 1, commitSha: "abc",
    });
    const r = evaluateEligibility({ ...baseInput, mr: fakeMR({}) });
    expect(r.eligible).toBe(false);
    expect(r.eligible || r.reason).toContain("cooldown");
  });

  test("eligible: cooldown elapsed (last fixed commit > 5 min ago)", () => {
    appendLogEntry(REPO, {
      branch: "feat/x", sha: "older-sha",
      attemptedAt: baseInput.now - 6 * 60_000,
      outcome: "fixed", durationMs: 1, commitSha: "abc",
    });
    expect(evaluateEligibility({ ...baseInput, mr: fakeMR({}) }))
      .toEqual({ eligible: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/auto-fix-eligibility.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/daemon/auto-fix-eligibility.ts`:

```typescript
/**
 * Auto-fix eligibility evaluator.
 *
 * Pure function over a normalized MR snapshot + the on-disk attempt log.
 * Returns `{ eligible: true }` only when every gate passes; otherwise
 * `{ eligible: false, reason: <short string> }` describing the first
 * gate that failed (cheapest-first for fast short-circuit).
 *
 * Gates:
 *   1. Author is me
 *   2. MR status = opened
 *   3. Approved + no pending changes_requested
 *   4. Pipeline failed on current HEAD; not a retried-and-passed flake
 *   5. Attempt budget for this SHA + cooldown since last fixed commit
 */

import { countAttemptsForSha, readLog } from "../auto-fix-log.ts";

export interface MrSnapshot {
  authorIsMe:            boolean;
  status:                string;     // "opened" | "draft" | "merged" | "closed"
  isApproved:            boolean;
  changesRequested:      boolean;
  pipelineStatus:        string;     // "failed" | "running" | …
  pipelineSha:           string;     // the SHA the failing pipeline ran on
  flakeRetriedAndPassed: boolean;    // true if any failing job retried-and-passed
}

export interface EligibilityInput {
  repoName:    string;
  branch:      string;
  headSha:     string;       // MR's current HEAD SHA
  mr:          MrSnapshot;
  now:         number;       // unix-ms — injected for testability
  cooldownMs:  number;       // typically 5 minutes
  attemptCap:  number;       // typically 2
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { mr, repoName, branch, headSha, now, cooldownMs, attemptCap } = input;

  // 1. Identity
  if (!mr.authorIsMe) {
    return { eligible: false, reason: "not authored by me" };
  }
  if (mr.status !== "opened") {
    return { eligible: false, reason: `status=${mr.status}` };
  }

  // 2. Review
  if (!mr.isApproved) {
    return { eligible: false, reason: "not approved" };
  }
  if (mr.changesRequested) {
    return { eligible: false, reason: "changes_requested pending" };
  }

  // 3. Pipeline
  if (mr.pipelineStatus !== "failed") {
    return { eligible: false, reason: `pipeline=${mr.pipelineStatus}` };
  }
  if (mr.pipelineSha !== headSha) {
    return { eligible: false, reason: "pipeline ran on stale SHA, not current MR HEAD" };
  }
  if (mr.flakeRetriedAndPassed) {
    return { eligible: false, reason: "flake (job retried-and-passed)" };
  }

  // 4. Attempt budget for this SHA
  const attempts = countAttemptsForSha(repoName, branch, headSha);
  if (attempts >= attemptCap) {
    return { eligible: false, reason: `attempt cap reached (${attempts}/${attemptCap})` };
  }

  // 5. Cooldown since last fixed commit on this branch
  const log = readLog(repoName);
  const lastFixed = log
    .filter(e => e.branch === branch && e.outcome === "fixed")
    .sort((a, b) => b.attemptedAt - a.attemptedAt)[0];
  if (lastFixed && now - lastFixed.attemptedAt < cooldownMs) {
    return {
      eligible: false,
      reason: `cooldown active (${Math.round((now - lastFixed.attemptedAt) / 1000)}s since last fix)`,
    };
  }

  return { eligible: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/daemon/__tests__/auto-fix-eligibility.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/auto-fix-eligibility.ts lib/daemon/__tests__/auto-fix-eligibility.test.ts
git commit -m "feat(auto-fix): pure eligibility gate evaluator"
```

---

### Task 7: `lib/daemon/auto-fix-agent-protocol.ts` — prompt + RESULT parsing

**Files:**
- Create: `lib/daemon/auto-fix-agent-protocol.ts`
- Test: `lib/daemon/__tests__/auto-fix-agent-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/auto-fix-agent-protocol.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  assembleAutoFixPrompt,
  parseAgentResult,
} from "../auto-fix-agent-protocol.ts";

describe("assembleAutoFixPrompt", () => {
  test("contains task framing, scope rules, and exit protocol instructions", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x",
      target: "main",
      jobLogs: [{ name: "lint", trace: "error: missing semicolon at line 42" }],
      gitContext: {
        commits: "- a1b2c3 fix lint",
        changedFiles: "src/foo.ts",
        diffStat: "1 file, 2 insertions",
        diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n",
      },
      fileCap: 5,
      lineCap: 200,
      denylist: ["package.json", "infra/**"],
      allowTestFixes: false,
    });
    expect(prompt).toContain("pipeline on this branch is failing");
    expect(prompt).toContain("RESULT: fixed");
    expect(prompt).toContain("RESULT: skipped");
    expect(prompt).toContain("RESULT: error");
    expect(prompt).toContain("≤ 5 files");
    expect(prompt).toContain("≤ 200 lines");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("infra/**");
    expect(prompt).toContain("error: missing semicolon at line 42");
    expect(prompt).toContain("feat/x");
    expect(prompt).toContain("main");
  });

  test("when allowTestFixes is true, prompt includes test-failure guidance", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x", target: "main", jobLogs: [],
      gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
      fileCap: 5, lineCap: 200, denylist: [], allowTestFixes: true,
    });
    expect(prompt.toLowerCase()).toContain("test failures are in scope");
  });

  test("when allowTestFixes is false, prompt restricts to lint/types/format", () => {
    const prompt = assembleAutoFixPrompt({
      branch: "feat/x", target: "main", jobLogs: [],
      gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
      fileCap: 5, lineCap: 200, denylist: [], allowTestFixes: false,
    });
    expect(prompt.toLowerCase()).toContain("test failures are out of scope");
  });
});

describe("parseAgentResult", () => {
  test("RESULT: fixed with summary", () => {
    const out = "did stuff\nRESULT: fixed: bumped semver in tsconfig\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "bumped semver in tsconfig" });
  });

  test("RESULT: fixed without colon-summary still parses", () => {
    const out = "RESULT: fixed\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "" });
  });

  test("RESULT: skipped with reason", () => {
    expect(parseAgentResult("RESULT: skipped: this looks like a real bug, not lint\n"))
      .toEqual({ kind: "skipped", reason: "this looks like a real bug, not lint" });
  });

  test("RESULT: error with note", () => {
    expect(parseAgentResult("RESULT: error: bun typecheck blew up\n"))
      .toEqual({ kind: "error", note: "bun typecheck blew up" });
  });

  test("missing RESULT line → unrecognized", () => {
    expect(parseAgentResult("hello world\nno result here"))
      .toEqual({ kind: "unrecognized" });
  });

  test("uses the LAST RESULT line if multiple appear", () => {
    const out = "RESULT: skipped: thinking\nRESULT: fixed: actually I figured it out\n";
    expect(parseAgentResult(out)).toEqual({ kind: "fixed", summary: "actually I figured it out" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/auto-fix-agent-protocol.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the module**

Create `lib/daemon/auto-fix-agent-protocol.ts`:

```typescript
/**
 * Pure helpers for the auto-fix agent protocol.
 *
 *   assembleAutoFixPrompt — build the full prompt string given context.
 *   parseAgentResult     — extract the structured RESULT line from agent stdout.
 *
 * Both are pure functions, fully tested in isolation.
 */

export interface JobLog {
  name:  string;
  trace: string;  // last ~200 lines of the failing job's trace, already truncated
}

export interface GitContext {
  commits:      string;  // formatted "- <sha> <subject>" lines, vs target
  changedFiles: string;  // "\n"-separated paths, vs target
  diffStat:     string;  // git diff --stat output, vs target
  diff:         string;  // truncated full diff
}

export interface AutoFixPromptInput {
  branch:         string;
  target:         string;
  jobLogs:        JobLog[];
  gitContext:     GitContext;
  fileCap:        number;
  lineCap:        number;
  denylist:       string[];
  allowTestFixes: boolean;
}

export function assembleAutoFixPrompt(input: AutoFixPromptInput): string {
  const parts: string[] = [];

  // 1. Framing
  parts.push(
    `# Task: auto-fix a failing CI pipeline\n\n` +
    `A pipeline on this branch is failing. Make the smallest change that makes it pass. ` +
    `Stay within scope caps below. Refuse rather than guess. ` +
    `If the failure looks like a real bug (logic error, missing handling) instead of a ` +
    `mechanical issue, reply with \`RESULT: skipped\` and a one-line reason.`,
  );

  // 2. Failing job logs
  if (input.jobLogs.length > 0) {
    parts.push("## Failing job logs");
    for (const job of input.jobLogs) {
      parts.push(`### ${job.name}\n\n\`\`\`\n${job.trace}\n\`\`\``);
    }
  }

  // 3. Repo / git context
  parts.push(
    `## Git context\n\n` +
    `Branch: ${input.branch}\n` +
    `Target: ${input.target}\n\n` +
    `### Commits (HEAD vs origin/${input.target})\n\n${input.gitContext.commits || "(none)"}\n\n` +
    `### Changed files\n\n${input.gitContext.changedFiles || "(none)"}\n\n` +
    `### Diff stat\n\n\`\`\`\n${input.gitContext.diffStat || "(none)"}\n\`\`\`\n\n` +
    `### Diff\n\n\`\`\`diff\n${input.gitContext.diff || "(none)"}\n\`\`\``,
  );

  // 4. Scope rules — these are HARD limits. Validation will reject otherwise.
  parts.push(
    `## Scope rules (hard limits)\n\n` +
    `- ≤ ${input.fileCap} files modified.\n` +
    `- ≤ ${input.lineCap} lines changed (insertions + deletions).\n` +
    `- The following paths are off-limits — do NOT modify any of them:\n` +
    input.denylist.map(p => `  - \`${p}\``).join("\n") + `\n\n` +
    (input.allowTestFixes
      ? `Test failures are in scope. Lint, type, format, and test failures may all be attempted.`
      : `Test failures are out of scope. Only attempt lint, type, and format failures. ` +
        `If the failure is a test, reply with \`RESULT: skipped: test failures opt-in only\`.`),
  );

  // 5. Validation requirement
  parts.push(
    `## Local validation before commit\n\n` +
    `Before staging your changes:\n` +
    `1. Run the project's lint and typecheck commands (consult package.json scripts, ` +
    `Makefile, or README to find them).\n` +
    `2. Confirm they pass on the changed files.\n` +
    `3. If validation fails, reply with \`RESULT: error: <one-line reason>\` and DO NOT commit.\n\n` +
    `Then \`git add\` your changes and \`git commit\` (do NOT push — the daemon pushes after ` +
    `verifying the diff).`,
  );

  // 6. Exit protocol
  parts.push(
    `## Exit protocol\n\n` +
    `End your reply with EXACTLY ONE of these lines (the daemon greps for the last \`RESULT:\` line):\n\n` +
    `  \`RESULT: fixed: <one-line summary of what you changed>\`\n` +
    `  \`RESULT: skipped: <one-line reason>\`\n` +
    `  \`RESULT: error: <one-line reason>\`\n\n` +
    `If you commit but do not include a RESULT line, the daemon will treat it as \`error\`.`,
  );

  return parts.join("\n\n");
}

// ─── parseAgentResult ────────────────────────────────────────────────────────

export type AgentResult =
  | { kind: "fixed";        summary: string }
  | { kind: "skipped";      reason:  string }
  | { kind: "error";        note:    string }
  | { kind: "unrecognized"                  };

const RESULT_LINE_REGEX = /^\s*RESULT:\s*(fixed|skipped|error)\s*(?::\s*(.*?))?\s*$/i;

export function parseAgentResult(stdout: string): AgentResult {
  // Walk lines bottom-up so the LAST RESULT line wins (the agent may
  // mid-thought write a tentative one, then change its mind).
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(RESULT_LINE_REGEX);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as "fixed" | "skipped" | "error";
    const detail = (m[2] ?? "").trim();
    if (kind === "fixed")   return { kind: "fixed",   summary: detail };
    if (kind === "skipped") return { kind: "skipped", reason:  detail };
    return { kind: "error", note: detail };
  }
  return { kind: "unrecognized" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/daemon/__tests__/auto-fix-agent-protocol.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/auto-fix-agent-protocol.ts lib/daemon/__tests__/auto-fix-agent-protocol.test.ts
git commit -m "feat(auto-fix): pure prompt assembly + RESULT parsing"
```

---

### Task 8: `lib/daemon/auto-fix.ts` — engine skeleton + provisioning

**Files:**
- Create: `lib/daemon/auto-fix.ts`

This task creates the engine module and implements the provisioning + teardown phase only. The orchestrator and other phases come in Tasks 9-11.

- [ ] **Step 1: Create the file with provisioning helpers**

Create `lib/daemon/auto-fix.ts`:

```typescript
/**
 * Auto-fix engine — orchestrates the full pipeline-failure → ephemeral
 * worktree → agent → validation → commit/push → teardown flow.
 *
 * Most of the logic lives in pure modules:
 *   - lib/auto-fix-config.ts          → caps, denylist, setup commands
 *   - lib/auto-fix-log.ts             → attempt log + notes
 *   - lib/auto-fix-lock.ts            → on-disk per-repo lock
 *   - lib/auto-fix-denylist.ts        → DEFAULT_DENYLIST + scope-cap helpers
 *   - lib/setup-commands.ts           → lockfile-driven install detection
 *   - lib/daemon/auto-fix-eligibility.ts   → gate evaluators
 *   - lib/daemon/auto-fix-agent-protocol.ts → prompt + RESULT parsing
 *
 * This file ties them together with the side-effect-heavy bits: git operations,
 * agent subprocess, file I/O, in-memory queue.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { reconcileForRepo } from "./doppler-sync.ts";
import { detectInstallCommand } from "../setup-commands.ts";
import { loadAutoFixConfig } from "../auto-fix-config.ts";

// ─── Paths ───────────────────────────────────────────────────────────────────

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

function autoFixWorktreesDir(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix-worktrees");
}

/** Compute the ephemeral worktree path for a given branch + sha. */
export function ephemeralWorktreePath(repoName: string, branch: string, sha: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  const shortSha = sha.slice(0, 8);
  return join(autoFixWorktreesDir(repoName), `${safeBranch}-${shortSha}`);
}

// ─── Provisioning ────────────────────────────────────────────────────────────

export interface ProvisionInput {
  repoName:  string;
  repoPath:  string;   // primary repo path; `git -C repoPath worktree add …` is run from here
  branch:    string;
  sha:       string;
  log:       (msg: string) => void;
}

export interface ProvisionResult {
  ok:           true;
  worktreePath: string;
}
export interface ProvisionError {
  ok:    false;
  error: string;
}

/**
 * Create an ephemeral worktree, fetch the failing branch, switch to it,
 * verify HEAD matches `sha`, run Doppler sync + setup commands.
 *
 * On failure, attempts to teardown anything partially created.
 */
export async function provisionWorktree(
  input: ProvisionInput,
): Promise<ProvisionResult | ProvisionError> {
  const { repoName, repoPath, branch, sha, log } = input;
  const wtPath = ephemeralWorktreePath(repoName, branch, sha);

  try {
    mkdirSync(autoFixWorktreesDir(repoName), { recursive: true });

    // If a previous attempt left a stale dir behind, remove it first so the
    // worktree-add doesn't trip over it.
    if (existsSync(wtPath)) {
      try {
        execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: "pipe" });
      } catch { /* not registered; just delete dir */ }
      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* */ }
    }

    log(`auto-fix: git worktree add → ${wtPath} from origin/${branch}`);
    execSync(
      `git -C "${repoPath}" fetch origin "${branch}" && ` +
      `git -C "${repoPath}" worktree add "${wtPath}" "origin/${branch}"`,
      { stdio: "pipe" },
    );

    // Verify HEAD matches the failing pipeline SHA — guards against a
    // force-push between when the cache was refreshed and now.
    const head = execSync(`git -C "${wtPath}" rev-parse HEAD`, {
      encoding: "utf8", stdio: "pipe",
    }).trim();
    if (head !== sha) {
      await teardownWorktree(repoPath, wtPath, log);
      return { ok: false, error: `HEAD drifted (worktree=${head.slice(0,8)} expected=${sha.slice(0,8)})` };
    }

    // Reconcile Doppler so the agent inherits the user's env.
    try {
      const summary = await reconcileForRepo({
        repoName,
        worktreeRoots: [wtPath],
      });
      log(`auto-fix: doppler:sync wrote=${summary.wrote} unchanged=${summary.unchanged}`);
    } catch (err) {
      log(`auto-fix: doppler:sync failed (continuing): ${err}`);
    }

    // Run setup commands (explicit override OR lockfile-detected install).
    const cfg = loadAutoFixConfig(repoName);
    const commands = cfg.setupCommands ?? (() => {
      const detected = detectInstallCommand(wtPath);
      return detected ? [detected] : [];
    })();

    for (const cmd of commands) {
      const [bin, ...args] = cmd;
      log(`auto-fix: running setup: ${bin} ${args.join(" ")}`);
      try {
        execSync(`${bin} ${args.map(a => JSON.stringify(a)).join(" ")}`, {
          cwd: wtPath, stdio: "pipe", timeout: 5 * 60_000,
        });
      } catch (err: any) {
        await teardownWorktree(repoPath, wtPath, log);
        return { ok: false, error: `setup ${bin} failed: ${(err.stderr?.toString() ?? err.message ?? "").slice(0, 200)}` };
      }
    }

    return { ok: true, worktreePath: wtPath };
  } catch (err: any) {
    await teardownWorktree(repoPath, wtPath, log);
    return { ok: false, error: `provision: ${err.message ?? String(err)}` };
  }
}

/** Remove the ephemeral worktree. Tolerant of partial state. */
export async function teardownWorktree(
  repoPath: string,
  worktreePath: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!existsSync(worktreePath)) return;
  try {
    execSync(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`, { stdio: "pipe" });
    log(`auto-fix: removed worktree ${worktreePath}`);
  } catch (err: any) {
    log(`auto-fix: worktree remove failed (${err.message}); rm -rf instead`);
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─── Stale sweep (called on daemon startup) ──────────────────────────────────

/**
 * On daemon startup, remove any ephemeral worktree directories left over
 * from a crashed previous daemon. Worktrees younger than 1h are kept since
 * they may still be in flight (multiple daemons should not exist; this is
 * defense in depth).
 */
export function sweepStaleArtifacts(
  repoIndex: () => Record<string, string>,
  log: (msg: string) => void,
): void {
  const STALE_AGE_MS = 60 * 60 * 1000;  // 1 hour
  const now = Date.now();

  for (const [repoName, repoPath] of Object.entries(repoIndex())) {
    const dir = autoFixWorktreesDir(repoName);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry);
      let age: number;
      try { age = now - statSync(path).mtimeMs; } catch { continue; }
      if (age < STALE_AGE_MS) continue;
      log(`auto-fix: sweeping stale worktree ${path} (age=${Math.round(age / 60_000)}m)`);
      try {
        execSync(`git -C "${repoPath}" worktree remove --force "${path}"`, { stdio: "pipe" });
      } catch { /* */ }
      try { rmSync(path, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
bun -e 'import("./lib/daemon/auto-fix.ts").then(m => console.log(Object.keys(m).sort()))'
```
Expected: `["ephemeralWorktreePath", "provisionWorktree", "sweepStaleArtifacts", "teardownWorktree"]`

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/auto-fix.ts
git commit -m "feat(auto-fix): engine skeleton — provisioning + teardown + stale sweep"
```

---

### Task 9: `lib/daemon/auto-fix.ts` — validation + commit/push

Append validation and commit logic to the engine.

**Files:**
- Modify: `lib/daemon/auto-fix.ts`

- [ ] **Step 1: Append the validation + commit helpers**

Append to `lib/daemon/auto-fix.ts`:

```typescript
import {
  DEFAULT_DENYLIST,
  matchesDenylist,
  enforceScopeCaps,
  type ScopeCapViolation,
} from "../auto-fix-denylist.ts";

// ─── Diff validation ─────────────────────────────────────────────────────────

export interface DiffSummary {
  files: string[];
  insertions: number;
  deletions: number;
}

/** Capture the agent's staged-or-working diff vs HEAD as a structured summary. */
export function captureWorktreeDiff(worktreePath: string): DiffSummary {
  // Files: prefer staged + unstaged.
  const filesOut = execSync(`git -C "${worktreePath}" diff HEAD --name-only`, {
    encoding: "utf8", stdio: "pipe",
  });
  const files = filesOut.split("\n").map(s => s.trim()).filter(Boolean);

  // Stats: insertions + deletions.
  const stat = execSync(`git -C "${worktreePath}" diff HEAD --shortstat`, {
    encoding: "utf8", stdio: "pipe",
  });
  // Format: " 3 files changed, 12 insertions(+), 4 deletions(-)"
  const insertions = parseInt(stat.match(/(\d+) insertion/)?.[1] ?? "0", 10);
  const deletions  = parseInt(stat.match(/(\d+) deletion/)?.[1]  ?? "0", 10);
  return { files, insertions, deletions };
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "denylist"; offendingPath: string }
  | { ok: false; reason: "scope"; violation: ScopeCapViolation };

/** Validate diff against caps + denylist (default + repo additions). */
export function validateDiff(
  diff: DiffSummary,
  caps: { fileCap: number; lineCap: number },
  additionalDenylist: string[],
): ValidationResult {
  if (diff.files.length === 0) return { ok: false, reason: "empty" };

  const allDeny = [...DEFAULT_DENYLIST, ...additionalDenylist];
  for (const f of diff.files) {
    if (matchesDenylist(f, allDeny)) {
      return { ok: false, reason: "denylist", offendingPath: f };
    }
  }

  const violation = enforceScopeCaps({
    files:   diff.files.length,
    lines:   diff.insertions + diff.deletions,
    fileCap: caps.fileCap,
    lineCap: caps.lineCap,
  });
  if (violation) return { ok: false, reason: "scope", violation };

  return { ok: true };
}

// ─── Commit + push ───────────────────────────────────────────────────────────

export interface CommitInput {
  worktreePath: string;
  branch:       string;
  sha:          string;       // pre-commit SHA (the failing pipeline's SHA)
  summary:      string;       // from agent's RESULT: fixed: <summary>
}

export interface CommitResult {
  ok: true;
  newCommitSha: string;
}
export interface CommitError {
  ok: false;
  error: string;
}

/** Stage everything modified, commit with the structured trailer, push. */
export async function commitAndPush(
  input: CommitInput,
  log: (msg: string) => void,
): Promise<CommitResult | CommitError> {
  const { worktreePath, branch, sha, summary } = input;
  try {
    execSync(`git -C "${worktreePath}" add -A`, { stdio: "pipe" });

    const subject = `auto-fix: ${summary}`;
    const body = `\n\nAuto-Fixed-By: rt\nPipeline-Failure-SHA: ${sha}\n`;
    const message = subject + body;

    execSync(
      `git -C "${worktreePath}" -c user.email="auto-fix@rt" -c user.name="rt auto-fix" ` +
      `commit -m ${JSON.stringify(message)}`,
      { stdio: "pipe" },
    );

    const newSha = execSync(`git -C "${worktreePath}" rev-parse HEAD`, {
      encoding: "utf8", stdio: "pipe",
    }).trim();

    log(`auto-fix: pushing ${branch} (${newSha.slice(0, 8)})`);
    execSync(`git -C "${worktreePath}" push origin "${branch}"`, { stdio: "pipe" });

    return { ok: true, newCommitSha: newSha };
  } catch (err: any) {
    const msg = (err.stderr?.toString() ?? err.message ?? String(err)).slice(0, 300);
    return { ok: false, error: msg };
  }
}

/** Reset the worktree to HEAD and clean untracked files (used on rejected diff). */
export function resetWorktree(worktreePath: string, preAgentSha: string): void {
  try {
    execSync(`git -C "${worktreePath}" reset --hard "${preAgentSha}"`, { stdio: "pipe" });
    execSync(`git -C "${worktreePath}" clean -fd`, { stdio: "pipe" });
  } catch { /* best-effort */ }
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
bun -e 'import("./lib/daemon/auto-fix.ts").then(m => console.log(Object.keys(m).sort().join(",")))'
```
Expected: includes `captureWorktreeDiff`, `validateDiff`, `commitAndPush`, `resetWorktree` along with the earlier exports.

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/auto-fix.ts
git commit -m "feat(auto-fix): diff validation + commit/push helpers"
```

---

### Task 10: `lib/daemon/auto-fix.ts` — orchestrator + queue

Append the top-level `runAutoFix` function that ties everything together, with the in-memory queue.

**Files:**
- Modify: `lib/daemon/auto-fix.ts`

- [ ] **Step 1: Append the orchestrator**

Append to `lib/daemon/auto-fix.ts`:

```typescript
import { runAgent, resolveAgentInvocation } from "../agent-runner.ts";
import { evaluateEligibility, type MrSnapshot } from "./auto-fix-eligibility.ts";
import {
  assembleAutoFixPrompt, parseAgentResult, type JobLog, type GitContext,
} from "./auto-fix-agent-protocol.ts";
import { acquireLock, releaseLock } from "../auto-fix-lock.ts";
import { appendLogEntry, writeNotes } from "../auto-fix-log.ts";
import { DEFAULT_DENYLIST } from "../auto-fix-denylist.ts";

const COOLDOWN_MS  = 5 * 60 * 1000;
const ATTEMPT_CAP  = 2;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes — way more than fixes ever take

// ─── In-memory inflight + queue ──────────────────────────────────────────────

const inflight = new Set<string>();
const queued = new Map<string, AutoFixContext>();

// ─── AutoFixContext + outcomes ───────────────────────────────────────────────

export interface AutoFixContext {
  repoName:       string;
  repoPath:       string;     // primary repo path
  branch:         string;
  sha:            string;     // current MR HEAD = failing pipeline SHA
  target:         string;     // MR's target branch (e.g. "main")
  mr:             MrSnapshot;
  jobLogs:        JobLog[];
  gitContext:     GitContext;
  log:            (msg: string) => void;
  notify?:        (kind: "auto_fix_pushed" | "auto_fix_skipped" | "auto_fix_rejected", details: string) => void;
}

export type AutoFixOutcome =
  | { kind: "ineligible";    reason: string }
  | { kind: "queued"                       }
  | { kind: "fixed";         commitSha: string; summary: string }
  | { kind: "skipped";       reason: string }
  | { kind: "error";         error: string }
  | { kind: "rejected_diff"; reason: string };

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Top-level entry. Fire-and-forget safe — caller does not need to await.
 * Per-repo serialization via in-memory inflight set + queue (most-recent-wins).
 */
export async function runAutoFix(ctx: AutoFixContext): Promise<AutoFixOutcome> {
  const { repoName, log } = ctx;

  if (inflight.has(repoName)) {
    queued.set(repoName, ctx);
    log(`auto-fix: ${repoName} in flight; queued ${ctx.branch}@${ctx.sha.slice(0, 8)}`);
    return { kind: "queued" };
  }
  inflight.add(repoName);

  try {
    return await runOnce(ctx);
  } finally {
    inflight.delete(repoName);
    const next = queued.get(repoName);
    if (next) {
      queued.delete(repoName);
      runAutoFix(next).catch(err => log(`auto-fix: queued retry failed: ${err}`));
    }
  }
}

async function runOnce(ctx: AutoFixContext): Promise<AutoFixOutcome> {
  const { repoName, repoPath, branch, sha, target, mr, log } = ctx;
  const startedAt = Date.now();

  // ── Eligibility ─────────────────────────────────────────────────────────
  const eligibility = evaluateEligibility({
    repoName, branch, headSha: sha, mr,
    now: startedAt, cooldownMs: COOLDOWN_MS, attemptCap: ATTEMPT_CAP,
  });
  if (!eligibility.eligible) {
    log(`auto-fix: ineligible — ${eligibility.reason}`);
    return { kind: "ineligible", reason: eligibility.reason };
  }

  // ── Lock ────────────────────────────────────────────────────────────────
  if (!acquireLock(repoName, { branch, sha })) {
    log(`auto-fix: lock held; skipping`);
    return { kind: "ineligible", reason: "lock held by another process" };
  }

  try {
    // ── Provision ───────────────────────────────────────────────────────
    const prov = await provisionWorktree({ repoName, repoPath, branch, sha, log });
    if (!prov.ok) {
      const out: AutoFixOutcome = { kind: "error", error: prov.error };
      finalize(ctx, startedAt, out);
      return out;
    }
    const wtPath = prov.worktreePath;

    try {
      // ── Run agent ───────────────────────────────────────────────────
      const cfg = loadAutoFixConfig(repoName);
      const denylistForPrompt = [...DEFAULT_DENYLIST, ...cfg.additionalDenylist];
      const prompt = assembleAutoFixPrompt({
        branch, target,
        jobLogs: ctx.jobLogs, gitContext: ctx.gitContext,
        fileCap: cfg.fileCap, lineCap: cfg.lineCap,
        denylist: denylistForPrompt,
        allowTestFixes: cfg.allowTestFixes,
      });

      log(`auto-fix: spawning agent in ${wtPath}`);
      const agentRes = await runAgent({
        ...resolveAgentInvocation({}),
        prompt, cwd: wtPath,
      });
      const result = parseAgentResult(agentRes.stdout);

      if (result.kind === "skipped") {
        writeNotes(repoName, branch, sha, `# Auto-fix skipped\n\nReason: ${result.reason}\n\n## Agent stdout (tail)\n\n\`\`\`\n${tail(agentRes.stdout, 4000)}\n\`\`\``);
        const out: AutoFixOutcome = { kind: "skipped", reason: result.reason };
        finalize(ctx, startedAt, out);
        return out;
      }
      if (result.kind === "error" || result.kind === "unrecognized") {
        const note = result.kind === "error" ? result.note : "agent exited without RESULT line";
        writeNotes(repoName, branch, sha, `# Auto-fix error\n\nReason: ${note}\n\n## Agent stdout (tail)\n\n\`\`\`\n${tail(agentRes.stdout, 4000)}\n\`\`\``);
        const out: AutoFixOutcome = { kind: "error", error: note };
        finalize(ctx, startedAt, out);
        return out;
      }

      // result.kind === "fixed" — validate the diff before committing.
      const diff = captureWorktreeDiff(wtPath);
      const validation = validateDiff(diff,
        { fileCap: cfg.fileCap, lineCap: cfg.lineCap },
        cfg.additionalDenylist,
      );
      if (!validation.ok) {
        const reason = validation.reason === "empty"      ? "agent reported fixed but produced no diff"
                     : validation.reason === "denylist"   ? `denied path ${validation.offendingPath}`
                     : /* scope */                           `${validation.violation.kind}=${validation.violation.actual}>${validation.violation.cap}`;
        resetWorktree(wtPath, sha);
        writeNotes(repoName, branch, sha, `# Auto-fix rejected\n\nReason: ${reason}\n\nFiles touched:\n${diff.files.map(f => `- ${f}`).join("\n")}\n\nDiff stats: ${diff.insertions} insertions, ${diff.deletions} deletions.\n`);
        const out: AutoFixOutcome = { kind: "rejected_diff", reason };
        finalize(ctx, startedAt, out);
        return out;
      }

      // Verify HEAD didn't drift mid-agent (third party push).
      const stillHead = execSync(`git -C "${wtPath}" rev-parse HEAD`, {
        encoding: "utf8", stdio: "pipe",
      }).trim();
      if (stillHead !== sha) {
        resetWorktree(wtPath, sha);
        const out: AutoFixOutcome = { kind: "error", error: "HEAD drifted during agent run" };
        finalize(ctx, startedAt, out);
        return out;
      }

      // Commit + push.
      const commit = await commitAndPush(
        { worktreePath: wtPath, branch, sha, summary: result.summary || "auto-fix" },
        log,
      );
      if (!commit.ok) {
        const out: AutoFixOutcome = { kind: "error", error: `commit/push failed: ${commit.error}` };
        finalize(ctx, startedAt, out);
        return out;
      }

      const out: AutoFixOutcome = { kind: "fixed", commitSha: commit.newCommitSha, summary: result.summary };
      finalize(ctx, startedAt, out);
      return out;
    } finally {
      await teardownWorktree(repoPath, wtPath, log);
    }
  } finally {
    releaseLock(repoName);
  }
}

// ─── Finalize: log + notify ──────────────────────────────────────────────────

function finalize(ctx: AutoFixContext, startedAt: number, outcome: AutoFixOutcome): void {
  const { repoName, branch, sha, log, notify } = ctx;
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "fixed") {
    appendLogEntry(repoName, {
      branch, sha, attemptedAt: startedAt, outcome: "fixed", durationMs,
      commitSha: outcome.commitSha, reason: outcome.summary,
    });
    log(`auto-fix: fixed ${branch}@${sha.slice(0, 8)} → ${outcome.commitSha.slice(0, 8)} (${durationMs}ms)`);
    notify?.("auto_fix_pushed", outcome.summary);
  } else if (outcome.kind === "skipped") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "skipped", durationMs, reason: outcome.reason });
    log(`auto-fix: skipped ${branch}@${sha.slice(0, 8)} (${outcome.reason})`);
    notify?.("auto_fix_skipped", outcome.reason);
  } else if (outcome.kind === "error") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "error", durationMs, reason: outcome.error });
    log(`auto-fix: error ${branch}@${sha.slice(0, 8)} (${outcome.error})`);
    notify?.("auto_fix_skipped", outcome.error);
  } else if (outcome.kind === "rejected_diff") {
    appendLogEntry(repoName, { branch, sha, attemptedAt: startedAt, outcome: "rejected_diff", durationMs, reason: outcome.reason });
    log(`auto-fix: rejected ${branch}@${sha.slice(0, 8)} (${outcome.reason})`);
    notify?.("auto_fix_rejected", outcome.reason);
  }
  // ineligible / queued: don't log, don't notify.
}

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}
```

Note: the `AGENT_TIMEOUT_MS` constant is declared but not used in this implementation — `runAgent` doesn't currently support a timeout. Adding a wrapper is out of scope for v1.

- [ ] **Step 2: Verify it compiles**

Run:
```bash
bun -e 'import("./lib/daemon/auto-fix.ts").then(m => console.log("ok", typeof m.runAutoFix))'
```
Expected: `ok function`

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/auto-fix.ts
git commit -m "feat(auto-fix): orchestrator + in-memory queue (most-recent-wins)"
```

---

### Task 11: `lib/notifier.ts` — fire auto-fix on pipeline-failed transition

**Files:**
- Modify: `lib/notifier.ts`

This task adds three event keys (`auto_fix_pushed`, `auto_fix_skipped`, `auto_fix_rejected`) and fires `runAutoFix` from inside the pipeline-failed transition block.

- [ ] **Step 1: Add the event keys**

In `lib/notifier.ts`, find the `NOTIFICATION_TYPES` array (search for `"pipeline_failed"`). Append three entries:

```typescript
  { key: "auto_fix_pushed",   label: "Auto-fix pushed",     description: "When rt auto-fix successfully pushed a fix" },
  { key: "auto_fix_skipped",  label: "Auto-fix skipped",    description: "When rt auto-fix declined or errored on a failure" },
  { key: "auto_fix_rejected", label: "Auto-fix rejected",   description: "When rt auto-fix's diff was rejected for scope/denylist violation" },
```

- [ ] **Step 2: Build an MR snapshot helper for the auto-fix call**

This is the trickiest integration point. The notifier already iterates cache entries and computes `was`/`now` snapshots. We need to assemble a `MrSnapshot` (the eligibility evaluator's input shape) from the cache entry, plus the supporting data (jobLogs, gitContext) for the agent.

Inside `lib/notifier.ts`, near the top of the file (after imports), add a helper that derives an MR snapshot from a cache entry. The exact field names depend on glance-sdk; consult `lib/notifier.ts` itself for how it currently reads `mr.pipeline.status`, `mr.reviews.isApproved`, etc., and follow the same patterns.

Add the snapshot builder + a fire-and-forget caller, both as private functions in `lib/notifier.ts`:

```typescript
import type { MrSnapshot } from "./daemon/auto-fix-eligibility.ts";

function buildMrSnapshot(entry: CacheEntry, currentUserId: string | null): MrSnapshot | null {
  const mr: any = entry.mr;
  if (!mr) return null;
  return {
    authorIsMe:            !!currentUserId && String(mr.authorId ?? mr.author?.id ?? "") === currentUserId,
    status:                String(mr.status ?? "opened"),
    isApproved:            !!mr.reviews?.isApproved,
    changesRequested:      Array.isArray(mr.reviews?.summaries)
                             ? mr.reviews.summaries.some((s: any) => s.state === "changes_requested")
                             : false,
    pipelineStatus:        String(mr.pipeline?.status ?? ""),
    pipelineSha:           String(mr.pipeline?.sha ?? mr.pipeline?.ref ?? mr.head?.sha ?? mr.headSha ?? ""),
    flakeRetriedAndPassed: Array.isArray(mr.pipeline?.jobs)
                             ? mr.pipeline.jobs.some((j: any) => j.retries?.some?.((r: any) => r.status === "success"))
                             : false,
  };
}

async function maybeFireAutoFix(
  repoName: string,
  repoPath: string,
  entry: CacheEntry,
  branch: string,
  currentUserId: string | null,
  log: (m: string) => void,
): Promise<void> {
  // Defensive: skip if anything required is missing.
  const mr = entry.mr;
  if (!mr) return;
  const headSha = String(mr.head?.sha ?? mr.headSha ?? mr.pipeline?.sha ?? "");
  if (!headSha) return;
  const target  = String(mr.target?.branch ?? mr.targetBranch ?? "main");
  const snapshot = buildMrSnapshot(entry, currentUserId);
  if (!snapshot) return;

  // Lazy-import to keep notifier startup cheap.
  const { runAutoFix } = await import("./daemon/auto-fix.ts");
  const failingJobs = Array.isArray(mr.pipeline?.jobs)
    ? mr.pipeline.jobs.filter((j: any) => j.status === "failed")
    : [];

  // Build minimal job logs (name + truncated trace). Full traces are fetched
  // lazily by the agent if needed; here we only ship the names + first 2KB
  // of any inline trace text the cache happens to have.
  const jobLogs = failingJobs.map((j: any) => ({
    name:  String(j.name ?? "job"),
    trace: String(j.trace ?? "(trace not cached — agent should fetch via project tooling)").slice(0, 2000),
  }));

  // Build gitContext via local git (cheap; ~100ms).
  const gitContext = (() => {
    try {
      const refSpec = `origin/${target}...${headSha}`;
      const opts = { cwd: repoPath, encoding: "utf8" as const, stdio: "pipe" as const };
      return {
        commits:      execSync(`git log ${refSpec} --pretty=format:"- %h %s" -n 20`, opts).trim(),
        changedFiles: execSync(`git diff ${refSpec} --name-only`, opts).trim(),
        diffStat:     execSync(`git diff ${refSpec} --shortstat`, opts).trim(),
        diff:         execSync(`git diff ${refSpec}`, opts).slice(0, 80 * 1024),
      };
    } catch {
      return { commits: "", changedFiles: "", diffStat: "", diff: "" };
    }
  })();

  runAutoFix({
    repoName, repoPath, branch, sha: headSha, target, mr: snapshot,
    jobLogs, gitContext, log,
  }).catch(err => log(`auto-fix: top-level failure: ${err}`));
}
```

Add `import { execSync } from "child_process";` to the top of `lib/notifier.ts` if not already present.

- [ ] **Step 3: Call `maybeFireAutoFix` from the pipeline-failed branch**

Inside the existing block at `lib/notifier.ts:440-454` (the `running/pending → failed` transition), AFTER the existing notification block but still inside the same branch, add:

```typescript
      // Auto-fix attempt — independent of the user's notification preferences;
      // gating happens inside runAutoFix's eligibility evaluator.
      const repos = ctx.repoIndex();
      const repoName = entry.repoName;
      const repoPath = repoName ? repos[repoName] : null;
      if (repoName && repoPath) {
        maybeFireAutoFix(repoName, repoPath, entry, branch, selfId, log).catch(err =>
          log(`auto-fix: dispatch failed for ${branch}: ${err}`),
        );
      }
```

Wait — the existing `checkAndNotify` doesn't take a `ctx` with `repoIndex`. Look at how it's called from `lib/daemon.ts`:

```typescript
checkAndNotify(cache.entries, portCacheRef.ports, log, getCurrentUserId());
```

We need `repoIndex` in there. Update the signature: extend `checkAndNotify(entries, ports, log, selfId)` to also take `repoIndex: () => RepoIndex`. The callsite in `lib/daemon.ts` passes `loadRepoIndex`.

Find the `checkAndNotify` export signature and update it. The `repoIndex` lookup is then available inside the function body.

- [ ] **Step 4: Update the caller in `lib/daemon.ts`**

In `lib/daemon.ts`, find `checkAndNotify(cache.entries, portCacheRef.ports, log, getCurrentUserId());` and change to:
```typescript
checkAndNotify(cache.entries, portCacheRef.ports, log, getCurrentUserId(), loadRepoIndex);
```

- [ ] **Step 5: Verify daemon compiles**

Run: `bun build lib/daemon.ts --outdir /tmp/rt-build 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 6: Run tests**

Run: `bun test lib/daemon/__tests__ lib/__tests__ 2>&1 | tail -3`
Expected: all green (no regressions to existing tests).

- [ ] **Step 7: Commit**

```bash
git add lib/notifier.ts lib/daemon.ts
git commit -m "feat(auto-fix): fire engine on pipeline-failed transition"
```

---

### Task 12: `lib/daemon/handlers/auto-fix.ts` — IPC handlers

**Files:**
- Create: `lib/daemon/handlers/auto-fix.ts`

- [ ] **Step 1: Create the handler module**

Create `lib/daemon/handlers/auto-fix.ts`:

```typescript
/**
 * Auto-fix IPC handlers — read-only inspection + config get/set.
 *
 *   auto-fix:log:read        — return last N attempts for a repo (default 25)
 *   auto-fix:notes:read      — return notes file content for a branch+sha
 *   auto-fix:status          — { enabled, recentAttempts, lockHolder }
 *   auto-fix:config:get      — current AutoFixConfig
 *   auto-fix:config:set      — partial update (merged with current)
 *
 * Mutating the engine itself (e.g. force-trigger) is deliberately not exposed.
 */

import { loadAutoFixConfig, saveAutoFixConfig, type AutoFixConfig } from "../../auto-fix-config.ts";
import { readLog, readNotes } from "../../auto-fix-log.ts";
import { isLockHeld, autoFixLockPath } from "../../auto-fix-lock.ts";
import { existsSync, readFileSync } from "fs";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createAutoFixHandlers(_ctx: HandlerContext): HandlerMap {
  return {
    "auto-fix:log:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const branch   = payload?.branch   as string | undefined;
      const limit    = (payload?.limit as number) ?? 25;
      if (!repoName) return { ok: false, error: "missing repoName" };
      let log = readLog(repoName);
      if (branch) log = log.filter(e => e.branch === branch);
      log = log.slice(Math.max(0, log.length - limit));
      return { ok: true, data: { entries: log } };
    },

    "auto-fix:notes:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const branch   = payload?.branch   as string | undefined;
      const sha      = payload?.sha      as string | undefined;
      if (!repoName || !branch || !sha) return { ok: false, error: "missing repoName/branch/sha" };
      const body = readNotes(repoName, branch, sha);
      if (body === null) return { ok: false, error: "notes not found" };
      return { ok: true, data: { body } };
    },

    "auto-fix:status": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      if (!repoName) return { ok: false, error: "missing repoName" };
      const cfg = loadAutoFixConfig(repoName);
      const log = readLog(repoName);
      const recent = log.slice(Math.max(0, log.length - 5));
      let lockHolder: any = null;
      if (existsSync(autoFixLockPath(repoName))) {
        try {
          lockHolder = JSON.parse(readFileSync(autoFixLockPath(repoName), "utf8"));
        } catch { /* */ }
      }
      return {
        ok: true,
        data: {
          enabled:        cfg.enabled,
          fileCap:        cfg.fileCap,
          lineCap:        cfg.lineCap,
          recentAttempts: recent,
          lockHeld:       isLockHeld(repoName),
          lockHolder,
        },
      };
    },

    "auto-fix:config:get": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      if (!repoName) return { ok: false, error: "missing repoName" };
      return { ok: true, data: loadAutoFixConfig(repoName) };
    },

    "auto-fix:config:set": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const patch    = payload?.patch    as Partial<AutoFixConfig> | undefined;
      if (!repoName || !patch) return { ok: false, error: "missing repoName/patch" };
      const current = loadAutoFixConfig(repoName);
      const next: AutoFixConfig = { ...current, ...patch };
      saveAutoFixConfig(repoName, next);
      return { ok: true, data: next };
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
bun -e 'import("./lib/daemon/handlers/auto-fix.ts").then(m => console.log(Object.keys(m)))'
```
Expected: `[ "createAutoFixHandlers" ]`

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/handlers/auto-fix.ts
git commit -m "feat(auto-fix): IPC handlers for log/notes/status/config"
```

---

### Task 13: Wire IPC + stale sweep into `lib/daemon.ts`

**Files:**
- Modify: `lib/daemon.ts`

- [ ] **Step 1: Add imports**

Search for `import { createDopplerHandlers }` and add right after it:

```typescript
import { createAutoFixHandlers } from "./daemon/handlers/auto-fix.ts";
import { sweepStaleArtifacts as sweepAutoFixArtifacts } from "./daemon/auto-fix.ts";
```

- [ ] **Step 2: Wire handlers**

In the `routedHandlers` object (search for `...createDopplerHandlers(handlerCtx),`), add:

```typescript
  ...createAutoFixHandlers(handlerCtx),
```

- [ ] **Step 3: Call stale sweep on startup**

Search for `refreshWatchedRepos();` (this is in the daemon's startup sequence, around line 887). Add immediately after it:

```typescript
  // Auto-fix: sweep any leftover ephemeral worktrees from a previous daemon
  // process. Cheap (file stats only) and bounded.
  try {
    sweepAutoFixArtifacts(loadRepoIndex, log);
  } catch (err) {
    log(`auto-fix: stale-sweep failed: ${err}`);
  }
```

- [ ] **Step 4: Verify daemon compiles**

Run: `bun build lib/daemon.ts --outdir /tmp/rt-build 2>&1 | tail -3`
Expected: succeeds.

- [ ] **Step 5: Run all tests**

Run: `bun test lib/daemon/__tests__ lib/__tests__ 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon.ts
git commit -m "feat(auto-fix): wire IPC handlers + startup stale-sweep"
```

---

### Task 14: `commands/auto-fix.ts` — CLI commands

**Files:**
- Create: `commands/auto-fix.ts`

- [ ] **Step 1: Create the file with all subcommands**

Create `commands/auto-fix.ts`:

```typescript
#!/usr/bin/env bun

/**
 * rt auto-fix — inspect and configure the daemon's auto-fix engine.
 *
 * Usage:
 *   rt auto-fix enable | disable   → toggle per-repo auto-fix
 *   rt auto-fix log [<branch>]      → recent attempts (date, branch, sha, outcome, duration)
 *   rt auto-fix notes <branch>      → most recent notes file for a branch
 *   rt auto-fix status              → enabled? recent attempts? lock holder?
 */

import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadAutoFixConfig, saveAutoFixConfig, autoFixConfigPath,
} from "../lib/auto-fix-config.ts";
import {
  readLog, readNotes, autoFixLogPath,
  type AutoFixLogEntry,
} from "../lib/auto-fix-log.ts";
import { isLockHeld, autoFixLockPath } from "../lib/auto-fix-lock.ts";
import { existsSync, readFileSync } from "fs";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── enable / disable ────────────────────────────────────────────────────────

export async function enableCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  if (cfg.enabled) {
    console.log(`\n  ${dim}auto-fix already enabled for${reset} ${bold}${repoName}${reset}\n`);
    return;
  }
  saveAutoFixConfig(repoName, { ...cfg, enabled: true });
  console.log(`\n  ${green}✓${reset} auto-fix ${green}enabled${reset} for ${bold}${repoName}${reset}`);
  console.log(`    ${dim}config: ${autoFixConfigPath(repoName)}${reset}\n`);
}

export async function disableCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  if (!cfg.enabled) {
    console.log(`\n  ${dim}auto-fix already disabled for${reset} ${bold}${repoName}${reset}\n`);
    return;
  }
  saveAutoFixConfig(repoName, { ...cfg, enabled: false });
  console.log(`\n  ${yellow}○${reset} auto-fix ${yellow}disabled${reset} for ${bold}${repoName}${reset}\n`);
}

// ─── log ────────────────────────────────────────────────────────────────────

export async function logCommand(args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const branchFilter = args[0];
  let entries = readLog(repoName);
  if (branchFilter) entries = entries.filter(e => e.branch === branchFilter);

  if (entries.length === 0) {
    console.log(`\n  ${dim}no auto-fix attempts${branchFilter ? ` for ${branchFilter}` : ""} yet${reset}`);
    console.log(`  ${dim}log file: ${autoFixLogPath(repoName)}${reset}\n`);
    return;
  }

  const widestBranch = Math.max(...entries.map(e => e.branch.length));
  console.log(`\n  ${bold}${cyan}rt auto-fix log${reset} ${dim}(${repoName})${reset}\n`);
  for (const e of entries) {
    const when = new Date(e.attemptedAt).toISOString().replace("T", " ").slice(0, 19);
    const icon = outcomeIcon(e.outcome);
    const sha = e.sha.slice(0, 8);
    console.log(`  ${dim}${when}${reset}  ${icon}  ${e.branch.padEnd(widestBranch)}  ${dim}${sha}${reset}  ${formatOutcome(e)}`);
  }
  console.log("");
}

function outcomeIcon(outcome: AutoFixLogEntry["outcome"]): string {
  if (outcome === "fixed")         return `${green}✓${reset}`;
  if (outcome === "skipped")       return `${dim}—${reset}`;
  if (outcome === "rejected_diff") return `${yellow}~${reset}`;
  return `${red}✗${reset}`;
}

function formatOutcome(e: AutoFixLogEntry): string {
  const dur = `${dim}(${Math.round(e.durationMs / 1000)}s)${reset}`;
  if (e.outcome === "fixed")
    return `${green}fixed${reset} ${e.commitSha?.slice(0, 8) ?? ""} ${dur}  ${e.reason ?? ""}`;
  if (e.outcome === "skipped")
    return `${dim}skipped${reset} ${dur}  ${e.reason ?? ""}`;
  if (e.outcome === "rejected_diff")
    return `${yellow}rejected${reset} ${dur}  ${e.reason ?? ""}`;
  return `${red}error${reset} ${dur}  ${e.reason ?? ""}`;
}

// ─── notes ──────────────────────────────────────────────────────────────────

export async function notesCommand(args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const branch = args[0];
  if (!branch) {
    console.log(`\n  ${red}usage: rt auto-fix notes <branch>${reset}\n`);
    process.exit(1);
  }

  // Find the most recent attempt for this branch with a notes file.
  const entries = readLog(repoName).filter(e => e.branch === branch);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const body = readNotes(repoName, e.branch, e.sha);
    if (body !== null) {
      console.log(`\n  ${bold}${cyan}rt auto-fix notes${reset} ${dim}(${branch} @ ${e.sha.slice(0, 8)})${reset}\n`);
      console.log(body);
      return;
    }
  }
  console.log(`\n  ${dim}no notes for${reset} ${bold}${branch}${reset}\n`);
}

// ─── status ─────────────────────────────────────────────────────────────────

export async function statusCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  const recentEntries = readLog(repoName).slice(-5);
  const locked = isLockHeld(repoName);

  console.log(`\n  ${bold}${cyan}rt auto-fix status${reset} ${dim}(${repoName})${reset}\n`);
  console.log(`    ${cfg.enabled ? `${green}●${reset}` : `${dim}○${reset}`} auto-fix ${cfg.enabled ? `${green}enabled${reset}` : `${dim}disabled${reset}`}`);
  console.log(`    ${dim}caps: ≤${cfg.fileCap} files, ≤${cfg.lineCap} lines${reset}`);
  if (cfg.allowTestFixes) console.log(`    ${dim}test failures: in scope${reset}`);
  if (cfg.additionalDenylist.length > 0) {
    console.log(`    ${dim}additional denylist: ${cfg.additionalDenylist.join(", ")}${reset}`);
  }
  if (locked) {
    try {
      const body = JSON.parse(readFileSync(autoFixLockPath(repoName), "utf8"));
      console.log(`    ${yellow}⚙${reset}  ${yellow}fix in flight${reset}: ${body.branch}@${String(body.sha).slice(0, 8)} (pid ${body.pid})`);
    } catch {
      console.log(`    ${yellow}⚙${reset}  fix in flight (lock file unreadable)`);
    }
  }
  console.log("");

  if (recentEntries.length === 0) {
    console.log(`  ${dim}no recent attempts${reset}\n`);
    return;
  }
  console.log(`  ${bold}recent attempts:${reset}`);
  const widestBranch = Math.max(...recentEntries.map(e => e.branch.length));
  for (const e of recentEntries) {
    const when = new Date(e.attemptedAt).toISOString().replace("T", " ").slice(0, 19);
    console.log(`    ${dim}${when}${reset}  ${outcomeIcon(e.outcome)}  ${e.branch.padEnd(widestBranch)}  ${formatOutcome(e)}`);
  }
  console.log("");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun cli.ts --help 2>&1 | head -3`
Expected: no TS errors. (`auto-fix` won't show up until Task 15 wires cli.ts.)

- [ ] **Step 3: Commit**

```bash
git add commands/auto-fix.ts
git commit -m "feat(auto-fix): rt auto-fix enable/disable/log/notes/status"
```

---

### Task 15: Wire `auto-fix` subcommand tree into `cli.ts`

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add the `auto-fix` block**

In `cli.ts`, search for the `doppler` block (already in the tree). Insert this `auto-fix` block immediately after it:

```typescript
  "auto-fix": {
    description: "Auto-fix pipeline failures on approved MRs (daemon-driven; this command is read-only inspection + per-repo toggle)",
    subcommands: {
      enable: {
        description: "Enable auto-fix for this repo",
        module: "./commands/auto-fix.ts",
        fn: "enableCommand",
        context: "repo",
      },
      disable: {
        description: "Disable auto-fix for this repo",
        module: "./commands/auto-fix.ts",
        fn: "disableCommand",
        context: "repo",
      },
      log: {
        description: "Show recent auto-fix attempts",
        module: "./commands/auto-fix.ts",
        fn: "logCommand",
        context: "repo",
      },
      notes: {
        description: "Print the most recent notes file for a branch",
        module: "./commands/auto-fix.ts",
        fn: "notesCommand",
        context: "repo",
      },
      status: {
        description: "Show enabled flag, caps, recent attempts, lock holder",
        module: "./commands/auto-fix.ts",
        fn: "statusCommand",
        context: "repo",
      },
    },
  },
```

- [ ] **Step 2: Verify the command tree**

Run: `bun cli.ts auto-fix 2>&1 | head -5`
Expected: lists `enable`, `disable`, `log`, `notes`, `status` as available subcommands.

- [ ] **Step 3: Commit**

```bash
git add cli.ts
git commit -m "feat(auto-fix): wire rt auto-fix subcommand tree"
```

---

### Task 16: Add an integration smoke test for the orchestrator

The fully-wired engine is hard to unit-test (it spawns subprocesses + does git ops). Add a single integration test that exercises the orchestrator's eligibility short-circuit path — the smallest path that touches the orchestrator end-to-end without spawning the agent.

**Files:**
- Create: `lib/daemon/__tests__/auto-fix-orchestrator.test.ts`

- [ ] **Step 1: Write the integration test**

Create `lib/daemon/__tests__/auto-fix-orchestrator.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-orch-"));
process.env.HOME = tmpHome;

const { runAutoFix } = await import("../auto-fix.ts");

const REPO = "test-repo";

afterEach(() => {
  try { rmSync(join(tmpHome, ".rt", REPO), { recursive: true, force: true }); } catch { /* */ }
});

describe("runAutoFix (orchestrator) — eligibility short-circuit", () => {
  function baseCtx() {
    const lines: string[] = [];
    return {
      lines,
      ctx: {
        repoName: REPO,
        repoPath: "/nonexistent",  // never reached because eligibility fails first
        branch:   "feat/x",
        sha:      "deadbeef",
        target:   "main",
        mr: {
          authorIsMe:            true,
          status:                "opened",
          isApproved:            true,
          changesRequested:      false,
          pipelineStatus:        "failed",
          pipelineSha:           "deadbeef",
          flakeRetriedAndPassed: false,
        },
        jobLogs:    [],
        gitContext: { commits: "", changedFiles: "", diffStat: "", diff: "" },
        log:        (m: string) => { lines.push(m); },
      },
    };
  }

  test("returns ineligible when MR is not authored by me", async () => {
    const { ctx } = baseCtx();
    ctx.mr.authorIsMe = false;
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
    if (result.kind === "ineligible") {
      expect(result.reason).toContain("author");
    }
  });

  test("returns ineligible when pipeline is running, not failed", async () => {
    const { ctx } = baseCtx();
    ctx.mr.pipelineStatus = "running";
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
  });

  test("returns ineligible when MR is a draft", async () => {
    const { ctx } = baseCtx();
    ctx.mr.status = "draft";
    const result = await runAutoFix(ctx);
    expect(result.kind).toBe("ineligible");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test lib/daemon/__tests__/auto-fix-orchestrator.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `bun test lib/daemon/__tests__ lib/__tests__ 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add lib/daemon/__tests__/auto-fix-orchestrator.test.ts
git commit -m "test(auto-fix): integration test for orchestrator eligibility paths"
```

---

### Task 17: Manual end-to-end verification

This task does no code changes — verify the wired feature works against a real failing MR (or a contrived setup).

**Files:** none.

- [ ] **Step 1: Confirm daemon picks up the new code**

```bash
bun run cli.ts daemon restart
sleep 5
bun run cli.ts daemon status
```

Expected: daemon running with the fresh build.

- [ ] **Step 2: Smoke-check IPC**

```bash
curl --unix-socket ~/.rt/rt.sock -X POST http://localhost/auto-fix:status \
  -H "Content-Type: application/json" -d '{"repoName":"<some-repo>"}'
```

Expected: `{"ok":true,"data":{"enabled":true,"fileCap":5,"lineCap":200,"recentAttempts":[],"lockHeld":false,"lockHolder":null}}`

- [ ] **Step 3: Smoke-check the CLI**

```bash
cd <some-repo-dir>
bun run cli.ts auto-fix status
bun run cli.ts auto-fix log
bun run cli.ts auto-fix disable
bun run cli.ts auto-fix enable
```

Each should run without errors and produce the expected output.

- [ ] **Step 4: Find a failing MR (or create one) for end-to-end**

If a real failing MR is available on an approved branch you own:
- Watch the daemon log: `tail -f ~/.rt/daemon.log`
- Wait for the next cache refresh (≤5 min) or trigger one: `curl --unix-socket ~/.rt/rt.sock -X POST http://localhost/api/refresh`
- Look for `auto-fix:` log lines and the spawned worktree under `~/.rt/<repo>/auto-fix-worktrees/`.

If no real failing MR is at hand, the orchestrator unit + integration tests already cover the gates; the actual subprocess flow can be exercised post-deploy.

- [ ] **Step 5: Final commit**

```bash
git commit --allow-empty -m "chore(auto-fix): end-to-end verified"
```

---

## Self-Review Checklist (run before claiming done)

- [ ] Every spec section in `2026-04-30-auto-fix-pipeline-design.md` has at least one task implementing it. (Trigger, 5 gates, ephemeral worktree provisioning + Doppler integration + setup commands, agent invocation with prompt + RESULT parsing, validation + commit/push, persistence files, CLI surface, notification keys, IPC handlers, stale sweep.)
- [ ] No "TBD" / "TODO" / placeholder text in any task's code blocks.
- [ ] Type names + signatures are consistent across tasks (`AutoFixConfig`, `AutoFixLogEntry`, `MrSnapshot`, `AutoFixContext`, `AutoFixOutcome`, `JobLog`, `GitContext`, `ValidationResult`).
- [ ] All tests use `mkdtempSync` + `process.env.HOME = tmpHome` BEFORE importing modules.
- [ ] Each TDD task: write test → run-fail → implement → run-pass → commit.
- [ ] Manual smoke test (Task 17) is executed end-to-end before declaring shipped.
