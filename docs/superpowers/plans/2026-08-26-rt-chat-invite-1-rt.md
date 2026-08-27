# rt chat invite, part 1: the rt primitives (repo-tools)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give rt the herdr-facing verbs the chat viewer and the recruiting skill need: `pane:list`, `pane:peek`, `pane:spawn`, `pane:accounts`, `pane:directories`, `chat:invite`, `rt chat read --last N`, the `chat.herdrWorkspace` setting, their rt-client wrappers, the `rt pane` CLI group, and the skill docs.

**Architecture:** A new daemon-side herdr client speaks newline-delimited JSON over herdr's unix socket, one connection per call (herdr closes after every response). Daemon handlers in `lib/daemon/handlers/pane.ts` join herdr's pane list to rt's presence rows by Claude session id and expose the verbs through the rt-client `Commands` catalog like every other typed verb. `chat:invite` lives in the chat handler module and types `/chat:join <room>` into a pane with `agent.prompt`. Process spawns (`cswap list`, `git` for a branch) go through `lib/subprocess.ts`'s async `runCapture`, never sync. The CLI gains a `pane` group and two chat additions; rt-client gains six wrappers and five types.

**Tech Stack:** Bun (`Bun.connect` / `Bun.listen` unix sockets, `bun:test`, `bun:sqlite`), TypeScript, the rt daemon's typed handler contract (`TypedHandlers`), rt-client.

**Spec:** `docs/superpowers/specs/2026-08-26-rt-chat-invite-design.md` (this repo).

## Global Constraints

- Work in this worktree (`~/Documents/GitHub/repo-tools-chat-invite`, branch `spec/rt-chat-invite`, rebased onto `main` before the PR); never on repo-tools' main checkout.
- **No sync-exec on the daemon thread (MAT-222).** Handlers may call synchronous `bun:sqlite`; every process spawn is `runCapture` from `lib/subprocess.ts`; every herdr call is the async socket client. No `execSync`/`spawnSync` anywhere under `lib/daemon/` or `lib/herdr/`.
- The herdr socket path is `HERDR_SOCKET_PATH`, else `~/.config/herdr/herdr.sock`. Socket timeout: 5s for a plain call; for a waiting call (`agent.wait`, `agent.prompt` with `wait`) the request's `timeout_ms` plus 5000.
- Every `pane:*` verb and `chat:invite` answers `{ ok: false, error: "herdr unavailable" }` when the socket is missing or does not answer; the string is exactly `herdr unavailable`, optionally followed by `: <detail>`.
- Every cataloged verb needs, in the same task: the `Commands` entry, the `COMMAND_NAMES` entry, the handler, and the router registration; `lib/daemon/__tests__/rt-client-commands.test.ts` fails otherwise.
- Types rt-client cannot import are duplicated in `packages/rt-client/src/commands.ts` with the existing "Duplicated shape on purpose" comment convention.
- Room and handle names are validated with `isValidChatName` (`^[a-z0-9._-]+$`).
- Tests: `bun test <path>` per file while working; `bun test lib commands packages scripts` before every commit. Handler tests live in `lib/daemon/__tests__/`, lib tests in `lib/<dir>/__tests__/` or `lib/__tests__/`, CLI tests in `commands/__tests__/`, rt-client tests in `packages/rt-client/test/`.
- After touching `lib/command-tree-def.ts`, run `bun scripts/gen-docs.ts` and commit the regenerated `website/docs/reference` (`bun scripts/check-docs.ts` gates it).
- After touching anything under `packages/rt-client/src`, run `cd packages/rt-client && bun run build` (the dist-freshness test).
- No em dashes or en dashes in code, comments, docs or commit messages. Comments only for constraints the code cannot show.
- Commit after every task with a short imperative message.

---

### Task 1: the herdr socket client and its fake

**Files:**
- Create: `lib/herdr/client.ts`
- Create: `lib/herdr/__tests__/fake-herdr.ts`
- Test: `lib/herdr/__tests__/client.test.ts`

**Interfaces:**
- Produces:
  - `herdrSocketPath(): string`
  - `HERDR_UNAVAILABLE = "herdr unavailable"`
  - `type HerdrResult<T> = { ok: true; result: T } | { ok: false; code: string; message: string }`
  - `herdrRequest<T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number; sockPath?: string }): Promise<HerdrResult<T>>`
  - `herdrAvailable(sockPath?: string): Promise<boolean>`
  - `waitTimeout(timeoutMs: number): number` (= `timeoutMs + 5000`)
  - test helper `fakeHerdr(handler): { sock, seen, stop }`

- [ ] **Step 1: Write the fake herdr server**

Create `lib/herdr/__tests__/fake-herdr.ts`:

```ts
import { tmpdir } from "os";
import { join } from "path";

/** A reply the fake returns as herdr's `{ error: { code, message } }` envelope. */
export class HerdrFakeError {
  constructor(public code: string, public message: string) {}
}

export type FakeHerdrHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

let counter = 0;

/**
 * herdr's wire contract, for tests: newline-delimited JSON over a unix
 * socket, one request per connection, the server closes after replying.
 * The handler returns the `result` object (with its `type` field) or a
 * HerdrFakeError; a thrown error becomes `internal_error`.
 */
export function fakeHerdr(handler: FakeHerdrHandler) {
  const sock = join(tmpdir(), `fake-herdr-${process.pid}-${counter++}.sock`);
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const buffers = new Map<object, string>();
  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, chunk) {
        const buf = (buffers.get(socket) ?? "") + chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          buffers.set(socket, buf);
          return;
        }
        buffers.delete(socket);
        const line = buf.slice(0, nl);
        void (async () => {
          let reply: string;
          let id = "";
          try {
            const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
            id = req.id;
            const params = req.params ?? {};
            seen.push({ method: req.method, params });
            const out = await handler(req.method, params);
            reply = out instanceof HerdrFakeError
              ? JSON.stringify({ id, error: { code: out.code, message: out.message } })
              : JSON.stringify({ id, result: out });
          } catch (err) {
            reply = JSON.stringify({ id, error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) } });
          }
          socket.write(reply + "\n");
          socket.end();
        })();
      },
      close(socket) {
        buffers.delete(socket);
      },
      error() {},
    },
  });
  return { sock, seen, stop: () => server.stop(true) };
}
```

- [ ] **Step 2: Write the failing client tests**

Create `lib/herdr/__tests__/client.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { HERDR_UNAVAILABLE, herdrAvailable, herdrRequest, waitTimeout } from "../client.ts";
import { fakeHerdr, HerdrFakeError } from "./fake-herdr.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
});

test("a success reply comes back as ok with the result object", async () => {
  const { sock, seen, stop } = fakeHerdr((method) => {
    if (method === "pane.list") return { type: "pane_list", panes: [{ pane_id: "w1:p1" }] };
    return new HerdrFakeError("invalid_request", "nope");
  });
  stops.push(stop);
  const res = await herdrRequest<{ type: string; panes: unknown[] }>("pane.list", {}, { sockPath: sock });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.result.panes).toHaveLength(1);
  expect(seen[0]).toEqual({ method: "pane.list", params: {} });
});

test("an error reply comes back as ok:false with herdr's code and message", async () => {
  const { sock, stop } = fakeHerdr(() => new HerdrFakeError("agent_blocked", "agent w1:p1 is blocked"));
  stops.push(stop);
  const res = await herdrRequest("agent.prompt", { target: "w1:p1", text: "hi" }, { sockPath: sock });
  expect(res).toEqual({ ok: false, code: "agent_blocked", message: "agent w1:p1 is blocked" });
});

test("params travel verbatim, with the request id as a string", async () => {
  const { sock, seen, stop } = fakeHerdr(() => ({ type: "ok" }));
  stops.push(stop);
  await herdrRequest("pane.send_input", { pane_id: "w1:p1", text: "ls", keys: ["enter"] }, { sockPath: sock });
  expect(seen[0]!.params).toEqual({ pane_id: "w1:p1", text: "ls", keys: ["enter"] });
});

test("a missing socket is herdr unavailable, never a throw", async () => {
  const res = await herdrRequest("pane.list", {}, { sockPath: join(tmpdir(), "no-such-herdr.sock") });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.message.startsWith(HERDR_UNAVAILABLE)).toBe(true);
});

test("a reply slower than timeoutMs is a timeout", async () => {
  const { sock, stop } = fakeHerdr(async () => {
    await Bun.sleep(400);
    return { type: "ok" };
  });
  stops.push(stop);
  const res = await herdrRequest("agent.wait", { target: "w1:p1" }, { sockPath: sock, timeoutMs: 100 });
  expect(res).toMatchObject({ ok: false, code: "timeout" });
});

test("herdrAvailable probes session.snapshot", async () => {
  const { sock, seen, stop } = fakeHerdr(() => ({ type: "session_snapshot", snapshot: { panes: [], workspaces: [], agents: [], tabs: [], layouts: [], version: "0.8.0", protocol: 19 } }));
  stops.push(stop);
  expect(await herdrAvailable(sock)).toBe(true);
  expect(seen[0]!.method).toBe("session.snapshot");
  expect(await herdrAvailable(join(tmpdir(), "no-such-herdr.sock"))).toBe(false);
});

test("waitTimeout adds the 5s margin herdr needs to answer at its own budget", () => {
  expect(waitTimeout(60_000)).toBe(65_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test lib/herdr/__tests__/client.test.ts`
Expected: FAIL, `Cannot find module "../client.ts"`.

- [ ] **Step 4: Write the client**

Create `lib/herdr/client.ts`:

```ts
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const HERDR_UNAVAILABLE = "herdr unavailable";

export type HerdrResult<T> = { ok: true; result: T } | { ok: false; code: string; message: string };

const PLAIN_TIMEOUT_MS = 5_000;
const WAIT_MARGIN_MS = 5_000;

/** The daemon runs outside any pane, so the path is configured, never inherited from herdr. */
export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/** herdr answers a waiting call at its budget, not before; the socket must outlive it. */
export function waitTimeout(timeoutMs: number): number {
  return timeoutMs + WAIT_MARGIN_MS;
}

let seq = 0;

/**
 * One request, one connection: herdr reads a single line and closes after
 * replying, so there is nothing to pool. Never throws.
 */
export function herdrRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number; sockPath?: string } = {},
): Promise<HerdrResult<T>> {
  const sockPath = opts.sockPath ?? herdrSocketPath();
  const timeoutMs = opts.timeoutMs ?? PLAIN_TIMEOUT_MS;
  const id = `rt:${process.pid}:${++seq}`;
  const line = JSON.stringify({ id, method, params }) + "\n";

  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    let conn: { end(): void } | undefined;
    const finish = (r: HerdrResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn?.end(); } catch { /* already closed */ }
      resolve(r);
    };
    const unavailable = (detail: string): HerdrResult<T> => ({ ok: false, code: "unreachable", message: `${HERDR_UNAVAILABLE}: ${detail}` });
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", message: `herdr ${method} timed out after ${timeoutMs}ms` }), timeoutMs);

    if (!existsSync(sockPath)) {
      finish(unavailable(`no socket at ${sockPath}`));
      return;
    }

    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          conn = socket;
          socket.write(line);
        },
        data(_socket, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const text = buf.slice(0, nl);
          let parsed: { result?: T; error?: { code?: string; message?: string } };
          try {
            parsed = JSON.parse(text);
          } catch {
            finish({ ok: false, code: "invalid_response", message: `herdr ${method}: unparseable reply` });
            return;
          }
          if (parsed.error) {
            finish({ ok: false, code: String(parsed.error.code ?? "error"), message: String(parsed.error.message ?? "") });
          } else {
            finish({ ok: true, result: parsed.result as T });
          }
        },
        error(_socket, err) {
          finish(unavailable(err.message));
        },
        connectError(_socket, err) {
          finish(unavailable(err.message));
        },
        close() {
          finish(unavailable("connection closed before a reply"));
        },
      },
    }).catch((err: unknown) => finish(unavailable(err instanceof Error ? err.message : String(err))));
  });
}

/** The gate every pane verb sits behind: a socket that exists and answers. */
export async function herdrAvailable(sockPath: string = herdrSocketPath()): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  const res = await herdrRequest("session.snapshot", {}, { sockPath });
  return res.ok;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/herdr/__tests__/client.test.ts`
Expected: 7 pass. If `close()` fires before `data()` has settled a normal reply, the `finish` guard makes it a no-op; if a test sees `connection closed before a reply` on a successful call, the fake wrote and ended before the client's `data` ran, which means the buffered chunk arrives after `close`: move the `close` handler's `finish` behind a `queueMicrotask` so the pending `data` callback wins.

