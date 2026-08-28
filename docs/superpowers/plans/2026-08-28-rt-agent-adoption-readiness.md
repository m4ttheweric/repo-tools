# rt agent adoption-readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `rt agent` optional `workspace`/`tab` on resume (A) and make it daemon-optional for the herdr and read verbs (B), so board/gitq can adopt it later as pure-consumer changes with no further rt work.

**Architecture:** A is a four-edit contract change (payload type, rt-client wrapper, handler default, CLI parsing). B branches `commands/agent.ts` on `isDaemonRunning()`; daemon-down runs the SAME `createAgentHandlers` in-process against a version-guarded local `state.db`, refusing headless before any handler runs. Zero handler-logic duplication.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test. rt daemon IPC over unix socket. herdr CLI.

**Spec:** `docs/superpowers/specs/2026-08-28-rt-agent-adoption-readiness-design.md` (read it; this plan argues from it).

## Global Constraints

- **No schema change.** The `agents` table already exists (`V7_SCHEMA`); current `SCHEMA_VERSION` on main is 8. Do NOT bump it, add a `V*_SCHEMA` block, or touch `runMigrations`.
- **state.db writer invariant (B).** The fallback writes the SAME `state.db` (`stateDbPath()`), goes through the existing `runCriticalWrite` in `agents-store` (no new concurrency code), NEVER migrates a db newer than this build (refuses), NEVER starts a daemon, and passes `emitEvent: () => 0` (no live bus).
- **Headless is daemon-only.** In fallback, a headless surface is refused BEFORE any handler is constructed/called; nothing is spawned, nothing recorded.
- **rt-client delivery.** After editing anything under `packages/rt-client/src/`, run `bun run build` in `packages/rt-client` (the `dist-freshness.test.ts` guard). No consumer bump lands in this lane; the npm publish is a post-merge action for Matt.
- **Module registry.** `commands/agent-fallback.ts` is a helper imported by `commands/agent.ts` (via a literal dynamic `import()` in the daemon-down branch), NOT a command-tree module. It needs no `lib/module-registry.ts` entry. Do not add one.
- **Comments:** clean-code only (state a non-obvious constraint or a why); no narration, no review artifacts. No em dashes or en dashes anywhere in code, comments, or commit messages (use `...`, parens, or rephrase).
- **Tests hermetic:** rely on the repo's bunfig HOME isolation; construct stores via `openStateDb(tempPath)`.

---

### Task 1: A — resume gains `workspace`/`tab` (payload + wrapper + handler + CLI)

One cohesive contract change delivered end to end. The wrapper edit is mandatory: today `agentResume` forwards only `id`/`prompt`/`surface`, so without it board's `workspace`/`tab` type-check and then vanish before the IPC call.

**Files:**
- Modify: `packages/rt-client/src/commands.ts:318` (payload type)
- Modify: `packages/rt-client/src/client.ts:364-371` (`agentResume` wrapper)
- Modify: `lib/daemon/handlers/agent.ts:195-196` (resume defaults)
- Modify: `commands/agent.ts` (`parseResumeArgs`)
- Test: `packages/rt-client/test/agent-wrappers.test.ts`, `lib/daemon/__tests__/agent-handlers.test.ts`, `commands/__tests__/agent.test.ts`

**Interfaces:**
- Produces: `Commands["agent:resume"].payload` now includes `workspace?: string; tab?: string`; `agentResume` forwards them; `agent:resume` handler honors them; CLI `resume` reads `--workspace`/`--tab`.
- Consumes: existing `agentStart` key-list pattern (`client.ts:359`), existing handler `repoLabel(rec.repo)` / `↺ ${rec.label ?? rec.id}` defaults.

- [ ] **Step 1: Write the failing wrapper-forwarding test**

In `packages/rt-client/test/agent-wrappers.test.ts`:

```ts
import { fakeDaemon } from "./fake-daemon.ts";

test("agentResume forwards workspace and tab", async () => {
  const fake = fakeDaemon({ "agent:resume": { ok: true, data: { id: "ag-1" } } });
  const res = await agentResume(
    { id: "ag-1", prompt: "go", workspace: "reviews", tab: "⟲ !5" },
    { sockPath: fake.sock },
  );
  fake.stop();
  expect(res.ok).toBe(true);
  const seen = fake.seen.find((s) => s.cmd === "agent:resume");
  expect(seen?.payload).toMatchObject({ id: "ag-1", prompt: "go", workspace: "reviews", tab: "⟲ !5" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/rt-client && bun test test/agent-wrappers.test.ts`
Expected: FAIL. Either a TS error (payload type lacks `workspace`/`tab`) or the `toMatchObject` mismatch (fields dropped by the wrapper).

- [ ] **Step 3: Add the fields to the payload type**

`packages/rt-client/src/commands.ts:318`:

```ts
  "agent:resume": { payload: { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string }; data: AgentRecord };
```

- [ ] **Step 4: Fix the wrapper to forward them (key-list pattern, mirroring `agentStart`)**

`packages/rt-client/src/client.ts` `agentResume`:

```ts
export function agentResume(
  a: Commands["agent:resume"]["payload"], o: RtClientOptions = {},
): Promise<RtResponse<AgentRecord>> {
  const payload: Record<string, unknown> = { id: a.id };
  for (const k of ["prompt", "surface", "workspace", "tab"] as const) {
    if (a[k] !== undefined) payload[k] = a[k];
  }
  return rtCommand<AgentRecord>("agent:resume", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}
```

- [ ] **Step 5: Run the wrapper test to verify it passes**

