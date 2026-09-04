# Linear MCP on a Fresh Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Install write a Linear MCP server named `linear` into the user's Claude config, make its absence visible as a checklist row, and assert both in the VM join pass, so a joiner's `mcp__linear__*` skill calls resolve without hand setup.

**Architecture:** One pure module (`lib/setup/linear-mcp.ts`) owns the path, the shape predicate, the state classification and the merge. A new Install step (`linear.mcp`) and a new checklist row (`tool.linear-mcp`) both import it, so a validator never imports a step and the two can never disagree. The write is read-modify-write with an atomic rename, additive only: exactly one key under `mcpServers`, nothing existing touched.

**Tech Stack:** Bun + TypeScript. `bun test`. rt's setup `Probes` seam for all fs/exec/network. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-03-linear-mcp-design.md`

## Global Constraints

- **No em dashes or en dashes** anywhere (code, comments, commit messages, docs). Use "..." or rephrase.
- **Comments state constraints the code cannot show.** No narration of the next line, no review-facing justification, no ticket numbers in source.
- **No new settings-registry key and no `rt-client` publish.** `rt.linearApiKey` is a sops SECRET address (`{ domain: "rt", key: "linearApiKey" }`), not a settings key. `getSetting("rt.linearApiKey")` throws `unknownKey`. Read it only through `SecretPresence.has("rt", "linearApiKey")`.
- **Never write the developer's real `~/.claude.json`.** Every test drives `fakeProbes({ home })` with a temp home; the real path is never opened. `test-setup.ts` (bunfig preload) repoints HOME for every test process; keep it.
- **Steps and validators use `ctx.p.*` / the `Probes` seam**, never `fs` or a bare `fetch` directly.
- **Secrets pass through `ctx.redact(value)`** before they can reach a log line, `detail`, or `remedy`.
- MCP entry shape, verbatim: `{ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer <key>" } }`. The `Bearer ` prefix is correct HERE and wrong for `api.linear.app`, which takes the key bare.
- Run `rt worktree await-ready merry-harbor` before any `bun` command in a fresh shell.
- Full gates before done: `bun run test`, `bun x tsc --noEmit`, `bun run docs:check`, `bun run picker:check`, `scripts/repo-purity.sh`.

---

### Task 1: The shared module, pure half

**Files:**
- Create: `lib/setup/linear-mcp.ts`
- Create: `lib/setup/__tests__/linear-mcp.test.ts`

**Interfaces:**
- Consumes: `Probes` from `lib/setup/probes.ts` (type only, for `Pick<>`).
- Produces, relied on by Tasks 2, 3 and 4:

```ts
export const LINEAR_MCP_SERVER_NAME = "linear";
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

export interface McpServerEntry { type?: string; url?: string; command?: string; args?: string[]; headers?: Record<string, string>; [k: string]: unknown }
export interface ClaudeConfig { mcpServers?: Record<string, McpServerEntry>; [k: string]: unknown }

export function claudeJsonPath(p: Pick<Probes, "env" | "home">): string;
export function isLinearMcp(entry: unknown): boolean;
export type ConfigRead = { ok: true; config: ClaudeConfig } | { ok: false; reason: "absent" } | { ok: false; reason: "unparsable" };
export function readClaudeConfig(p: Pick<Probes, "readFile">, path: string): ConfigRead;
export function linearServerNames(config: ClaudeConfig): string[];
export function nameTaken(config: ClaudeConfig): boolean;
export function callableBySkills(config: ClaudeConfig): boolean;
export function withLinearEntry(config: ClaudeConfig, apiKey: string): ClaudeConfig;
```

- [ ] **Step 1: Write the failing tests**