- [ ] **Step 6: Commit**

```bash
git add lib/herdr/client.ts lib/herdr/__tests__/fake-herdr.ts lib/herdr/__tests__/client.test.ts
git commit -m "herdr: NDJSON socket client with a fake server for tests"
```

---

### Task 2: cwd to repo and branch without a git spawn on the daemon

**Files:**
- Create: `lib/repo-for-cwd.ts`
- Modify: `commands/chat.ts:188-274` (move `safeRealpath`, `findGitRoot`, `resolveMainWorktreePath`, `repoAliasForPath` out; import them back)
- Test: `lib/__tests__/repo-for-cwd.test.ts`

**Interfaces:**
- Produces:
  - `findGitRoot(start: string): string | null`
  - `resolveMainWorktreePath(worktreeRoot: string): string | null`
  - `repoAliasForPath(mainWorktreePath: string, index: Record<string, string>): string | null`
  - `repoForCwd(cwd: string, index: Record<string, string>): string | null` (the three above composed: git root, main worktree, alias)
  - `branchForCwd(cwd: string, exec?: typeof runCapture): Promise<string | undefined>` (one async `git rev-parse --abbrev-ref HEAD`)
- Consumes: `runCapture` from `lib/subprocess.ts`, `repoLabel` from `lib/repo-label.ts`.

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/repo-for-cwd.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { branchForCwd, repoForCwd, resolveMainWorktreePath } from "../repo-for-cwd.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rt-repo-for-cwd-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function mainRepo(name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git", "worktrees"), { recursive: true });
  return path;
}

test("a main worktree resolves to its own alias", () => {
  const main = mainRepo("acme");
  mkdirSync(join(main, "src"));
  expect(repoForCwd(join(main, "src"), { "remote:gitlab.com%2Facme%2Facme": main })).toBe("acme");
});

test("a linked worktree resolves through its .git file to the main repo's alias", () => {
  const main = mainRepo("acme");
  mkdirSync(join(main, ".git", "worktrees", "wt-1"));
  const linked = join(root, "acme-wt-1");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt-1")}\n`);
  expect(resolveMainWorktreePath(linked)).toBe(main);
  expect(repoForCwd(linked, { "remote:gitlab.com%2Facme%2Facme": main })).toBe("acme");
});

test("a directory outside any repo resolves to null", () => {
  const stray = join(root, "stray");
  mkdirSync(stray);
  expect(repoForCwd(stray, {})).toBeNull();
});

test("branchForCwd reads the branch through an injected async exec and never throws", async () => {
  const exec = async () => ({ stdout: "feat/x\n", stderr: "", exitCode: 0 });
  expect(await branchForCwd("/anywhere", exec)).toBe("feat/x");
  const failing = async () => ({ stdout: "", stderr: "", exitCode: 128 });
  expect(await branchForCwd("/anywhere", failing)).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/__tests__/repo-for-cwd.test.ts`
Expected: FAIL, `Cannot find module "../repo-for-cwd.ts"`.

- [ ] **Step 3: Create the module by moving the four functions out of `commands/chat.ts`**

Create `lib/repo-for-cwd.ts` with the bodies of `safeRealpath`, `findGitRoot`, `resolveMainWorktreePath` and `repoAliasForPath` cut verbatim from `commands/chat.ts:188-274` (keep their comments), exported, plus:

```ts
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import { repoLabel } from "./repo-label.ts";
import { runCapture } from "./subprocess.ts";

// ... the four moved functions, each with `export` ...

/** cwd to the repo's display label using the repo index alone: no git spawn, so it is safe on the daemon thread. */
export function repoForCwd(cwd: string, index: Record<string, string>): string | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  const main = resolveMainWorktreePath(gitRoot);
  if (!main) return null;
  return repoAliasForPath(main, index);
}

/** The one git call an unsigned pane needs, async so the daemon loop never blocks. */
export async function branchForCwd(cwd: string, exec: typeof runCapture = runCapture): Promise<string | undefined> {
  const res = await exec(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 2_000 });
  if (res.exitCode !== 0) return undefined;
  const branch = res.stdout.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}
```

In `commands/chat.ts`, delete the four function bodies and add `import { findGitRoot, repoAliasForPath, resolveMainWorktreePath, safeRealpath } from "../lib/repo-for-cwd.ts";` (keep only the names chat.ts still uses; drop the now-unused `fs`/`path` imports if eslint or tsc flags them). The `__test__` seam at the bottom of `commands/chat.ts` keeps exporting `findGitRoot`, `resolveMainWorktreePath`, `repoAliasForPath` so `commands/__tests__/chat.test.ts` is untouched.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/__tests__/repo-for-cwd.test.ts commands/__tests__/chat.test.ts`
Expected: all pass (the chat CLI suite proves the move broke nothing).

- [ ] **Step 5: Commit**

```bash
git add lib/repo-for-cwd.ts lib/__tests__/repo-for-cwd.test.ts commands/chat.ts
git commit -m "lib: repo-for-cwd, the git-free cwd to repo resolution shared by chat and the pane verbs"
```

---

### Task 3: `pane:list` and `pane:peek`

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (types, two `Commands` entries, `COMMAND_NAMES`)
- Create: `lib/daemon/handlers/pane.ts`
- Modify: `lib/daemon/command-router.ts` (import + spread)
- Test: `lib/daemon/__tests__/pane-handlers.test.ts`

**Interfaces:**
- Produces (rt-client types, exported from `commands.ts`):

```ts
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Duplicated shape on purpose (see EventsBusEvent above): mirrors the daemon's pane row, which rt-client cannot import. */
export interface ChatPane {
  paneId: string;
  workspace: string;
  title?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  agentStatus: AgentStatus;
  sessionId?: string;
  presence?: { handle: string; status: BuddyStatus; rooms: string[] };
}
```

  and the catalog entries:

```ts
  "pane:list": { payload: Record<string, never>; data: { panes: ChatPane[] } };
  "pane:peek": { payload: { paneId: string; lines?: number }; data: { paneId: string; lines: string[] } };
```

- Produces (handler factory):

