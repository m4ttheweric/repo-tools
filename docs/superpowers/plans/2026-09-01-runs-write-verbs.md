# rt runs write verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pipeline run DB's write side from `pipeline-state.sh` (mattstack-skills) into rt as `rt runs <subcommand>` verbs, so stage skills record state through a bare `rt` word the Claude Code worktree guard accepts.

**Architecture:** A new `lib/runs/write.ts` owns the run DB schema, migration, and every mutating operation as plain functions over an open `bun:sqlite` `Database`. Small sibling modules handle pack provenance, identity fields, and best-effort event emission. A new `commands/runs-write.ts` does argument parsing, `RT_RUN_DB` resolution, and JSON printing, registered under the existing `rt runs` family. The daemon's `abandon` path moves onto the same write module. mattstack-skills then deletes the script and renames every call site.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun:test`. Two repos: rt (`repo-tools`, worktree `~/.mattstack/rt/worktrees/gh-m4ttstack-rt/joyful-feather`, branch `runs-write-verbs`) and mattstack-skills (`~/Documents/GitHub/mattstack-skills`, main, no PR needed per Matt).

**Spec:** `docs/superpowers/specs/2026-09-01-runs-write-verbs-design.md` (same worktree). Read it first; the plan argues from it.

## Global Constraints

- Command contract v2 is preserved verbatim: same subcommand names, flags, JSON shapes, and exit codes (0 ok, 1 sqlite failure, 2 usage or environment, 3 not found) as `pipeline-state.sh`. New: zero-row `stage-done`/`stage-fail` is exit 3; a non-JSON `--selection` is exit 2; a value flag with no following token is exit 2.
- Every subcommand except `run-start` reads `RT_RUN_DB`. `RT_RUNS_ROOT` overrides the runs root. `RT_RUN_EMIT=0` disables emission.
- Output is JSON on stdout for every outcome of every subcommand except `field get` (raw value, or nothing on exit 3). No stack traces.
- SQL values are bound as parameters, never interpolated.
- Emission uses `daemonSocketQuery` with a 1000 ms timeout, awaited, result ignored. Never `daemonQuery`.
- `busy_timeout=5000` on every open for writing. `journal_mode=WAL` on create.
- Schema version constant lives in `lib/runs/write.ts` as `KNOWN_SCHEMA_VERSION = 2`; `store.ts` re-exports it.
- Comments follow the clean-code rule: only constraints the code cannot show. No narration, no decision history.
- No em dashes anywhere (code, comments, commit messages).
- Commit after every task with the message given; end each commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run rt tests as `bun test <path>` from the worktree root. The suite preloads `test-setup.ts`, which fakes `HOME`, so `DAEMON_SOCK_PATH` and `runsRoot()` never touch the real machine.
- Rollout order is fixed: rt merges and releases before the mattstack-skills bump (Tasks 11 and 12) is promoted. Task 11's commit may land on mattstack-skills main, but the plugin bump and pack recompile wait for the rt release.

---

## File map

rt (worktree `joyful-feather`):

- Create `lib/runs/write.ts`: schema SQL, `createRunDb`, `openRunDb`, `migrate`, `KNOWN_SCHEMA_VERSION`, and the mutations `runStart`, `runStatus`, `stageStart`, `stageEnd`, `fieldSet`, `fieldGet`, `decisionRecord`, `snapshot`, plus the `Ok`/`Fail` result types.
- Create `lib/runs/paths.ts`: `runsRoot()` and `isPathComponent()`, moved out of `store.ts` so the read and write modules share them without a cycle; `store.ts` re-exports both.
- Create `lib/runs/provenance.ts`: `packProvenance(dirs)` and `composePackCommits(...)`.
- Create `lib/runs/identity.ts`: `recordIdentity(db, env, now)`.
- Create `lib/runs/emit.ts`: `emitRunUpdated(update, env, timeoutMs)`.
- Modify `lib/runs/store.ts`: import `KNOWN_SCHEMA_VERSION` from `write.ts` and re-export it; rewrite the header comment.
- Modify `lib/runs/reconcile.ts`: `abandonRun` uses `openRunDb`, `runStatus`, `fieldSet`; rewrite the header comment.
- Create `commands/runs-write.ts`: parsing, `runWriteVerb(sub, args, env)`, exported command functions.
- Modify `commands/runs.ts`: `runsList` rejects positionals with exit 2; rewrite the header comment.
- Modify `lib/command-tree-def.ts`: register the nine write verbs under `runsSubcommands`; drop "read-only" from the `runs` description.
- Create `lib/runs/__tests__/write.test.ts`, `lib/runs/__tests__/provenance.test.ts`, `lib/runs/__tests__/identity.test.ts`, `lib/runs/__tests__/emit.test.ts`, `commands/__tests__/runs-write.test.ts`.

mattstack-skills (main):

- Delete `attachments/pipeline/work/scripts/pipeline-state.sh`, `attachments/pipeline/work/scripts/tests/pipeline-state-run-start.test.sh`, `tests/pipeline-state.test.ts`.
- Modify `attachments/pipeline/work/SKILL.md`, the eight `attachments/pipeline/stage-*/SKILL.md`, `attachments/parameterized-skills/references/convention.md`, `README.md`, `.claude-plugin/plugin.json`.

---

### Task 1: Schema, create, open, migrate

**Files:**
- Create: `lib/runs/write.ts`
- Modify: `lib/runs/store.ts:1-13` (header comment and the constant)
- Test: `lib/runs/__tests__/write.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `KNOWN_SCHEMA_VERSION: 2`; `createRunDb(path: string): Database`; `openRunDb(path: string): Database`; `migrate(db: Database): void`; `type Fail = { ok: false; error: string; code: 1 | 2 | 3 }`; `type Ok<T extends object = {}> = { ok: true } & T`; and from `paths.ts`, `runsRoot(): string` and `isPathComponent(s: string): boolean`. Later tasks add mutations to `write.ts` (see Task 4's execution note: `runStart` itself ended up in a new `lib/runs/start.ts`, off the daemon's import graph).

- [ ] **Step 1: Write the failing tests**

Create `lib/runs/__tests__/write.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunDb, KNOWN_SCHEMA_VERSION, migrate, openRunDb } from "../write.ts";
import { seedRun } from "./fixtures.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rt-runs-write-"));
}