Create `lib/setup/__tests__/linear-mcp.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  callableBySkills,
  claudeJsonPath,
  isLinearMcp,
  linearServerNames,
  nameTaken,
  readClaudeConfig,
  withLinearEntry,
  LINEAR_MCP_URL,
} from "../linear-mcp.ts";
import { fakeProbes } from "./fakes.ts";

const hosted = { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_x" } };

describe("claudeJsonPath", () => {
  test("no CLAUDE_CONFIG_DIR -> ~/.claude.json, not ~/.claude/.claude.json", () => {
    expect(claudeJsonPath({ env: {}, home: "/h" })).toBe("/h/.claude.json");
  });
  test("CLAUDE_CONFIG_DIR set -> that dir's .claude.json", () => {
    expect(claudeJsonPath({ env: { CLAUDE_CONFIG_DIR: "/cfg" }, home: "/h" })).toBe("/cfg/.claude.json");
  });
});

describe("isLinearMcp", () => {
  test("hosted http entry", () => expect(isLinearMcp(hosted)).toBe(true));
  test("sse transport at the same host", () => expect(isLinearMcp({ type: "sse", url: "https://mcp.linear.app/sse" })).toBe(true));
  test("hosted entry with no auth header is still a Linear MCP (OAuth)", () => {
    expect(isLinearMcp({ type: "http", url: LINEAR_MCP_URL })).toBe(true);
  });
  test("stdio linear-mcp package", () => {
    expect(isLinearMcp({ command: "npx", args: ["-y", "@anthropic-ai/linear-mcp-server"] })).toBe(true);
  });
  test("a different host that merely mentions linear is not one", () => {
    expect(isLinearMcp({ type: "http", url: "https://evil.example.com/mcp.linear.app" })).toBe(false);
  });
  test("an unrelated server is not one", () => expect(isLinearMcp({ type: "http", url: "https://mcp.railway.app/mcp" })).toBe(false));
  test("junk values do not throw", () => {
    expect(isLinearMcp(null)).toBe(false);
    expect(isLinearMcp("linear")).toBe(false);
    expect(isLinearMcp({ url: 42 })).toBe(false);
  });
});

describe("readClaudeConfig", () => {
  test("absent file", () => {
    expect(readClaudeConfig(fakeProbes({}), "/h/.claude.json")).toEqual({ ok: false, reason: "absent" });
  });
  test("unparsable file", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": "{ not json" } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unparsable" });
  });
  test("a JSON scalar is not a config object", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": "42" } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: false, reason: "unparsable" });
  });
  test("parses", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": JSON.stringify({ numStartups: 3 }) } });
    expect(readClaudeConfig(p, "/h/.claude.json")).toEqual({ ok: true, config: { numStartups: 3 } });
  });
});

describe("detection by shape, under any name", () => {
  test("finds every Linear MCP whatever it is called", () => {
    const config = { mcpServers: { "linear-matt": hosted, railway: { type: "http", url: "https://mcp.railway.app/mcp" }, work: hosted } };
    expect(linearServerNames(config)).toEqual(["linear-matt", "work"]);
  });
  test("no mcpServers at all", () => expect(linearServerNames({})).toEqual([]));
  test("callableBySkills needs the name linear AND the shape", () => {
    expect(callableBySkills({ mcpServers: { linear: hosted } })).toBe(true);
    expect(callableBySkills({ mcpServers: { "linear-matt": hosted } })).toBe(false);
    expect(callableBySkills({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } })).toBe(false);
  });
  test("nameTaken is about the key, not the shape", () => {
    expect(nameTaken({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } })).toBe(true);
    expect(nameTaken({ mcpServers: { "linear-matt": hosted } })).toBe(false);
  });
});

describe("withLinearEntry", () => {
  test("adds exactly one key and preserves everything else", () => {
    const before = { numStartups: 3, mcpServers: { "linear-matt": hosted, railway: { type: "http", url: "https://mcp.railway.app/mcp" } } };
    const after = withLinearEntry(before, "lin_api_new");
    expect(after.mcpServers!.linear).toEqual({ type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_new" } });
    expect(after.mcpServers!["linear-matt"]).toBe(hosted);
    expect(after.mcpServers!.railway).toEqual({ type: "http", url: "https://mcp.railway.app/mcp" });
    expect(after.numStartups).toBe(3);
  });
  test("creates mcpServers when the config has none", () => {
    expect(Object.keys(withLinearEntry({ numStartups: 1 }, "k").mcpServers!)).toEqual(["linear"]);
  });
  test("does not mutate its input", () => {
    const before = { mcpServers: {} as Record<string, never> };
    withLinearEntry(before, "k");
    expect(before.mcpServers).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/linear-mcp.test.ts`
Expected: FAIL, cannot resolve `../linear-mcp.ts`.

- [ ] **Step 3: Write the module**

Create `lib/setup/linear-mcp.ts`:

```ts
/**
 * The one description of "a Linear MCP server" in rt: where Claude Code's
 * config lives, what counts as a Linear MCP by shape, and the single entry
 * Install adds. Kept apart from both the `linear.mcp` step and the
 * `tool.linear-mcp` row so the validator never imports a step and the two
 * can never disagree about what they are looking at.
 */
import { join } from "path";
import type { Probes } from "./probes.ts";

export const LINEAR_MCP_SERVER_NAME = "linear";
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const LINEAR_MCP_HOST = "mcp.linear.app";

export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/**
 * Claude Code keeps this file NEXT TO a custom CLAUDE_CONFIG_DIR but at the
 * home root by default. Deriving it from the default config dir instead
 * would pick `~/.claude/.claude.json`, a relic Claude Code no longer reads.
 */
export function claudeJsonPath(p: Pick<Probes, "env" | "home">): string {
  const dir = p.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(p.home, ".claude.json");
}

/**
 * By shape, never by name: `linear-matt` and `linear-work` are one person's
 * artifacts. Auth is not part of the test, because the hosted server is
 * equally valid with a bearer header and with Claude Code's own OAuth, which
 * stores no header here at all.
 */
export function isLinearMcp(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as McpServerEntry;
  if (typeof e.url === "string") {
    try {
      if (new URL(e.url).hostname === LINEAR_MCP_HOST) return true;
    } catch {
      // A malformed url is simply not a match.
    }
  }
  const argv = [e.command, ...(Array.isArray(e.args) ? e.args : [])].filter((v) => typeof v === "string").join(" ");
  return argv.includes("linear-mcp");
}

export type ConfigRead = { ok: true; config: ClaudeConfig } | { ok: false; reason: "absent" } | { ok: false; reason: "unparsable" };

export function readClaudeConfig(p: Pick<Probes, "readFile">, path: string): ConfigRead {
  const raw = p.readFile(path);
  if (raw === null) return { ok: false, reason: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  // JSON.parse accepts any value: a bare number or array is valid JSON and
  // an invalid config, and merging into one would destroy the file.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "unparsable" };
  return { ok: true, config: parsed as ClaudeConfig };
}

export function linearServerNames(config: ClaudeConfig): string[] {
  return Object.entries(config.mcpServers ?? {})
    .filter(([, entry]) => isLinearMcp(entry))
    .map(([name]) => name);
}

/** The name is taken whatever sits under it: an unrelated server called `linear` is not ours to move. */
export function nameTaken(config: ClaudeConfig): boolean {
  return Object.hasOwn(config.mcpServers ?? {}, LINEAR_MCP_SERVER_NAME);
}

/** `mcp__linear__get_issue` resolves on the server NAME, so a Linear MCP under any other name is unreachable from the skills. */
export function callableBySkills(config: ClaudeConfig): boolean {
  return isLinearMcp(config.mcpServers?.[LINEAR_MCP_SERVER_NAME]);
}

export function withLinearEntry(config: ClaudeConfig, apiKey: string): ClaudeConfig {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      [LINEAR_MCP_SERVER_NAME]: { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: `Bearer ${apiKey}` } },
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/linear-mcp.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/linear-mcp.ts lib/setup/__tests__/linear-mcp.test.ts
git commit -m "setup: add the linear-mcp module, detecting a Linear MCP by shape under any name"
```

---

### Task 2: The atomic writer and the `rename` probe

**Files:**
- Modify: `lib/setup/probes.ts` (the `Probes` interface, near `writeFile`/`removeFile`; and `createRealProbes`)
- Modify: `lib/setup/__tests__/fakes.ts` (`FakeProbesOpts` unchanged; add `rename` to the returned probe and `renames` to `calls`)
- Modify: `lib/setup/linear-mcp.ts` (append `writeClaudeConfig`)
- Modify: `lib/setup/__tests__/linear-mcp.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 1's `ClaudeConfig`.
- Produces, relied on by Task 3:

```ts
// lib/setup/probes.ts
rename(from: string, to: string): void;

// lib/setup/__tests__/fakes.ts, on the returned `calls` object
renames: Array<[string, string]>;