```ts
export function createPaneHandlers(opts: {
  db: Database;
  repoIndex: () => Record<string, string>;
  herdr?: typeof herdrRequest;   // test seam
  exec?: typeof runCapture;      // test seam
  now?: () => number;            // test seam
}): Pick<TypedHandlers, "pane:list" | "pane:peek"> & { db: Database }
```

  plus an exported `paneRow(pane: HerdrPane, ctx): Promise<ChatPane>` builder Task 5 reuses, and the wire types `HerdrPane`, `HerdrSnapshot`, `HerdrAgent` (the subset of herdr's `PaneInfo`/`AgentInfo`/`SessionSnapshot` fields used).

- Consumes: `herdrRequest`, `HERDR_UNAVAILABLE` (Task 1); `repoForCwd`, `branchForCwd` (Task 2); `listBuddies`, `listRooms` from `lib/state/index.ts`.

- [ ] **Step 1: Add the types and catalog entries to rt-client**

In `packages/rt-client/src/commands.ts`, after the `PresenceRow`/`BuddyStatus` declarations, add the `AgentStatus` and `ChatPane` types above. In the `Commands` interface, after `"chat:dm"`, add the two entries. In `COMMAND_NAMES`, append `"pane:list"`, `"pane:peek"`.

Run: `bun test lib/daemon/__tests__/rt-client-commands.test.ts`
Expected: FAIL: the exhaustiveness test names `pane:list` and `pane:peek` as catalog entries with no handler. That failure is the contract; Steps 2 to 4 satisfy it.

- [ ] **Step 2: Write the failing handler tests**

Create `lib/daemon/__tests__/pane-handlers.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { HERDR_UNAVAILABLE, herdrRequest } from "../../herdr/client.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers } from "../handlers/chat.ts";
import { createPaneHandlers } from "../handlers/pane.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
});

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `pane-h-${process.pid}-${n++}.db`));
}

const SNAPSHOT = {
  type: "session_snapshot",
  snapshot: {
    version: "0.8.0",
    protocol: 19,
    workspaces: [{ workspace_id: "w1", label: "acme", focused: false }],
    tabs: [],
    layouts: [],
    agents: [],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", cwd: "/tmp/acme", foreground_cwd: "/tmp/acme", terminal_title_stripped: "Evaluate codegen", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "sess-signed" }, revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", cwd: "/tmp/other", terminal_title_stripped: "fred", revision: 1 },
      { pane_id: "w1:p3", terminal_id: "t3", workspace_id: "w1", tab_id: "w1:t2", focused: false, agent_status: "unknown", cwd: "/tmp", revision: 1 },
    ],
  },
};

function harness(handler: FakeHerdrHandler, extra: { repoIndex?: Record<string, string> } = {}) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const db = freshDb();
  const herdr: typeof herdrRequest = (method, params, opts) => herdrRequest(method, params, { ...opts, sockPath: sock });
  const exec = async () => ({ stdout: "feat/branch\n", stderr: "", exitCode: 0 });
  const chat = createChatHandlers({ db, emitEvent: () => 0 });
  const pane = createPaneHandlers({ db, repoIndex: () => extra.repoIndex ?? {}, herdr, exec, now: Date.now });
  return { db, seen, chat, pane };
}

test("pane:list lists only claude panes, joined to presence by session id, with rooms", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-signed", baseHandle: "meg", cwd: "/tmp/acme", repo: "acme", branch: "main", pane: "w1:p1" });
  if (!signed.ok) throw new Error(signed.error);
  await chat["chat:join"]({ room: "build", handle: signed.data.handle });

  const res = await pane["pane:list"]({});
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.panes.map((p) => p.paneId)).toEqual(["w1:p1", "w1:p2"]);
  const first = res.data.panes[0]!;
  expect(first).toMatchObject({ workspace: "acme", title: "Evaluate codegen", cwd: "/tmp/acme", repo: "acme", branch: "main", agentStatus: "idle", sessionId: "sess-signed" });
  expect(first.presence).toMatchObject({ handle: "meg", rooms: ["build"] });
  expect(first.presence!.status).not.toBe("offline");
});

test("pane:list falls back to the presence row's pane id when herdr has no session id", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-by-pane", baseHandle: "fred", cwd: "/tmp/other", pane: "w1:p2" });
  if (!signed.ok) throw new Error(signed.error);
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  expect(res.data.panes.find((p) => p.paneId === "w1:p2")!.presence?.handle).toBe("fred");
});

test("pane:list derives repo and branch for an unsigned pane without touching the presence table", async () => {
  const { pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  const unsigned = res.data.panes.find((p) => p.paneId === "w1:p2")!;
  expect(unsigned.presence).toBeUndefined();
  expect(unsigned.branch).toBe("feat/branch");
  expect(unsigned.repo).toBeUndefined();
});

test("pane:list sorts listening, idle, deaf, then not signed in", async () => {
  const { chat, pane } = harness((method) => (method === "session.snapshot" ? SNAPSHOT : new HerdrFakeError("invalid_request", method)));
  const signed = await chat["chat:sign-in"]({ sessionId: "sess-p2", baseHandle: "fred", pane: "w1:p2" });
  if (!signed.ok) throw new Error(signed.error);
  const res = await pane["pane:list"]({});
  if (!res.ok) throw new Error(res.error);
  expect(res.data.panes.map((p) => p.paneId)).toEqual(["w1:p2", "w1:p1"]);
});

test("pane:list is herdr unavailable when the socket is missing", async () => {
  const db = freshDb();
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: join(tmpdir(), "absent-herdr.sock") });
  const pane = createPaneHandlers({ db, repoIndex: () => ({}), herdr });
  const res = await pane["pane:list"]({});
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith(HERDR_UNAVAILABLE)).toBe(true);
});

test("pane:peek reads the visible screen and drops trailing blank lines", async () => {
  const { pane, seen } = harness((method) =>
    method === "pane.read"
      ? { type: "pane_read", read: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", source: "visible", format: "text", text: "⏺ Read(x)\n  ⎿ 12 lines\n❯ \n\n\n", revision: 0, truncated: false } }
      : new HerdrFakeError("invalid_request", method),
  );
  const res = await pane["pane:peek"]({ paneId: "w1:p1", lines: 8 });
  if (!res.ok) throw new Error(res.error);
  expect(res.data).toEqual({ paneId: "w1:p1", lines: ["⏺ Read(x)", "  ⎿ 12 lines", "❯ "] });
  expect(seen[0]).toEqual({ method: "pane.read", params: { pane_id: "w1:p1", source: "visible", lines: 8 } });
});

test("pane:peek passes herdr's pane_not_found through as an error", async () => {
  const { pane } = harness(() => new HerdrFakeError("pane_not_found", "pane not found"));
  const res = await pane["pane:peek"]({ paneId: "w9:p9" });
  expect(res).toEqual({ ok: false, error: "pane_not_found: pane not found" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test lib/daemon/__tests__/pane-handlers.test.ts`
Expected: FAIL, `Cannot find module "../handlers/pane.ts"`.

- [ ] **Step 4: Write the handler module**

Create `lib/daemon/handlers/pane.ts`:

```ts
/**
 * pane:* daemon handlers: herdr's panes joined to rt's presence.
 * lib/herdr/client.ts owns the socket; this module owns the join.
 */
import type { Database } from "bun:sqlite";
import type { AgentStatus, BuddyStatus, ChatPane, Commands } from "../../../packages/rt-client/src/commands.ts";
import { HERDR_UNAVAILABLE, herdrRequest, type HerdrResult } from "../../herdr/client.ts";
import { branchForCwd, repoForCwd } from "../../repo-for-cwd.ts";
import { listBuddies, listRooms, type PresenceRow } from "../../state/index.ts";
import { runCapture } from "../../subprocess.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status: AgentStatus;
  cwd?: string;
  foreground_cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string };
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
}

export interface HerdrAgent extends HerdrPane {
  state_change_seq?: number;
}

export interface PaneRowContext {
  db: Database;
  repoIndex: () => Record<string, string>;
  exec: typeof runCapture;
  now: () => number;
  workspaces: Map<string, string>;
  bySession: Map<string, PresenceRow & { status: BuddyStatus }>;
  byPane: Map<string, PresenceRow & { status: BuddyStatus }>;
}

const STATUS_ORDER: Record<BuddyStatus | "none", number> = { live: 0, idle: 1, deaf: 2, offline: 3, none: 3 };

export function herdrError(res: { ok: false; code: string; message: string }): { ok: false; error: string } {
  if (res.code === "unreachable" || res.code === "timeout") return { ok: false, error: res.message.startsWith(HERDR_UNAVAILABLE) ? res.message : `${HERDR_UNAVAILABLE}: ${res.message}` };
  return { ok: false, error: `${res.code}: ${res.message}` };
}

/** Presence maps built once per verb call; offline rows are not presence. */
export function presenceMaps(db: Database, now: number): Pick<PaneRowContext, "bySession" | "byPane"> {
  const bySession = new Map<string, PresenceRow & { status: BuddyStatus }>();
  const byPane = new Map<string, PresenceRow & { status: BuddyStatus }>();
  for (const row of listBuddies(now, db)) {
    if (row.status === "offline") continue;
    bySession.set(row.sessionId, row);
    if (row.pane) byPane.set(row.pane, row);
  }
  return { bySession, byPane };
}

export async function paneRow(pane: HerdrPane, ctx: PaneRowContext): Promise<ChatPane> {
  const sessionId = pane.agent_session?.kind === "id" ? pane.agent_session.value : undefined;
  const presence = (sessionId ? ctx.bySession.get(sessionId) : undefined) ?? ctx.byPane.get(pane.pane_id);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  let repo = presence?.repo;
  let branch = presence?.branch;
  if (!presence && cwd) {
    repo = repoForCwd(cwd, ctx.repoIndex()) ?? undefined;
    branch = await branchForCwd(cwd, ctx.exec);
  }
  return {
    paneId: pane.pane_id,
    workspace: ctx.workspaces.get(pane.workspace_id) ?? pane.workspace_id,
    title: pane.terminal_title_stripped ?? pane.terminal_title,
    cwd,
    repo,
    branch,
    agentStatus: pane.agent_status,
    sessionId,
    presence: presence
      ? { handle: presence.handle, status: presence.status, rooms: listRooms(presence.handle, ctx.db).map((r) => r.room) }
      : undefined,
  };
}

export function sortPanes(panes: ChatPane[]): ChatPane[] {
  return panes
    .map((p, i) => ({ p, i }))
    .sort((a, b) => STATUS_ORDER[a.p.presence?.status ?? "none"] - STATUS_ORDER[b.p.presence?.status ?? "none"] || a.i - b.i)
    .map(({ p }) => p);
}

export function createPaneHandlers(opts: {
  db: Database;
  repoIndex: () => Record<string, string>;
  herdr?: typeof herdrRequest;
  exec?: typeof runCapture;
  now?: () => number;
}): Pick<TypedHandlers, "pane:list" | "pane:peek"> & { db: Database } {
  const { db, repoIndex } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const exec = opts.exec ?? runCapture;
  const now = opts.now ?? Date.now;

  async function snapshot(): Promise<HerdrResult<{ snapshot: HerdrSnapshot }>> {
    return herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
  }

  return {
    db,

    "pane:list": async (): Promise<CommandResult<"pane:list">> => {
      const snap = await snapshot();
      if (!snap.ok) return herdrError(snap);
      const ctx: PaneRowContext = {
        db, repoIndex, exec, now,
        workspaces: new Map(snap.result.snapshot.workspaces.map((w) => [w.workspace_id, w.label])),
        ...presenceMaps(db, now()),
      };
      const claude = snap.result.snapshot.panes.filter((p) => p.agent === "claude");
      const rows = await Promise.all(claude.map((p) => paneRow(p, ctx)));
      return { ok: true, data: { panes: sortPanes(rows) } };
    },

    "pane:peek": async (payload: Commands["pane:peek"]["payload"]): Promise<CommandResult<"pane:peek">> => {
      const params: Record<string, unknown> = { pane_id: payload.paneId, source: "visible" };
      if (payload.lines !== undefined) params.lines = payload.lines;
      const res = await herdr<{ read: { text: string } }>("pane.read", params);
      if (!res.ok) return herdrError(res);
      const lines = res.result.read.text.split("\n");
      while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
      return { ok: true, data: { paneId: payload.paneId, lines } };
    },
  };
}
```

Check `listBuddies`'s exact export in `lib/state/index.ts` (it is `listBuddies(now, db)` returning `Array<PresenceRow & { status: BuddyStatus }>`) and that `PresenceRow` is exported from the barrel; if the barrel exports it under another name, import that.

- [ ] **Step 5: Register the handlers in the router**

In `lib/daemon/command-router.ts`, add `import { createPaneHandlers } from "./handlers/pane.ts";` beside the chat import, and in `buildRoutedHandlers`, after the `chatHandlers` destructure:

```ts
  const { db: _paneDb, ...paneHandlers } = createPaneHandlers({ db: opts.chatDb, repoIndex: ctx.repoIndex });
```

and spread `...paneHandlers,` right after `...chatHandlers,`.

- [ ] **Step 6: Run the tests**

Run: `bun test lib/daemon/__tests__/pane-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts`
Expected: all pass. If the sort test fails because the signed-in `fred` row reads `deaf` rather than `idle` (no tail, no pulse), that is still ahead of `not signed in`; the expectation only orders presence before no presence.

- [ ] **Step 7: Commit**

```bash
git add packages/rt-client/src/commands.ts lib/daemon/handlers/pane.ts lib/daemon/command-router.ts lib/daemon/__tests__/pane-handlers.test.ts
git commit -m "daemon: pane:list and pane:peek, herdr panes joined to presence"
```

---

### Task 4: `pane:accounts` and `pane:directories`

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (types `PaneAccount`, `PaneDirectory`; two entries; `COMMAND_NAMES`)
- Create: `lib/cswap.ts`
- Modify: `lib/daemon/handlers/pane.ts`
- Test: `lib/__tests__/cswap.test.ts`, `lib/daemon/__tests__/pane-handlers.test.ts`

**Interfaces:**
- Produces (rt-client):

```ts
export interface PaneAccount { slot: number; email: string; alias?: string; headroom?: string }
export interface PaneDirectory { path: string; repo: string; branch?: string }
  "pane:accounts": { payload: Record<string, never>; data: { accounts: PaneAccount[] } };
  "pane:directories": { payload: { q?: string }; data: { directories: PaneDirectory[] } };
```

- Produces (lib): `parseCswapList(text: string): PaneAccount[]`, `cswapBin(): string`, `listCswapAccounts(exec?): Promise<PaneAccount[]>`.
- Consumes: `loadRegistry(repoName)` from `lib/worktree/registry.ts`, `repoLabel` from `lib/repo-label.ts`, `runCapture`.

- [ ] **Step 1: Catalog entries**

Add the two types and two entries to `packages/rt-client/src/commands.ts` and append `"pane:accounts"`, `"pane:directories"` to `COMMAND_NAMES`.

- [ ] **Step 2: Write the failing cswap parser tests**

Create `lib/__tests__/cswap.test.ts`:

```ts
import { expect, test } from "bun:test";
import { listCswapAccounts, parseCswapList } from "../cswap.ts";

const CAPTURED = `
A newer version of claude-swap is available (0.25.0). You are using 0.23.0. Run \`cswap upgrade\` to update.
Accounts:
  1: alex@acme.test [Acme] (history: shared)
     ├ $$:    100%   $400.07 / $400.00
     ├ 5h:      0%
     ├ 7d:     40%   resets Aug 30 20:00  in 4d 0h
     └ Fable:  35%   resets Aug 30 20:00  in 4d 0h · 6m ago
  2: someone@example.com
     └ 5h:     12%
`;

test("parses slots, emails, aliases and a compact headroom summary", () => {
  expect(parseCswapList(CAPTURED)).toEqual([
    { slot: 1, email: "alex@acme.test", alias: "Acme", headroom: "5h 0% · 7d 40% · Fable 35%" },
    { slot: 2, email: "someone@example.com", headroom: "5h 12%" },
  ]);
});

test("an empty or unrelated output parses to no accounts", () => {
  expect(parseCswapList("")).toEqual([]);
  expect(parseCswapList("cswap: not found")).toEqual([]);
});

test("listCswapAccounts is empty when the binary is missing or fails", async () => {
  const missing = async () => ({ stdout: "", stderr: "", exitCode: -1 });
  expect(await listCswapAccounts(missing)).toEqual([]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test lib/__tests__/cswap.test.ts`
Expected: FAIL, `Cannot find module "../cswap.ts"`.

- [ ] **Step 4: Write `lib/cswap.ts`**

```ts
import { homedir } from "os";
import { join } from "path";
import type { PaneAccount } from "../packages/rt-client/src/commands.ts";
import { runCapture } from "./subprocess.ts";

const ACCOUNT_LINE = /^\s*(\d+):\s+(\S+)(?:\s+\[([^\]]+)\])?/;
// The `$$` row is spend, not rate-limit headroom; it is skipped on purpose.
const HEADROOM_LINE = /^\s*[├└]\s+([^:$]+):\s+(\d+)%/;

export function parseCswapList(text: string): PaneAccount[] {
  const accounts: PaneAccount[] = [];
  const headroom: string[][] = [];
  for (const line of text.split("\n")) {
    const acct = ACCOUNT_LINE.exec(line);
    if (acct) {
      accounts.push({ slot: Number(acct[1]), email: acct[2]!, ...(acct[3] ? { alias: acct[3] } : {}) });
      headroom.push([]);
      continue;
    }
    const head = HEADROOM_LINE.exec(line);
    if (head && headroom.length) headroom[headroom.length - 1]!.push(`${head[1]!.trim()} ${head[2]}%`);
  }
  return accounts.map((a, i) => (headroom[i]!.length ? { ...a, headroom: headroom[i]!.join(" · ") } : a));
}

/** launchd's PATH does not carry ~/.local/bin, so resolve the binary explicitly. */
export function cswapBin(): string {
  return Bun.which("cswap") ?? join(homedir(), ".local", "bin", "cswap");
}

export async function listCswapAccounts(exec: typeof runCapture = runCapture): Promise<PaneAccount[]> {
  const res = await exec([cswapBin(), "list"], { timeoutMs: 5_000 });
  if (res.exitCode !== 0) return [];
  return parseCswapList(res.stdout);
}
```

- [ ] **Step 5: Write the failing handler tests**

Append to `lib/daemon/__tests__/pane-handlers.test.ts`:

```ts
test("pane:accounts parses cswap list through the injected exec", async () => {
  const db = freshDb();
  const exec = async (argv: [string, ...string[]]) =>
    argv[1] === "list"
      ? { stdout: "Accounts:\n  1: a@b.c [A]\n     └ 5h: 3%\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 1 };
  const pane = createPaneHandlers({ db, repoIndex: () => ({}), exec });
  const res = await pane["pane:accounts"]({});
  expect(res).toEqual({ ok: true, data: { accounts: [{ slot: 1, email: "a@b.c", alias: "A", headroom: "5h 3%" }] } });
});

test("pane:directories lists indexed repos and their registered worktrees, filtered by q", async () => {
  const db = freshDb();
  const pane = createPaneHandlers({
    db,
    repoIndex: () => ({ "remote:gitlab.com%2Facme%2Facme-dev": "/repos/acme-dev", "remote:github.com%2Fm%2Fchat": "/repos/chat" }),
    registry: (name) => (name.endsWith("acme-dev") ? [{ path: "/repos/acme-dev-wt-1", branch: "feat/one" }] : []),
  });
  const all = await pane["pane:directories"]({});
  if (!all.ok) throw new Error(all.error);
  expect(all.data.directories).toEqual([
    { path: "/repos/acme-dev", repo: "acme-dev" },
    { path: "/repos/acme-dev-wt-1", repo: "acme-dev", branch: "feat/one" },
    { path: "/repos/chat", repo: "chat" },
  ]);
  const filtered = await pane["pane:directories"]({ q: "wt-1" });
  if (!filtered.ok) throw new Error(filtered.error);
  expect(filtered.data.directories.map((d) => d.path)).toEqual(["/repos/acme-dev-wt-1"]);
});
```

- [ ] **Step 6: Implement both handlers**

In `lib/daemon/handlers/pane.ts`: extend the factory options with `registry?: (repoName: string) => Array<{ path: string; branch: string | null | undefined }>` (default: `(name) => loadRegistry(name)` imported from `../../worktree/registry.ts`), widen the return type to `Pick<TypedHandlers, "pane:list" | "pane:peek" | "pane:accounts" | "pane:directories">`, import `listCswapAccounts` from `../../cswap.ts` and `repoLabel` from `../../repo-label.ts`, and add:

```ts
    "pane:accounts": async (): Promise<CommandResult<"pane:accounts">> => {
      return { ok: true, data: { accounts: await listCswapAccounts(exec) } };
    },

    "pane:directories": async (payload: Commands["pane:directories"]["payload"]): Promise<CommandResult<"pane:directories">> => {
      const q = payload.q?.toLowerCase();
      const seen = new Set<string>();
      const out: PaneDirectory[] = [];
      const push = (d: PaneDirectory) => {
        if (seen.has(d.path)) return;
        if (q && !d.path.toLowerCase().includes(q)) return;
        seen.add(d.path);
        out.push(d);
      };
      for (const [name, path] of Object.entries(repoIndex()).sort(([, a], [, b]) => a.localeCompare(b))) {
        const repo = repoLabel(name);
        push({ path, repo });
        for (const tree of registry(name)) push({ path: tree.path, repo, ...(tree.branch ? { branch: tree.branch } : {}) });
      }
      return { ok: true, data: { directories: out } };
    },
```

(`PaneDirectory` imported from the rt-client commands module.)

- [ ] **Step 7: Run the tests**

Run: `bun test lib/__tests__/cswap.test.ts lib/daemon/__tests__/pane-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/rt-client/src/commands.ts lib/cswap.ts lib/__tests__/cswap.test.ts lib/daemon/handlers/pane.ts lib/daemon/__tests__/pane-handlers.test.ts
git commit -m "daemon: pane:accounts (cswap list) and pane:directories (repo index plus worktrees)"
```

---

### Task 5: the `chat.herdrWorkspace` setting and `pane:spawn`

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts` (chat block)
- Modify: `packages/rt-client/src/commands.ts` (`pane:spawn` entry; `COMMAND_NAMES`)
- Modify: `lib/daemon/handlers/pane.ts`
- Test: `lib/daemon/__tests__/pane-handlers.test.ts`

**Interfaces:**
- Produces:

```ts
  "pane:spawn": {
    payload: { cwd: string; account?: string; model?: string; effort?: string; prompt?: string; workspace?: string };
    data: { pane: ChatPane; ready: boolean };
  };
```

  and the setting row `chat.herdrWorkspace` (string, user scope, default `"chat"`).
- Consumes: `shellQuote` from `lib/herdr-launch.ts`, `getSetting` from `lib/settings/resolve.ts`, `listCswapAccounts`, `paneRow`.

- [ ] **Step 1: The setting**

In `packages/rt-client/src/settings/registry-defs.ts`, inside the `// --- chat (RT-48 Task 7)` block after `chat.viewerUrl`, add:

```ts
  {
    key: "chat.herdrWorkspace",
    type: "string",
    scopes: ["user"],
    default: "chat",
    merge: "replace",
    description: "herdr workspace label that rt pane spawn opens new agent tabs in; created when missing.",
  },
```

Run: `cd packages/rt-client && bun run build && cd ../.. && bun test packages/rt-client/test`
Expected: pass (the rt-client suite has no registry-specific test; the build and dist-freshness check are what this step proves).

- [ ] **Step 2: Catalog entry**

Add the `pane:spawn` entry to `Commands` and `"pane:spawn"` to `COMMAND_NAMES`.

- [ ] **Step 3: Write the failing spawn tests**

Append to `lib/daemon/__tests__/pane-handlers.test.ts`. The scripted fake tracks calls and returns status transitions in order:

```ts
function spawnFake(script: { statuses: string[]; screen?: string; agentGetFailures?: number }) {
  let getCalls = 0;
  let waitCalls = 0;
  const calls: string[] = [];
  const paneInfo = (status: string) => ({ pane_id: "w2:p7", terminal_id: "t7", workspace_id: "w2", tab_id: "w2:t3", focused: false, agent: "claude", agent_status: status, cwd: "/repos/acme-dev", terminal_title_stripped: "claude", revision: 3 });
  const handler: FakeHerdrHandler = (method, params) => {
    calls.push(method);
    switch (method) {
      case "workspace.list":
        return { type: "workspace_list", workspaces: [{ workspace_id: "w2", label: "chat", focused: false }] };
      case "workspace.create":
        return { type: "workspace_created", workspace: { workspace_id: "w3", label: params.label }, tab: { tab_id: "w3:t1" }, root_pane: paneInfo("unknown") };
      case "tab.create":
        return { type: "tab_created", tab: { tab_id: "w2:t3", workspace_id: "w2", label: params.label }, root_pane: paneInfo("unknown") };
      case "pane.send_input":
      case "pane.send_keys":
        return { type: "ok" };
      case "agent.get":
        if (getCalls++ < (script.agentGetFailures ?? 0)) return new HerdrFakeError("agent_not_found", "agent target w2:p7 not found");
        return { type: "agent_info", agent: paneInfo(script.statuses[Math.min(waitCalls, script.statuses.length - 1)]!) };
      case "agent.wait": {
        const status = script.statuses[Math.min(waitCalls++, script.statuses.length - 1)]!;
        if (status === "timeout") return new HerdrFakeError("timeout", "timed out waiting for agent status");
        return { type: "agent_info", agent: paneInfo(status) };
      }
      case "pane.read":
        return { type: "pane_read", read: { pane_id: "w2:p7", workspace_id: "w2", tab_id: "w2:t3", source: "visible", format: "text", text: script.screen ?? "", revision: 0, truncated: false } };
      case "agent.prompt":
        return { type: "agent_prompted", agent: paneInfo("working") };
      case "pane.get":
        return { type: "pane_info", pane: paneInfo(script.statuses[script.statuses.length - 1] === "timeout" ? "unknown" : script.statuses[script.statuses.length - 1]!) };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: { workspaces: [{ workspace_id: "w2", label: "chat" }], panes: [], tabs: [], layouts: [], agents: [], version: "0.8.0", protocol: 19 } };
      default:
        return new HerdrFakeError("invalid_request", method);
    }
  };
  return { handler, calls };
}

const CSWAP_EXEC = async (argv: [string, ...string[]]) =>
  argv[1] === "list" ? { stdout: "Accounts:\n  1: me@x.y [Me]\n", stderr: "", exitCode: 0 } : { stdout: "main\n", stderr: "", exitCode: 0 };

test("pane:spawn creates a tab in the chat workspace, launches claude, waits for idle and returns the pane ready", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"], agentGetFailures: 2 });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/acme-dev", account: "Me", model: "claude-fable-5", effort: "high" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(true);
  expect(res.data.pane).toMatchObject({ paneId: "w2:p7", workspace: "chat", cwd: "/repos/acme-dev", agentStatus: "idle" });
  const tab = seen.find((s) => s.method === "tab.create")!;
  expect(tab.params).toMatchObject({ workspace_id: "w2", label: "acme-dev", cwd: "/repos/acme-dev", focus: false });
  const input = seen.find((s) => s.method === "pane.send_input")!;
  // shellQuote leaves strings matching ^[a-zA-Z0-9_./:@=-]+$ bare; only a value outside that set gets quotes.
  expect(input.params.text).toBe("cd /repos/acme-dev && cswap run Me --share-history -- claude --model claude-fable-5 --effort high");
  expect(input.params.keys).toEqual(["enter"]);
  expect(calls.filter((c) => c === "agent.get").length).toBeGreaterThanOrEqual(3);
  expect(calls).not.toContain("workspace.create");
});

test("pane:spawn creates the workspace when the label is missing and launches plain claude without an account", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"] });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", workspace: "fleet" });
  if (!res.ok) throw new Error(res.error);
  expect(calls).toContain("workspace.create");
  expect(seen.find((s) => s.method === "workspace.create")!.params).toMatchObject({ label: "fleet", focus: false });
  expect(seen.find((s) => s.method === "pane.send_input")!.params.text).toBe("cd /repos/chat && claude");
});

test("pane:spawn quotes a cwd with a space", async () => {
  const { handler } = spawnFake({ statuses: ["idle"] });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/my repo" });
  if (!res.ok) throw new Error(res.error);
  expect(seen.find((s) => s.method === "pane.send_input")!.params.text).toBe("cd '/repos/my repo' && claude");
});

test("pane:spawn answers the trust dialog once, then sends the opening prompt", async () => {
  const { handler, calls } = spawnFake({ statuses: ["blocked", "idle"], screen: "Do you trust the files in this folder?" });
  const { pane, seen } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", prompt: "read AGENTS.md" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(true);
  expect(calls.filter((c) => c === "pane.send_keys")).toHaveLength(1);
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toMatchObject({ target: "w2:p7", text: "read AGENTS.md", wait: { until: ["working"], timeout_ms: 5000 } });
});

test("pane:spawn returns ready:false with the pane when idle never arrives, and does not send the prompt", async () => {
  const { handler, calls } = spawnFake({ statuses: ["timeout"] });
  const { pane } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", prompt: "hi" });
  if (!res.ok) throw new Error(res.error);
  expect(res.data.ready).toBe(false);
  expect(res.data.pane.paneId).toBe("w2:p7");
  expect(calls).not.toContain("agent.prompt");
});

test("pane:spawn refuses an unknown cswap account before touching herdr", async () => {
  const { handler, calls } = spawnFake({ statuses: ["idle"] });
  const { pane } = harness(handler);
  const res = await pane["pane:spawn"]({ cwd: "/repos/chat", account: "nobody" });
  expect(res).toEqual({ ok: false, error: 'unknown cswap account "nobody"' });
  expect(calls).toHaveLength(0);
});
```

Update `harness()` so its `exec` is `CSWAP_EXEC` (the earlier `branchForCwd` test still passes because `CSWAP_EXEC` answers `main` for git; adjust that test's expectation from `feat/branch` to `main`).

- [ ] **Step 4: Run to verify failure**

Run: `bun test lib/daemon/__tests__/pane-handlers.test.ts`
Expected: the five new tests FAIL (`pane["pane:spawn"] is not a function`).

- [ ] **Step 5: Implement `pane:spawn`**

In `lib/daemon/handlers/pane.ts`, add imports `import { basename } from "path"; import { getSetting } from "../../settings/resolve.ts"; import { shellQuote } from "../../herdr-launch.ts"; import { waitTimeout } from "../../herdr/client.ts";` (check `shellQuote`'s export in `lib/herdr-launch.ts:52`; if it is not exported, export it), widen the factory's return type with `"pane:spawn"`, and add these module-level constants and the handler:

```ts
const REGISTER_BUDGET_MS = 10_000;
const REGISTER_POLL_MS = 250;
const IDLE_BUDGET_MS = 50_000;
const TRUST_BUDGET_MS = 15_000;
const PROMPT_BUDGET_MS = 5_000;
const SETTLED = ["idle", "done", "blocked"];

export function launchCommand(a: { cwd: string; account?: string; model?: string; effort?: string }): string {
  const claude = ["claude", ...(a.model ? ["--model", shellQuote(a.model)] : []), ...(a.effort ? ["--effort", shellQuote(a.effort)] : [])].join(" ");
  const launch = a.account ? `cswap run ${shellQuote(a.account)} --share-history -- ${claude}` : claude;
  return `cd ${shellQuote(a.cwd)} && ${launch}`;
}
```

```ts
    "pane:spawn": async (payload: Commands["pane:spawn"]["payload"]): Promise<CommandResult<"pane:spawn">> => {
      const { cwd, account, model, effort, prompt } = payload;
      if (!cwd || !cwd.startsWith("/")) return { ok: false, error: "cwd must be an absolute path" };
      if (account) {
        const accounts = await listCswapAccounts(exec);
        const known = accounts.some((a) => a.alias === account || a.email === account || String(a.slot) === account);
        if (!known) return { ok: false, error: `unknown cswap account "${account}"` };
      }

      const label = payload.workspace ?? getSetting<string>("chat.herdrWorkspace").value ?? "chat";
      const list = await herdr<{ workspaces: HerdrWorkspace[] }>("workspace.list", {});
      if (!list.ok) return herdrError(list);
      let workspaceId = list.result.workspaces.find((w) => w.label === label)?.workspace_id;
      if (!workspaceId) {
        const created = await herdr<{ workspace: HerdrWorkspace }>("workspace.create", { label, focus: false });
        if (!created.ok) return herdrError(created);
        workspaceId = created.result.workspace.workspace_id;
      }

      const tab = await herdr<{ root_pane: HerdrPane }>("tab.create", { workspace_id: workspaceId, label: basename(cwd), cwd, focus: false });
      if (!tab.ok) return herdrError(tab);
      const paneId = tab.result.root_pane.pane_id;

      const sent = await herdr("pane.send_input", { pane_id: paneId, text: launchCommand({ cwd, account, model, effort }), keys: ["enter"] });
      if (!sent.ok) return herdrError(sent);

      // herdr registers the agent a few hundred ms after the shell starts claude.
      const registerDeadline = now() + REGISTER_BUDGET_MS;
      let registered = false;
      while (now() < registerDeadline) {
        const got = await herdr("agent.get", { target: paneId });
        if (got.ok) { registered = true; break; }
        await Bun.sleep(REGISTER_POLL_MS);
      }

      let status: AgentStatus = "unknown";
      let ready = false;
      if (registered) {
        const settled = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: IDLE_BUDGET_MS }, { timeoutMs: waitTimeout(IDLE_BUDGET_MS) });
        if (settled.ok) status = settled.result.agent.agent_status;
        if (status === "blocked") {
          const screen = await herdr<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible" });
          if (screen.ok && /trust/i.test(screen.result.read.text)) {
            await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
            const again = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: TRUST_BUDGET_MS }, { timeoutMs: waitTimeout(TRUST_BUDGET_MS) });
            if (again.ok) status = again.result.agent.agent_status;
          }
        }
        ready = status === "idle" || status === "done";
      }

      if (ready && prompt) {
        await herdr("agent.prompt", { target: paneId, text: prompt, wait: { until: ["working"], timeout_ms: PROMPT_BUDGET_MS } }, { timeoutMs: waitTimeout(PROMPT_BUDGET_MS) });
      }

      const info = await herdr<{ pane: HerdrPane }>("pane.get", { pane_id: paneId });
      const raw: HerdrPane = info.ok ? info.result.pane : { ...tab.result.root_pane, agent: "claude", agent_status: status };
      const ctx: PaneRowContext = { db, repoIndex, exec, now, workspaces: new Map([[workspaceId, label]]), ...presenceMaps(db, now()) };
      const pane = await paneRow({ ...raw, agent_status: info.ok ? raw.agent_status : status }, ctx);
      return { ok: true, data: { pane, ready } };
    },
```

Write the registration poll as a count loop rather than a deadline: `Math.ceil(REGISTER_BUDGET_MS / REGISTER_POLL_MS)` attempts, each `Bun.sleep(REGISTER_POLL_MS)` apart, so it does not depend on the injected `now`.

- [ ] **Step 6: Run the tests**

Run: `bun test lib/daemon/__tests__/pane-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts`
Expected: all pass. The `agentGetFailures: 2` test takes about 0.5s of real sleep; fine.

- [ ] **Step 7: Commit**

```bash
git add packages/rt-client/src/settings/registry-defs.ts packages/rt-client/src/commands.ts lib/daemon/handlers/pane.ts lib/daemon/__tests__/pane-handlers.test.ts
git commit -m "daemon: pane:spawn starts claude in a herdr tab; chat.herdrWorkspace setting"
```

---

### Task 6: `chat:invite`

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (`InviteResult`, entry, `COMMAND_NAMES`)
- Modify: `lib/daemon/handlers/chat.ts` (`CHAT_COMMANDS`, the handler, a `herdr` seam on the factory)
- Modify: `lib/daemon/command-router.ts` (nothing new: the chat factory already spreads)
- Test: `lib/daemon/__tests__/chat-handlers.test.ts`

**Interfaces:**
- Produces:

```ts
export interface InviteResult { paneId: string; delivered: "accepted" | "queued" | "refused"; reason?: string }
  "chat:invite": { payload: { paneId: string; room: string; note?: string; from: string; callerPane?: string }; data: InviteResult };
```

  and `inviteText(room: string, from: string, note?: string): string` exported from `lib/daemon/handlers/chat.ts`.
- Consumes: `herdrRequest`, `waitTimeout`, `HERDR_UNAVAILABLE`, `herdrError` (from `pane.ts`).

- [ ] **Step 1: Catalog entry**

Add `InviteResult` and the `chat:invite` entry to `Commands`, and `"chat:invite"` to `COMMAND_NAMES`.

- [ ] **Step 2: Write the failing tests**

Append to `lib/daemon/__tests__/chat-handlers.test.ts` (add imports `import { herdrRequest } from "../../herdr/client.ts"; import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts"; import { inviteText } from "../handlers/chat.ts";` and an `afterEach` that stops fakes, as in the pane tests):

```ts
function inviteHarness(handler: FakeHerdrHandler) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const db = openStateDb(join(tmpdir(), `chat-inv-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: sock });
  return { h: createChatHandlers({ db, emitEvent: () => 0, herdr }), seen };
}

const agent = (status: string, kind = "claude") => ({ type: "agent_info", agent: { pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: kind, agent_status: status, revision: 1 } });

test("inviteText is one line: the slash command, then the attributed note with newlines collapsed", () => {
  expect(inviteText("build", "matt")).toBe("/chat:join build");
  expect(inviteText("build", "fred", "take the\nserver half\n")).toBe("/chat:join build note from fred: take the server half");
});

test("chat:invite prompts an idle pane and reports accepted when it reaches working", async () => {
  const { h, seen } = inviteHarness((method, params) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: { ...agent("working").agent, text: params.text } };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt", note: "you own vite" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "accepted" } });
  const prompt = seen.find((s) => s.method === "agent.prompt")!;
  expect(prompt.params).toEqual({ target: "w1:p1", text: "/chat:join build note from matt: you own vite", wait: { until: ["working"], timeout_ms: 5000 } });
});

test("chat:invite queues into a working pane without waiting", async () => {
  const { h, seen } = inviteHarness((method) => {
    if (method === "agent.get") return agent("working");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: agent("working").agent };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toEqual({ target: "w1:p1", text: "/chat:join build" });
});

test("chat:invite refuses a blocked pane without sending anything", async () => {
  const { h, seen } = inviteHarness((method) => (method === "agent.get" ? agent("blocked") : new HerdrFakeError("invalid_request", method)));
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "at a prompt" } });
  expect(seen.map((s) => s.method)).toEqual(["agent.get"]);
});

test("chat:invite nudges Enter once on a stalled prompt, then reports accepted or queued honestly", async () => {
  let prompts = 0;
  const { h, seen } = inviteHarness((method) => {
    if (method === "agent.get") return agent("idle");
    // herdr answers a stall inside the 5s effect window with `timeout`; `agent_prompt_stalled` needs a longer budget. The handler accepts both.
    if (method === "agent.prompt") { prompts++; return new HerdrFakeError("timeout", "timed out waiting for agent status"); }
    if (method === "pane.send_keys") return { type: "ok" };
    if (method === "agent.wait") return new HerdrFakeError("timeout", "timed out waiting for agent status");
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(prompts).toBe(1);
  expect(seen.filter((s) => s.method === "pane.send_keys")).toHaveLength(1);
});

test("chat:invite refuses a pane that is not a claude pane, the caller's own pane, and a bad room", async () => {
  const { h } = inviteHarness((method) => (method === "agent.get" ? new HerdrFakeError("agent_not_found", "agent target w1:p1 not found") : new HerdrFakeError("invalid_request", method)));
  expect(await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "not a claude pane" } });
  expect(await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt", callerPane: "w1:p1" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "that is this pane" } });
  const codex = inviteHarness((method) => (method === "agent.get" ? agent("idle", "codex") : new HerdrFakeError("invalid_request", method)));
  expect(await codex.h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "not a claude pane" } });
  const bad = await h["chat:invite"]({ paneId: "w1:p1", room: "Bad Room", from: "matt" });
  expect(bad.ok).toBe(false);
});

