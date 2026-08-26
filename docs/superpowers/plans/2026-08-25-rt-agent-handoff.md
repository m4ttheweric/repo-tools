# rt agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared `rt agent start|resume|show|list` verb (CLI → daemon → state.db) that launches Claude Code into a herdr pane or headless `-p` run with a minted session id, records the handoff, and resumes it.

**Architecture:** CLI thin client (`commands/agent.ts`) over four daemon handlers (`agent:start/resume/get/list`) backed by an `agents` table in state.db. Pure argv-building and herdr-transport live in `lib/` modules with injectable runners so everything unit-tests without herdr or claude. Headless children are spawned async by the daemon; exit updates the record and emits `agent/done/<id>` on the events bus.

**Tech Stack:** Bun, bun:sqlite (state.db), the rt daemon handler seam, @mattstack/rt-client (source-in-repo at `packages/rt-client`), herdr CLI.

**Spec:** `docs/superpowers/specs/2026-08-25-rt-agent-handoff-design.md` — read it first; the ratified decisions and spike findings there are binding.

## Global Constraints

- No liveness/status/supervision anywhere: launch + record + resume only.
- Session uuids are minted by rt (`crypto.randomUUID()`) and validated (`isValidSessionUuid`) before ANY spawn — `--session-id ""` is silently ignored by claude and `-p --resume ""` silently resumes the wrong session (spike-proven).
- Repo keys are serialized identities (`serializeIdentity(await deriveRepoIdentity(path))` from `lib/settings/identity.ts`); display via `repoLabel()` from `lib/repo-arg.ts`. Never re-derive with your own git calls, never show wire form to humans.
- Daemon spawns: `Bun.spawn` with `env: { ...process.env }` always (runtime PATH overlay does not reach children otherwise), binaries by absolute path or `Bun.which` (executable lookup uses process-start PATH). Never sync-exec on the daemon thread.
- state.db: no module-load db access; all DDL `IF NOT EXISTS`; go through `getStateDb()`/`openStateDb()`.
- New command module MUST be registered in `lib/module-registry.ts` as a thunk; no static import of ink/rt-render anywhere in the new files.
- Comments follow the clean-code rule: constraints only, no narration, no task numbers.
- Every task ends: run the named tests, then commit. Repo-wide gates at the end: `bun x tsc --noEmit`, `bun test lib commands packages`, rt-client `bun run build`.

---

### Task 1: agents table + store

**Files:**
- Modify: `lib/state/db.ts` (SCHEMA_VERSION 4→5, add V5_SCHEMA, concat in runMigrations). Main owns v4 (chat presence, rt #97); this lane claims v5 — announced to the coordination lane 2026-08-25. If another lane lands v5 first, renumber to 6 and re-announce.
- Create: `lib/state/agents-store.ts`
- Modify: `lib/state/index.ts` (barrel re-export)
- Test: `lib/state/__tests__/agents-store.test.ts`

**Interfaces:**
- Consumes: `openStateDb`/`getStateDb` from `lib/state/db.ts`; `persistOrWarn`, `runCriticalWrite` from `lib/state/busy.ts`.
- Produces (Task 5 depends on these exact names):
  ```ts
  export type AgentSurface = "herdr" | "headless";
  export interface AgentRecord {
    id: string; repo: string; cwd: string; provider: string;
    surface: AgentSurface; sessionId: string;
    model?: string; effort?: string; account?: string;
    label?: string; caller?: string;
    paneId?: string; tabId?: string; workspaceId?: string;
    extraArgs?: string; exitCode?: number; resultPath?: string;
    createdAt: number; lastResumedAt?: number; finishedAt?: number;
  }
  export function insertAgent(rec: AgentRecord, db?: Database): void;
  export function getAgent(idOrSession: string, db?: Database): AgentRecord | undefined;
  export function listAgents(args: { repo?: string }, db?: Database): AgentRecord[];
  export function updateAgentPane(id: string, ids: { paneId: string; tabId: string; workspaceId: string }, db?: Database): void;
  export function markAgentResumed(id: string, at: number, db?: Database): void;
  export function finishAgent(id: string, args: { exitCode: number; resultPath: string; finishedAt: number }, db?: Database): void;
  export function newAgentId(): string;   // "ag-" + first 8 hex of randomUUID
  ```

- [ ] **Step 1: Write the failing test**

`lib/state/__tests__/agents-store.test.ts` (fresh-tmp-db pattern from `chat-store.test.ts`):

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import {
  finishAgent, getAgent, insertAgent, listAgents, markAgentResumed,
  newAgentId, updateAgentPane, type AgentRecord,
} from "../agents-store.ts";

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `agents-test-${process.pid}-${n++}.db`));
}

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: newAgentId(), repo: "remote:example.com%2Fa%2Fb", cwd: "/tmp/x",
    provider: "claude", surface: "herdr",
    sessionId: crypto.randomUUID(), createdAt: Date.now(), ...over,
  };
}

test("insert then get by id and by session uuid", () => {
  const db = freshDb();
  const r = rec({ model: "haiku", caller: "board:review" });
  insertAgent(r, db);
  expect(getAgent(r.id, db)).toMatchObject({ id: r.id, model: "haiku", caller: "board:review" });
  expect(getAgent(r.sessionId, db)?.id).toBe(r.id);
  expect(getAgent("nope", db)).toBeUndefined();
});

test("list filters by repo, newest first", () => {
  const db = freshDb();
  const a = rec({ createdAt: 1 });
  const b = rec({ createdAt: 2 });
  const c = rec({ repo: "remote:other%2Fr", createdAt: 3 });
  for (const r of [a, b, c]) insertAgent(r, db);
  expect(listAgents({ repo: a.repo }, db).map((x) => x.id)).toEqual([b.id, a.id]);
  expect(listAgents({}, db)).toHaveLength(3);
});

