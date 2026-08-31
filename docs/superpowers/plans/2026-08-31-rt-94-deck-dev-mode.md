# RT-94: Deck Dev-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One flag (`mattstack.mode`) switches every bundle-ready deck-managed app between its bundled serve shape (prod) and its linked-source serve shape (dev), with dev-gated build/deploy buttons that act on the linked source.

**Architecture:** Deck gains a serve-shape resolver (`src/registry/serve-shape.ts`) that picks bundled vs. source per record and mode, never returning a command that does not exist on disk; the manifest `dev` node is the single source of truth, read live from a stored `dev.workingDirectory` link. A selective-restart endpoint diffs resolved commands against installed launchd plists. rt pokes that endpoint on `rt settings dev-mode` flips.

**Tech Stack:** Bun + TypeScript in both repos; deck's tests are colocated `*.test.ts` run with `bun test`; the board UI is React (`core/board/`). rt's TS CLI stays UI-free.

**Spec:** `docs/superpowers/specs/2026-08-31-rt-94-deck-dev-mode-design.md` (repo-tools, commit 19a514c2). The plan implements it faithfully; where a task cites a rule ("never a phantom bundle", "grandfathered rows"), the spec section of the same name is the authority.

## Global Constraints

- Two repos are touched: **deck** (`~/Documents/GitHub/deck`, Tasks 1-14) and **repo-tools** (this repo, Tasks 16-17). Task 15 edits four `mattstack.deck.json` manifests (chat, console, mr-board, deck repos). Create a feature branch in each repo before its first task (`rt-94-deck-dev-mode` in deck; work in repo-tools happens on `feat/rt-94-deck-dev-mode`).
- Never use em dashes or en dashes in any text, comment, or commit message.
- Code comments state only constraints the code cannot show (parity anchors, ordering traps, invariants). No narration, no reviewer-facing justification, no task numbers.
- Commit after every task (and after any green test step where the task says so). Short imperative messages.
- deck registry writes go through `putRecord`/`addIssue`/`clearIssues` in `src/registry/records.ts` (read-modify-write; never mutate `cache` directly).
- deck tests isolate state with env fakes: `LOCAL_REGISTRY_PATH`, `LOCAL_STATE_DIR`, `LOCAL_AGENTS_DIR`, and inject `devMode` / `Exec` fakes rather than touching the real machine. Follow the patterns in `src/api/register.test.ts` and `src/services/launchd.test.ts`.
- rt's TS CLI must stay UI-free: no new UI code in `commands/` or `lib/` (Tasks 16-17 are pure orchestration; `lib/__tests__/no-ui-in-cli.test.ts` gates this).
- Never run a built rt binary or start a second deck against the real HOME. All validation is `bun test` in each repo. Do not restart the live deck/daemon as part of this plan; deployment is a separate, human-driven step.
- The spec's fallback matrix (section "Resolver and fallback") is the acceptance table for Tasks 4, 6, and 7. Reproduce rows as tests, not by re-deriving behavior.

**Key spec vocabulary used throughout:**
- **slim row:** a managed record whose serve shape is resolver-owned: has `dev.workingDirectory` (or has neither `command` nor `dev`, e.g. after Unlink), and no stored `command`.
- **grandfathered row:** a managed record still carrying `record.command` and no `dev` node (gitq, fresh installs registered by rt setup, pre-migration rows). Keeps today's behavior verbatim in both the resolver and the command route.
- **user row:** `managedBy: "user"`. Never mode-gated, never migrated.

---

## Phase A: deck manifest and record schema

### Task 1: Parse the `dev` node and `includeInBundle` in `mattstack.deck.json`

**Files:**
- Modify: `src/registry/deck-manifest.ts`
- Test: `src/registry/deck-manifest.test.ts`

**Interfaces:**
- Produces: `DeckManifest.dev?: Record<string, string>` (key `start` is the source serve command; every other key is a dev action command) and `DeckManifest.includeInBundle?: boolean`. Later tasks read `manifest.dev?.start`, `manifest.dev?.[key]`, `manifest.includeInBundle`.

- [ ] **Step 1: Write the failing tests**