test("chat:invite is herdr unavailable when the socket is missing", async () => {
  const db = openStateDb(join(tmpdir(), `chat-inv-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: join(tmpdir(), "absent-herdr.sock") });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith("herdr unavailable")).toBe(true);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts`
Expected: the new tests FAIL (`inviteText` not exported; `chat:invite` not a function).

- [ ] **Step 4: Implement**

In `lib/daemon/handlers/chat.ts`: add `"chat:invite"` to `CHAT_COMMANDS`; add `herdr?: typeof herdrRequest` to the factory options (`const herdr = opts.herdr ?? herdrRequest;`); import `herdrRequest`, `waitTimeout` from `../../herdr/client.ts` and `herdrError` from `./pane.ts`; and add:

```ts
const INVITE_WAIT_MS = 5_000;

/** One line, because Claude Code dispatches a slash command from the first line only. */
export function inviteText(room: string, from: string, note?: string): string {
  const head = `/chat:join ${room}`;
  const body = note?.replace(/\s*\n+\s*/g, " ").trim();
  return body ? `${head} note from ${from}: ${body}` : head;
}
```

```ts
    "chat:invite": async (payload: Commands["chat:invite"]["payload"]): Promise<CommandResult<"chat:invite">> => {
      const { paneId, room, note, from, callerPane } = payload;
      if (!isValidChatName(room)) return { ok: false, error: `invalid room "${room}"` };
      if (!isValidChatName(from)) return { ok: false, error: `invalid handle "${from}"` };
      const refused = (reason: string): CommandResult<"chat:invite"> => ({ ok: true, data: { paneId, delivered: "refused", reason } });
      if (callerPane && callerPane === paneId) return refused("that is this pane");

      const probe = await herdr<{ agent: { agent: string; agent_status: string } }>("agent.get", { target: paneId });
      if (!probe.ok) {
        if (probe.code === "agent_not_found" || probe.code === "agent_target_ambiguous") return refused("not a claude pane");
        return herdrError(probe);
      }
      if (probe.result.agent.agent !== "claude") return refused("not a claude pane");
      const status = probe.result.agent.agent_status;
      if (status === "blocked") return refused("at a prompt");

      const text = inviteText(room, from, note);
      if (status === "working") {
        const queued = await herdr("agent.prompt", { target: paneId, text });
        if (!queued.ok) return queued.code === "agent_blocked" ? refused("at a prompt") : herdrError(queued);
        return { ok: true, data: { paneId, delivered: "queued" } };
      }

      const prompted = await herdr("agent.prompt", { target: paneId, text, wait: { until: ["working"], timeout_ms: INVITE_WAIT_MS } }, { timeoutMs: waitTimeout(INVITE_WAIT_MS) });
      if (prompted.ok) return { ok: true, data: { paneId, delivered: "accepted" } };
      if (prompted.code === "agent_blocked") return refused("at a prompt");
      if (prompted.code !== "timeout" && prompted.code !== "agent_prompt_stalled") return herdrError(prompted);

      // The Claude TUI can absorb the bundled Enter into the composer; one nudge, one more wait.
      await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
      const nudged = await herdr("agent.wait", { target: paneId, until: ["working"], timeout_ms: INVITE_WAIT_MS }, { timeoutMs: waitTimeout(INVITE_WAIT_MS) });
      return { ok: true, data: { paneId, delivered: nudged.ok ? "accepted" : "queued" } };
    },
```

`pane.ts` importing nothing from `chat.ts` and `chat.ts` importing `herdrError` from `pane.ts` keeps the dependency one-way.

- [ ] **Step 5: Run the tests**

Run: `bun test lib/daemon/__tests__/chat-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/rt-client/src/commands.ts lib/daemon/handlers/chat.ts lib/daemon/__tests__/chat-handlers.test.ts
git commit -m "daemon: chat:invite types /chat:join into a herdr pane"
```

---

### Task 7: rt-client wrappers

**Files:**
- Modify: `packages/rt-client/src/client.ts`
- Modify: `packages/rt-client/src/index.ts` (function block, type block)
- Modify: `packages/rt-client/README.md` (the Chat table)
- Test: `packages/rt-client/test/client.test.ts`, `packages/rt-client/test/index-surface.test.ts`

**Interfaces:**
- Produces:

```ts
paneList(o?: RtClientOptions): Promise<RtResponse<{ panes: ChatPane[] }>>
panePeek(a: { paneId: string; lines?: number }, o?: RtClientOptions): Promise<RtResponse<{ paneId: string; lines: string[] }>>
paneSpawn(a: { cwd: string; account?: string; model?: string; effort?: string; prompt?: string; workspace?: string }, o?: RtClientOptions): Promise<RtResponse<{ pane: ChatPane; ready: boolean }>>   // timeoutMs default 90_000
paneAccounts(o?: RtClientOptions): Promise<RtResponse<{ accounts: PaneAccount[] }>>
paneDirectories(a: { q?: string }, o?: RtClientOptions): Promise<RtResponse<{ directories: PaneDirectory[] }>>
chatInvite(a: { paneId: string; room: string; note?: string; from: string; callerPane?: string }, o?: RtClientOptions): Promise<RtResponse<InviteResult>>   // timeoutMs default 30_000
```

  and type re-exports `AgentStatus`, `ChatPane`, `PaneAccount`, `PaneDirectory`, `InviteResult`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rt-client/test/client.test.ts` (the file already imports `fakeDaemon` and keeps a `stops` list); extend its existing `../src/client.ts` import at the top with `chatInvite, paneDirectories, paneList, panePeek, paneSpawn` and add `spyOn` to the `bun:test` import, then append:

```ts
describe("pane wrappers", () => {
  test("paneList sends an empty payload; panePeek and paneDirectories omit undefined fields", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "pane:list": { ok: true, data: { panes: [] } },
      "pane:peek": { ok: true, data: { paneId: "w1:p1", lines: [] } },
      "pane:directories": { ok: true, data: { directories: [] } },
    });
    stops.push(stop);
    await paneList({ sockPath: sock });
    await panePeek({ paneId: "w1:p1" }, { sockPath: sock });
    await paneDirectories({}, { sockPath: sock });
    expect(seen.map((s) => [s.cmd, s.payload])).toEqual([
      ["pane:list", {}],
      ["pane:peek", { paneId: "w1:p1" }],
      ["pane:directories", {}],
    ]);
  });

  test("paneSpawn and chatInvite outlive rt-client's 15s default", async () => {
    const { sock, stop } = fakeDaemon({});
    stops.push(stop);
    // fakeDaemon answers instantly; the assertion is on the timeout the wrapper hands rtCommand,
    // captured through the AbortSignal it builds. Spy on AbortSignal.timeout.
    const spy = spyOn(AbortSignal, "timeout");
    await paneSpawn({ cwd: "/x" }, { sockPath: sock });
    await chatInvite({ paneId: "w1:p1", room: "build", from: "matt" }, { sockPath: sock });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([90_000, 30_000]);
    spy.mockRestore();
  });
});
```

Append to `packages/rt-client/test/index-surface.test.ts` a check that `paneList`, `panePeek`, `paneSpawn`, `paneAccounts`, `paneDirectories`, `chatInvite` are functions on the barrel, in the file's existing style.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/rt-client/test/client.test.ts packages/rt-client/test/index-surface.test.ts`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Write the wrappers**

In `packages/rt-client/src/client.ts`, after the chat wrappers:

```ts
// ─── Panes (rt chat invite) ────────────────────────────────────────────────
// herdr-facing verbs; the daemon answers `herdr unavailable` without herdr.

export function paneList(o: RtClientOptions = {}): Promise<RtResponse<{ panes: ChatPane[] }>> {
  return rtCommand<{ panes: ChatPane[] }>("pane:list", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function panePeek(a: { paneId: string; lines?: number }, o: RtClientOptions = {}): Promise<RtResponse<{ paneId: string; lines: string[] }>> {
  const payload: Record<string, unknown> = { paneId: a.paneId };
  if (a.lines !== undefined) payload.lines = a.lines;
  return rtCommand<{ paneId: string; lines: string[] }>("pane:peek", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

/** The spawn waits on claude starting, so its budget is minutes, not seconds. */
export function paneSpawn(
  a: { cwd: string; account?: string; model?: string; effort?: string; prompt?: string; workspace?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<{ pane: ChatPane; ready: boolean }>> {
  const payload: Record<string, unknown> = { cwd: a.cwd };
  for (const k of ["account", "model", "effort", "prompt", "workspace"] as const) if (a[k] !== undefined) payload[k] = a[k];
  return rtCommand<{ pane: ChatPane; ready: boolean }>("pane:spawn", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 90_000 });
}

export function paneAccounts(o: RtClientOptions = {}): Promise<RtResponse<{ accounts: PaneAccount[] }>> {
  return rtCommand<{ accounts: PaneAccount[] }>("pane:accounts", {}, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function paneDirectories(a: { q?: string }, o: RtClientOptions = {}): Promise<RtResponse<{ directories: PaneDirectory[] }>> {
  const payload: Record<string, unknown> = {};
  if (a.q !== undefined) payload.q = a.q;
  return rtCommand<{ directories: PaneDirectory[] }>("pane:directories", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 10_000 });
}

export function chatInvite(
  a: { paneId: string; room: string; note?: string; from: string; callerPane?: string },
  o: RtClientOptions = {},
): Promise<RtResponse<InviteResult>> {
  const payload: Record<string, unknown> = { paneId: a.paneId, room: a.room, from: a.from };
  if (a.note !== undefined) payload.note = a.note;
  if (a.callerPane !== undefined) payload.callerPane = a.callerPane;
  return rtCommand<InviteResult>("chat:invite", payload, { sockPath: o.sockPath, timeoutMs: o.timeoutMs ?? 30_000 });
}
```

Import the types from `./commands.ts`. In `packages/rt-client/src/index.ts`, add the six functions to the function re-export block and the five types to the type block. In `packages/rt-client/README.md`'s Chat table, add a row: `paneList / panePeek / paneSpawn / paneAccounts / paneDirectories` with "herdr panes: list with presence joined, peek a screen, start claude in a tab, cswap accounts, directory suggestions" and a row `chatInvite` with "type `/chat:join <room>` into a pane; `accepted`, `queued` or `refused`".

- [ ] **Step 4: Build and test**

Run: `cd packages/rt-client && bun run build && cd ../.. && bun test packages/rt-client/test`
Expected: all pass, including dist-freshness.

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client
git commit -m "rt-client: pane and invite wrappers with their own timeouts"
```

---

### Task 8: the `rt pane` CLI group

**Files:**
- Create: `commands/pane.ts`
- Modify: `lib/command-tree-def.ts` (a `pane` group with five subcommands)
- Modify: `lib/module-registry.ts` (one entry)
- Test: `commands/__tests__/pane.test.ts`
- Regenerate: `website/docs/reference` via `bun scripts/gen-docs.ts`

**Interfaces:**
- Produces: `paneList`, `panePeek`, `paneSpawn`, `paneAccounts`, `paneDirectories` exports, each `(args: string[]) => Promise<void>`.
  - `rt pane list [--json]`
  - `rt pane peek <pane> [--lines 8] [--json]`
  - `rt pane spawn --cwd <path> [--account <a>] [--model <m>] [--effort <e>] [--prompt <text>] [--workspace <label>] [--json]`
  - `rt pane accounts [--json]`
  - `rt pane directories [--q <text>] [--json]`
- Consumes: the Task 7 wrappers.

- [ ] **Step 1: Write the failing CLI tests**

Create `commands/__tests__/pane.test.ts`, modelled on the fake daemon in `packages/rt-client/test/fake-daemon.ts` and the `process.exit` sentinel harness in `commands/__tests__/chat.test.ts:141-183` (copy `runRaw` from there, calling the pane exports):

```ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { paneAccounts, paneDirectories, paneList, panePeek, paneSpawn } from "../pane.ts";

let home: string;
let origHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Array<{ cmd: string; payload: unknown }> = [];
let replies: Record<string, unknown> = {};

beforeEach(() => {
  origHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-pane-cli-")));
  process.env.HOME = home;
  const sockDir = join(home, ".mattstack", "rt");
  mkdirSync(sockDir, { recursive: true });
  seen = [];
  server = Bun.serve({
    unix: join(sockDir, "rt.sock"),
    async fetch(req) {
      const cmd = new URL(req.url).pathname.slice(1);
      const payload = req.method === "POST" ? await req.json() : {};
      seen.push({ cmd, payload });
      return Response.json(replies[cmd] ?? { ok: false, error: `unknown command: ${cmd}` });
    },
  });
});

afterEach(() => {
  server?.stop(true);
  process.env.HOME = origHome;
});

async function run(fn: (args: string[]) => Promise<void>, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); });
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit sentinel"); });
  let code = 0;
  try {
    await fn(args);
  } catch (e) {
    if (e instanceof Error && e.message === "process.exit sentinel") code = (exitSpy.mock.calls.at(-1)?.[0] as number | undefined) ?? 1;
    else throw e;
  } finally {
    logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
  }
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const PANE = { paneId: "w1:p1", workspace: "acme", title: "Evaluate codegen", cwd: "/repos/acme", repo: "acme", branch: "main", agentStatus: "idle", presence: { handle: "meg", status: "live", rooms: ["build"] } };