test("pane update, resume stamp, finish", () => {
  const db = freshDb();
  const r = rec();
  insertAgent(r, db);
  updateAgentPane(r.id, { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" }, db);
  markAgentResumed(r.id, 42, db);
  finishAgent(r.id, { exitCode: 0, resultPath: "/tmp/r.json", finishedAt: 43 }, db);
  const got = getAgent(r.id, db)!;
  expect(got).toMatchObject({
    paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1",
    lastResumedAt: 42, exitCode: 0, resultPath: "/tmp/r.json", finishedAt: 43,
  });
});

test("duplicate session uuid is refused", () => {
  const db = freshDb();
  const r = rec();
  insertAgent(r, db);
  expect(() => insertAgent(rec({ sessionId: r.sessionId }), db)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/state/__tests__/agents-store.test.ts`
Expected: FAIL — cannot resolve `../agents-store.ts`.

- [ ] **Step 3: Implement schema + store**

In `lib/state/db.ts`: change `export const SCHEMA_VERSION = 4;` to `5` (update its docblock to include v5), add below `V4_SCHEMA`:

```ts
// Tables (v5): agent handoff records for `rt agent`
// (lib/state/agents-store.ts is the only module that touches them).
// Additive only: never put ALTER TABLE or non-IF-NOT-EXISTS DDL in a
// V*_SCHEMA block — runMigrations replays the full concat on every bump.
const V5_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  provider        TEXT NOT NULL,
  surface         TEXT NOT NULL,
  session_id      TEXT NOT NULL UNIQUE,
  model           TEXT,
  effort          TEXT,
  account         TEXT,
  label           TEXT,
  caller          TEXT,
  pane_id         TEXT,
  tab_id          TEXT,
  workspace_id    TEXT,
  extra_args      TEXT,
  exit_code       INTEGER,
  result_path     TEXT,
  created_at      INTEGER NOT NULL,
  last_resumed_at INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS agents_repo_created ON agents(repo, created_at);
`;
```

and in `runMigrations` change the exec line to `db.exec(V1_SCHEMA + V2_SCHEMA + V3_SCHEMA + V4_SCHEMA + V5_SCHEMA);`.

Create `lib/state/agents-store.ts`:

```ts
/**
 * lib/state/agents-store.ts — handoff records for `rt agent`.
 * The only module that touches the agents table. Launch + record + resume
 * only: no liveness columns exist by design (spec 2026-08-25).
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { runCriticalWrite } from "./busy.ts";

export type AgentSurface = "herdr" | "headless";

export interface AgentRecord {
  id: string; repo: string; cwd: string; provider: string;
  surface: AgentSurface; sessionId: string;
  model?: string; effort?: string; account?: string;
  label?: string; caller?: string;
  paneId?: string; tabId?: string; workspaceId?: string;
  extraArgs?: string; exitCode?: number; resultPath?: string;
  createdAt: number; lastResumedAt?: number; finishedAt?: number;
}

const COLUMNS =
  "id, repo, cwd, provider, surface, session_id, model, effort, account, label, caller, " +
  "pane_id, tab_id, workspace_id, extra_args, exit_code, result_path, " +
  "created_at, last_resumed_at, finished_at";

const INSERT_SQL = `INSERT INTO agents (${COLUMNS}) VALUES (${COLUMNS.split(",").map(() => "?").join(", ")});`;
const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM agents WHERE id = ? OR session_id = ?;`;
const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM agents ORDER BY created_at DESC;`;
const SELECT_REPO_SQL = `SELECT ${COLUMNS} FROM agents WHERE repo = ? ORDER BY created_at DESC;`;
const UPDATE_PANE_SQL = `UPDATE agents SET pane_id = ?, tab_id = ?, workspace_id = ? WHERE id = ?;`;
const UPDATE_RESUMED_SQL = `UPDATE agents SET last_resumed_at = ? WHERE id = ?;`;
const UPDATE_FINISH_SQL = `UPDATE agents SET exit_code = ?, result_path = ?, finished_at = ? WHERE id = ?;`;

interface AgentRow {
  id: string; repo: string; cwd: string; provider: string; surface: string;
  session_id: string; model: string | null; effort: string | null;
  account: string | null; label: string | null; caller: string | null;
  pane_id: string | null; tab_id: string | null; workspace_id: string | null;
  extra_args: string | null; exit_code: number | null; result_path: string | null;
  created_at: number; last_resumed_at: number | null; finished_at: number | null;
}

function rowToRecord(r: AgentRow): AgentRecord {
  const rec: AgentRecord = {
    id: r.id, repo: r.repo, cwd: r.cwd, provider: r.provider,
    surface: r.surface as AgentSurface, sessionId: r.session_id,
    createdAt: r.created_at,
  };
  if (r.model !== null) rec.model = r.model;
  if (r.effort !== null) rec.effort = r.effort;
  if (r.account !== null) rec.account = r.account;
  if (r.label !== null) rec.label = r.label;
  if (r.caller !== null) rec.caller = r.caller;
  if (r.pane_id !== null) rec.paneId = r.pane_id;
  if (r.tab_id !== null) rec.tabId = r.tab_id;
  if (r.workspace_id !== null) rec.workspaceId = r.workspace_id;
  if (r.extra_args !== null) rec.extraArgs = r.extra_args;
  if (r.exit_code !== null) rec.exitCode = r.exit_code;
  if (r.result_path !== null) rec.resultPath = r.result_path;
  if (r.last_resumed_at !== null) rec.lastResumedAt = r.last_resumed_at;
  if (r.finished_at !== null) rec.finishedAt = r.finished_at;
  return rec;
}

export function newAgentId(): string {
  return `ag-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export function insertAgent(rec: AgentRecord, db: Database = getStateDb()): void {
  const run = () =>
    db.query(INSERT_SQL).run(
      rec.id, rec.repo, rec.cwd, rec.provider, rec.surface, rec.sessionId,
      rec.model ?? null, rec.effort ?? null, rec.account ?? null,
      rec.label ?? null, rec.caller ?? null,
      rec.paneId ?? null, rec.tabId ?? null, rec.workspaceId ?? null,
      rec.extraArgs ?? null, rec.exitCode ?? null, rec.resultPath ?? null,
      rec.createdAt, rec.lastResumedAt ?? null, rec.finishedAt ?? null,
    );
  // UNIQUE(session_id) violations must surface to the handler, not be
  // swallowed as a busy retry outcome.
  run();
}

export function getAgent(idOrSession: string, db: Database = getStateDb()): AgentRecord | undefined {
  const row = db.query(SELECT_ONE_SQL).get(idOrSession, idOrSession) as AgentRow | null;
  return row ? rowToRecord(row) : undefined;
}

export function listAgents(args: { repo?: string }, db: Database = getStateDb()): AgentRecord[] {
  const rows = (args.repo
    ? db.query(SELECT_REPO_SQL).all(args.repo)
    : db.query(SELECT_ALL_SQL).all()) as AgentRow[];
  return rows.map(rowToRecord);
}

export function updateAgentPane(
  id: string, ids: { paneId: string; tabId: string; workspaceId: string },
  db: Database = getStateDb(),
): void {
  runCriticalWrite("updateAgentPane", () => db.query(UPDATE_PANE_SQL).run(ids.paneId, ids.tabId, ids.workspaceId, id), { id });
}

export function markAgentResumed(id: string, at: number, db: Database = getStateDb()): void {
  runCriticalWrite("markAgentResumed", () => db.query(UPDATE_RESUMED_SQL).run(at, id), { id });
}

export function finishAgent(
  id: string, args: { exitCode: number; resultPath: string; finishedAt: number },
  db: Database = getStateDb(),
): void {
  runCriticalWrite("finishAgent", () => db.query(UPDATE_FINISH_SQL).run(args.exitCode, args.resultPath, args.finishedAt, id), { id });
}
```

Add to `lib/state/index.ts` (alongside the chat-store block):

```ts
export {
  insertAgent, getAgent, listAgents, updateAgentPane, markAgentResumed,
  finishAgent, newAgentId,
  type AgentRecord, type AgentSurface,
} from "./agents-store.ts";
```

- [ ] **Step 4: Run tests**

Run: `bun test lib/state/__tests__/agents-store.test.ts && bun test lib/state`
Expected: PASS (including existing chat-store and presence tests — the v5 migration must not disturb v4 dbs).

- [ ] **Step 5: Commit**

```bash
git add lib/state/db.ts lib/state/agents-store.ts lib/state/index.ts lib/state/__tests__/agents-store.test.ts
git commit -m "feat(agent): agents table (schema v5) + store"
```

---

### Task 2: claude argv builder + session uuid validation

**Files:**
- Create: `lib/agent-argv.ts`
- Test: `lib/__tests__/agent-argv.test.ts`

**Interfaces:**
- Consumes: nothing rt-specific (pure module; `Bun.which` only inside `resolveClaudeBin`).
- Produces (Tasks 3, 5, 7 depend on these exact names):
  ```ts
  export function isValidSessionUuid(s: string): boolean;
  export function shellSingleQuote(s: string): string;
  export interface ClaudeInvocation {
    account?: string; model?: string; effort?: string; extraArgs?: string;
    session: { kind: "start"; sessionId: string } | { kind: "resume"; sessionId: string };
    headless: boolean; prompt?: string;
  }
  export function buildClaudeArgv(inv: ClaudeInvocation, bins?: { claude?: string; cswap?: string }): string[];
  export function buildPaneCommand(cwd: string, inv: ClaudeInvocation): string;
  export function resolveClaudeBin(): string;   // Bun.which("claude") ?? ~/.local/bin/claude
  export function resolveCswapBin(): string;    // Bun.which("cswap")  ?? ~/.local/bin/cswap
  ```

- [ ] **Step 1: Write the failing test**

`lib/__tests__/agent-argv.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildClaudeArgv, buildPaneCommand, isValidSessionUuid, shellSingleQuote } from "../agent-argv.ts";

const UUID = "6e225e74-4cb7-4aea-8807-6aa9011d4112";

describe("isValidSessionUuid", () => {
  test("accepts a v4 uuid, rejects the spike footguns", () => {
    expect(isValidSessionUuid(UUID)).toBe(true);
    expect(isValidSessionUuid("")).toBe(false);
    expect(isValidSessionUuid("ag-12345678")).toBe(false);
    expect(isValidSessionUuid("6E225E74-4CB7-4AEA-8807-6AA9011D4112")).toBe(true);
  });
});

describe("buildClaudeArgv", () => {
  const bins = { claude: "/abs/claude", cswap: "/abs/cswap" };

  test("plain start, pane surface", () => {
    expect(buildClaudeArgv({ session: { kind: "start", sessionId: UUID }, headless: false }, bins))
      .toEqual(["/abs/claude", "--session-id", UUID]);
  });

  test("all knobs, headless start with prompt", () => {
    expect(buildClaudeArgv({
      account: "a@b.c", model: "haiku", effort: "low", extraArgs: "--permission-mode plan",
      session: { kind: "start", sessionId: UUID }, headless: true, prompt: "do it",
    }, bins)).toEqual([
      "/abs/cswap", "run", "a@b.c", "--",
      "-p", "--output-format", "json",
      "--model", "haiku", "--effort", "low", "--session-id", UUID,
      "--permission-mode", "plan", "do it",
    ]);
  });

  test("resume never emits --session-id", () => {
    const argv = buildClaudeArgv({ session: { kind: "resume", sessionId: UUID }, headless: true, prompt: "q" }, bins);
    expect(argv).toEqual(["/abs/claude", "-p", "--output-format", "json", "--resume", UUID, "q"]);
    expect(argv).not.toContain("--session-id");
  });

  test("invalid uuid throws before any argv exists", () => {
    expect(() => buildClaudeArgv({ session: { kind: "start", sessionId: "" }, headless: false }, bins)).toThrow(/session uuid/);
    expect(() => buildClaudeArgv({ session: { kind: "resume", sessionId: "" }, headless: true, prompt: "x" }, bins)).toThrow(/session uuid/);
  });

  test("headless without a prompt throws", () => {
    expect(() => buildClaudeArgv({ session: { kind: "start", sessionId: UUID }, headless: true }, bins)).toThrow(/prompt/);
  });

  test("cswap surface uses bare claude args after --", () => {
    const argv = buildClaudeArgv({ account: "a@b.c", session: { kind: "start", sessionId: UUID }, headless: false }, bins);
    expect(argv.slice(0, 4)).toEqual(["/abs/cswap", "run", "a@b.c", "--"]);
    expect(argv).not.toContain("/abs/claude");
  });
});

describe("buildPaneCommand", () => {
  test("cd + invocation + quoted prompt; pane uses bare binary names", () => {
    const cmd = buildPaneCommand("/repo dir", {
      model: "haiku",
      session: { kind: "start", sessionId: UUID }, headless: false, prompt: "hi 'there'",
    });
    expect(cmd).toBe(`cd '/repo dir' && claude '--model' 'haiku' '--session-id' '${UUID}' 'hi '\\''there'\\'''`);
  });

  test("resume without prompt ends at the session id", () => {
    const cmd = buildPaneCommand("/r", { session: { kind: "resume", sessionId: UUID }, headless: false });
    expect(cmd).toBe(`cd '/r' && claude '--resume' '${UUID}'`);
  });

  test("account prefixes cswap run in the pane string", () => {
    const cmd = buildPaneCommand("/r", { account: "a@b.c", session: { kind: "start", sessionId: UUID }, headless: false });
    expect(cmd).toBe(`cd '/r' && cswap run 'a@b.c' -- '--session-id' '${UUID}'`);
  });
});

test("shellSingleQuote escapes embedded quotes", () => {
  expect(shellSingleQuote("a'b")).toBe(`'a'\\''b'`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/agent-argv.test.ts`
Expected: FAIL — cannot resolve `../agent-argv.ts`.

- [ ] **Step 3: Implement**

`lib/agent-argv.ts`:

```ts
/**
 * lib/agent-argv.ts — pure claude/cswap invocation building for `rt agent`.
 *
 * Session uuids are validated here because the claude CLI fails soft:
 * `--session-id ""` is silently ignored (random id minted) and
 * `-p --resume ""` silently resumes the most recent session in cwd
 * (spike 2026-08-25). Headless without a prompt blocks on stdin, so it is
 * refused at build time.
 *
 * Two output shapes: argv arrays for daemon-side Bun.spawn (absolute bins —
 * executable lookup uses the process-start PATH), and a single shell string
 * for `herdr pane run` (bare names — the pane shell carries the login PATH).
 */

import { homedir } from "os";
import { join } from "path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface ClaudeInvocation {
  account?: string;
  model?: string;
  effort?: string;
  extraArgs?: string;
  session: { kind: "start"; sessionId: string } | { kind: "resume"; sessionId: string };
  headless: boolean;
  prompt?: string;
}

export function resolveClaudeBin(): string {
  return Bun.which("claude") ?? join(process.env.HOME ?? homedir(), ".local", "bin", "claude");
}

export function resolveCswapBin(): string {
  return Bun.which("cswap") ?? join(process.env.HOME ?? homedir(), ".local", "bin", "cswap");
}

function claudeArgs(inv: ClaudeInvocation): string[] {
  if (!isValidSessionUuid(inv.session.sessionId)) {
    throw new Error(`invalid session uuid "${inv.session.sessionId}" — refusing to spawn`);
  }
  if (inv.headless && !inv.prompt) {
    throw new Error("headless launch requires a prompt (claude -p with no prompt blocks on stdin)");
  }
  const args: string[] = [];
  if (inv.headless) args.push("-p", "--output-format", "json");
  if (inv.model) args.push("--model", inv.model);
  if (inv.effort) args.push("--effort", inv.effort);
  if (inv.session.kind === "start") args.push("--session-id", inv.session.sessionId);
  else args.push("--resume", inv.session.sessionId);
  if (inv.extraArgs) args.push(...inv.extraArgs.split(/\s+/).filter(Boolean));
  if (inv.prompt) args.push(inv.prompt);
  return args;
}

export function buildClaudeArgv(inv: ClaudeInvocation, bins?: { claude?: string; cswap?: string }): string[] {
  const args = claudeArgs(inv);
  // `cswap run <acct> --` launches claude itself; after -- come claude ARGS,
  // never the word claude (board README parity).
  if (inv.account) return [bins?.cswap ?? resolveCswapBin(), "run", inv.account, "--", ...args];
  return [bins?.claude ?? resolveClaudeBin(), ...args];
}

export function buildPaneCommand(cwd: string, inv: ClaudeInvocation): string {
  // Every token is quoted, flags included ('--model' is valid shell): a
  // token-class allowlist would misquote a prompt that happens to equal a
  // flag keyword.
  const quoted = claudeArgs(inv).map(shellSingleQuote);
  const head = inv.account ? `cswap run ${shellSingleQuote(inv.account)} --` : "claude";
  return `cd ${shellSingleQuote(cwd)} && ${[head, ...quoted].join(" ")}`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test lib/__tests__/agent-argv.test.ts`
Expected: PASS. If the exact pane-command strings mismatch, fix the implementation, not the pinned strings — they are the contract.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-argv.ts lib/__tests__/agent-argv.test.ts
git commit -m "feat(agent): claude argv builder with session-uuid guards"
```

---

### Task 3: herdr transport (workspace/tab dedup, injectable runner)

**Files:**
- Create: `lib/agent-herdr.ts`
- Test: `lib/__tests__/agent-herdr.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (peer of Task 2).
- Produces (Tasks 5 and 7 depend on these exact names):
  ```ts
  export interface HerdrResult { stdout: string; exitCode: number }
  export type HerdrRunner = (args: string[]) => Promise<HerdrResult>;
  export function defaultHerdrRunner(): HerdrRunner;
  export interface LaunchOutcome { workspaceId: string; tabId: string; paneId: string; focusedExisting: boolean }
  export function launchInWorkspace(
    opts: { workspaceLabel: string; tabLabel: string; paneCommand: string },
    runner?: HerdrRunner,
  ): Promise<LaunchOutcome>;
  export function herdrAgentWait(
    paneId: string, until: string[], timeoutMs: number, runner?: HerdrRunner,
  ): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing test**

`lib/__tests__/agent-herdr.test.ts` — scripted runner asserting exact herdr arg arrays (the board's proven verb sequence):

```ts
import { expect, test } from "bun:test";
import { herdrAgentWait, launchInWorkspace, type HerdrRunner } from "../agent-herdr.ts";

function scripted(responses: Record<string, { stdout: string; exitCode?: number }>) {
  const calls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    calls.push(args);
    const r = responses[args.slice(0, 2).join(" ")] ?? { stdout: "{}" };
    return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
  };
  return { calls, runner };
}

const WS_CREATE = JSON.stringify({
  result: {
    root_pane: { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA" },
    tab: { tab_id: "wA:t1" },
    workspace: { workspace_id: "wA" },
  },
});
const TAB_CREATE = JSON.stringify({
  result: { root_pane: { pane_id: "wA:p2", tab_id: "wA:t2", workspace_id: "wA" } },
});

test("no workspace: create, rename initial tab, pane run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [] } }) },
    "workspace create": { stdout: WS_CREATE },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "cd '/r' && claude" }, runner);
  expect(calls).toEqual([
    ["workspace", "list"],
    ["workspace", "create", "--label", "reviews", "--no-focus"],
    ["tab", "rename", "wA:t1", "!7"],
    ["pane", "run", "wA:p1", "cd '/r' && claude"],
  ]);
  expect(out).toEqual({ workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1", focusedExisting: false });
});

test("workspace exists, tab label free: tab create + pane run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "reviews" }] } }) },
    "tab list": { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "wA:t1", label: "other" }] } }) },
    "tab create": { stdout: TAB_CREATE },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "X" }, runner);
  expect(calls[1]).toEqual(["tab", "list", "--workspace", "wA"]);
  expect(calls[2]).toEqual(["tab", "create", "--workspace", "wA", "--label", "!7", "--no-focus"]);
  expect(calls[3]).toEqual(["pane", "run", "wA:p2", "X"]);
  expect(out.focusedExisting).toBe(false);
});

test("live tab with same label: focus, never re-run", async () => {
  const { calls, runner } = scripted({
    "workspace list": { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "reviews" }] } }) },
    "tab list": { stdout: JSON.stringify({ result: { tabs: [{ tab_id: "wA:t9", label: "!7" }] } }) },
  });
  const out = await launchInWorkspace({ workspaceLabel: "reviews", tabLabel: "!7", paneCommand: "X" }, runner);
  expect(calls.map((c) => c[0])).toEqual(["workspace", "tab", "tab"]);
  expect(calls[2]).toEqual(["tab", "focus", "wA:t9"]);
  expect(out.focusedExisting).toBe(true);
  expect(calls.flat()).not.toContain("run");
});

test("herdr failure propagates as a throw", async () => {
  const runner: HerdrRunner = async () => ({ stdout: "boom", exitCode: 1 });
  await expect(launchInWorkspace({ workspaceLabel: "w", tabLabel: "t", paneCommand: "X" }, runner)).rejects.toThrow(/herdr/);
});

test("herdrAgentWait builds the current verb (agent wait --until)", async () => {
  const { calls, runner } = scripted({ "agent wait": { stdout: "" } });
  await herdrAgentWait("wA:p1", ["idle", "done"], 45000, runner);
  expect(calls[0]).toEqual(["agent", "wait", "wA:p1", "--until", "idle", "--until", "done", "--timeout", "45000"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/agent-herdr.test.ts`
Expected: FAIL — cannot resolve `../agent-herdr.ts`.

- [ ] **Step 3: Implement**

`lib/agent-herdr.ts`:

```ts
/**
 * lib/agent-herdr.ts — herdr transport for `rt agent` (and rebase
 * escalation): workspace find-or-create, tab-label dedup, pane run.
 *
 * Lifted from mr-board src/herdr.ts, which has months of production history
 * with exactly this sequence. Dedup rule: a live tab with the requested
 * label is focused, never re-run — re-invoking an action must not stack a
 * second claude in a fresh pane.
 *
 * herdr is invoked by absolute path with HERDR_SOCKET_PATH set explicitly:
 * under launchd the daemon's start PATH has neither, and Bun.spawn resolves
 * executables from the start env, not runtime process.env.
 */

import { homedir } from "os";
import { join } from "path";
import { runCapture } from "./subprocess.ts";

export interface HerdrResult { stdout: string; exitCode: number }
export type HerdrRunner = (args: string[]) => Promise<HerdrResult>;

export function defaultHerdrRunner(): HerdrRunner {
  const home = process.env.HOME ?? homedir();
  const bin = process.env.HERDR_BIN ?? join(home, ".local", "bin", "herdr");
  const socket = process.env.HERDR_SOCKET_PATH ?? join(home, ".config", "herdr", "herdr.sock");
  return async (args) => {
    const r = await runCapture([bin, ...args], {
      timeoutMs: 15_000,
      stderr: "pipe",
      env: { ...process.env, HERDR_SOCKET_PATH: socket },
    });
    return { stdout: r.stdout || r.stderr, exitCode: r.exitCode };
  };
}

async function herdrJson(runner: HerdrRunner, args: string[]): Promise<any> {
  const r = await runner(args);
  if (r.exitCode !== 0) throw new Error(`herdr ${args.join(" ")} failed (${r.exitCode}): ${r.stdout.slice(0, 400)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

export interface LaunchOutcome {
  workspaceId: string;
  tabId: string;
  paneId: string;
  focusedExisting: boolean;
}

export async function launchInWorkspace(
  opts: { workspaceLabel: string; tabLabel: string; paneCommand: string },
  runner: HerdrRunner = defaultHerdrRunner(),
): Promise<LaunchOutcome> {
  const list = await herdrJson(runner, ["workspace", "list"]);
  const workspaces: any[] = list?.result?.workspaces ?? [];
  const existing = workspaces.find((w) => w?.label === opts.workspaceLabel);

  if (!existing) {
    // A fresh workspace ships with an initial tab; reuse it instead of
    // orphaning a blank one.
    const created = await herdrJson(runner, ["workspace", "create", "--label", opts.workspaceLabel, "--no-focus"]);
    const root = created?.result?.root_pane;
    if (!root?.pane_id) throw new Error("herdr workspace create returned no root pane");
    await runner(["tab", "rename", root.tab_id, opts.tabLabel]);
    await runner(["pane", "run", root.pane_id, opts.paneCommand]);
    return { workspaceId: root.workspace_id, tabId: root.tab_id, paneId: root.pane_id, focusedExisting: false };
  }

  const wsId: string = existing.workspace_id;
  const tabs = await herdrJson(runner, ["tab", "list", "--workspace", wsId]);
  const match = (tabs?.result?.tabs ?? []).find((t: any) => t?.label === opts.tabLabel);
  if (match) {
    await runner(["tab", "focus", match.tab_id]);
    return { workspaceId: wsId, tabId: match.tab_id, paneId: "", focusedExisting: true };
  }

  const created = await herdrJson(runner, ["tab", "create", "--workspace", wsId, "--label", opts.tabLabel, "--no-focus"]);
  const root = created?.result?.root_pane;
  if (!root?.pane_id) throw new Error("herdr tab create returned no root pane");
  await runner(["pane", "run", root.pane_id, opts.paneCommand]);
  return { workspaceId: wsId, tabId: root.tab_id, paneId: root.pane_id, focusedExisting: false };
}

export async function herdrAgentWait(
  paneId: string,
  until: string[],
  timeoutMs: number,
  runner: HerdrRunner = defaultHerdrRunner(),
): Promise<boolean> {
  const args = ["agent", "wait", paneId];
  for (const u of until) args.push("--until", u);
  args.push("--timeout", String(timeoutMs));
  const r = await runner(args);
  return r.exitCode === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test lib/__tests__/agent-herdr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent-herdr.ts lib/__tests__/agent-herdr.test.ts
git commit -m "feat(agent): herdr transport with tab-label dedup"
```

---

### Task 4: rt-client catalog rows, wrappers, and agent.* settings

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (4 rows + COMMAND_NAMES + AgentRecord type)
- Modify: `packages/rt-client/src/client.ts` (4 wrappers)
- Modify: `packages/rt-client/src/index.ts` (barrel exports)
- Modify: `packages/rt-client/src/settings/registry-defs.ts` (agent.* block)
- Test: `packages/rt-client/test/agent-wrappers.test.ts`

**Interfaces:**
- Consumes: `rtCommand` from `packages/rt-client/src/transport.ts`.
- Produces (Tasks 5 and 6 depend on these exact shapes):
  ```ts
  // commands.ts
  export type AgentSurface = "herdr" | "headless";
  export interface AgentRecord { /* identical fields to Task 1's AgentRecord */ }
  "agent:start":  { payload: { repo: string; cwd: string; prompt?: string; surface?: AgentSurface; model?: string; effort?: string; account?: string; label?: string; caller?: string; workspace?: string; tab?: string; extraArgs?: string }; data: AgentRecord };
  "agent:resume": { payload: { id: string; prompt?: string; surface?: AgentSurface }; data: AgentRecord };
  "agent:get":    { payload: { id: string }; data: AgentRecord };
  "agent:list":   { payload: { repo?: string }; data: { agents: AgentRecord[] } };
  // client.ts — all with (a, o: RtClientOptions = {}) and timeoutMs 30_000
  export function agentStart(a: Commands["agent:start"]["payload"], o?): Promise<RtResponse<AgentRecord>>;
  export function agentResume(a: Commands["agent:resume"]["payload"], o?): Promise<RtResponse<AgentRecord>>;
  export function agentGet(a: { id: string }, o?): Promise<RtResponse<AgentRecord>>;
  export function agentList(a: { repo?: string }, o?): Promise<RtResponse<{ agents: AgentRecord[] }>>;
  ```

- [ ] **Step 1: Write the failing test**

`packages/rt-client/test/agent-wrappers.test.ts` (module-shape test; the daemon-side coverage test in Task 5 proves wiring):

```ts
import { expect, test } from "bun:test";
import { agentGet, agentList, agentResume, agentStart, COMMAND_NAMES } from "../src/index.ts";

test("agent wrappers are exported functions", () => {
  for (const fn of [agentStart, agentResume, agentGet, agentList]) {
    expect(typeof fn).toBe("function");
  }
});

test("agent commands are cataloged", () => {
  for (const name of ["agent:start", "agent:resume", "agent:get", "agent:list"]) {
    expect(COMMAND_NAMES).toContain(name);
  }
});

test("wrappers degrade to ok:false with no daemon", async () => {
  const res = await agentGet({ id: "ag-00000000" }, { sockPath: "/nonexistent/rt.sock" });
  expect(res.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rt-client && bun test test/agent-wrappers.test.ts`
Expected: FAIL — `agentStart` is not exported.

- [ ] **Step 3: Implement**

In `packages/rt-client/src/commands.ts`, near the chat types, add:

```ts
export type AgentSurface = "herdr" | "headless";

export interface AgentRecord {
  id: string; repo: string; cwd: string; provider: string;
  surface: AgentSurface; sessionId: string;
  model?: string; effort?: string; account?: string;
  label?: string; caller?: string;
  paneId?: string; tabId?: string; workspaceId?: string;
  extraArgs?: string; exitCode?: number; resultPath?: string;
  createdAt: number; lastResumedAt?: number; finishedAt?: number;
}
```

Add the four rows inside `interface Commands` (one line each, chat style) and the four names to `COMMAND_NAMES`, both exactly as in the Interfaces block above.

In `packages/rt-client/src/client.ts` add a section:

```ts
// ─── Agent handoff (rt agent) ─────────────────────────────────────────────

export function agentStart(
  a: Commands["agent:start"]["payload"], o: RtClientOptions = {},
): Promise<RtResponse<AgentRecord>> {
  const payload: Record<string, unknown> = { repo: a.repo, cwd: a.cwd };
  for (const k of ["prompt", "surface", "model", "effort", "account", "label", "caller", "workspace", "tab", "extraArgs"] as const) {
    if (a[k] !== undefined) payload[k] = a[k];
  }
  return rtCommand<AgentRecord>("agent:start", payload, { sockPath: o.sockPath, timeoutMs: 30_000 });
}

export function agentResume(
  a: Commands["agent:resume"]["payload"], o: RtClientOptions = {},
): Promise<RtResponse<AgentRecord>> {
  const payload: Record<string, unknown> = { id: a.id };
  if (a.prompt !== undefined) payload.prompt = a.prompt;
  if (a.surface !== undefined) payload.surface = a.surface;
  return rtCommand<AgentRecord>("agent:resume", payload, { sockPath: o.sockPath, timeoutMs: 30_000 });
}

export function agentGet(a: { id: string }, o: RtClientOptions = {}): Promise<RtResponse<AgentRecord>> {
  return rtCommand<AgentRecord>("agent:get", { id: a.id }, { sockPath: o.sockPath, timeoutMs: 10_000 });
}

export function agentList(a: { repo?: string }, o: RtClientOptions = {}): Promise<RtResponse<{ agents: AgentRecord[] }>> {
  const payload: Record<string, unknown> = {};
  if (a.repo !== undefined) payload.repo = a.repo;
  return rtCommand<{ agents: AgentRecord[] }>("agent:list", payload, { sockPath: o.sockPath, timeoutMs: 10_000 });
}
```

(add `AgentRecord` to the type imports from `./commands.ts` at the top). Export from `packages/rt-client/src/index.ts`: `agentStart, agentResume, agentGet, agentList` in the function block; `AgentRecord, AgentSurface` in the `export type` block.

In `packages/rt-client/src/settings/registry-defs.ts`, after the chat block:

```ts
  // --- agent (rt agent handoff) --------------------------------------------
  // No defaults by design: an unset key means the flag is omitted from the
  // claude invocation entirely (spec "Settings").
  {
    key: "agent.model",
    type: "string",
    scopes: ["user", "machine"],
    merge: "replace",
    description: "Default --model for rt agent launches; unset omits the flag.",
  },
  {
    key: "agent.effort",
    type: "string",
    scopes: ["user", "machine"],
    merge: "replace",
    description: "Default --effort for rt agent launches; unset omits the flag.",
  },
  {
    key: "agent.account",
    type: "string",
    scopes: ["user", "machine"],
    merge: "replace",
    description: "cswap account email rt agent launches under; unset uses the default claude profile.",
  },
  {
    key: "agent.extraArgs",
    type: "string",
    scopes: ["user", "machine"],
    merge: "replace",
    description: "Opaque extra claude arguments appended to every rt agent launch (escape hatch).",
  },
```

- [ ] **Step 4: Run tests and rebuild dist**

Run: `cd packages/rt-client && bun test && bun run build`
Expected: PASS, including `dist-freshness.test.ts` after the build. The build is not optional — file: consumers copy dist verbatim.

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client
git commit -m "feat(agent): rt-client agent:* catalog, wrappers, agent.* settings"
```

---

### Task 5: daemon handlers agent:start/resume/get/list

**Files:**
- Create: `lib/daemon/handlers/agent.ts`
- Modify: `lib/daemon/command-router.ts` (import + spread; reuse `opts.chatDb`, renamed `stateDb`)
- Modify: `lib/daemon.ts:411` (`chatDb:` → `stateDb:` at the `buildRoutedHandlers` call)
- Test: `lib/daemon/__tests__/agent-handlers.test.ts`

**Interfaces:**
- Consumes: Task 1 store functions; Task 2 `buildClaudeArgv`/`buildPaneCommand`/`isValidSessionUuid`; Task 3 `launchInWorkspace`/`HerdrRunner`; `getSetting` from `lib/settings/resolve.ts`; `repoLabel` from `lib/repo-arg.ts`; `rtDir` from `lib/rt-paths.ts`; `Commands`/`CommandResult`/`TypedHandlers` from `lib/daemon/handlers/types.ts`.
- Produces:
  ```ts
  export function createAgentHandlers(opts: {
    db: Database;
    emitEvent: (topic: string, payload?: unknown) => unknown;
    herdrRunner?: HerdrRunner;                                      // test seam
    spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild; // test seam
  }): Pick<TypedHandlers, "agent:start" | "agent:resume" | "agent:get" | "agent:list"> & { db: Database };
  export interface HeadlessChild { exited: Promise<number>; stdout: () => Promise<string> }
  ```
  Registered command names: `agent:start`, `agent:resume`, `agent:get`, `agent:list`. Headless completion emits topic `agent/done/<id>` with payload `{ exitCode }`.

- [ ] **Step 1: Write the failing test**

`lib/daemon/__tests__/agent-handlers.test.ts` (pattern: `chat-handlers.test.ts`):

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createAgentHandlers, type HeadlessChild } from "../handlers/agent.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";

let n = 0;
const REPO = "remote:example.com%2Fa%2Fb";

function okRunner(calls: string[][]): HerdrRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") return { stdout: JSON.stringify({ result: { workspaces: [] } }), exitCode: 0 };
    if (args[0] === "workspace" && args[1] === "create")
      return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }), exitCode: 0 };
    return { stdout: "{}", exitCode: 0 };
  };
}

function fresh(over: { runner?: HerdrRunner; spawn?: (argv: string[], cwd: string) => HeadlessChild; emit?: (t: string, p?: unknown) => void } = {}) {
  const db = openStateDb(join(tmpdir(), `agent-h-${process.pid}-${n++}.db`));
  return createAgentHandlers({
    db,
    emitEvent: over.emit ?? (() => 0),
    herdrRunner: over.runner,
    spawnHeadless: over.spawn,
  });
}

test("agent:start herdr records pane ids and a minted session uuid", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", model: "haiku" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.data).toMatchObject({ surface: "herdr", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", model: "haiku" });
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`--session-id '${res.data.sessionId}'`);
  expect(paneRun?.[3]).toContain("cd '/tmp/x'");
});

test("agent:start headless refuses a missing prompt", async () => {
  const h = fresh();
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/prompt/);
});

test("agent:start headless finishes the record and emits agent/done", async () => {
  const emitted: string[] = [];
  let resolveExit!: (c: number) => void;
  const child: HeadlessChild = {
    exited: new Promise<number>((r) => (resolveExit = r)),
    stdout: async () => JSON.stringify({ result: "ok" }),
  };
  const h = fresh({ spawn: () => child, emit: (t) => emitted.push(t) });
  const res = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", surface: "headless", prompt: "go" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.finishedAt).toBeUndefined();
  resolveExit(0);
  await new Promise((r) => setTimeout(r, 20));
  const got = await h["agent:get"]({ id: res.data.id });
  if (!got.ok) throw new Error("unreachable");
  expect(got.data.exitCode).toBe(0);
  expect(got.data.resultPath).toBeTruthy();
  expect(emitted).toContain(`agent/done/${res.data.id}`);
});

test("agent:resume herdr uses ↺ tab label and --resume, overwrites pane ids", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", label: "job7" });
  if (!started.ok) throw new Error("unreachable");
  calls.length = 0;
  const resumed = await h["agent:resume"]({ id: started.data.id });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) throw new Error("unreachable");
  const tabArg = calls.find((c) => c[0] === "tab" && c[1] === "rename")?.[3] ?? calls.find((c) => c[1] === "create" && c[0] === "tab")?.[5];
  expect(tabArg).toBe("↺ job7");
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run");
  expect(paneRun?.[3]).toContain(`'--resume' '${started.data.sessionId}'`);
  expect(paneRun?.[3]).not.toContain("--session-id");
  expect(resumed.data.lastResumedAt).toBeGreaterThan(0);
});