function cols(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

describe("createRunDb", () => {
  test("creates the four tables, WAL mode, and stamps the current schema version", () => {
    const path = join(tmp(), "r", "20260901-000000-abcd-1", "state.db");
    const db = createRunDb(path);
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toEqual(["decisions", "fields", "runs", "stages"]);
      expect(userVersion(db)).toBe(KNOWN_SCHEMA_VERSION);
      expect(cols(db, "stages")).toContain("reason");
      expect(cols(db, "runs")).toContain("pack_dirty");
      const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      expect(mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  test("brings a v1 DB to v2 in place and is idempotent", () => {
    const root = tmp();
    seedRun(root, "r", "20260901-000000-abcd-1", 1000, 1);
    const path = join(root, "r", "20260901-000000-abcd-1", "state.db");
    const db = openRunDb(path);
    try {
      expect(userVersion(db)).toBe(2);
      expect(cols(db, "stages")).toContain("detail_path");
      expect(cols(db, "runs")).toContain("pack_commits");
      migrate(db);
      expect(userVersion(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("openRunDb sets busy_timeout", () => {
    const path = join(tmp(), "r", "x", "state.db");
    createRunDb(path).close();
    const db = openRunDb(path);
    try {
      const t = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      expect(t).toBe(5000);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: FAIL, "Cannot find module '../write.ts'".

- [ ] **Step 3: Write the module**

Create `lib/runs/write.ts`:

```ts
/**
 * The run DB's write side: schema, migration, and every mutation the
 * pipeline records. Functions take an open Database and plain arguments and
 * return what the CLI prints, so commands/runs-write.ts stays parsing and
 * printing only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const KNOWN_SCHEMA_VERSION = 2;

export type Fail = { ok: false; error: string; code: 1 | 2 | 3 };
export type Ok<T extends object = {}> = { ok: true } & T;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
  pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
  spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  pack_commits TEXT, pack_dirty INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stages (
  run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER, ended_at INTEGER, reason TEXT, detail_path TEXT,
  PRIMARY KEY (run_id, name, attempt));
CREATE TABLE IF NOT EXISTS fields (
  run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL,
  value TEXT NOT NULL, produced_by TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, key));
CREATE TABLE IF NOT EXISTS decisions (
  run_id TEXT NOT NULL REFERENCES runs(id), contract TEXT NOT NULL,
  scope TEXT NOT NULL, selection TEXT NOT NULL, decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL, PRIMARY KEY (run_id, contract, scope));
`;

function columns(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
}

// Each ALTER is independently tolerant so a half-applied migration from an
// interrupted call converges on the next one. The version is stamped only
// once the columns are really there: an ALTER that failed for any reason
// other than duplicate-column must not leave a stamped DB that never
// migrated.
export function migrate(db: Database): void {
  const have = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (have >= KNOWN_SCHEMA_VERSION) return;
  const add = (table: string, col: string, decl: string) => {
    if (!columns(db, table).includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add("stages", "reason", "TEXT");
  add("stages", "detail_path", "TEXT");
  add("runs", "pack_commits", "TEXT");
  add("runs", "pack_dirty", "INTEGER DEFAULT 0");
  if (columns(db, "stages").includes("reason") && columns(db, "runs").includes("pack_commits")) {
    db.run(`PRAGMA user_version=${KNOWN_SCHEMA_VERSION}`);
  }
}

export function createRunDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

export function openRunDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}
```

Then create `lib/runs/paths.ts` so `write.ts` and `store.ts` share the path helpers without importing each other:

```ts
import { homedir } from "os";
import { join } from "path";

export function runsRoot(): string {
  return process.env.RT_RUNS_ROOT ?? join(homedir(), ".mattstack", "runs");
}

// repo/runId reach a path join straight from a network-reachable readonly
// seam (runs:get via REST decodes %2F): reject anything that could step
// outside <runsRoot>/<repo>/<runId> before it ever hits the filesystem.
export function isPathComponent(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");
}
```

Then in `lib/runs/store.ts` replace lines 1-32 (the header comment through the end of `isPathComponent`) with:

```ts
/**
 * The run DB's read side. Every open here is readonly and per-call, no held
 * connections, so a run dir can be pruned under us. Writes live in write.ts.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, type Dirent } from "fs";
import { join } from "path";
import type { Attention, RunDetail, RunFieldRow, RunStageRow, RunSummary } from "../../packages/rt-client/src/commands.ts";
import { computeAttention, fieldValue, lastEventAt, type RunLiveness } from "./attention.ts";
import { isPathComponent, runsRoot } from "./paths.ts";
import { KNOWN_SCHEMA_VERSION } from "./write.ts";

export { isPathComponent, KNOWN_SCHEMA_VERSION, runsRoot };

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d: Dirent) => d.isDirectory()).map((d: Dirent) => d.name);
  } catch {
    return [];
  }
}
```

Existing importers of `runsRoot` and `isPathComponent` from `store.ts` keep working through the re-export.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/write.test.ts lib/runs/__tests__/store.test.ts`
Expected: all PASS (store tests still green after the re-export).

- [ ] **Step 5: Commit**

```bash
git add lib/runs/write.ts lib/runs/paths.ts lib/runs/store.ts lib/runs/__tests__/write.test.ts
git commit -m "runs: write.ts owns the run DB schema and migration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pack provenance

**Files:**
- Create: `lib/runs/provenance.ts`
- Test: `lib/runs/__tests__/provenance.test.ts`

**Interfaces:**
- Produces: `type PackProvenance = { dirty: 0 | 1; commits: string[] }`; `packProvenance(dirs: string[]): PackProvenance`; `composePackCommits(p: PackProvenance, mattstackSha?: string, packSha?: string): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `lib/runs/__tests__/provenance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composePackCommits, packProvenance } from "../provenance.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rt-prov-${name}-`));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("packProvenance", () => {
  test("records basename=shortsha per git dir and is clean when nothing changed", () => {
    const dir = repo("clean");
    const sha = git(dir, "rev-parse", "--short", "HEAD");
    const p = packProvenance([dir]);
    expect(p.dirty).toBe(0);
    expect(p.commits).toEqual([`${dir.split("/").pop()}=${sha}`]);
  });

  test("an unstaged change marks the run dirty", () => {
    const dir = repo("unstaged");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("a staged but uncommitted change marks the run dirty", () => {
    const dir = repo("staged");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    git(dir, "add", "a.txt");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("an untracked file marks the run dirty", () => {
    const dir = repo("untracked");
    writeFileSync(join(dir, "new.txt"), "x\n");
    expect(packProvenance([dir]).dirty).toBe(1);
  });

  test("a directory that is not a git checkout contributes nothing and never sets dirty", () => {
    const plain = mkdtempSync(join(tmpdir(), "rt-prov-plain-"));
    writeFileSync(join(plain, "junk.txt"), "x\n");
    const p = packProvenance([plain, ""]);
    expect(p).toEqual({ dirty: 0, commits: [] });
  });
});

describe("composePackCommits", () => {
  test("orders dir entries, then mattstack, then the raw pack sha; empty is null", () => {
    expect(composePackCommits({ dirty: 0, commits: ["acme=abc1234"] }, "deadbee", "other=fff0000")).toBe("acme=abc1234,mattstack=deadbee,other=fff0000");
    expect(composePackCommits({ dirty: 0, commits: [] }, "deadbee")).toBe("mattstack=deadbee");
    expect(composePackCommits({ dirty: 0, commits: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/provenance.test.ts`
Expected: FAIL, "Cannot find module '../provenance.ts'".

- [ ] **Step 3: Write the module**

Create `lib/runs/provenance.ts`:

```ts
import { basename } from "path";

export type PackProvenance = { dirty: 0 | 1; commits: string[] };

function gitOut(dir: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

// A directory that is not a git checkout records nothing: unknown provenance
// must read as absent, never as a guess. `status --porcelain` covers
// unstaged, staged, and untracked in one call; `diff --quiet` alone would
// miss the last two.
export function packProvenance(dirs: string[]): PackProvenance {
  let dirty: 0 | 1 = 0;
  const commits: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const sha = gitOut(dir, ["rev-parse", "--short", "HEAD"]);
    if (sha === null) continue;
    commits.push(`${basename(dir)}=${sha}`);
    const status = gitOut(dir, ["status", "--porcelain"]);
    if (status !== null && status !== "") dirty = 1;
  }
  return { dirty, commits };
}

export function composePackCommits(p: PackProvenance, mattstackSha?: string, packSha?: string): string | null {
  const parts = [...p.commits];
  if (mattstackSha) parts.push(`mattstack=${mattstackSha}`);
  if (packSha) parts.push(packSha);
  return parts.length > 0 ? parts.join(",") : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/provenance.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/provenance.ts lib/runs/__tests__/provenance.test.ts
git commit -m "runs: pack provenance capture for run-start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Identity fields

**Files:**
- Create: `lib/runs/identity.ts`
- Test: `lib/runs/__tests__/identity.test.ts`

**Interfaces:**
- Consumes: `createRunDb` from Task 1.
- Produces: `recordIdentity(db: Database, env: NodeJS.ProcessEnv, now: number): void`.

- [ ] **Step 1: Write the failing tests**

Create `lib/runs/__tests__/identity.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recordIdentity } from "../identity.ts";
import { createRunDb } from "../write.ts";

function dbWithRun(): Database {
  const db = createRunDb(join(mkdtempSync(join(tmpdir(), "rt-ident-")), "state.db"));
  db.run("INSERT INTO runs (id, repo, work_type, pipeline, status, started_at) VALUES ('r1', 'demo', 'fix', 'default', 'running', 1)");
  return db;
}

function field(db: Database, key: string): { value: string; produced_by: string; at: number } | undefined {
  return db.query("SELECT value, produced_by, at FROM fields WHERE key=?").get(key) as any;
}

describe("recordIdentity", () => {
  test("records claude-session and herdr-pane from env under producer run", () => {
    const db = dbWithRun();
    recordIdentity(db, { CLAUDE_CODE_SESSION_ID: "sess-1", HERDR_PANE_ID: "w1:p2" }, 100);
    expect(field(db, "claude-session")).toEqual({ value: "sess-1", produced_by: "run", at: 100 });
    expect(field(db, "herdr-pane")).toEqual({ value: "w1:p2", produced_by: "run", at: 100 });
    db.close();
  });

  test("refreshes a changed value but never bumps at for an unchanged one", () => {
    const db = dbWithRun();
    recordIdentity(db, { CLAUDE_CODE_SESSION_ID: "sess-1", HERDR_PANE_ID: "w1:p2" }, 100);
    recordIdentity(db, { CLAUDE_CODE_SESSION_ID: "sess-1", HERDR_PANE_ID: "w1:p9" }, 200);
    expect(field(db, "claude-session")!.at).toBe(100);
    expect(field(db, "herdr-pane")).toEqual({ value: "w1:p9", produced_by: "run", at: 200 });
    db.close();
  });

  test("absent env vars record nothing", () => {
    const db = dbWithRun();
    recordIdentity(db, {}, 100);
    expect(db.query("SELECT COUNT(*) AS n FROM fields").get()).toEqual({ n: 0 });
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/identity.test.ts`
Expected: FAIL, "Cannot find module '../identity.ts'".

- [ ] **Step 3: Write the module**

Create `lib/runs/identity.ts`:

```ts
import type { Database } from "bun:sqlite";

// Change-guarded: rt's liveness ladder reads fields.at as pipeline activity,
// so an unchanged session or pane must not look like a fresh event.
export function recordIdentity(db: Database, env: NodeJS.ProcessEnv, now: number): void {
  const pairs: [string, string | undefined][] = [
    ["claude-session", env.CLAUDE_CODE_SESSION_ID],
    ["herdr-pane", env.HERDR_PANE_ID],
  ];
  for (const [key, value] of pairs) {
    if (!value) continue;
    const current = db.query("SELECT value FROM fields WHERE key=?").get(key) as { value: string } | undefined;
    if (current?.value === value) continue;
    db.run(
      "INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) SELECT id, ?, ?, 'run', ? FROM runs",
      [key, value, now],
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/identity.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/identity.ts lib/runs/__tests__/identity.test.ts
git commit -m "runs: change-guarded identity fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: run-start and run-status

**Execution note:** during execution, `runStart` moved to a new `lib/runs/start.ts` instead of `write.ts` as drafted below, because the daemon's import graph reaches `write.ts` (through `store.ts` and `reconcile.ts`) and must never reach a synchronous spawn; `runStart` shells out to git for pack provenance. `commands/runs-write.ts` is the only importer of `start.ts`. The interfaces and test bodies below are otherwise unchanged; read `runStart`'s location as `lib/runs/start.ts`.

**Files:**
- Modify: `lib/runs/write.ts` (append)
- Test: `lib/runs/__tests__/write.test.ts` (append)

**Interfaces:**
- Consumes: `packProvenance`, `composePackCommits` (Task 2); `recordIdentity` (Task 3); `isPathComponent` from `paths.ts` (Task 1).
- Produces:

```ts
export type RunStartOpts = {
  repo: string; workType: string; pipeline: string;
  runId?: string; spawnedBy?: string; packDirs?: string[]; ticket?: string;
  mattstackSha?: string; mattstackDirty?: boolean; packSha?: string;
  env?: NodeJS.ProcessEnv; now?: number;
};
export function runStart(root: string, o: RunStartOpts): Ok<{ runId: string; runDb: string }> | Fail;
export function runStatus(db: Database, status: string, now?: number): Ok | Fail;
```

- [ ] **Step 1: Write the failing tests**

Append to `lib/runs/__tests__/write.test.ts` (add `runStart`, `runStatus`, `snapshot` to the import from `../write.ts` when they exist; for now import `runStart` and `runStatus`):

```ts
describe("runStart", () => {
  test("creates the DB under root/repo/runId, records ticket under producer work, stamps v2", () => {
    const root = tmp();
    const r = runStart(root, { repo: "demo", workType: "feature", pipeline: "default", spawnedBy: "test", ticket: "ABC-1", env: {}, now: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runDb).toBe(join(root, "demo", r.runId, "state.db"));
    const db = new Database(r.runDb, { readonly: true });
    const run = db.query("SELECT * FROM runs").get() as Record<string, unknown>;
    expect(run).toMatchObject({ id: r.runId, repo: "demo", work_type: "feature", pipeline: "default", status: "running", spawned_by: "test", started_at: 5000, pack_commits: null, pack_dirty: 0 });
    expect(db.query("SELECT value, produced_by FROM fields WHERE key='ticket'").get()).toEqual({ value: "ABC-1", produced_by: "work" });
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test("generates a run id of the form YYYYMMDD-HHMMSS-xxxx-pid when none is given", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runId).toMatch(new RegExp(`^\\d{8}-\\d{6}-[0-9a-f]{4}-${process.pid}$`));
  });

  test("no ticket flag writes no ticket field", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM fields WHERE key='ticket'").get()).toEqual({ n: 0 });
    db.close();
  });

  test("mattstack sha and dirty flag and raw pack sha land in pack_commits and pack_dirty in order", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", mattstackSha: "deadbee", mattstackDirty: true, packSha: "acme=abc1234", packDirs: [""], env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT pack_commits, pack_dirty FROM runs").get()).toEqual({ pack_commits: "mattstack=deadbee,acme=abc1234", pack_dirty: 1 });
    db.close();
  });

  test("a duplicate run id is exit 1; a v1 directory is migrated first", () => {
    const root = tmp();
    seedRun(root, "demo", "20260901-000000-abcd-1", 1000, 1);
    const dup = runStart(root, { repo: "demo", workType: "fix", pipeline: "default", runId: "20260901-000000-abcd-1", env: {} });
    expect(dup).toMatchObject({ ok: false, code: 1 });
    const db = new Database(join(root, "demo", "20260901-000000-abcd-1", "state.db"), { readonly: true });
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test("a repo that is not a plain path component is exit 2", () => {
    expect(runStart(tmp(), { repo: "../x", workType: "fix", pipeline: "default", env: {} })).toMatchObject({ ok: false, code: 2 });
  });

  test("records identity from env", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: { CLAUDE_CODE_SESSION_ID: "s1", HERDR_PANE_ID: "w1:p1" } });
    if (!r.ok) throw new Error(r.error);
    const db = new Database(r.runDb, { readonly: true });
    expect(db.query("SELECT value FROM fields WHERE key='claude-session'").get()).toEqual({ value: "s1" });
    expect(db.query("SELECT produced_by FROM fields WHERE key='herdr-pane'").get()).toEqual({ produced_by: "run" });
    db.close();
  });
});

describe("runStatus", () => {
  test("closes the run with the given status; anything else is exit 2", () => {
    const r = runStart(tmp(), { repo: "demo", workType: "fix", pipeline: "default", env: {} });
    if (!r.ok) throw new Error(r.error);
    const db = openRunDb(r.runDb);
    expect(runStatus(db, "done", 9000)).toEqual({ ok: true });
    expect(db.query("SELECT status, ended_at FROM runs").get()).toEqual({ status: "done", ended_at: 9000 });
    expect(runStatus(db, "paused")).toMatchObject({ ok: false, code: 2 });
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: FAIL, `runStart` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/runs/write.ts` (add `import { join } from "path";`, `import { isPathComponent } from "./paths.ts";`, `import { composePackCommits, packProvenance } from "./provenance.ts";`, `import { recordIdentity } from "./identity.ts";` at the top; never import from `store.ts` here, it imports this file):

```ts
export type RunStartOpts = {
  repo: string; workType: string; pipeline: string;
  runId?: string; spawnedBy?: string; packDirs?: string[]; ticket?: string;
  mattstackSha?: string; mattstackDirty?: boolean; packSha?: string;
  env?: NodeJS.ProcessEnv; now?: number;
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

// Same shape the shell helper minted: local wall clock, four random hex
// digits, the pid. Run ids sort by start time within a repo dir.
function newRunId(now: number): string {
  const d = new Date(now);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
  return `${date}-${time}-${rand}-${process.pid}`;
}

const RUN_STATUSES = new Set(["done", "failed", "abandoned"]);

export function runStart(root: string, o: RunStartOpts): Ok<{ runId: string; runDb: string }> | Fail {
  if (!isPathComponent(o.repo)) return { ok: false, error: `--repo must be a single path component: ${o.repo}`, code: 2 };
  const now = o.now ?? Date.now();
  const runId = o.runId ?? newRunId(now);
  if (!isPathComponent(runId)) return { ok: false, error: `--run-id must be a single path component: ${runId}`, code: 2 };
  const runDb = join(root, o.repo, runId, "state.db");
  let db: Database;
  try {
    db = createRunDb(runDb);
  } catch (err) {
    return { ok: false, error: `run DB creation failed: ${String(err)}`, code: 1 };
  }
  try {
    const provenance = packProvenance(o.packDirs ?? []);
    const packCommits = composePackCommits(provenance, o.mattstackSha, o.packSha);
    const packDirty = o.mattstackDirty ? 1 : provenance.dirty;
    try {
      db.run(
        "INSERT INTO runs (id, repo, work_type, pipeline, status, spawned_by, started_at, pack_commits, pack_dirty) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        [runId, o.repo, o.workType, o.pipeline, o.spawnedBy ?? null, now, packCommits, packDirty],
      );
    } catch {
      return { ok: false, error: `run id already exists: ${runId}`, code: 1 };
    }
    if (o.ticket) {
      db.run("INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) VALUES (?, 'ticket', ?, 'work', ?)", [runId, o.ticket, now]);
    }
    recordIdentity(db, o.env ?? process.env, now);
    return { ok: true, runId, runDb };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  } finally {
    db.close();
  }
}

export function runStatus(db: Database, status: string, now: number = Date.now()): Ok | Fail {
  if (!RUN_STATUSES.has(status)) return { ok: false, error: "run-status needs --status done|failed|abandoned", code: 2 };
  try {
    db.run("UPDATE runs SET status=?, ended_at=?", [status, now]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/write.ts lib/runs/__tests__/write.test.ts
git commit -m "runs: run-start and run-status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Stage lifecycle with the zero-row guard

**Files:**
- Modify: `lib/runs/write.ts` (append)
- Test: `lib/runs/__tests__/write.test.ts` (append)

**Interfaces:**
- Produces: `stageStart(db, name, env, now?): Ok | Fail`; `stageEnd(db, name, status: "done" | "failed", opts?: { reason?: string; detailPath?: string; now?: number }): Ok | Fail`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runs/__tests__/write.test.ts` (extend the import with `stageStart, stageEnd`):

```ts
function started(): Database {
  const r = runStart(tmp(), { repo: "demo", workType: "feature", pipeline: "default", env: {} });
  if (!r.ok) throw new Error(r.error);
  return openRunDb(r.runDb);
}

describe("stage lifecycle", () => {
  test("stage-start inserts a running row, sets current_stage, and bumps attempt on re-entry", () => {
    const db = started();
    expect(stageStart(db, "plan", {}, 10)).toEqual({ ok: true });
    expect(stageEnd(db, "plan", "done", { now: 20 })).toEqual({ ok: true });
    expect(stageStart(db, "plan", {}, 30)).toEqual({ ok: true });
    const rows = db.query("SELECT attempt, status, started_at, ended_at FROM stages ORDER BY attempt").all();
    expect(rows).toEqual([{ attempt: 1, status: "done", started_at: 10, ended_at: 20 }, { attempt: 2, status: "running", started_at: 30, ended_at: null }]);
    expect(db.query("SELECT current_stage FROM runs").get()).toEqual({ current_stage: "plan" });
    db.close();
  });

  test("stage-start records identity from env", () => {
    const db = started();
    stageStart(db, "plan", { HERDR_PANE_ID: "w1:p4" }, 10);
    expect(db.query("SELECT value, produced_by FROM fields WHERE key='herdr-pane'").get()).toEqual({ value: "w1:p4", produced_by: "run" });
    db.close();
  });

  test("stage-fail records reason and detail path on the latest attempt", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    expect(stageEnd(db, "gates", "failed", { reason: "acme-gate assertion failed", detailPath: "/tmp/gates.log", now: 20 })).toEqual({ ok: true });
    expect(db.query("SELECT status, reason, detail_path FROM stages WHERE name='gates'").get()).toEqual({ status: "failed", reason: "acme-gate assertion failed", detail_path: "/tmp/gates.log" });
    db.close();
  });

  test("a reason containing quotes is stored verbatim", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    stageEnd(db, "gates", "failed", { reason: "expected '/c/1' got '/x'" });
    expect(db.query("SELECT reason FROM stages WHERE name='gates'").get()).toEqual({ reason: "expected '/c/1' got '/x'" });
    db.close();
  });

  test("stage-fail without a reason stores NULL", () => {
    const db = started();
    stageStart(db, "gates", {}, 10);
    stageEnd(db, "gates", "failed");
    expect(db.query("SELECT reason, detail_path FROM stages WHERE name='gates'").get()).toEqual({ reason: null, detail_path: null });
    db.close();
  });

  test("stage-done and stage-fail on a stage that was never started are exit 3 and write nothing", () => {
    const db = started();
    expect(stageEnd(db, "plan", "done")).toEqual({ ok: false, error: "stage never started: plan", code: 3 });
    expect(stageEnd(db, "gates", "failed", { reason: "boom" })).toEqual({ ok: false, error: "stage never started: gates", code: 3 });
    expect(db.query("SELECT COUNT(*) AS n FROM stages").get()).toEqual({ n: 0 });
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: FAIL, `stageStart` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/runs/write.ts`:

```ts
export function stageStart(db: Database, name: string, env: NodeJS.ProcessEnv, now: number = Date.now()): Ok | Fail {
  try {
    db.run(
      `INSERT INTO stages (run_id, name, status, attempt, started_at)
       SELECT id, ?, 'running', COALESCE((SELECT MAX(attempt) FROM stages WHERE name = ?), 0) + 1, ? FROM runs`,
      [name, name, now],
    );
    db.run("UPDATE runs SET current_stage=?", [name]);
    recordIdentity(db, env, now);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

function changes(db: Database): number {
  return (db.query("SELECT changes() AS n").get() as { n: number }).n;
}

// A zero-row update means stage-start never landed (skipped, or refused by
// the caller's shell guard); answering ok there once left a run with no row
// for the stage and nothing telling the agent to retry.
export function stageEnd(
  db: Database,
  name: string,
  status: "done" | "failed",
  opts: { reason?: string; detailPath?: string; now?: number } = {},
): Ok | Fail {
  try {
    db.run(
      `UPDATE stages SET status=?, ended_at=?, reason=?, detail_path=?
       WHERE name=? AND attempt=(SELECT MAX(attempt) FROM stages WHERE name=?)`,
      [status, opts.now ?? Date.now(), opts.reason ?? null, opts.detailPath ?? null, name, name],
    );
    if (changes(db) === 0) return { ok: false, error: `stage never started: ${name}`, code: 3 };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/write.ts lib/runs/__tests__/write.test.ts
git commit -m "runs: stage-start, stage-done, stage-fail with the zero-row guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Fields, decisions, snapshot

**Files:**
- Modify: `lib/runs/write.ts` (append)
- Test: `lib/runs/__tests__/write.test.ts` (append)

**Interfaces:**
- Produces: `fieldSet(db, key, value, stage, now?): Ok | Fail`; `fieldGet(db, key): Ok<{ value: string }> | Fail`; `decisionRecord(db, o: { contract, scope, selection, decidedBy, now? }): Ok | Fail`; `snapshot(db): Ok<{ run: Row | null; stages: Row[]; fields: Row[]; decisions: Row[] }>` where `Row = Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/runs/__tests__/write.test.ts` (extend the import with `fieldSet, fieldGet, decisionRecord, snapshot`):

```ts
describe("fields", () => {
  test("field set/get round-trips a value with single quotes; a missing key is exit 3", () => {
    const db = started();
    expect(fieldSet(db, "mr-url", "https://x/1?a='b'", "ship", 10)).toEqual({ ok: true });
    expect(fieldGet(db, "mr-url")).toEqual({ ok: true, value: "https://x/1?a='b'" });
    expect(db.query("SELECT produced_by, at FROM fields WHERE key='mr-url'").get()).toEqual({ produced_by: "ship", at: 10 });
    expect(fieldGet(db, "nope")).toMatchObject({ ok: false, code: 3 });
    db.close();
  });

  test("field set replaces an existing key", () => {
    const db = started();
    fieldSet(db, "branch", "a", "provision", 10);
    fieldSet(db, "branch", "b", "provision", 20);
    expect(db.query("SELECT value, at FROM fields WHERE key='branch'").get()).toEqual({ value: "b", at: 20 });
    db.close();
  });
});

describe("decisions", () => {
  test("decision record upserts on (contract, scope) and refuses a selection that is not JSON", () => {
    const db = started();
    const rec = (selection: string) => decisionRecord(db, { contract: "execution-strategy@1", scope: "run", selection, decidedBy: "stage-plan" });
    expect(rec('{"tier":"direct-tdd"}')).toEqual({ ok: true });
    expect(rec('{"tier":"superpowers"}')).toEqual({ ok: true });
    const rows = db.query("SELECT selection FROM decisions").all() as { selection: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.selection).tier).toBe("superpowers");
    expect(rec("not json")).toMatchObject({ ok: false, code: 2 });
    db.close();
  });
});

describe("snapshot", () => {
  test("returns raw rows in the script's order", () => {
    const db = started();
    stageStart(db, "plan", {}, 10);
    stageEnd(db, "plan", "done", { now: 20 });
    stageStart(db, "gates", {}, 30);
    fieldSet(db, "b", "2", "plan", 50);
    fieldSet(db, "a", "1", "plan", 40);
    decisionRecord(db, { contract: "c@1", scope: "run", selection: "{}", decidedBy: "x", now: 60 });
    const s = snapshot(db);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.run).toMatchObject({ status: "running", current_stage: "gates" });
    expect(s.stages.map((r) => r.name)).toEqual(["plan", "gates"]);
    expect(s.fields.map((r) => r.key)).toEqual(["a", "b"]);
    expect(s.decisions).toHaveLength(1);
    expect(s.stages[0]).toHaveProperty("run_id");
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: FAIL, `fieldSet` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `lib/runs/write.ts`:

```ts
export function fieldSet(db: Database, key: string, value: string, stage: string, now: number = Date.now()): Ok | Fail {
  try {
    db.run("INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) SELECT id, ?, ?, ?, ? FROM runs", [key, value, stage, now]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export function fieldGet(db: Database, key: string): Ok<{ value: string }> | Fail {
  const row = db.query("SELECT value FROM fields WHERE key=?").get(key) as { value: string } | undefined;
  if (!row || row.value === "") return { ok: false, error: `no field ${key}`, code: 3 };
  return { ok: true, value: row.value };
}

export function decisionRecord(
  db: Database,
  o: { contract: string; scope: string; selection: string; decidedBy: string; now?: number },
): Ok | Fail {
  try {
    JSON.parse(o.selection);
  } catch {
    return { ok: false, error: "--selection must be JSON", code: 2 };
  }
  try {
    db.run(
      "INSERT OR REPLACE INTO decisions (run_id, contract, scope, selection, decided_by, decided_at) SELECT id, ?, ?, ?, ?, ? FROM runs",
      [o.contract, o.scope, o.selection, o.decidedBy, o.now ?? Date.now()],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export type Row = Record<string, unknown>;

// Raw rows from the open handle, not store.ts's readRun: that one keys on
// (repo, runId) under runsRoot() and returns the enriched RunDetail shape,
// while callers of snapshot expect the table rows the script printed.
export function snapshot(db: Database): Ok<{ run: Row | null; stages: Row[]; fields: Row[]; decisions: Row[] }> | Fail {
  try {
    return {
      ok: true,
      run: (db.query("SELECT * FROM runs LIMIT 1").get() as Row | undefined) ?? null,
      stages: db.query("SELECT * FROM stages ORDER BY started_at, attempt").all() as Row[],
      fields: db.query("SELECT * FROM fields ORDER BY at").all() as Row[],
      decisions: db.query("SELECT * FROM decisions ORDER BY decided_at").all() as Row[],
    };
  } catch (err) {
    return { ok: false, error: `sqlite read failed: ${String(err)}`, code: 1 };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/write.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/write.ts lib/runs/__tests__/write.test.ts
git commit -m "runs: field set/get, decision record, snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: abandonRun moves onto write.ts

**Files:**
- Modify: `lib/runs/reconcile.ts:1-40`
- Test: `lib/runs/__tests__/reconcile.test.ts` (existing; must stay green)

**Interfaces:**
- Consumes: `openRunDb`, `runStatus`, `fieldSet` (Tasks 1, 4, 6).
- Produces: `abandonRun(repo, runId, reason): AbandonResult` unchanged.

- [ ] **Step 1: Run the existing reconcile tests to capture the baseline**

Run: `bun test lib/runs/__tests__/reconcile.test.ts`
Expected: PASS. Note the count.

- [ ] **Step 2: Rewrite abandonRun on the shared write functions**

Replace the header comment and the function body in `lib/runs/reconcile.ts` so the file starts:

```ts
/**
 * Reconciliation: only a person can decide a run is dead, and the record has
 * to stop claiming otherwise. The write itself goes through write.ts like
 * every other mutation.
 */
import { existsSync } from "fs";
import { join } from "path";
import { isPathComponent, runsRoot } from "./store.ts";
import { fieldSet, openRunDb, runStatus } from "./write.ts";

export type AbandonResult = { ok: true } | { ok: false; error: string };

export function abandonRun(repo: string, runId: string, reason: string): AbandonResult {
  if (!isPathComponent(repo) || !isPathComponent(runId)) return { ok: false, error: "invalid run path" };
  const path = join(runsRoot(), repo, runId, "state.db");
  if (!existsSync(path)) return { ok: false, error: `no run ${runId} in ${repo}` };

  const db = openRunDb(path);
  try {
    const row = db.query("SELECT status FROM runs LIMIT 1").get() as { status: string } | undefined;
    if (!row) return { ok: false, error: "run row missing" };
    if (row.status !== "running") return { ok: false, error: `run already ${row.status}` };

    const now = Date.now();
    const closed = runStatus(db, "abandoned", now);
    if (!closed.ok) return { ok: false, error: closed.error };
    const noted = fieldSet(db, "reconciled", reason, "rt runs abandon", now);
    if (!noted.ok) return { ok: false, error: noted.error };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    db.close();
  }
}
```

Keep whatever follows the original function in the file unchanged. Remove the now-unused `Database` import.

- [ ] **Step 3: Run the tests to verify they still pass**

Run: `bun test lib/runs/__tests__/reconcile.test.ts lib/runs/__tests__/write.test.ts`
Expected: same count as Step 1, all pass.

- [ ] **Step 4: Commit**

```bash
git add lib/runs/reconcile.ts
git commit -m "runs: abandonRun writes through write.ts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Best-effort emission

**Files:**
- Create: `lib/runs/emit.ts`
- Test: `lib/runs/__tests__/emit.test.ts`

**Interfaces:**
- Consumes: `daemonSocketQuery(cmd, payload?, timeoutMs?)` from `lib/daemon-client.ts`; `DAEMON_SOCK_PATH` from `lib/daemon-config.ts` (tests only).
- Produces: `type RunUpdate = { repo: string; runId: string; stage: string | null; kind: string }`; `emitRunUpdated(update: RunUpdate, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `lib/runs/__tests__/emit.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { DAEMON_SOCK_PATH } from "../../daemon-config.ts";
import { emitRunUpdated } from "../emit.ts";

const update = { repo: "demo", runId: "r1", stage: "plan", kind: "stage-done" };

describe("emitRunUpdated", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
  });

  test("posts events:emit with the run-updated topic and payload", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    let seen: { path: string; body: unknown } | null = null;
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch(req) {
        seen = { path: new URL(req.url).pathname, body: await req.json() };
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    await emitRunUpdated(update, {});
    expect(seen).toEqual({ path: "/events:emit", body: { topic: "run-updated", payload: update } });
  });

  test("RT_RUN_EMIT=0 sends nothing", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    let hits = 0;
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      fetch() { hits++; return new Response(JSON.stringify({ ok: true })); },
    });
    await emitRunUpdated(update, { RT_RUN_EMIT: "0" });
    expect(hits).toBe(0);
  });

  test("no socket returns at once", async () => {
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    const t0 = performance.now();
    await emitRunUpdated(update, {});
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("a daemon that accepts and never answers costs at most the timeout", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch() { await new Promise(() => {}); return new Response(); },
    });
    const t0 = performance.now();
    await emitRunUpdated(update, {}, 300);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/runs/__tests__/emit.test.ts`
Expected: FAIL, "Cannot find module '../emit.ts'".

- [ ] **Step 3: Write the module**

Create `lib/runs/emit.ts`:

```ts
import { daemonSocketQuery } from "../daemon-client.ts";

export type RunUpdate = { repo: string; runId: string; stage: string | null; kind: string };

// daemonSocketQuery, never daemonQuery: the latter restarts the daemon
// through the tray and waits on it, and a stage write must not do either.
// The DB write has already landed when this runs; a wedged daemon costs the
// timeout and nothing else.
export async function emitRunUpdated(update: RunUpdate, env: NodeJS.ProcessEnv = process.env, timeoutMs = 1_000): Promise<void> {
  if (env.RT_RUN_EMIT === "0") return;
  try {
    await daemonSocketQuery("events:emit", { topic: "run-updated", payload: update }, timeoutMs);
  } catch {
    // best effort by contract
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/runs/__tests__/emit.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runs/emit.ts lib/runs/__tests__/emit.test.ts
git commit -m "runs: best-effort run-updated emission over the daemon socket

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The command layer

**Files:**
- Create: `commands/runs-write.ts`
- Modify: `commands/runs.ts:1-15` (header) and `runsList`
- Modify: `lib/command-tree-def.ts` (`runsSubcommands` and the `runs` node description)
- Test: `commands/__tests__/runs-write.test.ts`

**Interfaces:**
- Consumes: everything exported from `lib/runs/write.ts`, `emitRunUpdated`, `runsRoot`.
- Produces: `type WriteVerb = "run-start" | "run-status" | "stage-start" | "stage-done" | "stage-fail" | "field" | "decision" | "snapshot"`; `runWriteVerb(verb: WriteVerb, args: string[], env?: NodeJS.ProcessEnv): Promise<{ out: string; code: number }>`; exported command functions `runsRunStart`, `runsRunStatus`, `runsStageStart`, `runsStageDone`, `runsStageFail`, `runsField`, `runsDecision`, `runsSnapshot`, each `(args: string[]) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `commands/__tests__/runs-write.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DAEMON_SOCK_PATH } from "../../lib/daemon-config.ts";
import { runWriteVerb } from "../runs-write.ts";
import { runsList } from "../runs.ts";

const QUIET = { RT_RUN_EMIT: "0" };

async function startRun(): Promise<{ env: Record<string, string>; runDb: string }> {
  const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
  const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "fix", "--pipeline", "default"], { RT_RUNS_ROOT: root, ...QUIET });
  const parsed = JSON.parse(r.out);
  return { env: { RT_RUN_DB: parsed.runDb, ...QUIET }, runDb: parsed.runDb };
}

describe("rt runs write verbs", () => {
  test("run-start prints ok, runId, runDb and exits 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "rt-runs-cli-"));
    const r = await runWriteVerb("run-start", ["--repo", "demo", "--work-type", "feature", "--pipeline", "default", "--spawned-by", "test"], { RT_RUNS_ROOT: root, ...QUIET });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.ok).toBe(true);
    expect(out.runDb).toBe(join(root, "demo", out.runId, "state.db"));
    expect(existsSync(out.runDb)).toBe(true);
  });

  test("run-start without its required flags is a JSON usage error, exit 2", async () => {
    const r = await runWriteVerb("run-start", ["--repo", "demo"], QUIET);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
  });

  test("a value flag with no value is exit 2", async () => {
    const { env } = await startRun();
    const r = await runWriteVerb("stage-start", ["--stage"], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error).toContain("--stage");
  });

  test("subcommands without RT_RUN_DB fail with a JSON error, exit 2", async () => {
    const r = await runWriteVerb("run-status", ["--status", "done"], QUIET);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: "RT_RUN_DB is not set" });
    const missing = await runWriteVerb("snapshot", [], { RT_RUN_DB: "/nowhere/state.db", ...QUIET });
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.out).error).toContain("run DB not found");
  });

  test("stage lifecycle through the CLI, including the never-started guard at exit 3", async () => {
    const { env, runDb } = await startRun();
    expect(await runWriteVerb("stage-done", ["--stage", "plan"], env)).toEqual({ out: JSON.stringify({ ok: false, error: "stage never started: plan" }), code: 3 });
    expect((await runWriteVerb("stage-start", ["--stage", "plan"], env)).out).toBe('{"ok":true}');
    expect((await runWriteVerb("stage-done", ["--stage", "plan"], env)).code).toBe(0);
    expect((await runWriteVerb("stage-start", ["--stage", "plan"], env)).code).toBe(0);
    expect((await runWriteVerb("stage-fail", ["--stage", "plan", "--reason", "boom", "--detail-path", "/tmp/x.log"], env)).code).toBe(0);
    const db = new Database(runDb, { readonly: true });
    expect(db.query("SELECT attempt, status, reason FROM stages ORDER BY attempt").all()).toEqual([{ attempt: 1, status: "done", reason: null }, { attempt: 2, status: "failed", reason: "boom" }]);
    db.close();
  });

  test("field set prints ok; field get prints the raw value or nothing with exit 3", async () => {
    const { env } = await startRun();
    expect(await runWriteVerb("field", ["set", "mr-url", "https://x/1?a='b'", "--stage", "ship"], env)).toEqual({ out: '{"ok":true}', code: 0 });
    expect(await runWriteVerb("field", ["get", "mr-url"], env)).toEqual({ out: "https://x/1?a='b'", code: 0 });
    expect(await runWriteVerb("field", ["get", "nope"], env)).toEqual({ out: "", code: 3 });
    expect((await runWriteVerb("field", ["set", "k"], env)).code).toBe(2);
    expect((await runWriteVerb("field", ["frob"], env)).code).toBe(2);
  });

  test("decision record, snapshot, and run-status", async () => {
    const { env } = await startRun();
    expect((await runWriteVerb("decision", ["record", "--contract", "execution-strategy@1", "--scope", "run", "--selection", '{"tier":"direct-tdd"}', "--decided-by", "stage-plan"], env)).code).toBe(0);
    expect((await runWriteVerb("decision", ["record", "--contract", "c", "--scope", "run", "--selection", "nope", "--decided-by", "x"], env)).code).toBe(2);
    const snap = JSON.parse((await runWriteVerb("snapshot", [], env)).out);
    expect(snap.ok).toBe(true);
    expect(snap.run.status).toBe("running");
    expect(snap.decisions).toHaveLength(1);
    expect((await runWriteVerb("run-status", ["--status", "done"], env)).out).toBe('{"ok":true}');
    expect((await runWriteVerb("run-status", ["--status", "paused"], env)).code).toBe(2);
    expect(JSON.parse((await runWriteVerb("snapshot", [], env)).out).run.status).toBe("done");
  });

  test("a write emits run-updated when a daemon is listening", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    const seen: unknown[] = [];
    const server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch(req) { seen.push(await req.json()); return new Response(JSON.stringify({ ok: true })); },
    });
    try {
      const { env } = await startRun();
      await runWriteVerb("stage-start", ["--stage", "plan"], { RT_RUN_DB: env.RT_RUN_DB });
      expect(seen).toEqual([{ topic: "run-updated", payload: { repo: "demo", runId: expect.any(String), stage: "plan", kind: "stage-start" } }]);
    } finally {
      server.stop(true);
      if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    }
  });
});

describe("rt runs positional rejection", () => {
  test("a positional that is not a subcommand is a usage error, exit 2, before any daemon call", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runsList(["stage-start", "--stage", "plan"])).rejects.toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("unknown subcommand");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test commands/__tests__/runs-write.test.ts`
Expected: FAIL, "Cannot find module '../runs-write.ts'".

- [ ] **Step 3: Write the command module**

Create `commands/runs-write.ts`:

```ts
/**
 * rt runs <write verb>: the pipeline's write side of the run DB. Parsing and
 * printing only; every mutation lives in lib/runs/write.ts.
 *   rt runs run-start   --repo R --work-type T --pipeline P [--run-id ID] [--spawned-by S]
 *                       [--pack-dirs "DIR:DIR"] [--ticket ID] [--mattstack-sha SHA]
 *                       [--mattstack-dirty 0|1] [--pack-sha NAME=VALUE]
 *   rt runs run-status  --status done|failed|abandoned
 *   rt runs stage-start --stage NAME
 *   rt runs stage-done  --stage NAME
 *   rt runs stage-fail  --stage NAME [--reason TEXT] [--detail-path PATH]
 *   rt runs field set   KEY VALUE --stage NAME
 *   rt runs field get   KEY
 *   rt runs decision record --contract C --scope S --selection JSON --decided-by W
 *   rt runs snapshot
 * Every verb but run-start reads RT_RUN_DB. Output is JSON on stdout for
 * every outcome except `field get`. Exit 1 sqlite, 2 usage or environment,
 * 3 not found.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { emitRunUpdated } from "../lib/runs/emit.ts";
import { runsRoot } from "../lib/runs/store.ts";
import {
  decisionRecord, fieldGet, fieldSet, openRunDb, runStart, runStatus, snapshot, stageEnd, stageStart,
  type Fail,
} from "../lib/runs/write.ts";

export type WriteVerb = "run-start" | "run-status" | "stage-start" | "stage-done" | "stage-fail" | "field" | "decision" | "snapshot";
export type CliResult = { out: string; code: number };

class Usage extends Error {
  constructor(message: string) { super(message); }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function fail(f: Fail): CliResult {
  return { out: json({ ok: false, error: f.error }), code: f.code };
}

// A value flag followed by nothing, or by another flag, is a usage error:
// silently taking the next flag as the value is how `--mattstack-dirty`
// once became a sha.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Usage(`${flag} requires a value`);
  return v;
}

function required(args: string[], flag: string): string {
  const v = flagValue(args, flag);
  if (v === undefined) throw new Usage(`${flag} is required`);
  return v;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) { i++; continue; }
    out.push(a);
  }
  return out;
}

function runIdentity(db: Database): { repo: string; runId: string } {
  const row = db.query("SELECT id, repo FROM runs LIMIT 1").get() as { id: string; repo: string } | undefined;
  return { repo: row?.repo ?? "", runId: row?.id ?? "" };
}

async function emitted(env: NodeJS.ProcessEnv, ident: { repo: string; runId: string }, stage: string | null, kind: string): Promise<void> {
  await emitRunUpdated({ repo: ident.repo, runId: ident.runId, stage, kind }, env);
}

export async function runWriteVerb(verb: WriteVerb, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  try {
    return await dispatch(verb, args, env);
  } catch (err) {
    if (err instanceof Usage) return { out: json({ ok: false, error: err.message }), code: 2 };
    return { out: json({ ok: false, error: `sqlite write failed: ${String(err)}` }), code: 1 };
  }
}

async function dispatch(verb: WriteVerb, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  switch (verb) {
    case "run-start": {
      const repo = required(args, "--repo");
      const workType = required(args, "--work-type");
      const pipeline = required(args, "--pipeline");
      const dirty = flagValue(args, "--mattstack-dirty");
      const packDirs = (flagValue(args, "--pack-dirs") ?? "").split(":").filter((d) => d !== "");
      const r = runStart(env.RT_RUNS_ROOT ?? runsRoot(), {
        repo, workType, pipeline,
        runId: flagValue(args, "--run-id"),
        spawnedBy: flagValue(args, "--spawned-by"),
        packDirs,
        ticket: flagValue(args, "--ticket"),
        mattstackSha: flagValue(args, "--mattstack-sha"),
        mattstackDirty: dirty === "1",
        packSha: flagValue(args, "--pack-sha"),
        env,
      });
      if (!r.ok) return fail(r);
      await emitted(env, { repo, runId: r.runId }, null, "run-start");
      return { out: json({ ok: true, runId: r.runId, runDb: r.runDb }), code: 0 };
    }
    case "run-status": {
      const status = required(args, "--status");
      return withRunDbAsync(env, async (db) => {
        const r = runStatus(db, status);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), null, "run-status");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "stage-start": {
      const stage = required(args, "--stage");
      return withRunDbAsync(env, async (db) => {
        const r = stageStart(db, stage, env);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), stage, "stage-start");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "stage-done":
    case "stage-fail": {
      const stage = required(args, "--stage");
      const reason = flagValue(args, "--reason");
      const detailPath = flagValue(args, "--detail-path");
      return withRunDbAsync(env, async (db) => {
        const r = stageEnd(db, stage, verb === "stage-done" ? "done" : "failed", { reason, detailPath });
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), stage, verb);
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "field": {
      const [sub, key, value] = positionals(args);
      if (sub === "set") {
        if (!key || value === undefined) throw new Usage("field set needs KEY VALUE");
        const stage = required(args, "--stage");
        return withRunDbAsync(env, async (db) => {
          const r = fieldSet(db, key, value, stage);
          if (!r.ok) return fail(r);
          await emitted(env, runIdentity(db), stage, "field-set");
          return { out: json({ ok: true }), code: 0 };
        });
      }
      if (sub === "get") {
        if (!key) throw new Usage("field get needs KEY");
        return withRunDbAsync(env, async (db) => {
          const r = fieldGet(db, key);
          return r.ok ? { out: r.value, code: 0 } : { out: "", code: 3 };
        });
      }
      throw new Usage("field needs set|get");
    }
    case "decision": {
      const [sub] = positionals(args);
      if (sub !== "record") throw new Usage("decision needs record");
      const o = {
        contract: required(args, "--contract"),
        scope: required(args, "--scope"),
        selection: required(args, "--selection"),
        decidedBy: required(args, "--decided-by"),
      };
      return withRunDbAsync(env, async (db) => {
        const r = decisionRecord(db, o);
        if (!r.ok) return fail(r);
        await emitted(env, runIdentity(db), o.scope, "decision");
        return { out: json({ ok: true }), code: 0 };
      });
    }
    case "snapshot":
      return withRunDbAsync(env, async (db) => {
        const r = snapshot(db);
        return r.ok ? { out: json(r), code: 0 } : fail(r);
      });
  }
}

async function withRunDbAsync(env: NodeJS.ProcessEnv, body: (db: Database) => Promise<CliResult>): Promise<CliResult> {
  const path = env.RT_RUN_DB;
  if (!path) return { out: json({ ok: false, error: "RT_RUN_DB is not set" }), code: 2 };
  if (!existsSync(path)) return { out: json({ ok: false, error: `run DB not found: ${path}` }), code: 2 };
  const db = openRunDb(path);
  try {
    return await body(db);
  } finally {
    db.close();
  }
}

async function finish(result: CliResult): Promise<void> {
  if (result.out !== "") console.log(result.out);
  if (result.code !== 0) process.exit(result.code);
}

export async function runsRunStart(args: string[]): Promise<void> { await finish(await runWriteVerb("run-start", args)); }
export async function runsRunStatus(args: string[]): Promise<void> { await finish(await runWriteVerb("run-status", args)); }
export async function runsStageStart(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-start", args)); }
export async function runsStageDone(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-done", args)); }
export async function runsStageFail(args: string[]): Promise<void> { await finish(await runWriteVerb("stage-fail", args)); }
export async function runsField(args: string[]): Promise<void> { await finish(await runWriteVerb("field", args)); }
export async function runsDecision(args: string[]): Promise<void> { await finish(await runWriteVerb("decision", args)); }
export async function runsSnapshot(args: string[]): Promise<void> { await finish(await runWriteVerb("snapshot", args)); }
```

`positionals` skips one token after any `--flag`, which is right for every write verb because all their flags take values.

Then in `commands/runs.ts`, replace the header comment (lines 1-7) with:

```ts
/**
 * rt runs: the run DB.
 *   rt runs [--repo R] [--json]           list, newest first
 *   rt runs show <runId> [--repo R] [--json]
 *   rt runs abandon <runId> [--repo R] [--reason TEXT]
 * Reads go through the daemon's runs:* commands; the pipeline's write verbs
 * live in runs-write.ts and open the run DB directly.
 */
```

and add the positional rejection at the top of `runsList`, before the `--repo` handling:

```ts
export async function runsList(args: string[]): Promise<void> {
  const stray = positional(args);
  if (stray) {
    console.error(`rt runs: unknown subcommand "${stray}"\nusage: rt runs [--repo R] [--json] | rt runs <show|abandon|run-start|run-status|stage-start|stage-done|stage-fail|field|decision|snapshot> ...`);
    process.exit(2);
  }
  const repoArg = flagValue(args, "--repo");
```

Then in `lib/command-tree-def.ts`, add to `runsSubcommands` after `abandon`:

```ts
  "run-start": {
    description: "Pipeline: open a run DB and print its runId and runDb",
    module: "./commands/runs-write.ts",
    fn: "runsRunStart",
    args: [
      { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Run-dir key for the repo" },
      { name: "Work type", flag: "--work-type", type: "text", placeholder: "feature", hint: "feature | fix | ..." },
      { name: "Pipeline", flag: "--pipeline", type: "text", placeholder: "feature", hint: "Pipeline name from the manifest" },
      { name: "Run id", flag: "--run-id", type: "text", placeholder: "20260901-120000-abcd-1", hint: "Omit to mint one" },
      { name: "Spawned by", flag: "--spawned-by", type: "text", placeholder: "shepherdr", hint: "Surface that spawned this run" },
      { name: "Pack dirs", flag: "--pack-dirs", type: "text", placeholder: "/a:/b", hint: "Colon-separated pack checkouts for provenance" },
      { name: "Ticket", flag: "--ticket", type: "text", placeholder: "ABC-1", hint: "Recorded under producer work" },
      { name: "mattstack sha", flag: "--mattstack-sha", type: "text", placeholder: "deadbee", hint: "Appended to pack_commits" },
      { name: "mattstack dirty", flag: "--mattstack-dirty", type: "text", placeholder: "0", hint: "1 forces pack_dirty" },
      { name: "Pack sha", flag: "--pack-sha", type: "text", placeholder: "acme=abc1234", hint: "Appended verbatim to pack_commits" },
    ],
  },
  "run-status": {
    description: "Pipeline: close the run (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsRunStatus",
    args: [{ name: "Status", flag: "--status", type: "text", placeholder: "done", hint: "done | failed | abandoned" }],
  },
  "stage-start": {
    description: "Pipeline: start a stage attempt (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsStageStart",
    args: [{ name: "Stage", flag: "--stage", type: "text", placeholder: "plan", hint: "Stage name" }],
  },
  "stage-done": {
    description: "Pipeline: finish the latest attempt of a stage (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsStageDone",
    args: [{ name: "Stage", flag: "--stage", type: "text", placeholder: "plan", hint: "Stage name" }],
  },
  "stage-fail": {
    description: "Pipeline: fail the latest attempt of a stage (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsStageFail",
    args: [
      { name: "Stage", flag: "--stage", type: "text", placeholder: "gates", hint: "Stage name" },
      { name: "Reason", flag: "--reason", type: "text", placeholder: "3 files exceed the loc budget", hint: "One sentence, what actually failed" },
      { name: "Detail path", flag: "--detail-path", type: "text", placeholder: "/tmp/gates.log", hint: "Log or report for this failure" },
    ],
  },
  field: {
    description: "Pipeline: field set KEY VALUE --stage NAME | field get KEY (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsField",
    omitBehavior: { exempt: "agent-facing; the work engine names the verb and key explicitly and RT_RUN_DB is its context" },
    args: [
      { name: "Verb", type: "text", placeholder: "set", hint: "set | get" },
      { name: "Key", type: "text", placeholder: "branch", hint: "Field key" },
      { name: "Value", type: "text", optional: true, placeholder: "acme-1-slug", hint: "set only" },
      { name: "Stage", flag: "--stage", type: "text", placeholder: "provision", hint: "set only: producing stage" },
    ],
  },
  decision: {
    description: "Pipeline: decision record --contract C --scope S --selection JSON --decided-by W (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsDecision",
    omitBehavior: { exempt: "agent-facing; the stage skill passes record and every flag explicitly and RT_RUN_DB is its context" },
    args: [
      { name: "Verb", type: "text", placeholder: "record", hint: "record" },
      { name: "Contract", flag: "--contract", type: "text", placeholder: "execution-strategy@1", hint: "Slot contract" },
      { name: "Scope", flag: "--scope", type: "text", placeholder: "run", hint: "Decision scope" },
      { name: "Selection", flag: "--selection", type: "text", placeholder: '{"tier":"direct-tdd"}', hint: "JSON" },
      { name: "Decided by", flag: "--decided-by", type: "text", placeholder: "stage-plan", hint: "Writer" },
    ],
  },
  snapshot: {
    description: "Pipeline: the full run document as JSON (reads RT_RUN_DB)",
    module: "./commands/runs-write.ts",
    fn: "runsSnapshot",
    args: [],
  },
```

and change the `runs` node's description to `"Pipeline run state: list, show, and the pipeline's write verbs"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test commands/__tests__/runs-write.test.ts lib/runs commands/__tests__/run-resolve.test.ts lib/__tests__/picker-conformance.test.ts`
Expected: all pass, including the picker conformance test (the two `exempt` declarations above are what satisfy it). Then `bunx tsc --noEmit` with zero errors, `bun run picker:check` clean, and `bun test lib commands packages scripts` fully green. `bun run docs:check` stays red until Task 10 regenerates the command reference; that is expected here.

- [ ] **Step 5: Smoke the real CLI**

Run from the worktree:

```bash
export RT_RUNS_ROOT=$(mktemp -d)
bun cli.ts runs run-start --repo demo --work-type fix --pipeline default --pack-dirs ""
```

Expected: `{"ok":true,"runId":"...","runDb":"..."}`. Then with `RT_RUN_DB` set to that path: `bun cli.ts runs stage-done --stage plan` prints `{"ok":false,"error":"stage never started: plan"}` and `echo $?` is 3. `bun cli.ts runs frob` prints the usage error and exits 2.

- [ ] **Step 6: Commit**

```bash
git add commands/runs-write.ts commands/runs.ts lib/command-tree-def.ts commands/__tests__/runs-write.test.ts
git commit -m "runs: rt runs write verbs (run-start, stages, fields, decisions, snapshot)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: rt docs, PR, release

**Files:**
- Modify: whatever the rt:docs skill regenerates for the command reference.

- [ ] **Step 1: Regenerate the command reference**

Invoke the `rt:docs` skill and follow it; it regenerates the generated command reference from the command tree. Commit what it produces:

```bash
git add -A docs
git commit -m "docs: rt runs write verbs in the command reference

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Push and open the PR**

Write the body below to `/tmp/rt-runs-pr-body.md`, then:

```bash
git push -u origin runs-write-verbs
gh pr create --title "rt runs: the run DB write verbs" --body-file /tmp/rt-runs-pr-body.md
```

Body (Matt's MR style, lowercase technical content):

```
## rt runs owns the run DB write side

Stage skills used to write run state through `"$RT_PIPELINE_STATE"`, a shell variable Claude Code's worktree guard now refuses. `rt runs <verb>` replaces the script with a bare word every agent can run.

### What changed

**Write side** (`lib/runs/`)

- Adds `write.ts` (schema, migration, every mutation), `provenance.ts`, `identity.ts`, `emit.ts`
- Moves `abandonRun` onto `write.ts`
- `stage-done`/`stage-fail` on a never-started stage exit 3 instead of answering ok

**CLI** (`commands/runs-write.ts`)

- Adds run-start, run-status, stage-start, stage-done, stage-fail, field, decision, snapshot under `rt runs`, same flags and JSON as the script
- `rt runs <unknown>` is a usage error, exit 2, instead of falling through to the list

### Follow-up

- mattstack-skills deletes `pipeline-state.sh` and renames call sites after this releases (spec: docs/superpowers/specs/2026-09-01-runs-write-verbs-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Wait for CodeRabbit and CI**

Per Matt's standing rule: address every actionable CodeRabbit finding, wait for CI green, then ask Matt before merging.

- [ ] **Step 4: Release**

After merge, invoke the `rt:release` skill so teammates' rt carries the verbs. Task 12 waits on this.

---

### Task 11: mattstack-skills call sites and deletions

**Repo:** `~/Documents/GitHub/mattstack-skills`, on `main`, worktree at `.worktrees/rt-runs-verbs` (gitignored; create with `git worktree add .worktrees/rt-runs-verbs -b rt-runs-verbs`).

**Files:**
- Delete: `attachments/pipeline/work/scripts/pipeline-state.sh`, `attachments/pipeline/work/scripts/tests/pipeline-state-run-start.test.sh`, `tests/pipeline-state.test.ts`
- Modify: `attachments/pipeline/work/SKILL.md`, `attachments/pipeline/stage-{provision,plan,gates,evidence,implement,self-review,ship,watch-ci}/SKILL.md`, `attachments/parameterized-skills/references/convention.md`, `README.md`

- [ ] **Step 1: Load the writing-skills skill**

Invoke `superpowers:writing-skills` before touching any SKILL.md; follow its guidance for the edits below.

- [ ] **Step 2: Rename every call site**

```bash
cd ~/Documents/GitHub/mattstack-skills/.worktrees/rt-runs-verbs
grep -rl '"\$RT_PIPELINE_STATE"' attachments | xargs sed -i '' 's/"\$RT_PIPELINE_STATE"/rt runs/g'
grep -rn 'RT_PIPELINE_STATE' attachments plugin skills README.md
grep -rn 'pipeline-state' --exclude-dir=.git --exclude-dir=.local-dev --exclude-dir=.worktrees --exclude-dir=node_modules . | grep -v '^./docs/'
```

Expected after the sed: the first grep hits the `export RT_PIPELINE_STATE=` line in `attachments/pipeline/work/SKILL.md` (removed in the next step) and the prose on line 377 of `attachments/parameterized-skills/references/convention.md` (fixed below). The second grep hits the script, its two tests, the work engine's allowed-tools line, README line 344, and convention.md line 374 (fixed below). Any other hit is a call site this plan missed: a quoted-variable call gets the same rename, and prose that names the script or the variable is rewritten to say `rt runs`.

Then fix the two prose lines in `attachments/parameterized-skills/references/convention.md`. Replace

```
Alongside `stage-consumes`/`stage-produces`, every stage reports lifecycle
and data to the run DB through the `pipeline-state.sh` helper. The contract:

- A compiled stage always runs under `work`, which exports `RT_RUN_DB` and
  `RT_PIPELINE_STATE` before the first stage. There is no standalone stage
  invocation, so the four calls below are unconditional.
```

with

```
Alongside `stage-consumes`/`stage-produces`, every stage reports lifecycle
and data to the run DB through `rt runs`. The contract:

- A compiled stage always runs under `work`, which exports `RT_RUN_DB`
  before the first stage. There is no standalone stage invocation, so the
  four calls below are unconditional.
```

Re-run both greps: the only remaining hits are the work engine's export line and allowed-tools line (Step 3), README line 344 (Step 4), and the files this task deletes (Step 4).

- [ ] **Step 3: Edit the work engine**

In `attachments/pipeline/work/SKILL.md`:

Frontmatter `allowed-tools`: replace the line `  - Bash(${CLAUDE_SKILL_DIR}/scripts/pipeline-state.sh:*)` with `  - Bash(rt runs:*)`. Keep `  - Bash(git -C *:*)`.

Section "## 3. Start the run": replace

````
```bash
export RT_PIPELINE_STATE="${CLAUDE_SKILL_DIR}/scripts/pipeline-state.sh"
PACK_DIRS="$(cd "${CLAUDE_SKILL_DIR}/../.." && pwd -P)"
```
````

with

````
```bash
PACK_DIRS="$(cd "${CLAUDE_SKILL_DIR}/../.." && pwd -P)"
```
````

and replace the run-start block

````
```bash
rt runs run-start <flags for the work type> --pack-dirs "$PACK_DIRS" [--ticket <id>] [--spawned-by "<surface>"]
export RT_RUN_DB=<runDb from the response>
```
````

with

````
```bash
rt runs run-start <flags for the work type> --pack-dirs "$PACK_DIRS" [--ticket <id>] [--spawned-by "<surface>"]
export RT_RUN_DB=<runDb from the response>
```

The response must parse as JSON with `ok: true` and a `runDb`. Anything
else (a listing of runs, usage text) means this rt predates the run DB
write verbs: stop, and tell the user to update rt before continuing. Do
not proceed without a `runDb`.
````

- [ ] **Step 4: Delete the script and its tests; fix the README**

```bash
git rm attachments/pipeline/work/scripts/pipeline-state.sh attachments/pipeline/work/scripts/tests/pipeline-state-run-start.test.sh tests/pipeline-state.test.ts
sed -i '' 's|bun test                              # tests/desc-test.test.ts, tests/pipeline-state.test.ts|bun test                              # tests/desc-test.test.ts|' README.md
rmdir attachments/pipeline/work/scripts/tests 2>/dev/null; rmdir attachments/pipeline/work/scripts 2>/dev/null
```

If `scripts/` still holds other files, leave the directory.

- [ ] **Step 5: Certify every touched skill dir**

```bash
for d in attachments/pipeline/work attachments/pipeline/stage-*; do sh tests/certify.sh "$d" || echo "FAILED $d"; done
bun test
```

Expected: every dir prints only `ok` lines; `bun test` green (desc-test only now).

- [ ] **Step 6: Commit on the branch (no bump yet)**

```bash
git add -A
git commit -m "pipeline: stage skills call rt runs; drop pipeline-state.sh

the run DB write side now lives in rt (rt runs run-start, stage-start,
stage-done, stage-fail, field, decision, snapshot, run-status). the
run-start step gates on a JSON response so an rt without the verbs stops
the pipeline instead of recording nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Do not merge to main or bump until Task 12's precondition holds.

---

### Task 12: Promote, in order

Precondition: the rt release from Task 10 is published and installed on every machine that runs pipelines (Matt's, and teammates' via their rt update). Confirm on this machine with `rt runs run-start` printing a JSON usage error (exit 2), not a run listing.

- [ ] **Step 1: Land mattstack-skills and bump**

```bash
cd ~/Documents/GitHub/mattstack-skills
git merge --ff-only rt-runs-verbs
```

Bump `.claude-plugin/plugin.json` to the next patch version, commit as `mattstack: bump for rt runs write verbs`, push main, remove the worktree and branch.

- [ ] **Step 2: Update the installed mattstack plugin**

```bash
claude plugin update mattstack@mattstack
```

Confirm the new cache dir has no `attachments/pipeline/work/scripts/pipeline-state.sh`.

- [ ] **Step 3: Recompile the team pack**

Only with no pipeline in flight on this machine (`rt runs` shows nothing running for the repos this pack serves).

```bash
rt skills check --pack <team>
```

Bump `~/.mattstack/teams/<team>/mattstack/packs/<team>/.claude-plugin/plugin.json` to the next patch, then:

```bash
rt skills compile --pack <team>
rt skills check --pack <team>
```

Use the plain form; `--json` reports without writing. Expected: every verb in-sync, and `packs/<team>/skills/work/scripts/pipeline-state.sh` gone, `grep -rn 'rt runs' packs/<team>/attachments/stage-*/SKILL.md` hitting every stage.

- [ ] **Step 4: Commit and push the pack, update the plugin**

```bash
cd ~/.mattstack/teams/<team>/mattstack
git add -A packs/<team>
git commit -m "<pack> <version>: recompile for rt runs write verbs"
git push origin main
claude plugin update <pack>@<marketplace>
```

Tell Matt each teammate's next `claude plugin update <pack>@<marketplace>` removes the script on their machine, so they should run it between pipelines, after updating rt.

- [ ] **Step 5: Verify end to end**

Start a throwaway run through the compiled work verb (or by hand):

```bash
RT_RUNS_ROOT=$(mktemp -d) rt runs run-start --repo demo --work-type fix --pipeline default --pack-dirs ""
```

Then with `RT_RUN_DB` exported from the response, `rt runs stage-start --stage plan`, `rt runs stage-done --stage plan`, `rt runs snapshot`. Expected: JSON ok on each, the snapshot showing one done plan stage. Open console and confirm the run appears with its stage.