test("pane list --json prints the rows; plain prints one line per pane", async () => {
  replies = { "pane:list": { ok: true, data: { panes: [PANE, { ...PANE, paneId: "w1:p2", presence: undefined, title: "fred" }] } } };
  const json = await run(paneList, ["--json"]);
  expect(JSON.parse(json.stdout)).toEqual({ ok: true, panes: replies["pane:list"]!["data"]["panes"] });
  const plain = await run(paneList, []);
  expect(plain.stdout).toContain("w1:p1");
  expect(plain.stdout).toContain("meg");
  expect(plain.stdout).toContain("not signed in");
});

test("pane list reports herdr unavailable and exits 1", async () => {
  replies = { "pane:list": { ok: false, error: "herdr unavailable: no socket" } };
  const r = await run(paneList, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("herdr unavailable");
});

test("pane peek passes the pane id and --lines", async () => {
  replies = { "pane:peek": { ok: true, data: { paneId: "w1:p1", lines: ["a", "b"] } } };
  const r = await run(panePeek, ["w1:p1", "--lines", "2"]);
  expect(seen[0]).toEqual({ cmd: "pane:peek", payload: { paneId: "w1:p1", lines: 2 } });
  expect(r.stdout).toBe("a\nb");
});

test("pane spawn passes every flag and prints the pane and readiness", async () => {
  replies = { "pane:spawn": { ok: true, data: { pane: PANE, ready: true } } };
  const r = await run(paneSpawn, ["--cwd", "/repos/acme", "--account", "Acme", "--model", "claude-fable-5", "--effort", "high", "--workspace", "chat", "--prompt", "read AGENTS.md", "--json"]);
  expect(seen[0]!.payload).toEqual({ cwd: "/repos/acme", account: "Acme", model: "claude-fable-5", effort: "high", workspace: "chat", prompt: "read AGENTS.md" });
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, ready: true, pane: { paneId: "w1:p1" } });
});