// lib/setup/linear-mcp.ts
export function writeClaudeConfig(p: Pick<Probes, "mkdirp" | "writeFile" | "rename">, path: string, config: ClaudeConfig): void;
```

- [ ] **Step 1: Write the failing tests**

Append to `lib/setup/__tests__/linear-mcp.test.ts`:

```ts
describe("writeClaudeConfig", () => {
  test("lands the merged config at the real path via a temp file", () => {
    const p = fakeProbes({ files: { "/h/.claude.json": JSON.stringify({ numStartups: 3 }, null, 2) } });
    writeClaudeConfig(p, "/h/.claude.json", withLinearEntry({ numStartups: 3 }, "lin_api_k"));
    expect(p.calls.renames).toEqual([["/h/.claude.json.rt-tmp", "/h/.claude.json"]]);
    expect(JSON.parse(p.readFile("/h/.claude.json")!)).toEqual({
      numStartups: 3,
      mcpServers: { linear: { type: "http", url: LINEAR_MCP_URL, headers: { Authorization: "Bearer lin_api_k" } } },
    });
    expect(p.readFile("/h/.claude.json.rt-tmp")).toBeNull();
  });

  test("writes 2-space JSON, matching the file Claude Code keeps", () => {
    const p = fakeProbes({});
    writeClaudeConfig(p, "/h/.claude.json", { a: 1 });
    expect(p.readFile("/h/.claude.json")).toBe('{\n  "a": 1\n}\n');
  });

  test("the temp file is created 0600 so a rename cannot widen a token-bearing file", () => {
    const p = fakeProbes({});
    writeClaudeConfig(p, "/h/.claude.json", { a: 1 });
    expect(p.calls.modes["/h/.claude.json.rt-tmp"]).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/linear-mcp.test.ts`
Expected: FAIL, `writeClaudeConfig` is not exported and `p.calls.renames` is undefined.

- [ ] **Step 3: Add `rename` to the seam, its fake, and the writer**

In `lib/setup/probes.ts`, add to the `Probes` interface right after `writeFile`:

```ts
  /** Atomic replace. The only safe way to rewrite a live config file: a partial writeFile over it leaves the user with a truncated one. */
  rename(from: string, to: string): void;
```

and to `createRealProbes` (import `renameSync` from `fs` alongside the existing imports):

```ts
    rename(from, to) {
      renameSync(from, to);
    },
```

In `lib/setup/__tests__/fakes.ts`, add `renames: [] as Array<[string, string]>` to the `calls` literal, declare it in the returned type next to `removed`, and implement it on the returned probe next to `writeFile`:

```ts
    rename(from, to) {
      calls.renames.push([from, to]);
      if (files[from] !== undefined) {
        files[to] = files[from]!;
        calls.writes[to] = files[from]!;
        delete files[from];
        delete calls.writes[from];
      }
    },
```

Append to `lib/setup/linear-mcp.ts`:

```ts
/**
 * The target is Claude Code's live state file (hundreds of KB of session
 * state), so the replace is atomic: a partial write over it would leave the
 * user with a corrupt config. 0600 on the temp file because the rename
 * carries the temp file's own mode onto a path holding an API token.
 */
export function writeClaudeConfig(p: Pick<Probes, "mkdirp" | "writeFile" | "rename">, path: string, config: ClaudeConfig): void {
  const tmp = `${path}.rt-tmp`;
  p.mkdirp(dirname(path));
  p.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", 0o600);
  p.rename(tmp, path);
}
```

and widen the `path` import to `import { dirname, join } from "path";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/linear-mcp.test.ts && bun x tsc --noEmit`
Expected: PASS, and tsc clean (the `Probes` interface gained a member, so every hand-rolled Probes literal in the tree must still satisfy it; if tsc names one, add `rename` there rather than making it optional).

- [ ] **Step 5: Commit**

```bash
git add lib/setup/probes.ts lib/setup/__tests__/fakes.ts lib/setup/linear-mcp.ts lib/setup/__tests__/linear-mcp.test.ts
git commit -m "setup: add a rename probe and an atomic claude.json writer"
```

---

### Task 3: The `linear.mcp` Install step

**Files:**
- Create: `lib/setup/steps/linear-mcp.ts`
- Modify: `lib/setup/contract.ts` (insert `"linear.mcp"` into `STEP_IDS` immediately after `"plugins.install"`)
- Modify: `lib/setup/steps/index.ts` (import + insert at the identical index)
- Modify: `lib/setup/__tests__/contract.test.ts` (the hard-coded id array and the "24 ids" test name)
- Modify: `lib/setup/__tests__/steps-c.test.ts` (append a describe block)
- Modify: `docs/superpowers/specs/2026-08-21-rt-setup-contract.md` (the step-id list)

**Interfaces:**
- Consumes: Task 1's `claudeJsonPath`, `readClaudeConfig`, `nameTaken`, `withLinearEntry`; Task 2's `writeClaudeConfig`. `ApplyContext` from `lib/setup/apply.ts` (`ctx.p`, `ctx.secretPresence`, `ctx.redact`, `ctx.log`).
- Produces, relied on by nothing downstream in code, but pinned by tests: `export const linearMcpStep: StepDef` with `id: "linear.mcp"`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/setup/__tests__/steps-c.test.ts`, inside the file's existing top-level `describe` structure (reuse that file's `makeCtx`, `fakeProbes`, `home` fixture and `beforeEach`/`afterEach` HOME isolation exactly as the neighbouring step suites do):

```ts
describe("linear.mcp", () => {
  const KEY = "lin_api_testkey";
  const hosted = { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${KEY}` } };
  const withKey = { has: async () => KEY };
  const noKey = { has: async () => null };

  test("no stored key -> skipped, nothing written", async () => {
    const p = fakeProbes({ home, env: {} });
    const { ctx } = makeCtx(p, { secretPresence: noKey });
    expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "no Linear key stored (connect Linear, then Retry)" });
    expect(p.calls.writes).toEqual({});
  });

  test("key stored, no config file -> writes the entry into the fake HOME only", async () => {
    const p = fakeProbes({ home, env: {} });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    const outcome = await linearMcpStep.run(ctx);
    expect(outcome.state).toBe("done");
    const written = JSON.parse(p.readFile(`${home}/.claude.json`)!);
    expect(written.mcpServers.linear).toEqual(hosted);
    for (const path of Object.keys(p.calls.writes)) expect(path.startsWith(home)).toBe(true);
  });

  test("an existing differently-named Linear MCP is preserved and `linear` is still added", async () => {
    const before = { numStartups: 7, mcpServers: { "linear-matt": { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer other" } } } };
    const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: JSON.stringify(before, null, 2) } });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    expect((await linearMcpStep.run(ctx)).state).toBe("done");
    const written = JSON.parse(p.readFile(`${home}/.claude.json`)!);
    expect(written.mcpServers["linear-matt"]).toEqual(before.mcpServers["linear-matt"]);
    expect(written.mcpServers.linear).toEqual(hosted);
    expect(written.numStartups).toBe(7);
  });

  test("running twice is a no-op the second time", async () => {
    const p = fakeProbes({ home, env: {} });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    expect((await linearMcpStep.run(ctx)).state).toBe("done");
    const afterFirst = p.readFile(`${home}/.claude.json`);
    const renamesAfterFirst = p.calls.renames.length;
    expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "already configured" });
    expect(p.readFile(`${home}/.claude.json`)).toBe(afterFirst);
    expect(p.calls.renames.length).toBe(renamesAfterFirst);
  });

  test("the name `linear` taken by an unrelated server is never taken over", async () => {
    const railway = { type: "http", url: "https://mcp.railway.app/mcp" };
    const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: JSON.stringify({ mcpServers: { linear: railway } }) } });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    expect(await linearMcpStep.run(ctx)).toEqual({ state: "skipped", detail: "already configured" });
    expect(JSON.parse(p.readFile(`${home}/.claude.json`)!).mcpServers.linear).toEqual(railway);
  });

  test("an unparsable config is failed, never replaced", async () => {
    const p = fakeProbes({ home, env: {}, files: { [`${home}/.claude.json`]: "{ not json" } });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    const outcome = await linearMcpStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect(p.readFile(`${home}/.claude.json`)).toBe("{ not json");
  });

  test("CLAUDE_CONFIG_DIR is honored", async () => {
    const p = fakeProbes({ home, env: { CLAUDE_CONFIG_DIR: `${home}/alt` } });
    const { ctx } = makeCtx(p, { secretPresence: withKey });
    expect((await linearMcpStep.run(ctx)).state).toBe("done");
    expect(p.readFile(`${home}/alt/.claude.json`)).not.toBeNull();
    expect(p.readFile(`${home}/.claude.json`)).toBeNull();
  });

  test("the key is registered for redaction before anything is written", async () => {
    const redacted: string[] = [];
    const p = fakeProbes({ home, env: {} });
    const { ctx } = makeCtx(p, { secretPresence: withKey, redact: (v: string) => redacted.push(v) });
    await linearMcpStep.run(ctx);
    expect(redacted).toContain(KEY);
  });
});
```

If `makeCtx` in that file does not already forward `secretPresence` and `redact` from its overrides, widen it to do so (it spreads its `overrides` argument over the built context; confirm and extend rather than duplicating the helper).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/steps-c.test.ts`
Expected: FAIL, `linearMcpStep` is not exported from `../steps/linear-mcp.ts`.