Run: `cd packages/rt-client && bun test test/agent-wrappers.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing handler-override test**

In `lib/daemon/__tests__/agent-handlers.test.ts` (uses the file's existing `fresh()` + `okRunner(calls)` seam):

```ts
test("agent:resume honors workspace and tab overrides", async () => {
  const calls: string[][] = [];
  const h = fresh({ runner: okRunner(calls) });
  const started = await h["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr", label: "L" });
  if (!started.ok) throw new Error("unreachable");
  calls.length = 0;
  const resumed = await h["agent:resume"]({ id: started.data.id, workspace: "reviews", tab: "⟲ !5" });
  expect(resumed.ok).toBe(true);
  expect(calls.find((c) => c[0] === "workspace" && c[1] === "create")?.[3]).toBe("reviews");
  const tabArg = calls.find((c) => c[0] === "tab" && c[1] === "rename")?.[3]
    ?? calls.find((c) => c[0] === "tab" && c[1] === "create")?.[5];
  expect(tabArg).toBe("⟲ !5");
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test lib/daemon/__tests__/agent-handlers.test.ts -t "honors workspace"`
Expected: FAIL (handler still uses `repoLabel(rec.repo)` / `↺ ...`, so the custom labels are absent).

- [ ] **Step 8: Fix the handler defaults**

`lib/daemon/handlers/agent.ts` `agent:resume`, lines 195-196:

```ts
      const tabLabel = payload.tab ?? `↺ ${rec.label ?? rec.id}`;
      const workspaceLabel = payload.workspace ?? repoLabel(rec.repo);
```

- [ ] **Step 9: Run the handler test to verify it passes**

Run: `bun test lib/daemon/__tests__/agent-handlers.test.ts -t "honors workspace"`
Expected: PASS. Also re-run the whole file to confirm the existing `↺` default test (no overrides) still passes: `bun test lib/daemon/__tests__/agent-handlers.test.ts`.

- [ ] **Step 10: Write the failing CLI-parse test**

In `commands/__tests__/agent.test.ts`:

```ts
import { __test__ } from "../agent.ts";

test("parseResumeArgs reads --workspace and --tab", () => {
  const r = __test__.parseResumeArgs(["ag-1", "--workspace", "reviews", "--tab", "⟲ !5", "--prompt", "go"]);
  expect(r).toMatchObject({ id: "ag-1", workspace: "reviews", tab: "⟲ !5", prompt: "go" });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `bun test commands/__tests__/agent.test.ts -t "parseResumeArgs reads"`
Expected: FAIL (`workspace`/`tab` absent from the parsed object).

- [ ] **Step 12: Fix `parseResumeArgs` (FLAGS_WITH_VALUES already includes `--workspace`/`--tab`)**

`commands/agent.ts` `parseResumeArgs`:

```ts
function parseResumeArgs(args: string[]): { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string } {
  const id = positional(args);
  if (!id) throw new Error("missing id: rt agent resume <id|session-uuid>");
  const out: { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string } = { id };
  const prompt = flagValue(args, "--prompt");
  if (prompt !== undefined) out.prompt = prompt;
  const surface = parseSurface(flagValue(args, "--surface"));
  if (surface !== undefined) out.surface = surface;
  const workspace = flagValue(args, "--workspace");
  if (workspace !== undefined) out.workspace = workspace;
  const tab = flagValue(args, "--tab");
  if (tab !== undefined) out.tab = tab;
  return out;
}
```

`runResume` already passes `parsed` straight to `agentResume` (and, after Task 4, to the fallback), so the new fields thread through with no further change.

- [ ] **Step 13: Run the CLI test to verify it passes**

Run: `bun test commands/__tests__/agent.test.ts -t "parseResumeArgs reads"`
Expected: PASS.

- [ ] **Step 14: Rebuild rt-client dist and refresh docs**

Run: `cd packages/rt-client && bun run build && cd ../.. && bun scripts/gen-docs.ts`
Then `git status`: if `website/docs/reference/agent.mdx` changed, stage it (the `docs:check` CI gate). If it did not change, that is fine (the `--workspace`/`--tab` flags already existed at the command level for `start`).

- [ ] **Step 15: Commit**

```bash
git add packages/rt-client/src/commands.ts packages/rt-client/src/client.ts packages/rt-client/dist \
        lib/daemon/handlers/agent.ts commands/agent.ts \
        packages/rt-client/test/agent-wrappers.test.ts lib/daemon/__tests__/agent-handlers.test.ts commands/__tests__/agent.test.ts \
        website/docs/reference/agent.mdx 2>/dev/null
git commit -m "agent: resume accepts workspace/tab overrides (payload, wrapper, handler, CLI)"
```

---

### Task 2: B — `openStateDbGuarded(path)` (version-guarded local open)

The fallback's safe seam onto `state.db`: refuse a db strictly newer than this build, otherwise open+migrate normally.

**Files:**
- Modify: `lib/state/db.ts` (add `openStateDbGuarded`; add `existsSync` import)
- Modify: `lib/state/index.ts` (re-export `openStateDbGuarded`)
- Test: `lib/state/__tests__/state-db-guarded.test.ts` (new)

**Interfaces:**
- Produces: `openStateDbGuarded(path: string): Database` — throws `Error("state.db is newer than this rt build ...")` when `user_version > SCHEMA_VERSION`; otherwise returns the migrated handle; creates+migrates a missing file.
- Consumes: existing `openStateDb`, `SCHEMA_VERSION` (both in `db.ts`).

- [ ] **Step 1: Write the failing tests**

`lib/state/__tests__/state-db-guarded.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openStateDb } from "../index.ts";
import { openStateDbGuarded } from "../index.ts";
import { SCHEMA_VERSION } from "../db.ts";

let n = 0;
const tmp = () => join(tmpdir(), `guard-${process.pid}-${n++}.db`);
const uv = (db: Database) => (db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;

test("creates and migrates a missing db", () => {
  const db = openStateDbGuarded(tmp());
  expect(uv(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("opens an at-version db", () => {
  const p = tmp();
  openStateDb(p).close();
  const db = openStateDbGuarded(p);
  expect(uv(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("refuses a db newer than this build", () => {
  const p = tmp();
  openStateDb(p).close();
  const raw = new Database(p);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
  raw.close();
  expect(() => openStateDbGuarded(p)).toThrow(/newer than this rt build/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test lib/state/__tests__/state-db-guarded.test.ts`
Expected: FAIL (`openStateDbGuarded` not exported).

- [ ] **Step 3: Implement the helper**

`lib/state/db.ts` (ensure `existsSync` is imported from `"fs"`):

```ts
/** Version-guarded open for the CLI daemon-down fallback (spec 2026-08-28).
    Refuses a db STRICTLY newer than this build so a short-lived CLI never
    stamps a schema another build owns; equal-or-behind opens and migrates
    normally (data-preserving, IF NOT EXISTS). A missing file is created. */
export function openStateDbGuarded(path: string): Database {
  if (existsSync(path)) {
    const probe = new Database(path, { readonly: true });
    let userVersion: number;
    try {
      userVersion = (probe.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
    } finally {
      probe.close();
    }
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(`state.db is newer than this rt build (v${userVersion} > v${SCHEMA_VERSION}); start the matching daemon`);
    }
  }
  return openStateDb(path, "cli");
}
```

Re-export from `lib/state/index.ts` alongside `openStateDb`/`getStateDb`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test lib/state/__tests__/state-db-guarded.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/state/db.ts lib/state/index.ts lib/state/__tests__/state-db-guarded.test.ts
git commit -m "state: openStateDbGuarded refuses a db newer than this build"
```

---

### Task 3: B — `runAgentFallback` (in-process handler dispatch)

Reuses `createAgentHandlers` for the surfaces the CLI can serve daemon-down; refuses headless before any handler runs.

**Files:**
- Create: `commands/agent-fallback.ts`
- Test: `commands/__tests__/agent-fallback.test.ts` (new)

**Interfaces:**
- Produces: `runAgentFallback<T>(command, payload, deps?): Promise<RtResponse<T>>` where `command` is `"agent:start" | "agent:resume" | "agent:get" | "agent:list"`; `deps?: { db?, herdrRunner?, spawnHeadless? }` (tests inject; production omits and it opens `openStateDbGuarded(stateDbPath())`). Also exports `HEADLESS_NEEDS_DAEMON`.
- Consumes: `createAgentHandlers` (`lib/daemon/handlers/agent.ts`), `openStateDbGuarded`/`getAgent` (`lib/state`), `stateDbPath` (`lib/state/db.ts`), `RtResponse`/`AgentSurface` (rt-client).

- [ ] **Step 1: Write the failing tests**

`commands/__tests__/agent-fallback.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentFallback, HEADLESS_NEEDS_DAEMON } from "../agent-fallback.ts";
import { openStateDb, insertAgent, newAgentId } from "../../lib/state/index.ts";
import type { HerdrRunner } from "../../lib/agent-herdr.ts";

let n = 0;
const REPO = "remote:example.com%2Fa%2Fb";
const tmp = () => join(tmpdir(), `agent-fb-${process.pid}-${n++}.db`);

const okRunner = (calls: string[][]): HerdrRunner => async (args) => {
  calls.push(args);
  if (args[0] === "workspace" && args[1] === "list") return { stdout: JSON.stringify({ result: { workspaces: [] } }), exitCode: 0 };
  if (args[0] === "workspace" && args[1] === "create")
    return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }), exitCode: 0 };
  return { stdout: "{}", exitCode: 0 };
};