test("pane spawn requires --cwd", async () => {
  const r = await run(paneSpawn, []);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--cwd");
});

test("pane accounts and directories render", async () => {
  replies = {
    "pane:accounts": { ok: true, data: { accounts: [{ slot: 1, email: "a@b.c", alias: "A", headroom: "5h 3%" }] } },
    "pane:directories": { ok: true, data: { directories: [{ path: "/repos/chat", repo: "chat" }] } },
  };
  expect((await run(paneAccounts, [])).stdout).toContain("A");
  const d = await run(paneDirectories, ["--q", "chat"]);
  expect(seen.at(-1)).toEqual({ cmd: "pane:directories", payload: { q: "chat" } });
  expect(d.stdout).toContain("/repos/chat");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test commands/__tests__/pane.test.ts`
Expected: FAIL, `Cannot find module "../pane.ts"`.

- [ ] **Step 3: Write `commands/pane.ts`**

```ts
/**
 * rt pane: herdr panes as rt sees them (joined to chat presence).
 *
 *   rt pane list [--json]                                         claude panes, presence joined
 *   rt pane peek <pane> [--lines 8] [--json]                      the last lines of a pane's screen
 *   rt pane spawn --cwd <path> [--account <a>] [--model <m>]
 *                 [--effort <e>] [--prompt <text>] [--workspace <label>] [--json]
 *   rt pane accounts [--json]                                     cswap accounts with headroom
 *   rt pane directories [--q <text>] [--json]                     repos and worktrees for --cwd
 *
 * Every verb needs herdr; without it the daemon answers "herdr unavailable".
 */
import type { ChatPane, RtResponse } from "../packages/rt-client/src/index.ts";
import { paneAccounts as paneAccountsRt, paneDirectories as paneDirectoriesRt, paneList as paneListRt, panePeek as panePeekRt, paneSpawn as paneSpawnRt } from "../packages/rt-client/src/index.ts";

const FLAGS_WITH_VALUES = new Set(["--lines", "--cwd", "--account", "--model", "--effort", "--prompt", "--workspace", "--q", "--sock"]);

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

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`rt pane: ${msg}`);
  process.exit(1);
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

function opts(args: string[]) {
  const sockPath = flagValue(args, "--sock");
  return sockPath ? { sockPath } : {};
}

function renderPane(p: ChatPane): string {
  const who = p.presence ? `${p.presence.handle} (${p.presence.status})` : "not signed in";
  const where = [p.repo, p.branch].filter(Boolean).join(" · ");
  const title = p.title && p.title !== p.presence?.handle ? ` · ${p.title}` : "";
  const rooms = p.presence?.rooms.length ? `  #${p.presence.rooms.join(" #")}` : "";
  return `${p.paneId.padEnd(8)} ${p.agentStatus.padEnd(8)} ${who.padEnd(22)} ${p.workspace}${title}${where ? `  ${where}` : ""}${rooms}`;
}

export async function paneList(args: string[]): Promise<void> {
  const data = unwrap(await paneListRt(opts(args)), "pane list");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, panes: data.panes }));
  if (data.panes.length === 0) return void console.log("no claude panes");
  console.log(data.panes.map(renderPane).join("\n"));
}