- [ ] **Step 3: Write the step and register it**

Create `lib/setup/steps/linear-mcp.ts`:

```ts
/**
 * `linear.mcp` adds ONE `mcpServers` entry, named `linear`, to Claude
 * Code's config so the pack skills' `mcp__linear__*` calls resolve on a
 * machine that never configured one by hand.
 *
 * This is the deliberate, scoped exception to plugins.install's rule that the
 * installer never touches ~/.claude.json: that rule still holds for
 * plugins.install itself, and this step touches nothing else in the file.
 * An entry already named `linear` is left exactly as it is, whatever it is.
 */
import type { StepOutcome, StepDef, ApplyContext } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";
import { claudeJsonPath, nameTaken, readClaudeConfig, withLinearEntry, writeClaudeConfig } from "../linear-mcp.ts";

async function linearMcpRun(ctx: ApplyContext): Promise<StepOutcome> {
  const path = claudeJsonPath(ctx.p);
  const read = readClaudeConfig(ctx.p, path);
  if (!read.ok && read.reason === "unparsable") {
    return { state: "failed", detail: `${path} is not valid JSON`, remedy: "Fix or remove that file, then Retry." };
  }
  const config = read.ok ? read.config : {};
  if (nameTaken(config)) return { state: "skipped", detail: "already configured" };

  const key = await ctx.secretPresence.has("rt", "linearApiKey");
  if (key === null) return { state: "skipped", detail: "no Linear key stored (connect Linear, then Retry)" };
  ctx.redact(key);

  writeClaudeConfig(ctx.p, path, withLinearEntry(config, key));
  ctx.log("linear.mcp", `added linear to ${path}`);
  return { state: "done", detail: `added linear to ${path}` };
}

export async function installLinearMcp(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await linearMcpRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const linearMcpStep: StepDef = {
  id: "linear.mcp",
  title: "Configure Linear MCP",
  kind: "rt",
  applies: () => true,
  run: installLinearMcp,
};
```