test("herdr start records and journals herdr argv", async () => {
  const db = openStateDb(tmp());
  const calls: string[][] = [];
  const res = await runAgentFallback("agent:start",
    { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" }, { db, herdrRunner: okRunner(calls) });
  expect(res.ok).toBe(true);
  expect(calls.some((c) => c[0] === "pane" && c[1] === "run")).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const got = await runAgentFallback("agent:get", { id: (res.data as { id: string }).id }, { db });
  expect(got.ok).toBe(true);
});

test("refuses headless start before spawning", async () => {
  const db = openStateDb(tmp());
  const spy = { called: false };
  const res = await runAgentFallback("agent:start",
    { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "headless" },
    { db, spawnHeadless: () => { spy.called = true; return { exited: Promise.resolve(0), stdout: async () => "" }; } });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe(HEADLESS_NEEDS_DAEMON);
  expect(spy.called).toBe(false);
});

test("refuses resume of a headless record (surface from record)", async () => {
  const db = openStateDb(tmp());
  const rec = { id: newAgentId(), repo: REPO, cwd: "/tmp/x", provider: "claude" as const, surface: "headless" as const, sessionId: crypto.randomUUID(), createdAt: Date.now() };
  insertAgent(rec, db);
  const res = await runAgentFallback("agent:resume", { id: rec.id }, { db });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toBe(HEADLESS_NEEDS_DAEMON);
});

test("list returns records", async () => {
  const db = openStateDb(tmp());
  const calls: string[][] = [];
  await runAgentFallback("agent:start", { repo: REPO, cwd: "/tmp/x", prompt: "hi", surface: "herdr" }, { db, herdrRunner: okRunner(calls) });
  const res = await runAgentFallback("agent:list", { repo: REPO }, { db });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect((res.data as { agents: unknown[] }).agents.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test commands/__tests__/agent-fallback.test.ts`
Expected: FAIL (`../agent-fallback.ts` does not exist).

- [ ] **Step 3: Implement `commands/agent-fallback.ts`**

```ts
/**
 * Daemon-down execution for `rt agent` (spec 2026-08-28). Reuses the exact
 * daemon handlers in-process for the surfaces a short-lived CLI can serve:
 * herdr launch/resume and the read verbs. Headless is refused BEFORE any
 * handler is constructed, because the CLI exits immediately and cannot reap
 * the async `claude -p` child (it would spawn and orphan it).
 */
import type { Database } from "bun:sqlite";
import { createAgentHandlers } from "../lib/daemon/handlers/agent.ts";
import { openStateDbGuarded, getAgent, type insertAgent } from "../lib/state/index.ts";
import { stateDbPath } from "../lib/state/db.ts";
import type { HerdrRunner, HeadlessChild } from "../lib/daemon/handlers/agent.ts";
import type { AgentSurface, RtResponse } from "../packages/rt-client/src/index.ts";

export const HEADLESS_NEEDS_DAEMON =
  "headless needs the rt daemon to reap completion; start it (rt daemon start) or use --surface herdr";

type FallbackCommand = "agent:start" | "agent:resume" | "agent:get" | "agent:list";

export async function runAgentFallback<T>(
  command: FallbackCommand,
  payload: Record<string, unknown>,
  deps: { db?: Database; herdrRunner?: HerdrRunner; spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild } = {},
): Promise<RtResponse<T>> {
  const db = deps.db ?? openStateDbGuarded(stateDbPath());

  // Headless pre-gate, before any handler runs.
  if (command === "agent:start" && ((payload.surface as AgentSurface | undefined) ?? "herdr") === "headless") {
    return { ok: false, error: HEADLESS_NEEDS_DAEMON };
  }
  if (command === "agent:resume") {
    const rec = getAgent(payload.id as string, db);
    const effective: AgentSurface = (payload.surface as AgentSurface | undefined) ?? rec?.surface ?? "herdr";
    if (effective === "headless") return { ok: false, error: HEADLESS_NEEDS_DAEMON };
  }

  const handlers = createAgentHandlers({
    db,
    emitEvent: () => 0,
    ...(deps.herdrRunner !== undefined && { herdrRunner: deps.herdrRunner }),
    ...(deps.spawnHeadless !== undefined && { spawnHeadless: deps.spawnHeadless }),
  });
  const res = await handlers[command](payload as never);
  return res as RtResponse<T>;
}
```

Note: import `HerdrRunner`/`HeadlessChild` from wherever `handlers/agent.ts` re-exports them; if it does not, import `HerdrRunner` from `../lib/agent-herdr.ts` and `HeadlessChild` from `../lib/daemon/handlers/agent.ts` (it exports `HeadlessChild`). Verify the exact export sites when wiring and adjust the import lines; do not invent a type.

- [ ] **Step 4: Run to verify pass**

Run: `bun test commands/__tests__/agent-fallback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add commands/agent-fallback.ts commands/__tests__/agent-fallback.test.ts
git commit -m "agent: runAgentFallback runs herdr + read verbs in-process, refuses headless"
```

---

### Task 4: B — wire `commands/agent.ts` to branch on `isDaemonRunning()`

Daemon-up path is unchanged; daemon-down routes through the Task 3 fallback via a literal dynamic import (keeps daemon-side modules off the hot path).

**Files:**
- Modify: `commands/agent.ts` (add a dispatch helper; route `runStart`/`runResume`/`runShow`/`runList` through it)

**Interfaces:**
- Consumes: `isDaemonRunning` (`lib/daemon-client.ts`), `runAgentFallback` (`commands/agent-fallback.ts`), the existing `agentStart`/`agentResume`/`agentGet`/`agentList` wrappers.
- Produces: no new exported surface. Behavior: every `rt agent` verb works daemon-down (headless start/resume error out via the fallback's gate).

- [ ] **Step 1: Add the dispatch helper and route each verb**

In `commands/agent.ts`, add (near the top-level helpers):

```ts
import { isDaemonRunning } from "../lib/daemon-client.ts";

// Daemon-optional: the herdr and read verbs run in-process when the daemon is
// down (spec 2026-08-28). Headless is refused inside the fallback. The fallback
// module is imported lazily so a daemon-up call never loads daemon-side code.
async function dispatch<T>(
  command: "agent:start" | "agent:resume" | "agent:get" | "agent:list",
  payload: Record<string, unknown>,
  wrapper: () => Promise<RtResponse<T>>,
): Promise<RtResponse<T>> {
  if (await isDaemonRunning()) return wrapper();
  const { runAgentFallback } = await import("./agent-fallback.ts");
  return runAgentFallback<T>(command, payload);
}
```

Then in each `run*`, replace the direct wrapper call. For example `runStart`:

```ts
  const payload = { repo, cwd, ...parsed };
  const data = unwrap(await dispatch("agent:start", payload, () => agentStart(payload)), "start");
```

`runResume`: `dispatch("agent:resume", parsed, () => agentResume(parsed))`.
`runShow`: `dispatch("agent:get", { id }, () => agentGet({ id }))`.
`runList`: `dispatch("agent:list", repo ? { repo } : {}, () => agentList(repo ? { repo } : {}))`.

Keep every `unwrap(...)`, `--json`, and `renderRecord` path exactly as-is.

- [ ] **Step 2: Type-check and run the existing CLI tests**

Run: `bun test commands/__tests__/agent.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS / clean. (Runtime daemon-down behavior is covered by the e2e in Task 5, which exercises the real `isDaemonRunning()` branch under the compiled binary. A module-mock unit test for the branch would be brittle and is intentionally omitted.)

- [ ] **Step 3: Confirm no startup regression**

Run: `bun test lib/__tests__/no-eager-tui.test.ts`
Expected: PASS (the fallback's daemon-side imports live behind a dynamic `import()` in the daemon-down branch, not at module top level).

- [ ] **Step 4: Commit**

```bash
git add commands/agent.ts
git commit -m "agent: fall back to in-process herdr + read verbs when the daemon is down"
```

---

### Task 5: B — e2e proof (daemon-down launch + read; headless refused)

**Files:**
- Modify: `e2e/tests/agent.test.ts`

**Interfaces:**
- Consumes: the file's existing helpers `createTestHome()`, `runRt(args, home, extraEnv?)`, `finished(proc)`, and the `FAKE_HERDR` shim string. Key difference from the existing block: daemon-down, the CLI (not the daemon) shells out to herdr, so the fake-herdr env (`HERDR_BIN`/`FAKE_HERDR_LOG`/`FAKE_HERDR_STATE`) must ride the `runRt` CLI call, and NO daemon is started for this HOME.

- [ ] **Step 1: Add a daemon-down describe block (its own HOME, no daemon)**

Add to `e2e/tests/agent.test.ts`. Mirror `beforeAll`'s shim setup but do NOT start a daemon and do NOT `waitForSocket`:

```ts
describe("rt agent (daemon-down fallback)", () => {
  let home: string;
  let cleanup: () => void;
  let herdrLog: string;
  let herdrEnv: Record<string, string>;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const herdrBin = join(binDir, "herdr");
    writeFileSync(herdrBin, FAKE_HERDR, { mode: 0o755 });
    herdrLog = join(home, "herdr.log");
    writeFileSync(herdrLog, "");
    const herdrState = join(home, "herdr-state");
    mkdirSync(herdrState, { recursive: true });
    // The CLI shells out to herdr in the fallback, so the fake-herdr env rides
    // the CLI invocation, not a daemon (there is none).
    herdrEnv = { HERDR_BIN: herdrBin, FAKE_HERDR_LOG: herdrLog, FAKE_HERDR_STATE: herdrState };
  });

  afterAll(() => cleanup());

  test("herdr start records with no daemon, and show reads it back", async () => {
    const start = await finished(runRt(["agent", "start", "--repo", home, "--surface", "herdr", "--prompt", "hi", "--json"], home, herdrEnv));
    expect(start.exitCode).toBe(0);
    const parsed = JSON.parse(start.stdout.trim());
    expect(parsed.agent.paneId).toBe("w1:p1");
    expect(readFileSync(herdrLog, "utf8")).toContain("pane run w1:p1");

    const show = await finished(runRt(["agent", "show", parsed.agent.id, "--json"], home, herdrEnv));
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout.trim()).agent.id).toBe(parsed.agent.id);
  }, 30_000);

  test("headless start is refused with no daemon", async () => {
    const res = await finished(runRt(["agent", "start", "--repo", home, "--surface", "headless", "--prompt", "hi", "--json"], home, herdrEnv));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("headless needs the rt daemon");
  }, 15_000);
});
```

If `runRt`/`finished`/`createTestHome` differ from the above when you open the file, use the file's real signatures... do not fabricate helpers.

- [ ] **Step 2: Run to verify (build + run)**

Run: `bun test e2e/tests/agent.test.ts`
Expected: the new cases FAIL first only if wiring is incomplete; with Tasks 1-4 landed they PASS. (This step rebuilds+re-signs `dist/rt` via `e2e/setup.ts`; it is slow. Run it in the foreground and wait, do not background-and-poll.)

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/agent.test.ts
git commit -m "agent(e2e): daemon-down herdr start+show works, headless refused"
```

---

### Task 6: Branch verification gates

**Files:** none (verification only; commit any generated drift).

- [ ] **Step 1: Run the repo gates the CI enforces**

```bash
bun run picker:check
bun test lib/state/__tests__/agents-store.test.ts lib/daemon/__tests__/agent-handlers.test.ts \
         commands/__tests__/agent.test.ts commands/__tests__/agent-fallback.test.ts \
         lib/state/__tests__/state-db-guarded.test.ts
cd packages/rt-client && bun test && bun run build && cd ../..
bun scripts/gen-docs.ts   # commit agent.mdx only if it changed
bunx tsc --noEmit -p tsconfig.json
```

Expected: all green; `dist-freshness.test.ts` green (rt-client built in Task 1/here); no `agent.mdx` drift left uncommitted.

- [ ] **Step 2: Commit any drift, then the branch is ready for review/PR**

```bash
git add -A && git commit -m "agent: regen docs / dist after adoption-readiness" || echo "nothing to commit"
```

---

## Post-merge delivery (Matt, NOT a build task)

- Publish `@mattstack/rt-client` at `>0.7.0` from a `main` checkout (OTP-gated; `prepack` rebuilds `dist`; grep the built bundle for `agentResume` and the `workspace`/`tab` payload keys before publishing). This delivers A's resume fields (and `agent:*` to gitq, which predates the wrappers).
- No consumer pin bump in this lane. board/gitq bump only when they actually migrate.
- Deploy: the daemon-optional fallback (B) ships in the rt binary; it takes effect after the normal rt deploy (main checkout sync + dev daemon restart), which Matt controls.