export async function panePeek(args: string[]): Promise<void> {
  const paneId = positional(args);
  if (!paneId) fail("usage: rt pane peek <pane> [--lines 8]");
  const linesRaw = flagValue(args, "--lines");
  let lines: number | undefined;
  if (linesRaw !== undefined) {
    lines = Number(linesRaw);
    if (!Number.isInteger(lines) || lines <= 0) fail(`--lines must be a positive integer (got "${linesRaw}")`);
  }
  const data = unwrap(await panePeekRt({ paneId, lines }, opts(args)), "pane peek");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(data.lines.join("\n"));
}

export async function paneSpawn(args: string[]): Promise<void> {
  const cwd = flagValue(args, "--cwd");
  if (!cwd) fail("usage: rt pane spawn --cwd <path> [--account <a>] [--model <m>] [--effort <e>] [--prompt <text>] [--workspace <label>]");
  const data = unwrap(
    await paneSpawnRt(
      { cwd, account: flagValue(args, "--account"), model: flagValue(args, "--model"), effort: flagValue(args, "--effort"), prompt: flagValue(args, "--prompt"), workspace: flagValue(args, "--workspace") },
      opts(args),
    ),
    "pane spawn",
  );
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(`${data.ready ? "ready" : "not ready"}  ${renderPane(data.pane)}`);
}

export async function paneAccounts(args: string[]): Promise<void> {
  const data = unwrap(await paneAccountsRt(opts(args)), "pane accounts");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, accounts: data.accounts }));
  if (data.accounts.length === 0) return void console.log("no cswap accounts");
  console.log(data.accounts.map((a) => `${String(a.slot).padStart(2)}: ${a.alias ?? a.email}${a.alias ? `  ${a.email}` : ""}${a.headroom ? `  ${a.headroom}` : ""}`).join("\n"));
}