In `lib/setup/contract.ts`, insert `"linear.mcp",` immediately after `"plugins.install",` in `STEP_IDS`. In `lib/setup/steps/index.ts`, import `linearMcpStep` and insert it into `STEPS` at the matching position. In `lib/setup/__tests__/contract.test.ts`, add `"linear.mcp"` to the hard-coded array at the same position and change the test name's count from 24 to 25. In `docs/superpowers/specs/2026-08-21-rt-setup-contract.md`, add the step to the id list next to `plugins.install`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/steps-c.test.ts lib/setup/__tests__/contract.test.ts lib/setup/__tests__/apply.test.ts`
Expected: PASS. `apply.test.ts` pins `STEPS` against `STEP_IDS` in order and asserts every step's `kind`; a mismatch there means the two insert positions differ.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/steps/linear-mcp.ts lib/setup/contract.ts lib/setup/steps/index.ts lib/setup/__tests__/contract.test.ts lib/setup/__tests__/steps-c.test.ts docs/superpowers/specs/2026-08-21-rt-setup-contract.md
git commit -m "setup: add the linear.mcp step, writing one mcpServers entry"
```

---

### Task 4: The `tool.linear-mcp` checklist row

**Files:**
- Modify: `lib/setup/validators/tools.ts` (new `linearMcpRow`, called from `toolRows`; `toolRows`' opts gains `secrets`)
- Modify: `lib/setup/plan.ts:157` (pass `i.secrets` through)
- Modify: `lib/setup/__tests__/validators-tools.test.ts` (82 call sites gain the new opts field; new describe block)

**Interfaces:**
- Consumes: Task 1's `claudeJsonPath`, `readClaudeConfig`, `linearServerNames`, `callableBySkills`, `nameTaken`. `SecretPresence` from `lib/setup/validators/accounts.ts`.
- Produces: a `Row` with `id: "tool.linear-mcp"`. `toolRows`' new signature:

```ts
export async function toolRows(p: Probes, reqs: PackRequirements[], opts: { hasBrew: boolean; secrets: SecretPresence }, seams: ToolsSeams = REAL_SEAMS): Promise<Row[]>
```

- [ ] **Step 1: Write the failing tests**

In `lib/setup/__tests__/validators-tools.test.ts`, add near `NOOP_SEAMS`:

```ts
const NO_SECRETS: SecretPresence = { has: async () => null };
const HAS_KEY: SecretPresence = { has: async () => "lin_api_k" };
```

(importing `SecretPresence` from `../validators/accounts.ts`), then append:

```ts
describe("toolRows: tool.linear-mcp", () => {
  const HOME = "/h";
  const hosted = { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer k" } };
  const conf = (config: unknown) => ({ [`${HOME}/.claude.json`]: JSON.stringify(config) });
  const rowFor = (files: Record<string, string>, secrets: SecretPresence) =>
    pickRow(toolRows(fakeProbes({ home: HOME, env: {}, files }), [], { hasBrew: true, secrets }, NOOP_SEAMS), "tool.linear-mcp");

  test("a Linear MCP named linear -> ready", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: hosted } }), HAS_KEY);
    expect([r.status, r.required]).toEqual(["ready", false]);
  });

  test("an OAuth hosted entry with no auth header is still ready", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }), NO_SECRETS);
    expect(r.status).toBe("ready");
  });

  test("the name linear held by an unrelated server -> needs-you, and says so", async () => {
    const r = await rowFor(conf({ mcpServers: { linear: { type: "http", url: "https://mcp.railway.app/mcp" } } }), HAS_KEY);
    expect(r.status).toBe("needs-you");
    expect(r.detail).toContain("not a Linear MCP");
  });

  test("a Linear MCP under another name -> missing, naming it", async () => {
    const r = await rowFor(conf({ mcpServers: { "linear-matt": hosted } }), HAS_KEY);
    expect(r.status).toBe("missing");
    expect(r.detail).toContain("linear-matt");
  });

  test("nothing configured and no key -> needs-you with a connect action", async () => {
    const r = await rowFor(conf({}), NO_SECRETS);
    expect(r.status).toBe("needs-you");
    expect(r.action).toEqual({ type: "connect", label: "Connect Linear", integration: "linear", fields: [{ name: "apiKey", label: "Linear API key", secret: true, hint: "lin_api_…" }] });
  });

  test("nothing configured but a key is stored -> missing, Install's job", async () => {
    const r = await rowFor(conf({}), HAS_KEY);
    expect([r.status, r.detail]).toEqual(["missing", "installed by Install (linear.mcp)"]);
  });

  test("an absent config file is not an error", async () => {
    const r = await rowFor({}, HAS_KEY);
    expect(r.status).toBe("missing");
  });

  test("an unparsable config -> error naming the file", async () => {
    const r = await rowFor({ [`${HOME}/.claude.json`]: "{ not json" }, HAS_KEY);
    expect(r.status).toBe("error");
    expect(r.detail).toContain(".claude.json");
  });

  test("never required, so it can neither block Install nor fail verify", async () => {
    for (const secrets of [NO_SECRETS, HAS_KEY]) {
      const r = await rowFor(conf({}), secrets);
      expect([r.required, r.optionalNote]).toEqual([false, "Installed by Install (linear.mcp)."]);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts`
Expected: FAIL, `no row tool.linear-mcp` from `pickRow`.

- [ ] **Step 3: Widen `toolRows` and add the row**

Mechanically update the existing 82 call sites in the test file:

```bash
sed -i '' 's/{ hasBrew: true }/{ hasBrew: true, secrets: NO_SECRETS }/g; s/{ hasBrew: false }/{ hasBrew: false, secrets: NO_SECRETS }/g' lib/setup/__tests__/validators-tools.test.ts
```

In `lib/setup/validators/tools.ts`, widen the opts parameter to `{ hasBrew: boolean; secrets: SecretPresence }`, add the row builder, and push it in `toolRows` next to `pluginsRow`:

```ts
const CONNECT_LINEAR_ACTION: Action = { type: "connect", label: "Connect Linear", integration: "linear", fields: integrationDef("linear").fields };

/** Wiring only: the credential itself is `account.linear`'s job, which validates this same secret against api.linear.app. Two probes of one key is one probe too many, and two rows that can disagree. */
async function linearMcpRow(p: Probes, secrets: SecretPresence): Promise<Row> {
  const base = {
    id: "tool.linear-mcp",
    kind: "tool" as const,
    title: "Linear MCP",
    why: "Skills that read and update Linear tickets reach them through this MCP server.",
    required: false,
    optionalNote: "Installed by Install (linear.mcp).",
  };
  const path = claudeJsonPath(p);
  const read = readClaudeConfig(p, path);
  if (!read.ok && read.reason === "unparsable") return row({ ...base, status: "error", detail: `${path} is not valid JSON` });

  const config = read.ok ? read.config : {};
  if (callableBySkills(config)) return row({ ...base, status: "ready", detail: "linear" });
  if (nameTaken(config)) return row({ ...base, status: "needs-you", detail: "a server named linear is not a Linear MCP" });

  const others = linearServerNames(config);
  if (others.length > 0) return row({ ...base, status: "missing", detail: `Linear MCP present as ${others.join(", ")}; skills call mcp__linear__*` });

  if ((await secrets.has("rt", "linearApiKey")) === null) {
    return row({ ...base, status: "needs-you", detail: "no Linear account connected", action: CONNECT_LINEAR_ACTION });
  }
  return row({ ...base, status: "missing", detail: "installed by Install (linear.mcp)" });
}
```

Import `claudeJsonPath`, `readClaudeConfig`, `callableBySkills`, `nameTaken`, `linearServerNames` from `../linear-mcp.ts`, `integrationDef` from `../integrations.ts`, and the `SecretPresence` type from `./accounts.ts`. In `lib/setup/plan.ts:157`, change the call to `toolRows(i.p, reqs, { hasBrew, secrets: i.secrets })`.

Do NOT add `tool.linear-mcp` to `INSTALL_SATISFIED_IDS`: that flip is unconditional in status mode and would turn "this person does not use Linear" into a critical `rt verify` failure.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/setup/__tests__/validators-tools.test.ts lib/setup/__tests__/plan.test.ts && bun x tsc --noEmit`
Expected: PASS. The Done-screen contract suite at the end of `validators-tools.test.ts` also stays green: it constrains only optional rows whose action is `steps` or `open-url`, and this row's action is `connect`.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/validators/tools.ts lib/setup/plan.ts lib/setup/__tests__/validators-tools.test.ts
git commit -m "setup: add the tool.linear-mcp row, wiring-only and never required"
```

---

### Task 5: The VM assertion

**Blocked on Matt naming the harness Linear key file.** Ask before starting this task, using the brief's question command. If the answer has not arrived when Tasks 1 to 4 are green, stop and report the VM leg as pending-key; do not invent a path.

**Files:**
- Modify: `rt-tray/vm/run/guest/assert-team.sh`
- Modify: `rt-tray/vm/fixtures/team-kitchen-sink/expect.json` (add the gate field)
- Modify: `rt-tray/vm/README.md` (document the key's env var or file, and that it is never committed)

**Interfaces:**
- Consumes: `rt setup status --json` rows `tool.linear-mcp` and `account.linear`; the joiner's `~/.claude.json`.
- Produces: `TEAM ok` / `TEAM FAIL` lines in the existing tally.

- [ ] **Step 1: Add the assertion, gated on the fixture**

Append to `rt-tray/vm/run/guest/assert-team.sh`, before the closing tally, in that script's existing idiom (`ok`/`bad`, `jq`, `"$RT" setup status --json | tail -1`):

```bash
# Linear MCP: the entry the pack skills call by name, plus rt's own proof the
# key behind it works. The credential check is `account.linear`'s row, not a
# curl from here: rt makes the api.linear.app call.
if jq -e '.linearMcp == true' "$EXPECT" >/dev/null 2>&1; then
  CJ="$HOME/.claude.json"
  if [ -f "$CJ" ] && jq -e '.mcpServers.linear.url == "https://mcp.linear.app/mcp"' "$CJ" >/dev/null 2>&1; then
    ok "linear MCP entry present in ~/.claude.json"
  else
    bad "no linear MCP entry in ~/.claude.json"
  fi
  for id in tool.linear-mcp account.linear; do
    ROW=$(printf '%s' "$SETUP_JSON" | jq -c --arg id "$id" '.groups[]?.rows[]? | select(.id == $id)' 2>/dev/null | head -1)
    if [ -z "$ROW" ]; then bad "$id row absent"; continue; fi
    S=$(printf '%s' "$ROW" | jq -r '.status'); D=$(printf '%s' "$ROW" | jq -r '.detail // empty')
    if [ "$S" = "ready" ]; then ok "$id row ready"; else bad "$id row $S: $D"; fi
  done
fi
```

Reuse the `SETUP_JSON` the script already captured; if it is out of scope at that point in the file, capture it again the same way it is captured at line 19. Add `"linearMcp": true` to the kitchen-sink fixture's `expect.json` only once the key is actually available to that fixture; otherwise leave every fixture ungated so the block is inert.

- [ ] **Step 2: Syntax-gate it**

Run: `bash rt-tray/vm/check-vm-scripts.sh`
Expected: PASS (it `bash -n`s every guest script).

- [ ] **Step 3: Document the key**

In `rt-tray/vm/README.md`, next to the `MATTSTACK_VMTEST_PAT` paragraph, record where the Linear key comes from, that it reaches the guest the same way (name forwarded, value never in the repo or in argv), and that `linearMcp` in a fixture's `expect.json` turns the assertion on.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/guest/assert-team.sh rt-tray/vm/README.md rt-tray/vm/fixtures/team-kitchen-sink/expect.json
git commit -m "vm: assert the linear MCP entry and its rows on a joiner"
```

---

### Task 6: Full gates and the follow-up filing

**Files:**
- No source changes expected. Fix whatever the gates surface.

- [ ] **Step 1: Run every gate**

```bash
bun run test
bun x tsc --noEmit
bun run docs:check
bun run picker:check
scripts/repo-purity.sh
```

Expected: all green. There is no Swift change on this branch, so no `swift build`. `bun run test` does not run e2e and this branch changes no verbatim CLI output, so the e2e suite is not a gate here; if any exact-string assertion did move, run `bun run test:all`.

- [ ] **Step 2: Confirm the developer's real config was never touched**

```bash
git status --porcelain
ls -la ~/.claude.json
```

Expected: a clean tree, and an `~/.claude.json` whose mtime predates the test run (the preload plus per-test temp HOMEs mean nothing should have reached it).

- [ ] **Step 3: Commit any gate fixes**

```bash
git commit -am "setup: <what the gate surfaced>"
```

---

## Self-Review

**Spec coverage.** Shape detection and the name decision: Task 1. Path resolution and the `~/.claude/.claude.json` relic: Task 1. Atomic write, 0600, key-never-in-argv: Task 2. Step outcomes, the scoped `~/.claude.json` exception, ordering after `plugins.install`: Task 3. Six row states, permanently optional, no second network probe, `INSTALL_SATISFIED_IDS` deliberately not joined: Task 4. Three VM checks in `assert-team.sh`, gated on the fixture, credential proof through rt: Task 5. Isolated-HOME and idempotence proofs: Tasks 3 and 6. The two spec follow-ups (`onboard/SKILL.md`, uninstall mirror, cswap) are recorded as follow-ups and correctly have no task.

**Placeholders.** None: every code step carries the code, every test step carries the assertions, and the one genuinely unknown value (the harness key file) is called out as a blocking question with an explicit fallback rather than a TODO.

**Type consistency.** `claudeJsonPath`, `readClaudeConfig`, `linearServerNames`, `nameTaken`, `callableBySkills`, `withLinearEntry`, `writeClaudeConfig` are named identically in their definition (Tasks 1 and 2) and at every call site (Tasks 3 and 4). `ConfigRead`'s `{ ok: false; reason }` shape is destructured the same way in both consumers. `SecretPresence.has(domain, key)` returns `Promise<string | null>` in both the step and the row.