Add to `src/registry/deck-manifest.test.ts` (follow the file's existing tmp-dir fixture helper; if it writes manifests with a local `write(dir, obj)` helper, reuse it):

```ts
test("parses dev node and includeInBundle", () => {
  const dir = writeManifest({
    name: "chat",
    port: 11002,
    includeInBundle: true,
    dev: { start: "bun src/server/index.ts", build: "bun run build", deploy: "bun run deploy" },
  });
  const parsed = readDeckManifest(dir);
  expect(parsed?.ok).toBe(true);
  if (parsed?.ok) {
    expect(parsed.manifest.includeInBundle).toBe(true);
    expect(parsed.manifest.dev).toEqual({
      start: "bun src/server/index.ts",
      build: "bun run build",
      deploy: "bun run deploy",
    });
  }
});

test("rejects a non-boolean includeInBundle", () => {
  const dir = writeManifest({ name: "chat", includeInBundle: "yes" });
  const parsed = readDeckManifest(dir);
  expect(parsed?.ok).toBe(false);
});

test("rejects bad dev nodes", () => {
  for (const dev of [["a"], { "BAD KEY": "x" }, { build: "" }, { build: 3 }]) {
    const dir = writeManifest({ name: "chat", dev });
    expect(readDeckManifest(dir)?.ok).toBe(false);
  }
});

test("dev node absent stays undefined", () => {
  const dir = writeManifest({ name: "chat", port: 11002 });
  const parsed = readDeckManifest(dir);
  expect(parsed?.ok).toBe(true);
  if (parsed?.ok) {
    expect(parsed.manifest.dev).toBeUndefined();
    expect(parsed.manifest.includeInBundle).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/registry/deck-manifest.test.ts`
Expected: FAIL (new fields are silently dropped today, so the equality assertions fail).

- [ ] **Step 3: Implement the parsing**

In `src/registry/deck-manifest.ts`, extend the interface:

```ts
export interface DeckManifest {
  name: string;
  displayName?: string;
  description?: string;
  icon?: string;
  port?: number;
  /** Shell strings. `start` (when present) is the supervised service; every other key is an action command. */
  commands: Record<string, string>;
  /** Marks the app bundle-ready and in scope for the dev/prod serve switch (field name provisional; fox owns this file's schema). */
  includeInBundle?: boolean;
  /** Dev-only shell strings: `start` is the source serve command; every other key is a dev action command. */
  dev?: Record<string, string>;
  env?: Record<string, string>;
  altConfigs?: Record<string, { port?: number; start?: string }>;
}
```

In `readDeckManifest`, after the `commands` block, add validation mirroring it exactly (same `COMMAND_KEY_RE`, same non-empty-string rule):

```ts
if (m.includeInBundle !== undefined) {
  if (typeof m.includeInBundle !== "boolean") return err("includeInBundle must be a boolean");
  out.includeInBundle = m.includeInBundle;
}

if (m.dev !== undefined) {
  if (typeof m.dev !== "object" || m.dev === null || Array.isArray(m.dev)) return err("dev must be an object");
  const dev: Record<string, string> = {};
  for (const [key, val] of Object.entries(m.dev as Record<string, unknown>)) {
    if (!COMMAND_KEY_RE.test(key)) return err(`dev command key ${key} must match ${COMMAND_KEY_RE}`);
    if (typeof val !== "string" || val.length === 0) return err(`dev command ${key} must be a non-empty string`);
    dev[key] = val;
  }
  out.dev = dev;
}
```

Place `out.includeInBundle` / `out.dev` assignments with the other optional-field assignments (the `out` object is built before this point; move these blocks after `const out = ...` accordingly).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/deck-manifest.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/registry/deck-manifest.ts src/registry/deck-manifest.test.ts
git commit -m "deck-manifest: parse dev node and includeInBundle"
```

### Task 2: Record schema: `dev.workingDirectory` and the `dev-link` issue source

**Files:**
- Modify: `src/registry/records.ts`
- Test: `src/registry/records.test.ts`

**Interfaces:**
- Produces: `AppRecord.dev?: { workingDirectory: string }` and `SyncIssue.source` union extended with `"dev-link"`. Later tasks call `addIssue(name, { source: "dev-link", ... })` / `clearIssues(name, "dev-link")` and read/write `record.dev`.

- [ ] **Step 1: Write the failing test**

```ts
test("dev.workingDirectory round-trips and dev-link issues clear by source", () => {
  putRecord({
    name: "chat", managedBy: "rt", port: 11002, kind: "service",
    dev: { workingDirectory: "/tmp/chat-checkout" },
    createdAt: new Date().toISOString(),
  });
  expect(getRecord("chat")?.dev?.workingDirectory).toBe("/tmp/chat-checkout");
  addIssue("chat", { source: "dev-link", message: "broken", at: new Date().toISOString() });
  expect(getRecord("chat")?.issues?.[0]?.source).toBe("dev-link");
  clearIssues("chat", "dev-link");
  expect(getRecord("chat")?.issues).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/registry/records.test.ts`
Expected: FAIL with a type error on `dev` / `"dev-link"` (bun surfaces it at runtime as a failing build of the test file).

- [ ] **Step 3: Implement**

In `src/registry/records.ts`:

```ts
export interface SyncIssue {
  source: "portless" | "launchd" | "cloudflare" | "railway" | "dev-link";
  message: string;
  at: string;
}
```

And on `AppRecord`, next to `sourceDirectory`:

```ts
  /** The developer's linked source checkout. The one stored dev value:
      serve/build/deploy commands are read live from its mattstack.deck.json. */
  dev?: { workingDirectory: string };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/records.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/records.ts src/registry/records.test.ts
git commit -m "records: add dev.workingDirectory and dev-link issue source"
```

---

## Phase B: deck serve-shape resolver

### Task 3: Link reading and bundle derivation helpers

**Files:**
- Create: `src/registry/serve-shape.ts`
- Test: `src/registry/serve-shape.test.ts`

**Interfaces:**
- Consumes: `readDeckManifest`, `startArgv` (Task 1); `AppRecord.dev` (Task 2); `bundleHelpersDir` from `src/services/bundle-layout.ts`.
- Produces (exact exports later tasks import):

```ts
export interface ResolvedShape { command: string[]; cwd: string; }
export type LinkedManifest =
  | { state: "unlinked" }
  | { state: "broken"; error: string }
  | { state: "linked"; manifest: DeckManifest; dir: string };
export function dataDir(name: string): string;
export function bundleBinaryPath(name: string, helpersDir?: string | null): string | null;
export function readLinkedManifest(record: AppRecord): LinkedManifest;
```

- [ ] **Step 1: Write the failing tests**

`src/registry/serve-shape.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bundleBinaryPath, dataDir, readLinkedManifest } from "./serve-shape.ts";
import type { AppRecord } from "./records.ts";

function rec(over: Partial<AppRecord>): AppRecord {
  return { name: "chat", managedBy: "rt", port: 11002, kind: "service", createdAt: "2026-08-31", ...over };
}

test("dataDir derives from name under ~/.mattstack", () => {
  expect(dataDir("chat")).toBe(join(process.env.HOME!, ".mattstack", "chat"));
});

test("bundleBinaryPath: null outside a bundle, null when missing, path when installed", () => {
  expect(bundleBinaryPath("chat", null)).toBeNull();
  const helpers = mkdtempSync(join(tmpdir(), "helpers-"));
  expect(bundleBinaryPath("chat", helpers)).toBeNull();
  writeFileSync(join(helpers, "chat"), "#!/bin/sh\n");
  expect(bundleBinaryPath("chat", helpers)).toBe(join(helpers, "chat"));
});

describe("readLinkedManifest", () => {
  test("unlinked when no dev.workingDirectory", () => {
    expect(readLinkedManifest(rec({})).state).toBe("unlinked");
  });
  test("broken when the dir is gone", () => {
    const r = rec({ dev: { workingDirectory: "/nonexistent/chat" } });
    expect(readLinkedManifest(r).state).toBe("broken");
  });
  test("broken when the manifest is missing or unparseable", () => {
    const dir = mkdtempSync(join(tmpdir(), "link-"));
    expect(readLinkedManifest(rec({ dev: { workingDirectory: dir } })).state).toBe("broken");
    writeFileSync(join(dir, "mattstack.deck.json"), "{not json");
    expect(readLinkedManifest(rec({ dev: { workingDirectory: dir } })).state).toBe("broken");
  });
  test("linked returns the parsed manifest and dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "link-"));
    writeFileSync(join(dir, "mattstack.deck.json"), JSON.stringify({ name: "chat", dev: { start: "bun x" } }));
    const link = readLinkedManifest(rec({ dev: { workingDirectory: dir } }));
    expect(link.state).toBe("linked");
    if (link.state === "linked") expect(link.manifest.dev?.start).toBe("bun x");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/registry/serve-shape.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

`src/registry/serve-shape.ts`:

```ts
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bundleHelpersDir } from "../services/bundle-layout.ts";
import { readDeckManifest, type DeckManifest } from "./deck-manifest.ts";
import type { AppRecord } from "./records.ts";

export interface ResolvedShape { command: string[]; cwd: string; }

/** Prod data dir convention for managed apps: derived from the name, never stored. */
export function dataDir(name: string): string {
  return join(process.env.HOME ?? homedir(), ".mattstack", name);
}

/** The installed bundle binary for a managed app, or null when deck runs outside
    a bundle or the binary is not installed. Existence is checked here so no
    caller can ever build a phantom bundle command. */
export function bundleBinaryPath(name: string, helpersDir: string | null = bundleHelpersDir()): string | null {
  if (!helpersDir) return null;
  const bin = join(helpersDir, name);
  return existsSync(bin) ? bin : null;
}

export type LinkedManifest =
  | { state: "unlinked" }
  | { state: "broken"; error: string }
  | { state: "linked"; manifest: DeckManifest; dir: string };

/** The one dir + manifest validity check, shared by the resolver and the
    command-route gate so the two cannot diverge. */
export function readLinkedManifest(record: AppRecord): LinkedManifest {
  const dir = record.dev?.workingDirectory;
  if (!dir) return { state: "unlinked" };
  if (!existsSync(dir)) return { state: "broken", error: `${dir} does not exist` };
  const parsed = readDeckManifest(dir);
  if (parsed === null) return { state: "broken", error: `no mattstack.deck.json in ${dir}` };
  if (!parsed.ok) return { state: "broken", error: parsed.error };
  return { state: "linked", manifest: parsed.manifest, dir };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/serve-shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/serve-shape.ts src/registry/serve-shape.test.ts
git commit -m "serve-shape: dataDir, bundleBinaryPath, readLinkedManifest helpers"
```

### Task 4: The `serveShape` resolver and issue lifecycle

**Files:**
- Modify: `src/registry/serve-shape.ts`
- Test: `src/registry/serve-shape.test.ts`

**Interfaces:**
- Consumes: Task 3 helpers; `isDevMode` from `src/api/dev-mode.ts`; `addIssue`/`clearIssues` (Task 2); `startArgv` from `deck-manifest.ts`.
- Produces:

```ts
export interface ServeShapeDeps { devMode?: () => boolean; helpersDir?: string | null; }
export function sourceShape(record: AppRecord): ResolvedShape | null;
export function bundleShape(record: AppRecord, helpersDir?: string | null): ResolvedShape | null;
export function serveShape(record: AppRecord, deps?: ServeShapeDeps): ResolvedShape | null;
```

**Behavior contract (the spec's resolver, verbatim in intent):**
- user row: return `{ command: record.command!, cwd: record.workingDirectory! }`, clear `dev-link` issues.
- grandfathered row (`!record.dev?.workingDirectory && record.command?.length`): return the stored shape verbatim, clear `dev-link` issues. This covers gitq, fresh installs, and every pre-migration row.
- otherwise (slim or linked row): `source = sourceShape(record)` (null unless linked + valid + has `dev.start`); `bundle = bundleShape(record)`. For a row that still carries `record.command` alongside `dev` (a fresh-install row the developer linked), `bundleShape` is that stored command verbatim, existence-checked on its absolute argv0; for a slim row it is the derived bundle command, only when installed. Pick `isDevMode() ? (source ?? bundle) : (bundle ?? source)`. Null pick: add a `dev-link` issue ("no runnable shape"), return null. Bundle picked while the link is broken: add the "missing or invalid; running bundled" issue. Source picked in prod because no bundle: add the "bundle not installed; serving source" issue. Clean pick: clear `dev-link` issues.
- A valid linked manifest that merely omits `dev.start` is NOT broken (deck itself): `source` is null, no issue.

- [ ] **Step 1: Write the failing tests (the fallback matrix)**

Append to `src/registry/serve-shape.test.ts`. Use a registry fixture: set `process.env.LOCAL_REGISTRY_PATH` to a tmp file and call `reloadRegistry()` in `beforeEach` (pattern: `src/registry/records.test.ts`), because `serveShape` writes issues through `addIssue`/`clearIssues`.

```ts
import { putRecord, getRecord, reloadRegistry } from "./records.ts";
import { serveShape } from "./serve-shape.ts";

function linkedDir(manifest: object): string {
  const dir = mkdtempSync(join(tmpdir(), "src-"));
  writeFileSync(join(dir, "mattstack.deck.json"), JSON.stringify(manifest));
  return dir;
}
const CHAT_DEV = { name: "chat", dev: { start: "bun src/server/index.ts", build: "bun run build" } };

describe("serveShape matrix", () => {
  test("user row: record shape, any mode", () => {
    const r = rec({ managedBy: "user", command: ["node", "s.js"], workingDirectory: "/x" });
    putRecord(r);
    expect(serveShape(r, { devMode: () => true })).toEqual({ command: ["node", "s.js"], cwd: "/x" });
  });

  test("grandfathered row: stored command verbatim, no issue, both modes", () => {
    const r = rec({ command: ["/bundle/gitq", "board"], workingDirectory: "/data/gitq" });
    putRecord(r);
    for (const dev of [true, false]) {
      expect(serveShape(r, { devMode: () => dev })).toEqual({ command: ["/bundle/gitq", "board"], cwd: "/data/gitq" });
    }
    expect(getRecord("chat")?.issues).toBeUndefined();
  });

  test("dev + linked valid: source", () => {
    const dir = linkedDir(CHAT_DEV);
    const r = rec({ dev: { workingDirectory: dir } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => true, helpersDir: null })).toEqual({
      command: ["bun", "src/server/index.ts"], cwd: dir,
    });
    expect(getRecord("chat")?.issues).toBeUndefined();
  });

  test("prod + linked + bundle installed: bundle, clean", () => {
    const helpers = mkdtempSync(join(tmpdir(), "helpers-"));
    writeFileSync(join(helpers, "chat"), "");
    const r = rec({ dev: { workingDirectory: linkedDir(CHAT_DEV) } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => false, helpersDir: helpers })).toEqual({
      command: [join(helpers, "chat")], cwd: dataDir("chat"),
    });
  });

  test("never a phantom bundle: prod, source linked, no bundle: serves source loudly", () => {
    const dir = linkedDir(CHAT_DEV);
    const r = rec({ dev: { workingDirectory: dir } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => false, helpersDir: null })?.cwd).toBe(dir);
    expect(getRecord("chat")?.issues?.[0]?.message).toContain("not installed");
  });

  test("dev + broken link + bundle: bundle with loud issue; issue clears on next clean resolve", () => {
    const helpers = mkdtempSync(join(tmpdir(), "helpers-"));
    writeFileSync(join(helpers, "chat"), "");
    const r = rec({ dev: { workingDirectory: "/nonexistent/chat" } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => true, helpersDir: helpers })?.command).toEqual([join(helpers, "chat")]);
    expect(getRecord("chat")?.issues?.[0]?.source).toBe("dev-link");
    const fixed = rec({ dev: { workingDirectory: linkedDir(CHAT_DEV) } });
    putRecord(fixed);
    serveShape(fixed, { devMode: () => true, helpersDir: helpers });
    expect(getRecord("chat")?.issues).toBeUndefined();
  });

  test("neither bundle nor valid source: null with loud issue", () => {
    const r = rec({ dev: { workingDirectory: "/nonexistent/chat" } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => true, helpersDir: null })).toBeNull();
    expect(getRecord("chat")?.issues?.[0]?.message).toContain("no runnable shape");
  });

  test("dev.start absent is not broken: deck-style manifest resolves to bundle cleanly", () => {
    const helpers = mkdtempSync(join(tmpdir(), "helpers-"));
    writeFileSync(join(helpers, "chat"), "");
    const dir = linkedDir({ name: "chat", dev: { deploy: "bun run deploy" } });
    const r = rec({ dev: { workingDirectory: dir } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => true, helpersDir: helpers })?.command).toEqual([join(helpers, "chat")]);
    expect(getRecord("chat")?.issues).toBeUndefined();
  });

  test("linked fresh-install row: stored bundle command is the bundle shape", () => {
    const binDir = mkdtempSync(join(tmpdir(), "bin-"));
    const bin = join(binDir, "chat");
    writeFileSync(bin, "");
    const dir = linkedDir(CHAT_DEV);
    const r = rec({ command: [bin], workingDirectory: "/data/chat", dev: { workingDirectory: dir } });
    putRecord(r);
    expect(serveShape(r, { devMode: () => false, helpersDir: null })).toEqual({ command: [bin], cwd: "/data/chat" });
    expect(serveShape(r, { devMode: () => true, helpersDir: null })?.cwd).toBe(dir);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/registry/serve-shape.test.ts`
Expected: FAIL (`serveShape` not exported).

- [ ] **Step 3: Implement the resolver**

Append to `src/registry/serve-shape.ts`:

```ts
import { addIssue, clearIssues } from "./records.ts";
import { startArgv } from "./deck-manifest.ts";
import { isDevMode } from "../api/dev-mode.ts";

export interface ServeShapeDeps {
  devMode?: () => boolean;
  /** Test seam for bundleBinaryPath's helpers dir; default derives from the running bundle. */
  helpersDir?: string | null;
}

export function sourceShape(record: AppRecord): ResolvedShape | null {
  const link = readLinkedManifest(record);
  if (link.state !== "linked") return null;
  const start = link.manifest.dev?.start;
  if (!start) return null;
  return { command: startArgv(start), cwd: link.dir };
}

export function bundleShape(record: AppRecord, helpersDir?: string | null): ResolvedShape | null {
  // A stored command on a dev-linked row is the prod shape rt setup registered
  // (absolute bundled binary, possibly with serve args); it outranks derivation
  // so args like gitq's `board` are never lost. Existence-checked like the
  // derived path: never a phantom bundle.
  if (record.command?.length) {
    return existsSync(record.command[0]!)
      ? { command: record.command, cwd: record.workingDirectory ?? dataDir(record.name) }
      : null;
  }
  const bin = bundleBinaryPath(record.name, helpersDir);
  return bin ? { command: [bin], cwd: dataDir(record.name) } : null;
}

function issue(name: string, message: string): void {
  addIssue(name, { source: "dev-link", message, at: new Date().toISOString() });
}

export function serveShape(record: AppRecord, deps: ServeShapeDeps = {}): ResolvedShape | null {
  if (record.managedBy === "user") {
    clearIssues(record.name, "dev-link");
    return { command: record.command!, cwd: record.workingDirectory! };
  }
  // Grandfathered: a managed row with a stored command and no dev link keeps
  // today's behavior verbatim (gitq, fresh installs, pre-migration rows).
  if (!record.dev?.workingDirectory && record.command?.length) {
    clearIssues(record.name, "dev-link");
    return { command: record.command, cwd: record.workingDirectory! };
  }

  const source = sourceShape(record);
  const bundle = deps.helpersDir !== undefined ? bundleShape(record, deps.helpersDir) : bundleShape(record);
  const linkBroken = readLinkedManifest(record).state === "broken";
  const dev = (deps.devMode ?? isDevMode)();
  const chosen = dev ? (source ?? bundle) : (bundle ?? source);

  if (!chosen) {
    issue(record.name, `no runnable shape for ${record.name} (no bundle, no valid source)`);
    return null;
  }
  if (chosen === bundle && linkBroken) {
    issue(record.name, `dev source ${record.dev!.workingDirectory} missing or invalid; running bundled`);
  } else if (chosen === source && !bundle && !dev) {
    issue(record.name, `bundle for ${record.name} not installed; serving source`);
  } else {
    clearIssues(record.name, "dev-link");
  }
  return chosen;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/serve-shape.test.ts`
Expected: PASS, every matrix row.

- [ ] **Step 5: Commit**

```bash
git add src/registry/serve-shape.ts src/registry/serve-shape.test.ts
git commit -m "serve-shape: mode-picking resolver with dev-link issue lifecycle"
```

### Task 5: Wire the resolver into every plist render

**Files:**
- Modify: `src/api/register.ts` (`specFor` and its three call sites: `registerApp`, `editApp`, `reinstallSupervised`)
- Test: `src/api/register.test.ts`

**Interfaces:**
- Consumes: `serveShape`, `ResolvedShape` (Task 4).
- Produces: `function specFor(record: AppRecord, shape: ResolvedShape): ServiceSpec` (module-private; programArguments from `shape.command`, workingDirectory from `shape.cwd`; env/PORT/label/log paths unchanged). Every install site becomes:

```ts
const shape = serveShape(record);
if (shape) {
  await tryDriver(record.name, "launchd", () => drivers.manager.install(specFor(record, shape)));
}
```

(`serveShape` already recorded the dev-link issue on null; the app is deliberately not stood up, per "deck does not stand up a command that isn't there". In `reinstallSupervised`, a null shape counts the record as failed. Keep `registerApp`'s existing `isService` gate around its install call: external (staticPort) records still get no plist.)

- [ ] **Step 1: Write the failing test**

Add to `src/api/register.test.ts` (reuse its existing fake `Drivers` and registry fixture):

```ts
test("a linked managed record installs its resolved source shape in dev mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "src-"));
  writeFileSync(join(dir, "mattstack.deck.json"),
    JSON.stringify({ name: "srcapp", dev: { start: "bun run serve" } }));
  // register as a user app first to get a record + label, then repoint it to managed+linked
  await registerApp({ name: "srcapp", command: ["bun", "x.ts"], workingDirectory: "/tmp" }, drivers);
  const r = getRecord("srcapp")!;
  putRecord({ ...r, managedBy: "rt", command: undefined, workingDirectory: undefined, dev: { workingDirectory: dir } });
  // editApp re-renders the plist through the resolver
  await editApp("srcapp", {}, "rt", true, drivers);
  const installed = fakeManager.installed.get(`${LABEL_PREFIX}srcapp`)!;
  expect(installed.workingDirectory).toBe(dir);
  expect(installed.programArguments.slice(1)).toEqual(["run", "serve"]);
});
```

Adjust to the file's actual fake-manager shape (it records installed specs; find the existing assertion pattern and mirror it). The resolver reads `isDevMode()` by default, which tests must not depend on, so add one module-level test seam in `register.ts` rather than widening `Drivers`:

```ts
/** Test seam: overrides the resolver's mode read; production leaves it unset. */
export let serveShapeDeps: ServeShapeDeps = {};
export function setServeShapeDeps(deps: ServeShapeDeps): void { serveShapeDeps = deps; }
```

and pass `serveShapeDeps` at each `serveShape(record, serveShapeDeps)` call. Tests call `setServeShapeDeps({ devMode: () => true, helpersDir: null })` in `beforeEach` and reset in `afterEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/api/register.test.ts`
Expected: FAIL (plist rendered from record fields, or `specFor` throws on the slim record's missing command).

- [ ] **Step 3: Implement**

In `src/api/register.ts`:

```ts
import { serveShape, type ResolvedShape, type ServeShapeDeps } from "../registry/serve-shape.ts";

function specFor(record: AppRecord, shape: ResolvedShape): ServiceSpec {
  const env = { ...(record.env ?? {}), PORT: String(record.port) };
  const path = env.PATH ?? composeServicePath();
  const [argv0, ...rest] = shape.command;
  const program = resolveProgram(argv0!, path);
  if (!program) throw new Error(`${argv0} not found on the service PATH (${path})`);
  return {
    label: record.label!,
    programArguments: [program, ...rest],
    workingDirectory: shape.cwd,
    environment: { ...env, PATH: path },
    stdoutPath: join(logsDir(), `${record.name}.out.log`),
    stderrPath: join(logsDir(), `${record.name}.err.log`),
  };
}
```

Update the three call sites as in the Interfaces block. In `editApp`, compute the shape from the persisted `next` record after `putRecord`, so the install reflects the edit. Leave `convert.ts`'s own `specFor` alone: it renders legacy user adoptions whose records always carry a command.

- [ ] **Step 4: Run the full register suite**

Run: `bun test src/api/register.test.ts`
Expected: PASS, all pre-existing tests included (user-app behavior is byte-identical: their `serveShape` returns the record fields).

- [ ] **Step 5: Commit**

```bash
git add src/api/register.ts src/api/register.test.ts
git commit -m "register: render plists from the serve-shape resolver"
```

---

## Phase C: deck command gate, status, board UI

### Task 6: Command-route gating per app class

**Files:**
- Modify: `src/api/server.ts` (the `/api/v1/apps/:name/commands/:key` block, currently ~line 353)
- Test: `src/api/server.test.ts`

**Interfaces:**
- Consumes: `readLinkedManifest` (Task 3).
- Produces: route behavior only. Classification logic:

```ts
const record = getRecord(name);
if (!record) return json({ error: "not found" }, 404);
const dev = (deps.devMode ?? isDevMode)();
let shell: string | undefined;
let cwd: string | undefined;
const grandfathered = !record.dev?.workingDirectory && !!record.commands;
if (record.managedBy === "user") {
  // user apps are never mode-gated (fixes the prod over-gate)
  shell = record.commands?.[cmd];
  cwd = record.sourceDirectory ?? record.workingDirectory;
} else if (grandfathered) {
  // pre-migration/managed-without-dev rows keep today's dev-gated behavior verbatim
  if (!dev) return json({ error: "not found" }, 404);
  shell = record.commands?.[cmd];
  cwd = record.sourceDirectory ?? record.workingDirectory;
} else {
  if (!dev || !record.dev?.workingDirectory) return json({ error: "not found" }, 404);
  const link = readLinkedManifest(record);
  if (link.state !== "linked") return json({ error: "not found" }, 404);
  shell = link.manifest.dev?.[cmd];
  cwd = link.dir;
}
if (!shell) return json({ error: "not found" }, 404);
```

Then the existing runId-GET / POST body runs unchanged, except `startCommandRun` receives `shell` and `workingDirectory: cwd` (the `cwd` null-check with its 400 stays for the user/grandfathered branches). The current top-of-block `if (!dev) return 404` moves into the two managed branches; production still answers 404 indistinguishable from absent for every mattstack command, and a user app's key that is not declared is a 404 in any mode.

- [ ] **Step 1: Write the failing tests**

Add to `src/api/server.test.ts`, following its existing route-test harness (it constructs the server with injected `deps` including `devMode`):

```ts
describe("command route gating by app class", () => {
  test("user app runs its declared key in prod", async () => { /* devMode: () => false; expect 200/started */ });
  test("user app 404s on an undeclared key", async () => { /* expect 404 */ });
  test("grandfathered managed row keeps dev-gated record.commands", async () => {
    /* record: managedBy rt, commands: { build: "x" }, no dev node.
       prod: 404. dev: started, cwd = sourceDirectory ?? workingDirectory. */
  });
  test("slim managed row 404s in prod, when unlinked, and on a broken link", async () => { /* three cases */ });
  test("slim managed row runs a live-read dev key when linked in dev mode", async () => {
    /* linked dir manifest dev: { build: "bun run build" }; expect run in that dir.
       Then rewrite the manifest's dev.build and run again: the NEW string is used (live-read, no drift). */
  });
  test("deck-self shape: linked manifest with dev.deploy and no dev.start still runs deploy", async () => { /* expect started */ });
});
```

Write each case fully against the harness's real request helper; assert on the fake command-runner or response body the way the file's existing `/commands/` tests do.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/server.test.ts`
Expected: new tests FAIL (user apps 404 in prod today; slim rows 404 because `record.commands` is empty).

- [ ] **Step 3: Implement the route block per the Interfaces snippet**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/server.test.ts`
Expected: PASS including all pre-existing command-route tests (they exercise user/grandfathered rows in dev mode, which are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/api/server.test.ts
git commit -m "server: per-class command gate (user un-gated, slim rows live-read)"
```

### Task 7: Status rows expose per-class command keys and dev-link state

**Files:**
- Modify: `src/api/status.ts` (StatusRow + the row builder, currently ~line 224)
- Modify: `src/registry/serve-shape.ts` (one new export)
- Test: `src/api/status.test.ts`

**Interfaces:**
- Produces on `StatusRow`:

```ts
  /** Action-command names surfaced to the board: user apps always; managed apps per the dev gate. */
  commands?: string[];
  /** Managed rows in dev mode only: drives the board's Link source / fix link affordances. */
  devLink?: "unlinked" | "linked" | "broken";
```

- Produces in `serve-shape.ts`:

```ts
/** Command keys the board may show for a record, mirroring the command route's gate. */
export function commandKeysFor(record: AppRecord, devMode: boolean): string[] | undefined {
  if (record.managedBy === "user") {
    const keys = Object.keys(record.commands ?? {});
    return keys.length ? keys : undefined;
  }
  if (!record.dev?.workingDirectory && record.commands) {
    return devMode ? Object.keys(record.commands) : undefined;
  }
  if (!devMode || !record.dev?.workingDirectory) return undefined;
  const link = readLinkedManifest(record);
  if (link.state !== "linked") return undefined;
  const keys = Object.keys(link.manifest.dev ?? {}).filter((k) => k !== "start");
  return keys.length ? keys : undefined;
}
```

- In the status row builder, replace the `commands:` line and add `devLink`:

```ts
commands: record ? commandKeysFor(record, opts.devMode) : undefined,
devLink:
  record && record.managedBy !== "user" && opts.devMode && !(record.commands && !record.dev)
    ? readLinkedManifest(record).state
    : undefined,
```

(`devLink` is omitted for grandfathered rows: they have no link concept yet.)

- [ ] **Step 1: Write the failing tests**

Add to `src/api/status.test.ts` using its existing buildStatus fixture: (a) a user app's `commands` present with `devMode: false`; (b) a grandfathered managed row's `commands` present only in dev; (c) a slim linked row lists manifest dev keys minus `start` in dev and nothing in prod, with `devLink: "linked"`; (d) an unlinked slim row gets `devLink: "unlinked"` and no commands; (e) a broken link gets `devLink: "broken"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/status.test.ts`

- [ ] **Step 3: Implement per the Interfaces block**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/status.test.ts src/registry/serve-shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/status.ts src/api/status.test.ts src/registry/serve-shape.ts
git commit -m "status: per-class command keys + devLink state on rows"
```

### Task 8: Board UI: Link source, Unlink, and the button matrix

**Files:**
- Modify: `core/board/logic.ts` (Row type), `core/board/AppsTable.tsx` (row affordances), `core/board/useBoardState.ts` (PATCH actions)
- Test: `core/board/logic.test.ts`

**Interfaces:**
- Consumes: `StatusRow.devLink` and `commands` (Task 7); the PATCH body `{ dev: { workingDirectory: string } | null }` (Task 9; the two tasks are independently mergeable because the UI action degrades to a 400 until Task 9 lands, and Task 9 is testable without the UI).
- Produces: `Row.devLink?: "unlinked" | "linked" | "broken"` mirrored from the API (add it wherever `Row.commands` is populated in `logic.ts`).

Behavior (the spec's matrix, board column):
- `devLink === "unlinked"`: render a "Link source" control where command buttons would sit (`AppsTable.tsx` ~line 383 renders buttons off `row.commands`). Click reveals an inline text input; submit calls `linkSource(row, path)`.
- `devLink === "broken"`: no buttons; the existing issue badge already renders the loud `dev-link` SyncIssue; add a "fix link" hint next to it that reopens the same inline input.
- `devLink === "linked"`: an "Unlink" affordance beside the buttons; `unlinkSource(row)` sends `{ dev: null }`.
- No `devLink`: render exactly as today.

In `useBoardState.ts`, next to the existing `apiPost` command runner (~line 152), add:

```ts
function linkSource(row: Row, workingDirectory: string): Promise<void> {
  return apiPatch(`/api/v1/apps/${row.name}`, { dev: { workingDirectory } });
}
function unlinkSource(row: Row): Promise<void> {
  return apiPatch(`/api/v1/apps/${row.name}`, { dev: null });
}
```

using the same fetch helper the edit dialog's PATCH uses (`core/board/api.ts`; add `apiPatch` there if only a modal-local variant exists). Server-side validation is the source of truth; the UI just surfaces the 400 error message inline (typo'd paths are caught immediately, per spec).

- [ ] **Step 1: Write the failing logic test**

In `core/board/logic.test.ts`, extend the row-mapping test to assert `devLink` passes through from a status payload to `Row`, and that a row with `devLink: "unlinked"` has no `commands`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test core/board/logic.test.ts`

- [ ] **Step 3: Implement logic.ts + the two useBoardState actions**

- [ ] **Step 4: Implement the AppsTable affordances**

Follow the existing command-button styles in `AppsTable.tsx` and `board.css`; keep the inline input minimal (text field + confirm/cancel, submitting on Enter). The new affordances key on `devLink`, which only arrives when the server is in dev mode, so no public-board consideration applies (user-app `commands` do arrive in prod after Task 7; their buttons render as today).

- [ ] **Step 5: Run the board suite and typecheck**

Run: `bun test core/board/ && bun run build` (or the repo's board build script per `package.json`; `board-assets.test.ts` catches a broken bundle).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/board/
git commit -m "board: link-source / unlink affordances and dev-link states"
```

---

## Phase D: deck linking front doors

### Task 9: PATCH front door: validate and store `dev.workingDirectory`

**Files:**
- Modify: `src/api/register.ts` (`editApp`)
- Test: `src/api/register.test.ts`

**Interfaces:**
- Produces: `editApp` patch type gains `dev?: { workingDirectory: string } | null`. Semantics:
  - `patch.dev` object: validate before any teardown: the dir exists, `readDeckManifest(dir)` parses ok, and `manifest.name === record.name`; each failure is a 400 with a distinct error (`"directory not found"`, the parse error, `"manifest name mismatch"`).
  - `patch.dev === null`: clear the link (Unlink).
  - A patch touching ONLY `dev` skips `authorizeStructural`: the link is developer-local machine state, not registrar-owned structure (the mutation plane is already 127.0.0.1-only and public mutations 403). Any patch that also touches structural fields keeps the existing gate.
  - `next.dev = patch.dev === null ? undefined : (patch.dev ?? record.dev)`, and the normal teardown/standup path then re-renders through the resolver (Task 5), so a link or unlink immediately restarts the app onto its newly resolved shape.

- [ ] **Step 1: Write the failing tests**

```ts
describe("editApp dev link", () => {
  test("valid link stores dev.workingDirectory and reinstalls", async () => {
    /* managed record; PATCH { dev: { workingDirectory: dir } } with a matching-name manifest;
       expect 200, getRecord().dev.workingDirectory === dir, fake manager reinstalled the label. */
  });
  test("rejects a missing dir, a bad manifest, and a name mismatch with 400s", async () => { /* three asserts */ });
  test("dev-only patch on a managed record needs no force", async () => {
    /* caller "user", force false, managedBy "rt": expect 200, not 409. */
  });
  test("dev: null unlinks", async () => { /* expect record.dev undefined afterwards */ });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/register.test.ts`
Expected: FAIL (unknown patch field is ignored; managed PATCH 409s).

- [ ] **Step 3: Implement in `editApp`**

Validation block before `authorizeStructural`:

```ts
const devOnly = patch.dev !== undefined
  && patch.name === undefined && patch.command === undefined
  && patch.workingDirectory === undefined && patch.env === undefined && patch.port === undefined;
if (patch.dev != null) {
  const dir = patch.dev.workingDirectory;
  if (typeof dir !== "string" || !dir.startsWith("/")) return { status: 400, body: { error: "dev.workingDirectory must be an absolute path" } };
  if (!existsSync(dir)) return { status: 400, body: { error: "directory not found", dir } };
  const parsed = readDeckManifest(dir);
  if (parsed === null) return { status: 400, body: { error: `no mattstack.deck.json in ${dir}` } };
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  if (parsed.manifest.name !== record.name) {
    return { status: 400, body: { error: "manifest name mismatch", expected: record.name, got: parsed.manifest.name } };
  }
}
if (!devOnly) {
  const verdict = authorizeStructural(record, caller, force);
  if (!verdict.ok) return { status: verdict.status, body: verdict.body };
}
```

and in the `next` construction: `dev: patch.dev === null ? undefined : (patch.dev ?? record.dev)` (JSON serialization drops the `undefined`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/register.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/api/register.ts src/api/register.test.ts
git commit -m "editApp: dev.workingDirectory link/unlink with manifest validation"
```

### Task 10: CLI front door: `deck register <path>` links managed apps; retire `sourceDirectory` writes

**Files:**
- Modify: `src/api/register-manifest.ts` (`applyManifest`, `attachSource`)
- Modify: `src/edge/remote.ts:71` (read chain)
- Test: `src/api/register-manifest.test.ts`

**Interfaces:**
- Consumes: `editApp`'s `dev` patch (Task 9).
- Produces: `applyManifest(dir, activeAlt, drivers)` behavior change for existing managed records:
  - Platform row (`isPlatformManagedBy`): `attachSource` writes `dev: { workingDirectory: dir }` instead of `sourceDirectory: dir`, stops copying `commands` onto the record (they are live-read now), keeps its declares-serve-shape refusal, and keeps its putRecord-only flow (never churn the platform's own launchd agent from inside a request).
  - Other managed rows (`managedBy` not `"user"`): the register becomes a link: `return editApp(manifest.name, { dev: { workingDirectory: dir } }, existing.managedBy, true, drivers)`. It must NOT fall through to the serve-shape `editApp` branch that rewrites `command`/`workingDirectory` from the manifest (that path is exactly the three-way drift RT-94 removes), and must NOT overwrite `record.commands`/`altConfigs` afterwards for these rows.
  - User rows and creation: unchanged.
- `remote.ts` push dir becomes `record.dev?.workingDirectory ?? record.sourceDirectory ?? record.workingDirectory!` (tolerates unmigrated rows).

- [ ] **Step 1: Write the failing tests**

Add to `src/api/register-manifest.test.ts`:

```ts
test("register on a managed app links the checkout instead of rewriting its serve shape", async () => {
  /* existing record managedBy "rt" with command [<bin>]; applyManifest(chatCheckoutDir);
     expect record.dev.workingDirectory === dir, record.command unchanged, no record.commands copy. */
});
test("register on the platform row writes dev.workingDirectory, not sourceDirectory", async () => {
  /* deck-shaped manifest (dev.deploy only); expect record.dev set, record.sourceDirectory undefined,
     serve-shape-declaring manifest still refused with 400. */
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/register-manifest.test.ts`

- [ ] **Step 3: Implement**

In `attachSource`, the `declaresServeShape` check must also treat a manifest `dev.start` as a serve-shape declaration for the platform (deck refuses to run from source):

```ts
const declaresServeShape =
  manifest.commands.start !== undefined ||
  manifest.dev?.start !== undefined ||
  manifest.port !== undefined ||
  manifest.altConfigs !== undefined ||
  manifest.env !== undefined;
```

and the write becomes:

```ts
putRecord({ ...existing, dev: { workingDirectory: dir }, sourceDirectory: undefined, commands: undefined });
```

In `applyManifest`, replace the `existing && isPlatformManagedBy(...)` special case with a managed branch covering both:

```ts
if (existing && existing.managedBy !== "user") {
  if (isPlatformManagedBy(existing.managedBy)) {
    return attachSource(existing, manifest, dir, activeAlt, actionCommands);
  }
  if (activeAlt !== undefined) return { status: 400, body: { error: "alt configs do not apply to a linked managed app" } };
  return editApp(manifest.name, { dev: { workingDirectory: dir } }, existing.managedBy, true, drivers);
}
```

and make the trailing metadata `putRecord` (action commands/altConfigs) apply only to the user-row path it still reaches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/api/register-manifest.test.ts src/edge/`
Expected: PASS including remote tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/register-manifest.ts src/api/register-manifest.test.ts src/edge/remote.ts
git commit -m "register: managed manifest register links source; retire sourceDirectory writes"
```

---

## Phase E: deck selective restart

### Task 11: Plist read-back helper

**Files:**
- Modify: `src/services/launchd.ts`
- Test: `src/services/launchd.test.ts`

**Interfaces:**
- Produces: `export function readInstalledProgramArguments(label: string): string[] | null` (null when the plist is absent or has no ProgramArguments array). Deck has no plist reader today; this parses back the XML deck itself rendered (`renderPlist`), so a regex extraction against that known shape is sufficient and correct.

- [ ] **Step 1: Write the failing test (render round-trip)**

```ts
test("readInstalledProgramArguments round-trips renderPlist, escapes included", async () => {
  process.env.LOCAL_AGENTS_DIR = mkdtempSync(join(tmpdir(), "agents-"));
  const manager = new LaunchdManager(async () => 0);
  const spec = {
    label: "com.mattstack.deck.chat",
    programArguments: ["/usr/bin/env", "arg<with&odd>chars", "plain"],
    workingDirectory: "/tmp", environment: {}, stdoutPath: "/tmp/o", stderrPath: "/tmp/e",
  };
  await manager.install(spec);
  expect(readInstalledProgramArguments("com.mattstack.deck.chat")).toEqual(spec.programArguments);
  expect(readInstalledProgramArguments("com.mattstack.deck.ghost")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/launchd.test.ts`

- [ ] **Step 3: Implement**

In `src/services/launchd.ts`:

```ts
import { readFileSync } from "fs";

/** ProgramArguments read back from an installed plist deck itself rendered
    (renderPlist's known shape); the plist stays the source of truth for
    "what is actually running" so no last-resolved command is stored. */
export function readInstalledProgramArguments(label: string): string[] | null {
  let xml: string;
  try {
    xml = readFileSync(join(agentsDir(), `${label}.plist`), "utf8");
  } catch {
    return null;
  }
  const array = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array) return null;
  return [...array[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  );
}
```

(Unescape `&amp;` last, the reverse of `esc()`'s order.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/launchd.test.ts src/services/plist.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/launchd.ts src/services/launchd.test.ts
git commit -m "launchd: readInstalledProgramArguments plist read-back"
```

### Task 12: `POST /api/v1/apps/managed/reresolve`

**Files:**
- Modify: `src/api/register.ts` (new `reresolveManagedApps`)
- Modify: `src/api/server.ts` (route, next to `managed/restart`)
- Test: `src/api/register.test.ts`, `src/api/server.test.ts`

**Interfaces:**
- Consumes: `serveShape` (Task 4), `specFor` (Task 5), `readInstalledProgramArguments` (Task 11).
- Produces:

```ts
export async function reresolveManagedApps(drivers: Drivers): Promise<FlowResult>
// body: { ok: boolean, restarted: string[], unchanged: string[], failed: Array<{ name: string; error: string }> }
```

Behavior:

```ts
export async function reresolveManagedApps(drivers: Drivers): Promise<FlowResult> {
  const restarted: string[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const record of listRecords()) {
    if (record.managedBy === "user" || record.kind !== "service" || !record.label) continue;
    // The platform never restarts itself mid-request; bootstrapSelf owns its shape.
    if (isPlatformManagedBy(record.managedBy)) continue;
    const shape = serveShape(record, serveShapeDeps);
    if (!shape) { failed.push({ name: record.name, error: "no runnable shape" }); continue; }
    let spec: ServiceSpec;
    try {
      spec = specFor(record, shape);
    } catch (err) {
      failed.push({ name: record.name, error: String(err).slice(0, 300) });
      continue;
    }
    const installed = readInstalledProgramArguments(record.label);
    if (installed !== null && installed.length === spec.programArguments.length
        && installed.every((a, i) => a === spec.programArguments[i])) {
      unchanged.push(record.name);
      continue;
    }
    try {
      await drivers.manager.uninstall(record.label);
      await drivers.manager.install(spec);
      restarted.push(record.name);
    } catch (err) {
      failed.push({ name: record.name, error: String(err).slice(0, 300) });
    }
  }
  return { status: 200, body: { ok: failed.length === 0, restarted, unchanged, failed } };
}
```

A null shape leaves the currently-installed service untouched (the loud `dev-link` issue is already on the record); deck never tears down a running app to replace it with nothing. Route in `server.ts`, mirroring the `managed/restart` block:

```ts
if (pathname === "/api/v1/apps/managed/reresolve" && req.method === "POST") {
  const r = await reresolveManagedApps(deps);
  return json(r.body, r.status);
}
```

- [ ] **Step 1: Write the failing tests**

In `src/api/register.test.ts`: (a) a flip that changes the resolved command uninstalls + reinstalls only the changed app (two managed records, one whose plist already matches); (b) a no-op flip restarts nothing (`restarted: []`, both `unchanged`); (c) a user record and the platform record are never touched; (d) a no-shape record lands in `failed` with the service left installed. Drive mode via `setServeShapeDeps`. In `src/api/server.test.ts`: the route answers 200 with the body shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/api/register.test.ts src/api/server.test.ts`

- [ ] **Step 3: Implement per the Interfaces block**

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/api/register.ts src/api/server.ts src/api/register.test.ts src/api/server.test.ts
git commit -m "api: managed/reresolve selective restart on plist diff"
```

---

## Phase F: deck migration and bootstrap

### Task 13: One-time registry migration with the uptime guard

**Files:**
- Create: `src/registry/migrate-dev-shape.ts`
- Modify: `src/main.ts` (call in `serve()` after registry/boot-env are ready and before `startApi` constructs the server)
- Test: `src/registry/migrate-dev-shape.test.ts`

**Interfaces:**
- Consumes: `readDeckManifest` (Task 1), records API (Task 2).
- Produces: `export function migrateManagedDevShape(): { slimmed: string[]; skipped: string[] }`, idempotent, safe to run on every boot.

Rules (spec: Migration):
- Skip user rows.
- Platform row: if `sourceDirectory` is set and `dev` is not, move it (`dev: { workingDirectory: sourceDirectory }`, drop `sourceDirectory`, drop copied `commands`). Never touch the platform's `command`.
- Managed app row already carrying `dev`: skip (already slim or linked).
- Managed app row with a `workingDirectory` whose manifest parses, name-matches, and declares `includeInBundle: true`: slim it. This discriminator is what keeps gitq (no `includeInBundle`) and fresh-install rows (dataDir has no manifest) grandfathered.
- **UPTIME GUARD (named, spec-pinned):** the slim write must set `dev.workingDirectory` and clear the legacy source fields in the SAME `putRecord`, and an explicit assertion refuses the write otherwise, so a future edit cannot reorder the steps and reintroduce the app-down window.

```ts
import { listRecords, putRecord, type AppRecord } from "./records.ts";
import { readDeckManifest } from "./deck-manifest.ts";
import { isPlatformManagedBy } from "../services/manager.ts";

/** Uptime guard: a slim row must carry its dev
    link in the same write that clears its legacy source command, or the app
    would be left with neither a bundle nor a source to fall back to. */
export function assertSlimRowKeepsAFallback(name: string, next: AppRecord): void {
  if (!next.dev?.workingDirectory) {
    throw new Error(`migration guard: refusing to slim ${name} without dev.workingDirectory`);
  }
}

export function migrateManagedDevShape(): { slimmed: string[]; skipped: string[] } {
  const slimmed: string[] = [];
  const skipped: string[] = [];
  for (const record of listRecords()) {
    if (record.managedBy === "user") continue;
    if (isPlatformManagedBy(record.managedBy)) {
      if (record.sourceDirectory && !record.dev) {
        putRecord({ ...record, dev: { workingDirectory: record.sourceDirectory }, sourceDirectory: undefined, commands: undefined });
        slimmed.push(record.name);
      }
      continue;
    }
    if (record.dev?.workingDirectory) continue;
    const dir = record.workingDirectory;
    const parsed = dir ? readDeckManifest(dir) : null;
    if (!parsed?.ok || parsed.manifest.name !== record.name || parsed.manifest.includeInBundle !== true) {
      skipped.push(record.name);
      continue;
    }
    const next: AppRecord = {
      ...record,
      dev: { workingDirectory: dir! },
      command: undefined,
      workingDirectory: undefined,
      commands: undefined,
      sourceDirectory: undefined,
    };
    assertSlimRowKeepsAFallback(record.name, next);
    putRecord(next);
    slimmed.push(record.name);
  }
  return { slimmed, skipped };
}
```

- [ ] **Step 1: Write the failing tests**

`src/registry/migrate-dev-shape.test.ts` (registry fixture as in Task 4; export `assertSlimRowKeepsAFallback` for the last test):

```ts
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRecord, putRecord, reloadRegistry } from "./records.ts";
import { assertSlimRowKeepsAFallback, migrateManagedDevShape } from "./migrate-dev-shape.ts";
import type { AppRecord } from "./records.ts";

beforeEach(() => {
  process.env.LOCAL_REGISTRY_PATH = join(mkdtempSync(join(tmpdir(), "reg-")), "registry.json");
  reloadRegistry();
});

function row(over: Partial<AppRecord>): AppRecord {
  return { name: "chat", managedBy: "rt", port: 11002, kind: "service", label: "com.mattstack.deck.chat", createdAt: "2026-08-31", ...over };
}
function repoWith(manifest: object): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  writeFileSync(join(dir, "mattstack.deck.json"), JSON.stringify(manifest));
  return dir;
}

test("slims an old-shape bundle-ready row, and a second run is a no-op", () => {
  const dir = repoWith({ name: "chat", includeInBundle: true, dev: { start: "bun x" } });
  putRecord(row({ command: ["bun", "src/server/index.ts"], workingDirectory: dir, commands: { build: "b" } }));
  expect(migrateManagedDevShape().slimmed).toEqual(["chat"]);
  const r = getRecord("chat")!;
  expect(r.dev?.workingDirectory).toBe(dir);
  expect(r.command).toBeUndefined();
  expect(r.workingDirectory).toBeUndefined();
  expect(r.commands).toBeUndefined();
  expect(migrateManagedDevShape().slimmed).toEqual([]);
});

test("skips gitq-shaped (no includeInBundle) and fresh-install (no manifest) rows untouched", () => {
  const gitqDir = repoWith({ name: "gitq" });
  putRecord(row({ name: "gitq", command: ["/b/gitq", "board"], workingDirectory: gitqDir }));
  putRecord(row({ name: "console", command: ["/b/console"], workingDirectory: "/home/.mattstack/console" }));
  migrateManagedDevShape();
  expect(getRecord("gitq")?.command).toEqual(["/b/gitq", "board"]);
  expect(getRecord("gitq")?.dev).toBeUndefined();
  expect(getRecord("console")?.command).toEqual(["/b/console"]);
});

test("platform row: sourceDirectory moves to dev.workingDirectory, command survives", () => {
  putRecord(row({ name: "deck", managedBy: "deck", command: ["/app/deck", "serve"], sourceDirectory: "/repos/deck", commands: { deploy: "d" } }));
  migrateManagedDevShape();
  const r = getRecord("deck")!;
  expect(r.dev?.workingDirectory).toBe("/repos/deck");
  expect(r.sourceDirectory).toBeUndefined();
  expect(r.command).toEqual(["/app/deck", "serve"]);
});

test("user rows are untouched", () => {
  putRecord(row({ name: "mine", managedBy: "user", command: ["node", "s.js"], workingDirectory: "/x" }));
  migrateManagedDevShape();
  expect(getRecord("mine")?.command).toEqual(["node", "s.js"]);
  expect(getRecord("mine")?.dev).toBeUndefined();
});

test("uptime guard throws on a slim write without a dev link", () => {
  expect(() => assertSlimRowKeepsAFallback("chat", row({}))).toThrow(/refusing to slim/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/registry/migrate-dev-shape.test.ts`

- [ ] **Step 3: Implement the module and wire it into `src/main.ts` serve startup**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/`

- [ ] **Step 5: Commit**

```bash
git add src/registry/migrate-dev-shape.ts src/registry/migrate-dev-shape.test.ts src/main.ts
git commit -m "registry: slim-row migration with dev-link uptime guard"
```

### Task 14: `bootstrapSelf` self-links a checkout

**Files:**
- Modify: `src/registry/bootstrap.ts`
- Test: `src/registry/bootstrap.test.ts`

**Interfaces:**
- Consumes: `readDeckManifest` (Task 1).
- Produces: in `bootstrapSelf`'s field-patch block (after `rec.workingDirectory = stateDir()`), checkout mode self-links:

```ts
if (opts.entry) {
  // entry is <checkout>/src/main.ts; the manifest name check validates the derivation.
  const repoRoot = dirname(dirname(opts.entry));
  const parsed = readDeckManifest(repoRoot);
  if (parsed?.ok && parsed.manifest.name === PLATFORM_NAME) {
    rec.dev = { workingDirectory: repoRoot };
  }
}
```

(`dirname` is already imported from `path` in the file or add it.) A compiled-binary install (`opts.entry === null`) sets nothing; a checkout whose derivation lands somewhere without a deck manifest sets nothing. A fresh install from a checkout therefore self-links without a manual `deck register`, which is what surfaces deck's own deploy button.

- [ ] **Step 1: Write the failing test**

Extend `src/registry/bootstrap.test.ts`'s existing bootstrapSelf fixture: entry pointing into a tmp checkout containing `mattstack.deck.json` with `{ "name": "deck", "dev": { "deploy": "bun run deploy" } }` yields `getRecord("deck")?.dev?.workingDirectory === <checkout>`; a null entry yields no `dev`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/registry/bootstrap.test.ts`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/registry/bootstrap.test.ts`

- [ ] **Step 5: Commit, then run the full deck suite as the phase gate**

```bash
git add src/registry/bootstrap.ts src/registry/bootstrap.test.ts
git commit -m "bootstrap: self-link dev.workingDirectory in checkout mode"
bun test
```

Expected: full deck suite green. Fix any fallout before Phase G.

---

## Phase G: app manifests

### Task 15: `mattstack.deck.json` in chat, console, mr-board, deck

**Files (one commit per repo, on a branch per that repo's conventions):**
- Modify: `~/Documents/GitHub/chat/mattstack.deck.json`
- Modify: `~/Documents/GitHub/console/mattstack.deck.json`
- Modify: `~/Documents/GitHub/mr-board/mattstack.deck.json`
- Modify: `~/Documents/GitHub/deck/mattstack.deck.json`

**Interfaces:**
- Consumes: the Task 1 schema. The final shapes (keep each file's existing `displayName`/`description`/`icon` lines verbatim; only the fields shown change):

chat:

```jsonc
{
  "name": "chat",
  "port": 11002,
  "includeInBundle": true,
  "dev": {
    "start": "bun src/server/index.ts",
    "build": "bun run build",
    "deploy": "bun install && bun run build && deck restart chat"
  }
}
```

console: same transform (`start`: `bun run src/server/index.ts`, `build`: `bun run build`, `deploy`: `bun run build && deck restart console`, port 11001).

mr-board (`name` is `board`): `start`: `caffeinate -s bun src/server.ts`, `build`: `bun run build`, `deploy`: `bun run build && deck restart board`, port 11006, `includeInBundle: true`.

deck (no `includeInBundle`, no `dev.start`; deck refuses to run from source):

```jsonc
{
  "name": "deck",
  "dev": {
    "deploy": "bun run deploy"
  }
}
```

The top-level `commands` block is removed in all four (its `start`/`build`/`deploy` move under `dev`); each app's existing `deploy` string is carried over verbatim from its current `commands.deploy`, not re-derived. Transition caveat to note in each commit body: an old deck binary reading the new manifest sees no `commands.start`, so a manual `deck register` against an OLD deck would register the app as route-only; the deck release from Phases A-F deploys first in the natural order, and the resolver makes any other order safe for serving (spec: Rollout sequencing).

- [ ] **Step 1: Edit the four manifests to the exact shapes above**

- [ ] **Step 2: Validate each parses under the new deck schema**

From the deck repo:

```bash
bun -e 'import { readDeckManifest } from "./src/registry/deck-manifest.ts";
for (const d of ["../chat", "../console", "../mr-board", "."]) {
  const p = readDeckManifest(d);
  if (!p?.ok) throw new Error(d + ": " + JSON.stringify(p));
  console.log(d, "ok", p.manifest.name);
}'
```

Expected: four `ok` lines.

- [ ] **Step 3: Commit in each repo**

```bash
# in each of chat, console, mr-board, deck:
git add mattstack.deck.json
git commit -m "manifest: move serve/build/deploy under dev node (RT-94)"
```

---

## Phase H: rt

### Task 16: rt setup registers chat

**Files (repo-tools, branch `feat/rt-94-deck-dev-mode`):**
- Modify: `lib/setup/steps/deck.ts`
- Test: `lib/setup/__tests__/steps-b.test.ts` (the suite covering `deckManagedRun`)

**Interfaces:**
- Consumes: nothing new; `registerManagedApp(ctx, deckBin, name)` already exists in the file and is bundled-gated (`bundledToolPath` returns null until chat ships in the bundle, so this is a no-op that reports "not bundled" until the CI-bundling work lands, exactly like console/gitq today).
- Produces: chat included in the step's detail string.

- [ ] **Step 1: Write the failing test**

Mirror the existing console/gitq assertions in the step's test: a fake `ctx.p` whose `bundledToolPath` yields a path for `chat` sees a `deck add chat --cmd <bin> --dir <home>/.mattstack/chat` exec followed by the adopt exec; the outcome detail mentions chat.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/setup/steps/`

- [ ] **Step 3: Implement**

In `deckManagedRun`:

```ts
  const gitqDetail = await registerManagedApp(ctx, deckBin, "gitq", ["board"]);
  const consoleDetail = await registerManagedApp(ctx, deckBin, "console");
  const chatDetail = await registerManagedApp(ctx, deckBin, "chat");

  return { state: "done", detail: `${boardDetail}; ${gitqDetail}; ${consoleDetail}; ${chatDetail}` };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/setup/steps/`

- [ ] **Step 5: Commit**

```bash
git add lib/setup/steps/deck.ts lib/setup/__tests__/steps-b.test.ts
git commit -m "setup: register chat as a managed deck app"
```

### Task 17: `rt settings dev-mode` pokes deck's reresolve

**Files:**
- Modify: `commands/settings.ts` (`toggleDevMode`)
- Test: `commands/__tests__/settings-deck-poke.test.ts` (create; or fold into the existing settings test file if one covers `toggleDevMode`)

**Interfaces:**
- Consumes: deck's `POST /api/v1/apps/managed/reresolve` (Task 12) and its response body `{ restarted, unchanged, failed }`.
- Produces:

```ts
export async function pokeDeckReresolve(
  deps: {
    readApiFile?: () => string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<string>
```

returning a one-line human summary, never throwing. Implementation:

```ts
export async function pokeDeckReresolve(deps: {
  readApiFile?: () => string | null;
  fetchImpl?: typeof fetch;
} = {}): Promise<string> {
  const read = deps.readApiFile ?? (() => {
    try {
      return readFileSync(join(process.env.HOME ?? homedir(), ".mattstack", "deck", "api.json"), "utf8");
    } catch {
      return null;
    }
  });
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const raw = read();
    if (raw === null) return "deck not poked (no api.json); managed apps follow on their next resolve";
    const port = (JSON.parse(raw) as { port?: unknown }).port;
    if (typeof port !== "number") return "deck not poked (bad api.json); managed apps follow on their next resolve";
    const res = await doFetch(`http://127.0.0.1:${port}/api/v1/apps/managed/reresolve`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `deck answered ${res.status} on reresolve; managed apps follow on their next resolve`;
    const body = (await res.json()) as { restarted?: string[]; unchanged?: string[]; failed?: Array<{ name: string; error: string }> };
    const restarted = body.restarted ?? [];
    const failed = body.failed ?? [];
    const parts = [`${restarted.length} restarted`, `${(body.unchanged ?? []).length} unchanged`];
    if (failed.length) parts.push(`${failed.length} failed (${failed.map((f) => f.name).join(", ")})`);
    return `deck re-resolved managed apps: ${parts.join(", ")}`;
  } catch (e) {
    return `deck not poked (${(e as Error).message}); managed apps follow on their next resolve`;
  }
}
```

In `toggleDevMode`, after `handoffToFlavor(...)` in BOTH the dev and prod branches:

```ts
console.log(`  ${dim}${await pokeDeckReresolve()}${reset}`);
```

This is the whole "rt setup and dev-mode enable" contract for the toggle: deck's resolver does the per-app confirm/fail-closed work and its `failed` list is the surfaced one-line note; unlinked apps come back `unchanged` (still bundled).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { pokeDeckReresolve } from "../settings.ts";

describe("pokeDeckReresolve", () => {
  test("summarizes a successful reresolve", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => Response.json({ restarted: ["chat"], unchanged: ["console"], failed: [] })) as typeof fetch,
    });
    expect(msg).toContain("1 restarted");
    expect(msg).toContain("1 unchanged");
  });
  test("degrades to a note when deck is not reachable", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch,
    });
    expect(msg).toContain("not poked");
  });
  test("degrades when api.json is absent", async () => {
    expect(await pokeDeckReresolve({ readApiFile: () => null })).toContain("no api.json");
  });
  test("names failed apps", async () => {
    const msg = await pokeDeckReresolve({
      readApiFile: () => JSON.stringify({ port: 4141 }),
      fetchImpl: (async () => Response.json({ restarted: [], unchanged: [], failed: [{ name: "chat", error: "x" }] })) as typeof fetch,
    });
    expect(msg).toContain("chat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test commands/__tests__/settings-deck-poke.test.ts`
Expected: FAIL (`pokeDeckReresolve` not exported).

- [ ] **Step 3: Implement and wire into both toggle branches**

- [ ] **Step 4: Run tests and the repo gates**

Run: `bun test commands/ lib/__tests__/no-ui-in-cli.test.ts lib/__tests__/no-eager-tui.test.ts && bun run picker:check`
Expected: PASS (no new command nodes, so picker conformance is untouched; the poke adds no UI or eager imports).

- [ ] **Step 5: Commit**

```bash
git add commands/settings.ts commands/__tests__/settings-deck-poke.test.ts
git commit -m "settings: dev-mode toggle pokes deck managed/reresolve"
```

---

## Phase I: verification

### Task 18: Cross-repo verification against the spec

**Files:** none (verification only).

- [ ] **Step 1: Full deck suite**

Run in `~/Documents/GitHub/deck`: `bun test`
Expected: green.

- [ ] **Step 2: Full rt-relevant suite**

Run in repo-tools: `bun test commands/ lib/`
Expected: green. (Do not run any built binary; do not start a daemon or a second deck.)

- [ ] **Step 3: Spec matrix walk**

Re-read the spec's "Testing surface" section and confirm each bullet maps to a committed test: resolver matrix (Task 4), no-phantom-bundle (Task 4), issue lifecycle (Task 4), command-route gating incl. deck-self and grandfathered rows (Task 6), live-read no-drift (Task 6), selective restart no-op flip (Task 12), link validation via CLI and PATCH (Tasks 9-10), migration incl. deck's `sourceDirectory` move, gitq skip, and user-row untouched (Task 13). Any bullet without a pointing test gets its test added now, in the task's file, before this step is checked off.

- [ ] **Step 4: Deployment notes (hand-off, not executed here)**

Record in the final report, not in code: the live daemon/deck on this machine keep running old code until Matt drives a main sync + restart; the migration runs at deck's next serve boot; the `includeInBundle` field name is still provisional pending fox (the parser treats it as optional, so a rename is a two-line follow-up in `deck-manifest.ts` plus the four manifests).

---

## Execution order and cross-repo notes

- Phases A-F are deck-repo work and land as one deck branch/PR; tasks are strictly ordered within phases (each consumes the previous task's exports), but Phase C (6-8) and Phase D (9-10) may swap as blocks if convenient. Phase E depends on Tasks 4-5 only.
- Phase G (manifests) and Phase H (rt) are independent of each other; both should land after the deck work exists, but the spec's Rollout section makes any order safe for serving correctness (the resolver never selects a bundle that is not installed, and grandfathered rows keep today's behavior verbatim).
- The migration-ordering uptime guard is Task 13's `assertSlimRowKeepsAFallback`; it is a named, tested assertion precisely so a future refactor cannot separate "set the link" from "clear the legacy command".
- gitq and boxscore are out of scope by spec: no manifest edits, no migration, no resolver derivation for them; their rows ride the grandfathered branch untouched.