export async function paneDirectories(args: string[]): Promise<void> {
  const data = unwrap(await paneDirectoriesRt({ q: flagValue(args, "--q") }, opts(args)), "pane directories");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, directories: data.directories }));
  console.log(data.directories.map((d) => `${d.path}  ${d.repo}${d.branch ? ` · ${d.branch}` : ""}`).join("\n"));
}
```

Check how `commands/chat.ts` imports rt-client (it imports from `../packages/rt-client/src/client.ts` or the barrel); match it. The wrappers' `a.lines === undefined` handling means passing `undefined` fields is safe.

- [ ] **Step 4: Register the group**

In `lib/command-tree-def.ts`, add beside `secrets`:

```ts
  pane: {
    description: "herdr panes as rt sees them: list with chat presence, peek, spawn claude, cswap accounts, directory suggestions",
    subcommands: {
      list: {
        description: "Claude panes with their chat handle, status and rooms joined in (needs herdr)",
        module: "./commands/pane.ts",
        fn: "paneList",
        args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON instead of one line per pane" }],
      },
      peek: {
        description: "The last lines of a pane's visible screen",
        module: "./commands/pane.ts",
        fn: "panePeek",
        args: [
          { name: "Pane", type: "text", placeholder: "w7A:pY", hint: "herdr pane id" },
          { name: "Lines", flag: "--lines", type: "text", optional: true, placeholder: "8", hint: "How many lines from the bottom" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
      spawn: {
        description: "Open a herdr tab in a directory and start claude in it, optionally under a cswap account",
        module: "./commands/pane.ts",
        fn: "paneSpawn",
        args: [
          { name: "Directory", flag: "--cwd", type: "text", placeholder: "~/Documents/GitHub/chat", hint: "Absolute directory to start in" },
          { name: "Account", flag: "--account", type: "text", optional: true, placeholder: "Acme", hint: "cswap alias, email or slot" },
          { name: "Model", flag: "--model", type: "text", optional: true, placeholder: "claude-fable-5", hint: "claude --model" },
          { name: "Effort", flag: "--effort", type: "text", optional: true, placeholder: "high", hint: "claude --effort" },
          { name: "Prompt", flag: "--prompt", type: "text", optional: true, placeholder: "read AGENTS.md", hint: "Typed once claude is idle" },
          { name: "Workspace", flag: "--workspace", type: "text", optional: true, placeholder: "chat", hint: "herdr workspace label; default chat.herdrWorkspace" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
      accounts: {
        description: "cswap accounts with rate-limit headroom, for spawn --account",
        module: "./commands/pane.ts",
        fn: "paneAccounts",
        args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" }],
      },
      directories: {
        description: "Repos and worktrees rt knows, as suggestions for spawn --cwd",
        module: "./commands/pane.ts",
        fn: "paneDirectories",
        args: [
          { name: "Filter", flag: "--q", type: "text", optional: true, placeholder: "chat", hint: "Substring of the path" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
    },
  },
```

In `lib/module-registry.ts`, add `"./commands/pane.ts": () => import("../commands/pane.ts"),`.

- [ ] **Step 5: Run the tests and regenerate the docs**

Run: `bun test commands/__tests__/pane.test.ts && bun scripts/gen-docs.ts && bun scripts/check-docs.ts`
Expected: tests pass; docs regenerate; check passes. Then `rt pane list --json` against the live machine as a smoke test (`bun cli.ts pane list --json`): either rows or `herdr unavailable`, never a stack trace.

- [ ] **Step 6: Commit**

```bash
git add commands/pane.ts commands/__tests__/pane.test.ts lib/command-tree-def.ts lib/module-registry.ts website/docs/reference
git commit -m "cli: rt pane list, peek, spawn, accounts, directories"
```

---

### Task 9: `rt chat invite` and `rt chat read --last N`

**Files:**
- Modify: `commands/chat.ts` (`FLAGS_WITH_VALUES`, `runRead`, new `runInvite`, `VERBS`, `USAGE`)
- Modify: `lib/command-tree-def.ts` (the `chat` entry's Verb placeholder and a `--last`/`--note` arg row)
- Test: `commands/__tests__/chat.test.ts`
- Regenerate docs.

**Interfaces:**
- Produces: `rt chat read <room> --last N [--json]`, `rt chat invite <pane> --room <room> [--note <text>] [--json]`.
- Consumes: `chatMessages`, `chatMark`, `chatInvite` wrappers; `readChatSession`/`currentSessionId` from `lib/chat-session.ts`; `getSetting("chat.humanHandle")`.

- [ ] **Step 1: Write the failing tests**

Append to `commands/__tests__/chat.test.ts` (its fake daemon dispatches to the real chat handlers; add a `canned` map consulted before the handlers so `chat:invite` can be scripted: in the `fetch`, `if (cmd in canned) return Response.json(canned[cmd]);` with `let canned: Record<string, unknown> = {}` reset in `beforeEach`):

```ts
test("read --last N shows the newest N messages regardless of the cursor, then marks read", async () => {
  await runChat(["join", "build", "--as", "alice"]);
  await runChat(["post", "build", "seed one", "--as", "alice"]);
  await runChat(["post", "build", "seed two", "--as", "alice"]);
  await runChat(["join", "build", "--as", "bob"]);
  const nothing = await runChat(["read", "build", "--as", "bob", "--json"]);
  expect(JSON.parse(nothing).rooms[0]?.messages ?? []).toHaveLength(0);
  const last = await runChat(["read", "build", "--last", "5", "--as", "bob", "--json"]);
  expect(JSON.parse(last).rooms[0].messages.map((m: { body: string }) => m.body)).toEqual(["seed one", "seed two"]);
  const again = await runChat(["read", "build", "--as", "bob", "--json"]);
  expect(JSON.parse(again).rooms[0]?.messages ?? []).toHaveLength(0);
});

test("read --last refuses --since and a non-positive N", async () => {
  await runChat(["join", "build", "--as", "alice"]);
  expect((await runChatRaw(["read", "build", "--last", "5", "--since", "5m", "--as", "alice"])).code).toBe(1);
  expect((await runChatRaw(["read", "build", "--last", "0", "--as", "alice"])).code).toBe(1);
});

test("read --last requires a room", async () => {
  expect((await runChatRaw(["read", "--last", "5", "--as", "alice"])).code).toBe(1);
});

test("invite sends the pane, room, note, the human handle when not signed in, and the caller pane", async () => {
  canned = { "chat:invite": { ok: true, data: { paneId: "w1:p1", delivered: "accepted" } } };
  process.env.HERDR_PANE_ID = "w9:p9";
  const out = await runChat(["invite", "w1:p1", "--room", "build", "--note", "take vite"]);
  expect(out).toContain("accepted");
  const sent = seen.find((s) => s.cmd === "chat:invite")!;
  expect(sent.payload).toEqual({ paneId: "w1:p1", room: "build", note: "take vite", from: "matt", callerPane: "w9:p9" });
});

test("invite uses the session's own handle when signed in, and reports refusals with exit 0", async () => {
  await runChat(["sign-in", "--as", "carol", "--session", "sess-c", "--no-room"]);
  canned = { "chat:invite": { ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "at a prompt" } } };
  const r = await runChatRaw(["invite", "w1:p1", "--room", "build", "--session", "sess-c"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("refused: at a prompt");
  expect((seen.find((s) => s.cmd === "chat:invite")!.payload as { from: string }).from).toBe("carol");
});

test("invite requires a pane and --room", async () => {
  expect((await runChatRaw(["invite"])).code).toBe(1);
  expect((await runChatRaw(["invite", "w1:p1"])).code).toBe(1);
});
```

The harness needs `seen` recorded in its `fetch` (`seen.push({ cmd, payload })`, declared beside `canned`). Sign-in in this suite may need `CLAUDE_CODE_SESSION_ID` unset (the suite already clears it) and `--session` given, as above.

- [ ] **Step 2: Run to verify failure**

Run: `bun test commands/__tests__/chat.test.ts`
Expected: the six new tests FAIL (`unknown verb "invite"`; `--last` ignored so the read shows nothing).

- [ ] **Step 3: Implement**

In `commands/chat.ts`:

1. Add `"--last"`, `"--note"` to `FLAGS_WITH_VALUES`.
2. In `runRead`, after `sinceMs` parsing:

```ts
  const lastRaw = flagValue(args, "--last");
  if (lastRaw !== undefined) {
    if (sinceRaw !== undefined) fail("--last and --since are mutually exclusive");
    if (!room) fail("--last needs a room");
    const n = Number(lastRaw);
    if (!Number.isInteger(n) || n <= 0) fail(`--last must be a positive integer (got "${lastRaw}")`);
    const page = unwrap(await chatMessages({ room, limit: n }, sockOpts(args)), "read");
    unwrap(await chatMark({ handle, room }, sockOpts(args)), "mark");
    const rooms = [{ room, messages: page.messages }];
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ok: true, rooms }));
      return;
    }
    const headingFor = await dmHeadingsFor(handle);
    console.log(renderReadRooms(rooms, args.includes("--full"), headingFor));
    return;
  }
```

   where `sockOpts(args)` is a small helper `const sockPath = flagValue(args, "--sock"); return sockPath ? { sockPath } : {};` (chatTail already builds this inline; hoist it). Confirm `chatMessages` returns messages oldest-first; if it returns newest-first, reverse before rendering so `--last` reads top to bottom like a plain read. Import `chatMessages` beside `chatMark`.
3. Add `runInvite`:

```ts
async function runInvite(args: string[]): Promise<void> {
  const paneId = positional(args);
  if (!paneId) fail("usage: rt chat invite <pane> --room <room> [--note <text>]");
  const room = flagValue(args, "--room");
  if (!room) fail("--room is required");
  requireValidName("room", room);
  const note = flagValue(args, "--note");
  const session = readChatSession(currentSessionId(args));
  const from = session?.handle ?? getSetting<string>("chat.humanHandle").value;
  const callerPane = process.env.HERDR_PANE_ID;
  const res = await chatInvite({ paneId, room, note, from, callerPane }, sockOpts(args));
  const data = unwrap(res, "invite");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, ...data }));
    return;
  }
  console.log(data.delivered === "refused" ? `${paneId}: refused: ${data.reason ?? "unknown"}` : `${paneId}: ${data.delivered}`);
}
```

   Check the exact names exported by `lib/chat-session.ts` (`readChatSession`, `currentSessionId`); `commands/chat.ts` already imports them for `resolveHandle`. `readChatSession` takes the session id (undefined when there is none) and returns `null`/`undefined` when no file exists.
4. Add `invite: runInvite` to `VERBS` and `invite` to `USAGE`.
5. In `lib/command-tree-def.ts`'s `chat` entry, add `invite` to the Verb placeholder and two arg rows: `{ name: "Last", flag: "--last", type: "text", optional: true, placeholder: "10", hint: "read: the newest N messages regardless of your cursor, then mark read" }` and `{ name: "Note", flag: "--note", type: "text", optional: true, placeholder: "you own the vite side", hint: "invite: a one-line note appended to the /chat:join command" }`, plus `{ name: "Pane", ... }` only if the tree's Room arg cannot double for the pane id (its hint already says "the target handle for dm"; extend it with "the pane id for invite").

- [ ] **Step 4: Run the tests and regenerate the docs**

Run: `bun test commands/__tests__/chat.test.ts && bun scripts/gen-docs.ts && bun scripts/check-docs.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add commands/chat.ts commands/__tests__/chat.test.ts lib/command-tree-def.ts website/docs/reference
git commit -m "cli: rt chat invite, rt chat read --last N"
```

---

### Task 10: `lib/herdr-agent.ts`: `herdr wait` became `herdr agent wait`

**Files:**
- Modify: `lib/herdr-agent.ts:88-93, 117-124, 126-138`
- Modify: `lib/__tests__/herdr-agent.test.ts` (lines 147-219, the `wait-agent-status` keys and argv assertions)

**Interfaces:** unchanged (`startClaude`, `waitAgentWorking`, `waitAgentIdle` keep their signatures; callers `lib/repo-index.ts` and `lib/rebase-escalation.ts` untouched).

- [ ] **Step 1: Update the tests first**

In `lib/__tests__/herdr-agent.test.ts`, every `setExit("wait-agent-status", ...)` / `setExitSequence("wait-agent-status", ...)` becomes the key `"agent-wait"`, and every assertion on the recorded argv that starts with `wait agent-status <pane> --status <s> --timeout <ms>` becomes `agent wait <pane> --until <s> --timeout <ms>`.

Run: `bun test lib/__tests__/herdr-agent.test.ts`
Expected: FAIL (the code still calls `wait agent-status`).

- [ ] **Step 2: Rename the three call sites**

In `lib/herdr-agent.ts`, each argv `["wait", "agent-status", pane.paneId, "--status", <s>, "--timeout", <ms>]` becomes `["agent", "wait", pane.paneId, "--until", <s>, "--timeout", <ms>]` (herdr 0.7.5 replaced the top-level `wait` group; `agent wait --until` is exact-match, so pass exactly the one status each site waited for).

- [ ] **Step 3: Run the tests**

Run: `bun test lib/__tests__/herdr-agent.test.ts lib/__tests__`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add lib/herdr-agent.ts lib/__tests__/herdr-agent.test.ts
git commit -m "herdr-agent: herdr agent wait replaces the removed top-level wait"
```

---

### Task 11: skill docs

**Files:**
- Modify: `skills/rt-chat/SKILL.md`

- [ ] **Step 1: Edit the skill**

1. Frontmatter `description`: append `, or when asked to put you and another agent into a room together (recruiting through herdr).` before the closing quote-less end of the line.
2. In `## Reading`, add a bullet after the `--since` one:

   ```markdown
   - `rt chat read <room> --last N` shows the newest N messages of a room
     regardless of your cursor, then marks the room read. Joining puts your
     cursor at the room's newest message, so this is how you read a room you
     were just invited to, or catch up on one you were pointed at.
   ```
3. In the verb table, add after the `rt chat post` row:

   ```markdown
   | `rt chat invite <pane> --room <room> [--note <text>]` | type `/chat:join <room>` into one herdr pane, so that agent joins itself; needs herdr. Reports `accepted` \| `queued` \| `refused`; never changes membership. The note is attributed to you |
   ```
   and after the table a short paragraph: `rt pane list`, `rt pane peek <pane>`, `rt pane spawn --cwd <path> [...]`, `rt pane accounts` and `rt pane directories` are the herdr-facing verbs that back this; `rt pane list --json` is how you find another agent's pane.
4. Add a new section before `## Announce before you take something`:

   ````markdown
   ## Recruiting another agent

   When Matt says "add you and the agent working on foo into a room so you can
   coordinate" (or anything that means: put me and another pane in a room),
   this is the flow. It needs herdr; every step that touches another pane is
   gated on a form.

   1. `rt pane list --json`. If it errors with `herdr unavailable`, say this
      needs herdr and stop.
   2. Match *foo* against each pane's `title`, `repo`, `branch`, `cwd` and
      `presence.handle`. Exclude your own pane (`HERDR_PANE_ID`) and panes
      whose `presence.rooms` already includes the target room.
   3. **Always a form.** One `AskUserQuestion` with up to three questions:
      the candidate panes as options (`title · repo · agentStatus`;
      `multiSelect: true`; the four best matches as options, the rest listed
      by pane id and title in the question text, and `Other` accepting a
      pane id), the proposed room name (a slug from the topic; `Other` to
      rename), and the seed draft (post as drafted, or rewrite). Touch no pane
      before the form returns.
   4. Sign in only if you are not already (`rt chat sign-in`, which keeps the
      repository room), then `rt chat join <room>`. Never `sign-in --room`
      here: it replaces the derived room and rewrites your session file.
      Post the seed as yourself with a heredoc. Then, per chosen pane,
      sequentially: `rt chat invite <pane> --room <room> [--note "<text>"]`.
   5. Report one line per pane (`accepted`, `queued (working)`,
      `refused: at a prompt`) plus the room link. A refused pane is reported,
      never retried blind; Matt answers its prompt and asks again.
   ````

- [ ] **Step 2: Check and commit**

Run: `grep -n $'\xe2\x80\x94\\|\xe2\x80\x93' skills/rt-chat/SKILL.md | head` (the file already contains em dashes from earlier authors; do not add new ones in the inserted text: `grep -c` before and after must match).

```bash
git add skills/rt-chat/SKILL.md
git commit -m "rt-chat skill: read --last, rt chat invite, the rt pane group, recruiting flow"
```

---

### Task 12: full suite, version bump, PR

**Files:**
- Modify: `packages/rt-client/package.json` (`0.6.1` to `0.6.2`)

- [ ] **Step 1: The whole suite**

Run: `bun test lib commands packages scripts && bun scripts/check-docs.ts`
Expected: green.

- [ ] **Step 2: Bump rt-client**

Set `"version": "0.6.2"` in `packages/rt-client/package.json` (additive surface; the viewer's `^0.6` pin picks it up), run `cd packages/rt-client && bun run build && cd ../.. && bun test packages/rt-client/test`, and grep the built bundle for the new verbs: `grep -c 'pane:spawn\|chat:invite' packages/rt-client/dist/index.js` must be at least 2.

```bash
git add packages/rt-client/package.json
git commit -m "rt-client: 0.6.2, pane and invite wrappers"
```

- [ ] **Step 3: Rebase and open the PR**

```bash
git fetch origin && git rebase origin/main
bun test lib commands packages scripts
git push -u origin spec/rt-chat-invite
gh pr create --title "rt chat invite: pane verbs, chat:invite, read --last" --body-file - <<'EOF'
## rt chat invite, part 1: the rt primitives

Adds the herdr-facing verbs the chat viewer's pane picker and the recruiting flow stand on. Spec: docs/superpowers/specs/2026-08-26-rt-chat-invite-design.md.

### What changed

**herdr client** (`lib/herdr/`)

- NDJSON unix-socket client, one connection per call, with a fake server for tests
- 5s plain timeout; waiting calls get their own budget plus 5s

**Daemon verbs** (`lib/daemon/handlers/pane.ts`, `chat.ts`)

- `pane:list` joins herdr's claude panes to presence by session id, pane id as fallback
- `pane:peek`, `pane:accounts` (cswap list, async), `pane:directories` (repo index plus worktrees, no git)
- `pane:spawn` opens a tab in `chat.herdrWorkspace`, starts claude, waits for idle, answers the trust dialog once
- `chat:invite` types `/chat:join <room>` into a pane; `accepted`, `queued` or `refused`

**CLI and client**

- `rt pane list|peek|spawn|accounts|directories`, `rt chat invite`, `rt chat read --last N`
- rt-client 0.6.2: six wrappers, five types, `chat.herdrWorkspace`

**Also**

- `lib/herdr-agent.ts` calls `herdr agent wait` (the top-level `wait` went away in herdr 0.7.5)
- `lib/repo-for-cwd.ts` extracted from `commands/chat.ts` so the daemon resolves a cwd without git

### Follow-up

- Publishing 0.6.2 is release-class: from `main`, after merge, never `--ignore-scripts`.
- Migrating `lib/herdr-agent.ts` onto the socket client is out of scope (spec, Out of scope).
EOF
```

Publishing to npm is not part of this plan's automated steps: it is a push-class side effect done from `main` after merge (CLAUDE.md). Stop and ask before `npm publish`.

---

## Self-review

**Spec coverage.** Gate and socket timeouts: Task 1. `pane:list` shape, session-id join, pane-id fallback, sort, presence-row-first repo/branch with async git and MAT-222: Tasks 2 and 3. `pane:peek`: Task 3. `pane:accounts`, `pane:directories`: Task 4. `chat.herdrWorkspace`, `pane:spawn` (workspace create-or-reuse, tab, launch line with cswap, registration poll, idle wait, trust dialog once, prompt, `ready: false` returns the pane): Task 5. `chat:invite` (one-line text with attributed note, `agent.get` first, queued/accepted/refused, nudge, `callerPane`): Task 6. rt-client wrappers with `timeoutMs` 90s/30s and types: Task 7. `rt pane` group: Task 8. `rt chat invite` and `read --last` via `chat:messages` plus `chat:mark`, exclusive with `--since`: Task 9. `herdr agent wait` rename with callers untouched: Task 10. Skill verb table, `--last`, `rt pane` pointer, recruiting section with the four-option form rule: Task 11. Publish rt-client: Task 12 (gated on asking).

**Placeholders.** None; every step carries code or exact commands. The one deliberate defer is `npm publish`, which the plan says to ask about.

**Type consistency.** `ChatPane`, `PaneAccount`, `PaneDirectory`, `InviteResult`, `AgentStatus` are declared once in Task 3/4/6 and referenced by those names in Tasks 5, 7, 8. `herdrRequest` / `HerdrResult` / `waitTimeout` / `HERDR_UNAVAILABLE` (Task 1) are the names Tasks 3 to 6 import. `paneRow`, `presenceMaps`, `herdrError` are exported from `pane.ts` in Task 3 and used in Tasks 5 and 6. The CLI functions in Task 8 are `paneList`/`panePeek`/`paneSpawn`/`paneAccounts`/`paneDirectories`, matching `command-tree-def.ts`'s `fn` fields.