test("agent:resume headless without prompt is refused; unknown id errors", async () => {
  const h = fresh();
  const missing = await h["agent:resume"]({ id: "ag-ffffffff" });
  expect(missing.ok).toBe(false);
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" });
  if (!started.ok) throw new Error("unreachable");
  const res = await h["agent:resume"]({ id: started.data.id, surface: "headless" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toMatch(/prompt/);
});

test("agent:list filters by repo", async () => {
  const h = fresh({ runner: okRunner([]) });
  await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "a", surface: "herdr" });
  await h["agent:start"]({ repo: "remote:other%2Fr", cwd: "/tmp/y", prompt: "b", surface: "herdr", tab: "t2" });
  const res = await h["agent:list"]({ repo: REPO });
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.agents).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/agent-handlers.test.ts`
Expected: FAIL — cannot resolve `../handlers/agent.ts`.

- [ ] **Step 3: Implement the handler module**

`lib/daemon/handlers/agent.ts`:

```ts
/**
 * agent:* — daemon handlers for `rt agent` (launch + record + resume; no
 * liveness by design — spec 2026-08-25).
 *
 * Session uuids are minted here and validated in lib/agent-argv.ts before
 * any spawn; resume always runs under the RECORDED account because claude
 * transcripts are per-cswap-profile.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import {
  finishAgent, getAgent, insertAgent, listAgents, markAgentResumed,
  newAgentId, updateAgentPane, type AgentRecord, type AgentSurface,
} from "../../state/index.ts";
import { buildClaudeArgv, buildPaneCommand, type ClaudeInvocation } from "../../agent-argv.ts";
import { defaultHerdrRunner, launchInWorkspace, type HerdrRunner } from "../../agent-herdr.ts";
import { repoLabel } from "../../repo-arg.ts";
import { getSetting } from "../../settings/resolve.ts";
import { rtDir } from "../../rt-paths.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

export interface HeadlessChild {
  exited: Promise<number>;
  stdout: () => Promise<string>;
}

function defaultSpawnHeadless(argv: string[], cwd: string): HeadlessChild {
  const proc = Bun.spawn(argv as [string, ...string[]], {
    cwd,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    exited: proc.exited,
    stdout: () => new Response(proc.stdout).text(),
  };
}

function fromSetting(key: string): string | undefined {
  try {
    return getSetting<string>(key).value ?? undefined;
  } catch {
    return undefined;
  }
}

export function createAgentHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
  herdrRunner?: HerdrRunner;
  spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild;
}): Pick<TypedHandlers, "agent:start" | "agent:resume" | "agent:get" | "agent:list"> & { db: Database } {
  const { db, emitEvent } = opts;
  const spawnHeadless = opts.spawnHeadless ?? defaultSpawnHeadless;

  async function launch(
    rec: AgentRecord,
    session: ClaudeInvocation["session"],
    prompt: string | undefined,
    tabLabel: string,
    workspaceLabel: string,
  ): Promise<CommandResult<"agent:start">> {
    const inv: ClaudeInvocation = {
      session,
      headless: rec.surface === "headless",
      ...(rec.account !== undefined && { account: rec.account }),
      ...(rec.model !== undefined && { model: rec.model }),
      ...(rec.effort !== undefined && { effort: rec.effort }),
      ...(rec.extraArgs !== undefined && { extraArgs: rec.extraArgs }),
      ...(prompt !== undefined && { prompt }),
    };

    if (rec.surface === "herdr") {
      const runner = opts.herdrRunner ?? defaultHerdrRunner();
      const out = await launchInWorkspace(
        { workspaceLabel, tabLabel, paneCommand: buildPaneCommand(rec.cwd, inv) },
        runner,
      );
      if (!out.focusedExisting) {
        rec.paneId = out.paneId;
        rec.tabId = out.tabId;
        rec.workspaceId = out.workspaceId;
      }
      return { ok: true, data: rec };
    }

    const argv = buildClaudeArgv(inv);
    const resultPath = join(rtDir(), "agents", `${rec.id}.json`);
    mkdirSync(dirname(resultPath), { recursive: true });
    const child = spawnHeadless(argv, rec.cwd);
    rec.resultPath = resultPath;
    void child.exited.then(async (exitCode) => {
      try {
        writeFileSync(resultPath, await child.stdout());
      } catch { /* result body is best-effort; the exit code is the record */ }
      finishAgent(rec.id, { exitCode, resultPath, finishedAt: Date.now() }, db);
      emitEvent(`agent/done/${rec.id}`, { exitCode });
    });
    return { ok: true, data: rec };
  }

  return {
    db,

    "agent:start": async (payload: Commands["agent:start"]["payload"]): Promise<CommandResult<"agent:start">> => {
      const { repo, cwd } = payload;
      if (!repo || !cwd) return { ok: false, error: "agent:start requires repo (serialized identity) and cwd" };
      const surface: AgentSurface = payload.surface ?? "herdr";
      const prompt = payload.prompt;
      if (surface === "headless" && !prompt) {
        return { ok: false, error: "headless launch requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      const rec: AgentRecord = {
        id: newAgentId(),
        repo, cwd, provider: "claude", surface,
        sessionId: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      const model = payload.model ?? fromSetting("agent.model");
      const effort = payload.effort ?? fromSetting("agent.effort");
      const account = payload.account ?? fromSetting("agent.account");
      const extraArgs = payload.extraArgs ?? fromSetting("agent.extraArgs");
      if (model !== undefined) rec.model = model;
      if (effort !== undefined) rec.effort = effort;
      if (account !== undefined) rec.account = account;
      if (extraArgs !== undefined) rec.extraArgs = extraArgs;
      if (payload.label !== undefined) rec.label = payload.label;
      if (payload.caller !== undefined) rec.caller = payload.caller;

      const tabLabel = payload.tab ?? rec.label ?? rec.id;
      const workspaceLabel = payload.workspace ?? repoLabel(repo);
      try {
        const res = await launch(rec, { kind: "start", sessionId: rec.sessionId }, prompt, tabLabel, workspaceLabel);
        if (res.ok) insertAgent(rec, db);
        return res;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "agent:resume": async (payload: Commands["agent:resume"]["payload"]): Promise<CommandResult<"agent:resume">> => {
      const rec = getAgent(payload.id, db);
      if (!rec) return { ok: false, error: `no agent record for "${payload.id}"` };
      const surface: AgentSurface = payload.surface ?? rec.surface;
      if (surface === "headless" && !payload.prompt) {
        return { ok: false, error: "headless resume requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      // ↺ prefix: resume tabs must never dedup against the still-open launch
      // tab; repeated resumes share the label and dedup against each other.
      const tabLabel = `↺ ${rec.label ?? rec.id}`;
      const workspaceLabel = repoLabel(rec.repo);
      const attempt: AgentRecord = { ...rec, surface };
      try {
        const res = await launch(attempt, { kind: "resume", sessionId: rec.sessionId }, payload.prompt, tabLabel, workspaceLabel);
        if (!res.ok) return res;
        const now = Date.now();
        markAgentResumed(rec.id, now, db);
        if (surface === "herdr" && attempt.paneId && attempt.tabId && attempt.workspaceId) {
          updateAgentPane(rec.id, { paneId: attempt.paneId, tabId: attempt.tabId, workspaceId: attempt.workspaceId }, db);
        }
        return { ok: true, data: { ...(getAgent(rec.id, db) ?? attempt) } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "agent:get": async (payload: Commands["agent:get"]["payload"]): Promise<CommandResult<"agent:get">> => {
      const rec = getAgent(payload.id, db);
      return rec ? { ok: true, data: rec } : { ok: false, error: `no agent record for "${payload.id}"` };
    },

    "agent:list": async (payload: Commands["agent:list"]["payload"]): Promise<CommandResult<"agent:list">> => {
      return { ok: true, data: { agents: listAgents({ ...(payload.repo !== undefined && { repo: payload.repo }) }, db) } };
    },
  };
}
```

In `lib/daemon/command-router.ts`: rename the `chatDb` opt to `stateDb` (update its docblock to say "state.db, for chat:* and agent:* handlers"), add `import { createAgentHandlers } from "./handlers/agent.ts";`, destructure `const { db: _agentDb, ...agentHandlers } = createAgentHandlers({ db: opts.stateDb, emitEvent });` next to the chat line, and spread `...agentHandlers,` after `...chatHandlers,`. In `lib/daemon.ts` change `chatDb: getStateDb("daemon"),` to `stateDb: getStateDb("daemon"),`. Update the `rt-client-commands.test.ts` stub (`chatDb:` → `stateDb:`).

- [ ] **Step 4: Run tests**

Run: `bun test lib/daemon/__tests__/agent-handlers.test.ts && bun test lib/daemon`
Expected: PASS — including `rt-client-commands.test.ts`, which now proves every `agent:*` catalog row resolves to a handler.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/handlers/agent.ts lib/daemon/command-router.ts lib/daemon.ts lib/daemon/__tests__/agent-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts
git commit -m "feat(agent): daemon handlers agent:start/resume/get/list"
```

---

### Task 6: CLI verb commands/agent.ts

**Files:**
- Create: `commands/agent.ts`
- Modify: `lib/command-tree-def.ts` (new `agent` node)
- Modify: `lib/module-registry.ts` (thunk entry)
- Test: `commands/__tests__/agent.test.ts`

**Interfaces:**
- Consumes: `agentStart/agentResume/agentGet/agentList` + `AgentRecord` from `packages/rt-client/src/index.ts` (Task 4); `resolveRepoArg`, `currentRepoIdentity`, `repoLabel` from `lib/repo-arg.ts`; `serializeIdentity`/`deriveRepoIdentity` via `resolveRepoArg` only.
- Produces: `export async function agent(args: string[]): Promise<void>` — self-dispatching leaf (chat pattern); exit 1 on any failure via `fail()`.

- [ ] **Step 1: Write the failing test**

`commands/__tests__/agent.test.ts` — pure-function coverage of the argv layer via a `__test__` seam (daemon calls are covered by Task 5 and e2e):

```ts
import { describe, expect, test } from "bun:test";
import { __test__ } from "../agent.ts";

const { parseStartArgs, parseResumeArgs } = __test__;

describe("parseStartArgs", () => {
  test("full flag set", () => {
    const p = parseStartArgs([
      "--prompt", "do it", "--surface", "headless", "--model", "haiku",
      "--effort", "low", "--account", "a@b.c", "--label", "job7",
      "--caller", "board:review", "--workspace", "reviews", "--tab", "!7",
      "--extra-args", "--permission-mode plan",
    ]);
    expect(p).toEqual({
      prompt: "do it", surface: "headless", model: "haiku", effort: "low",
      account: "a@b.c", label: "job7", caller: "board:review",
      workspace: "reviews", tab: "!7", extraArgs: "--permission-mode plan",
    });
  });

  test("bad surface fails", () => {
    expect(() => parseStartArgs(["--surface", "tmux"])).toThrow(/surface/);
  });

  test("--prompt-file reads the file", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-prompt-${process.pid}.txt`;
    require("fs").writeFileSync(path, "from file");
    expect(parseStartArgs(["--prompt-file", path]).prompt).toBe("from file");
  });

  test("--prompt and --prompt-file together fail", () => {
    expect(() => parseStartArgs(["--prompt", "a", "--prompt-file", "/x"])).toThrow(/one of/);
  });
});

describe("parseResumeArgs", () => {
  test("id positional + optional prompt/surface", () => {
    expect(parseResumeArgs(["ag-12345678", "--prompt", "next", "--surface", "herdr"]))
      .toEqual({ id: "ag-12345678", prompt: "next", surface: "herdr" });
  });
  test("missing id fails", () => {
    expect(() => parseResumeArgs(["--prompt", "x"])).toThrow(/id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test commands/__tests__/agent.test.ts`
Expected: FAIL — cannot resolve `../agent.ts`.

- [ ] **Step 3: Implement**

`commands/agent.ts`:

```ts
/**
 * rt agent — hand a prompt to a Claude Code agent and keep the receipt.
 *
 *   rt agent start  [--repo <path>] [--prompt <text> | --prompt-file <path>]
 *                   [--surface herdr|headless] [--model M] [--effort E]
 *                   [--account A] [--label L] [--caller C]
 *                   [--workspace W] [--tab T] [--extra-args "<tail>"] [--json]
 *   rt agent resume <id|session-uuid> [--prompt <text>] [--surface herdr|headless] [--json]
 *   rt agent show   <id|session-uuid> [--json]
 *   rt agent list   [--repo <path>] [--json]
 *
 * Thin client over agent:* daemon handlers; the daemon owns spawning,
 * session-uuid minting, and the record. Spec:
 * docs/superpowers/specs/2026-08-25-rt-agent-handoff-design.md
 */

import { readFileSync, realpathSync } from "fs";
import { currentRepoIdentity, repoLabel, resolveRepoArg } from "../lib/repo-arg.ts";
import {
  agentGet, agentList, agentResume, agentStart,
  type AgentRecord, type AgentSurface,
} from "../packages/rt-client/src/index.ts";
import type { RtResponse } from "../packages/rt-client/src/index.ts";

const FLAGS_WITH_VALUES = new Set([
  "--repo", "--prompt", "--prompt-file", "--surface", "--model", "--effort",
  "--account", "--label", "--caller", "--workspace", "--tab", "--extra-args",
]);

function fail(msg: string): never {
  console.error(`rt agent: ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed — is the rt daemon running?`);
  return res.data;
}

function parseSurface(s: string | undefined): AgentSurface | undefined {
  if (s === undefined) return undefined;
  if (s !== "herdr" && s !== "headless") throw new Error(`invalid surface "${s}" — herdr | headless`);
  return s;
}

interface StartArgs {
  prompt?: string; surface?: AgentSurface; model?: string; effort?: string;
  account?: string; label?: string; caller?: string; workspace?: string;
  tab?: string; extraArgs?: string;
}

function parseStartArgs(args: string[]): StartArgs {
  const prompt = flagValue(args, "--prompt");
  const promptFile = flagValue(args, "--prompt-file");
  if (prompt !== undefined && promptFile !== undefined) throw new Error("pass one of --prompt / --prompt-file, not both");
  const out: StartArgs = {};
  const resolved = promptFile !== undefined ? readFileSync(promptFile, "utf8").trim() : prompt;
  if (resolved !== undefined) out.prompt = resolved;
  const surface = parseSurface(flagValue(args, "--surface"));
  if (surface !== undefined) out.surface = surface;
  for (const [flag, key] of [
    ["--model", "model"], ["--effort", "effort"], ["--account", "account"],
    ["--label", "label"], ["--caller", "caller"], ["--workspace", "workspace"],
    ["--tab", "tab"], ["--extra-args", "extraArgs"],
  ] as const) {
    const v = flagValue(args, flag);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function parseResumeArgs(args: string[]): { id: string; prompt?: string; surface?: AgentSurface } {
  const id = positional(args);
  if (!id) throw new Error("missing id — rt agent resume <id|session-uuid>");
  const out: { id: string; prompt?: string; surface?: AgentSurface } = { id };
  const prompt = flagValue(args, "--prompt");
  if (prompt !== undefined) out.prompt = prompt;
  const surface = parseSurface(flagValue(args, "--surface"));
  if (surface !== undefined) out.surface = surface;
  return out;
}

async function repoAndCwd(args: string[]): Promise<{ repo: string; cwd: string }> {
  const repoArg = flagValue(args, "--repo");
  if (repoArg) {
    // start/resume need a real cwd, so --repo must be a directory here;
    // list accepts names because it never derives a cwd.
    let cwd: string;
    try {
      cwd = realpathSync(repoArg);
    } catch {
      fail(`--repo must be a directory path for this verb, got "${repoArg}"`);
    }
    return { repo: await resolveRepoArg(repoArg, fail), cwd };
  }
  const identity = currentRepoIdentity();
  if (!identity) fail("not inside a repo — pass --repo <path>");
  return { repo: identity, cwd: process.cwd() };
}

function renderRecord(r: AgentRecord): string {
  const bits = [
    `${r.id}  ${repoLabel(r.repo)}  ${r.surface}`,
    `session ${r.sessionId}`,
    r.model && `model ${r.model}`,
    r.account && `account ${r.account}`,
    r.paneId && `pane ${r.paneId}`,
    r.finishedAt !== undefined && `exit ${r.exitCode}`,
    r.lastResumedAt !== undefined && "resumed",
  ].filter(Boolean);
  return bits.join("  ·  ");
}

async function runStart(args: string[]): Promise<void> {
  let parsed: StartArgs;
  try {
    parsed = parseStartArgs(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { repo, cwd } = await repoAndCwd(args);
  const data = unwrap(await agentStart({ repo, cwd, ...parsed }), "start");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runResume(args: string[]): Promise<void> {
  let parsed: { id: string; prompt?: string; surface?: AgentSurface };
  try {
    parsed = parseResumeArgs(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const data = unwrap(await agentResume(parsed), "resume");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runShow(args: string[]): Promise<void> {
  const id = positional(args);
  if (!id) fail("missing id — rt agent show <id|session-uuid>");
  const data = unwrap(await agentGet({ id }), "show");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runList(args: string[]): Promise<void> {
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRepoArg(repoArg, fail) : currentRepoIdentity();
  const data = unwrap(await agentList(repo ? { repo } : {}), "list");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agents: data.agents }));
    return;
  }
  if (data.agents.length === 0) {
    console.log("no agent handoffs recorded");
    return;
  }
  for (const r of data.agents) console.log(renderRecord(r));
}

const USAGE = "usage: rt agent <start|resume|show|list> ...";

const VERBS: Record<string, (args: string[]) => Promise<void>> = {
  start: runStart, resume: runResume, show: runShow, list: runList,
};

export async function agent(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (!verb) fail(USAGE);
  const handler = VERBS[verb];
  if (!handler) fail(`unknown verb "${verb}" — ${USAGE}`);
  await handler(rest);
}

export const __test__ = { parseStartArgs, parseResumeArgs };
```

Add to `lib/command-tree-def.ts` (alphabetical near `chat`):

```ts
  // Self-dispatching leaf: agent() routes its own verbs (start/resume/show/list).
  agent: {
    description: "Hand a prompt to a Claude Code agent (herdr pane or headless) and keep the receipt",
    module: "./commands/agent.ts",
    fn: "agent",
    args: [
      { name: "Verb", type: "text", placeholder: "start | resume | show | list", hint: "The agent action to run" },
      { name: "Id", type: "text", placeholder: "ag-1a2b3c4d", hint: "For resume/show: the handoff id or session uuid" },
      { name: "Repo", flag: "--repo", type: "text", placeholder: "~/Documents/GitHub/x", hint: "Repo path (default: the current repo)" },
      { name: "Prompt", flag: "--prompt", type: "text", placeholder: "…", hint: "Initial prompt (required for headless)" },
      { name: "Surface", flag: "--surface", type: "text", placeholder: "herdr | headless", hint: "Where the agent runs (default herdr)" },
      { name: "Model", flag: "--model", type: "text", placeholder: "sonnet", hint: "Override agent.model" },
      { name: "Account", flag: "--account", type: "text", placeholder: "me@example.com", hint: "cswap account (override agent.account)" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit the record as JSON" },
    ],
  },
```

Add to `lib/module-registry.ts`:

```ts
  "./commands/agent.ts": () => import("../commands/agent.ts"),
```

- [ ] **Step 4: Run tests**

Run: `bun test commands/__tests__/agent.test.ts && bun test lib/__tests__/no-eager-tui.test.ts`
Expected: PASS — the no-eager test proves the new module didn't regress startup.

- [ ] **Step 5: Commit**

```bash
git add commands/agent.ts commands/__tests__/agent.test.ts lib/command-tree-def.ts lib/module-registry.ts
git commit -m "feat(agent): rt agent start/resume/show/list CLI verb"
```

---

### Task 7: migrate rebase escalation off lib/herdr-agent.ts

**Files:**
- Modify: `lib/rebase-escalation.ts` (swap imports; use Task 2 + Task 3 modules)
- Delete: `lib/herdr-agent.ts`
- Modify/Delete tests: update `lib/__tests__/rebase-escalation*.test.ts` expectations; delete `lib/__tests__/herdr-agent.test.ts` if present
- Test: existing rebase-escalation tests

**Interfaces:**
- Consumes: `buildPaneCommand` (Task 2); `launchInWorkspace`, `herdrAgentWait`, `defaultHerdrRunner`, `HerdrRunner` (Task 3).
- Produces: `lib/rebase-escalation.ts` keeps its existing exported API unchanged (`resolveEscalationMode`, `runEscalationFlow`, …) — callers `commands/sync.ts:448` and `commands/git/rebase.ts:512` must not change.

- [ ] **Step 1: Establish the red baseline**

Run: `bun test lib/__tests__ -t escalation`
Read `lib/rebase-escalation.ts:20-27` (the herdr-agent imports) and the test file's fakes. The migration below must keep every existing test green or update fakes mechanically (same behavior, new seam).

- [ ] **Step 2: Rewire the spawn path**

In `lib/rebase-escalation.ts`, replace the `lib/herdr-agent.ts` imports with:

```ts
import { buildPaneCommand } from "./agent-argv.ts";
import { defaultHerdrRunner, herdrAgentWait, launchInWorkspace, type HerdrRunner } from "./agent-herdr.ts";
```

Replace the spawn+kickoff sequence (previously `spawnAgentPane` → `startClaude` → wait ready → `sendTask`) with:

```ts
  const runner: HerdrRunner = deps.herdrRunner ?? defaultHerdrRunner();
  const sessionId = crypto.randomUUID();
  const paneCommand = buildPaneCommand(worktreePath, {
    session: { kind: "start", sessionId },
    headless: false,
    prompt: `Read ${taskFilePath} and complete the task it describes.`,
  });
  const out = await launchInWorkspace(
    { workspaceLabel: repoName, tabLabel: `rebase ${branchName}`, paneCommand },
    runner,
  );
  // agent-status readiness replaces the old wait/nudge dance: the prompt is
  // argv-submitted, so working→idle is the whole lifecycle to observe.
  const settled = await herdrAgentWait(out.paneId, ["idle", "done"], AGENT_WAIT_TIMEOUT_MS, runner);
```

Keep the existing verification unchanged (`verifyRebaseCompleted` reads git state only — never agent output). Keep the existing timeout constants; thread `deps.herdrRunner` through the same `deps` object the module already uses for test injection (add the field if absent). Preserve the pane-read diagnostics call by replacing `readPane` with a direct `runner(["pane", "read", out.paneId, "--source", "recent"])` where it was used.

- [ ] **Step 3: Delete lib/herdr-agent.ts and fix references**

```bash
rm lib/herdr-agent.ts
grep -rn "herdr-agent" lib commands docs/*.md || true
```

Every hit must be updated (imports) or is prose referencing the old file (update the sentence). The `rt-agent-boundary` pointer comment moves to `lib/agent-herdr.ts`'s header if it was only in the deleted file.

- [ ] **Step 4: Run tests**

Run: `bun test lib && bun x tsc --noEmit`
Expected: PASS — escalation tests green against the new seam; no dangling imports.

- [ ] **Step 5: Commit**

```bash
git add -A lib
git commit -m "refactor(agent): rebase escalation on agent-herdr; delete broken herdr-agent"
```

---

### Task 8: e2e — compiled binary, fake herdr + claude shims

**Files:**
- Create: `e2e/tests/agent.test.ts`
- Consumes: `e2e/harness.ts` (`RT_BINARY`, `createTestHome`), the daemon-e2e pattern from `e2e/tests/chat.test.ts` (hermetic env, `RT_API_PORT`, children reaping).

- [ ] **Step 1: Write the test**

`e2e/tests/agent.test.ts` — same skeleton as `chat.test.ts` (copy its `runRt`, daemon start/stop `beforeAll`/`afterAll`, port pick). The fake herdr shim is a script written into the test HOME's `.local/bin/herdr`; `HERDR_BIN` points at it and it journals argv:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
// runRt/daemon lifecycle: copy the helpers from e2e/tests/chat.test.ts verbatim,
// adding HERDR_BIN to the env block.

const FAKE_HERDR = `#!/bin/sh
echo "$@" >> "$FAKE_HERDR_LOG"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1"}}}' ;;
  *) echo '{}' ;;
esac
`;

let home: string;
let herdrLog: string;

beforeAll(async () => {
  home = createTestHome().path;
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "herdr"), FAKE_HERDR, { mode: 0o755 });
  herdrLog = join(home, "herdr.log");
  writeFileSync(herdrLog, "");
  // start daemon exactly as chat.test.ts does, with extraEnv:
  //   HERDR_BIN: join(binDir, "herdr"), FAKE_HERDR_LOG: herdrLog
});

afterAll(() => { /* chat.test.ts teardown */ });

test("agent start records a handoff and drives fake herdr", async () => {
  const start = runRt(["agent", "start", "--repo", home, "--prompt", "hello", "--json"], home,
    { HERDR_BIN: join(home, ".local", "bin", "herdr"), FAKE_HERDR_LOG: herdrLog });
  const out = await new Response(start.stdout).text();
  expect(start.exitCode ?? (await start.exited)).toBe(0);
  const parsed = JSON.parse(out.trim());
  expect(parsed.ok).toBe(true);
  expect(parsed.agent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(parsed.agent.paneId).toBe("w1:p1");
  const log = readFileSync(herdrLog, "utf8");
  expect(log).toContain("pane run w1:p1");
  expect(log).toContain(`'--session-id' '${parsed.agent.sessionId}'`);

  const show = runRt(["agent", "show", parsed.agent.id, "--json"], home, {});
  const shown = JSON.parse((await new Response(show.stdout).text()).trim());
  expect(shown.agent.sessionId).toBe(parsed.agent.sessionId);
});

test("agent resume uses --resume and the ↺ tab", async () => {
  // start (as above), then:
  // runRt(["agent", "resume", id, "--json"], ...) and assert the herdr log's
  // last pane run contains `'--resume' '<sessionId>'` and a tab labeled "↺ ".
});

test("agent start --surface headless without prompt exits 1", async () => {
  const p = runRt(["agent", "start", "--repo", home, "--surface", "headless"], home, {});
  expect(await p.exited).toBe(1);
});
```

Note: the fake-herdr env vars ride the DAEMON's env (it does the spawning) — pass them when starting the daemon, not only the client invocations. The resume test's fake must also answer `"tab list"` with the launch tab (label = the record id) so the ↺ dedup path is exercised.

- [ ] **Step 2: Build and run**

Run: `bun run build && bun test e2e/tests/agent.test.ts`
Expected: PASS against the compiled binary. If `dist/rt` is stale from an earlier session, delete it first — a stale binary passing is a false green.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/agent.test.ts
git commit -m "test(agent): e2e handoff round-trip against fake herdr"
```

---

### Task 9: full verification

- [ ] **Step 1: Repo gates**

```bash
bun x tsc --noEmit
bun test lib commands packages
cd packages/rt-client && bun run build && bun test && cd ../..
bun run build && bun test e2e/tests/agent.test.ts e2e/tests/chat.test.ts
```

Expected: all green. `dist-freshness`, `no-eager-tui`, and `rt-client-commands` are the three most likely to catch integration mistakes — treat any failure as an instruction, not noise.

- [ ] **Step 2: Live smoke (operator machine only, not CI)**

With the dev daemon restarted (new handlers don't exist in a running daemon):

```bash
rt agent start --repo ~/Documents/GitHub/repo-tools --prompt 'Reply with exactly smoke-ok.' --model haiku --json
rt agent list --json
rt agent resume <id> --surface headless --prompt 'What did you reply?' --json
rt events wait 'agent/done/*' --waitMs 1000
```

Expected: pane opens in a workspace named `repo-tools`, record round-trips, cross-surface resume answers `smoke-ok`. Close the tab afterward.

- [ ] **Step 3: Commit any fixups and stop**

Board/gitq/shepherdr adoption is follow-up work (spec Non-goals) — do not start it.
