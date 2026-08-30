# rt-ui bridge (phases 0 + 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Ink-rendered rt screen with a bundled Go helper (`rt-ui`) driven over NDJSON, delete `rt status` and the rezi kit, and remove Ink/React from the bundle, with zero change to any non-interactive path.

**Architecture:** TS stays the entrypoint and spawns `rt-ui` lazily on a TTY; the child renders on `/dev/tty` while stdin/stdout carry a one-line-per-message JSON protocol. Two verbs ship in this plan: `prompt` (stateless, one spawn per prompt) and `steps` (one spawn per step, write-only tty). The TS facade (`select`, `multiselect`, `confirm`, `textInput`, `createStepRunner`, `withSpinner`) keeps its signatures; only its implementation becomes a spawn.

**Tech Stack:** Bun 1.3.13 + TypeScript (rt); Go 1.26 with `charm.land/bubbletea/v2` v2.0.9, `charm.land/lipgloss/v2` v2.0.6, `charm.land/bubbles/v2` v2.2.1, `charm.land/huh/v2` v2.0.3, `github.com/creack/pty` (tests only).

**Spec:** `docs/superpowers/specs/2026-08-29-rt-ui-bridge-design.md` (this plan implements its phases 0 and 1; phase 2, the `session` verb and the runner board, is `2026-08-29-rt-runner-design.md` and gets its own plan).

## Global Constraints

- Protocol version is `1`. Every prompt spec carries `"protocol": 1`; every steps stream starts with `{"t":"hello","protocol":1}`.
- Exit codes: `0` answered/done · `130` cancelled (Esc, Ctrl-C) · `131` back · `2` bad spec / protocol mismatch · `70` internal failure. Nothing on stderr except the `2`/`70` message, and the single `first-paint <ms>` line when `RT_UI_BENCH=1`.
- `rt-ui` is never spawned unless `process.stdin.isTTY && !json && !process.env.RT_BATCH`; every non-TTY / `--json` path stays byte-identical.
- TS keeps the child's stdin open until the child exits (stdin EOF means "the brain died"). Go ignores `SIGPIPE` and treats any stdout write error as EOF.
- Theme values are exactly `lib/tui/palette.ts` (`#161224 #1C162C #37284B #2A2033 #FF6B9D #FF9EC0 #62E6A8 #FF7979 #FFB77A #5AAAFF #BD93F9 #E6E0FF #D2CDEB #A8A0C6 #8B84A8 #6E668C #2A2340 #34304E`); glyphs `● ○ ✗ ▌ ❯ ◉ ✓ ⚠ ↩`; braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠣⠏` at 80 ms.
- Go module path is `rt-ui`; import paths are `charm.land/...` (NOT `github.com/charmbracelet/...`); `CGO_ENABLED=0`.
- Build output is always `ui/dist/rt-ui` (gitignored) via `bun run ui:build`.
- Never use em dashes or en dashes anywhere (code, comments, docs, commit messages). Never write the phrase "load bearing".
- Comments state constraints the code cannot show; never narrate the next line, never cite review findings or task numbers.
- Commit after every task with a short imperative message ending in `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- TS checks: `bunx tsc --noEmit`, `bun test lib commands packages scripts`, `bun run docs:check`, `bun run picker:check`. Go checks: `cd ui && go vet ./... && go test ./...`.
- Never run a compiled `dist/rt` outside an isolated `HOME` (`env -i HOME=<tmp> ...`); tests run under the bunfig preload's isolated HOME already.
- When a Charm method name in this plan does not match the installed module, `go doc charm.land/<module>/v2 <Symbol>` is the reference; the tests in each task define the contract that must hold.

---

## File structure

**TypeScript (rt)**

| file | responsibility |
|---|---|
| `lib/ui/protocol.ts` | Message types for `prompt` and `steps` (specs, results, events); a `PROTOCOL_VERSION` const. |
| `lib/ui/resolve.ts` | Find the `rt-ui` binary: `RT_UI_BIN` → source checkout `ui/dist/rt-ui` → bundle `Contents/Helpers/rt-ui` → PATH → error. Injectable probes. |
| `lib/ui/spawn.ts` | `runPrompt(spec)` and `openStep(title)`: spawn, keep stdin open, map exit codes, kill on process exit. |
| `lib/ui/prompts.ts` | The facade: `select`, `multiselect`, `confirm`, `textInput` (same signatures as today, plus `confirm({ destructive })`). |
| `lib/ui/steps.ts` | `createStepRunner()` and `withSpinner()` on `openStep`; `log()` lines in palette truecolor. |
| `lib/rt-render.tsx` | Becomes an Ink-free re-export shim of `lib/ui/*` + `lib/fzf-select.ts`. |
| `lib/ui/__tests__/fake-rt-ui.ts` | Executable fake speaking the protocol with scripted answers (`RT_UI_BIN`). |
| `lib/ui/__tests__/*.test.ts` | protocol fixtures, resolve ladder, spawn exit-code mapping, facade spec assertions, steps. |
| `lib/tui/palette.ts` | Gains `SPINNER_FRAMES` (moved from the deleted `theme.ts`). |

**Go (`ui/`)**

| file | responsibility |
|---|---|
| `ui/go.mod`, `ui/go.sum` | module `rt-ui`, Go 1.26, charm.land v2 pins, creack/pty for tests. |
| `ui/cmd/rt-ui/main.go` | Verb dispatch (`prompt`, `steps`, `--version`), SIGPIPE ignore, exit codes. |
| `ui/internal/protocol/protocol.go` | Wire types + one-line JSON decode/encode; fixture golden test. |
| `ui/internal/theme/theme.go` | Palette, glyphs, spinner frames, lipgloss styles, the huh `Theme`. |
| `ui/internal/tty/tty.go` | Open `/dev/tty` (rw or write-only), stdin EOF watcher, bench first-paint hook. |
| `ui/internal/prompt/prompt.go` | The four prompt kinds on huh: card, header, back row, Esc/ctrl-c/ctrl-up mapping, collapse line. |
| `ui/internal/steps/steps.go` | One-step renderer: spinner, `log` above, `done`/`fail` line, EOF = interrupted, fast-step no-flash. |
| `ui/fixtures/*.json` | Shared protocol fixtures (also read by the TS test). |
| `ui/internal/*/…_test.go` | Black-box tests: build the binary once, run under a pty, drive keys, assert stdout JSON, exit code, tty bytes. |

**Deleted**

`commands/status/` (whole dir), `website/docs/reference/status.mdx` (regenerated), `lib/tui/atoms/`, `lib/tui/molecules/`, `lib/tui/hooks/`, `lib/tui/tmux/`, `lib/tui/utils/groups.ts`, `lib/tui/utils/modal.ts`, `lib/tui/theme.ts`, `lib/tui/index.ts`, `lib/tui/SKILL.md`. Kept: `lib/tui/palette.ts`, `lib/tui/inline-spinner.ts`, `lib/tui/utils/label.ts`. Dependencies removed from `package.json`: `ink`, `react`, `@inkjs/ui`, `@rezi-ui/core`, `@rezi-ui/jsx`, `@rezi-ui/node`, `@types/react`, `react-devtools-core`.

**Wiring touched**

`lib/command-tree-def.ts` (drop `status`), `lib/module-registry.ts` (drop status), `lib/__tests__/no-eager-tui.test.ts` (drop the status exemption; add `spawn.ts` to the daemon-graph banned basenames), `package.json` (`ui:build` script, deps), `.gitignore` (`ui/dist/`), `.github/workflows/checks.yml` (Go vet + test), `.github/workflows/release.yml` (setup-go + `ui:build`), `rt-tray/build.sh` (copy + sign `rt-ui`), `rt-tray/check-bundle.sh` (assert `rt-ui`), `CLAUDE.md` (pointer to the spec).

---

## Phase 0

### Task 1: Delete `rt status`

**Files:**
- Delete: `commands/status/` (all files, including `__tests__/`)
- Modify: `lib/command-tree-def.ts:463-473`, `lib/module-registry.ts:38`, `lib/__tests__/no-eager-tui.test.ts:22-43`, `lib/setup/__tests__/validators-rt-health.test.ts:399-406`
- Regenerate: `website/docs/reference/` via `bun run docs:gen`

**Interfaces:**
- Consumes: nothing.
- Produces: a tree with no `status` node; the no-eager-tui test no longer exempts a `status` directory.

- [ ] **Step 1: Confirm the only importers of `commands/status` are the tree, the registry, and the tree's own docs**

Run: `grep -rn 'commands/status' lib commands cli.ts scripts --include='*.ts' --include='*.tsx' | grep -v '^commands/status/'`
Expected: exactly these hits: `lib/command-tree-def.ts` (the `module:` line), `lib/module-registry.ts` (one line), comment-only mentions in `lib/tui/utils/label.ts`, `lib/tui/hooks/use-spinner.ts`, `lib/tui/hooks/use-terminal-width.ts`, and `lib/setup/__tests__/validators-rt-health.test.ts` (a comment). Anything else is a real importer and must be dealt with before deleting.

- [ ] **Step 2: Delete the command directory**

Run: `git rm -r -q commands/status`

- [ ] **Step 3: Remove the tree node**

In `lib/command-tree-def.ts`, delete the whole `status: { ... },` block (the one whose `module` is `"./commands/status/index.tsx"`, currently lines 463-473).

- [ ] **Step 4: Remove the registry entry**

In `lib/module-registry.ts`, delete the line:
```ts
  "./commands/status/index.tsx": () => import("../commands/status/index.tsx"),
```

- [ ] **Step 5: Drop the status exemption from the no-eager-tui test**

In `lib/__tests__/no-eager-tui.test.ts`, change the second test's name and remove the directory skip:

```ts
test("no command module has a static value import of rt-render or ink", () => {
  const commandsDir = resolve(import.meta.dir, "..", "..", "commands");

  function collectFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }
```
(Keep the rest of that test body as it is.)

- [ ] **Step 6: Fix the stale comment in the rt-health test**

In `lib/setup/__tests__/validators-rt-health.test.ts`, replace the doc comment above the `describe` whose name starts with `rtHealthRows` and ends with `tool.daemon` with:

```ts
/**
 * DAEMON_CONFIG_PATH is a module-load const bound under the shared preload
 * HOME (see lib/daemon-config.ts's own comment on RT_DIR). Save/restore
 * whatever was there before this describe ran rather than just deleting on
 * afterEach, so this file can never leave that fixture in a state a
 * different test file didn't expect.
 */
```

- [ ] **Step 7: Regenerate the command reference and check the gates**

Run: `bun run docs:gen && bunx tsc --noEmit && bun test lib commands packages scripts && bun run docs:check && bun run picker:check`
Expected: `website/docs/reference/status.mdx` is deleted by the generator (if it is not, `git rm website/docs/reference/status.mdx`), tsc reports 0 errors, all suites pass, both checks pass.

- [ ] **Step 8: Commit**

```bash
git add -A commands/status lib/command-tree-def.ts lib/module-registry.ts lib/__tests__/no-eager-tui.test.ts lib/setup/__tests__/validators-rt-health.test.ts website/docs/reference
git commit -m "delete rt status (unused Ink dashboard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2: Prune `lib/tui` to its non-Ink survivors and drop rezi

**Files:**
- Delete: `lib/tui/atoms/`, `lib/tui/molecules/`, `lib/tui/hooks/`, `lib/tui/tmux/`, `lib/tui/utils/groups.ts`, `lib/tui/utils/modal.ts`, `lib/tui/theme.ts`, `lib/tui/index.ts`, `lib/tui/SKILL.md`
- Modify: `lib/tui/palette.ts`, `lib/tui/inline-spinner.ts:16`, `lib/tui.ts:6`, `package.json`

**Interfaces:**
- Produces: `SPINNER_FRAMES` exported from `lib/tui/palette.ts` as `readonly string[]`.

- [ ] **Step 1: Write the failing test for the moved spinner frames**

Create `lib/tui/__tests__/palette.test.ts`:

```ts
import { test, expect } from "bun:test";
import { SPINNER_FRAMES, T, toHex } from "../palette.ts";

test("SPINNER_FRAMES is the ten-frame braille cycle the theme uses", () => {
  expect([...SPINNER_FRAMES].join("")).toBe("⠋⠙⠹⠸⠼⠴⠦⠧⠣⠏");
});

test("palette hexes match the rt-ui token sheet", () => {
  expect(toHex(T.pink)).toBe("#FF6B9D");
  expect(toHex(T.mint)).toBe("#62E6A8");
  expect(toHex(T.bgBase)).toBe("#161224");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test lib/tui/__tests__/palette.test.ts`
Expected: FAIL, `SPINNER_FRAMES` is not exported from `../palette.ts`.

- [ ] **Step 3: Move `SPINNER_FRAMES` into palette.ts**

Append to `lib/tui/palette.ts`:

```ts
/** Braille spinner frames; advance every 80 ms. Shared by the inline spinner and the rt-ui theme. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"] as const;
```

In `lib/tui/inline-spinner.ts`, change the import on line 16 from `import { SPINNER_FRAMES } from "./theme.ts";` to `import { SPINNER_FRAMES } from "./palette.ts";`, and in its doc comment delete the two sentences that point at `withSpinner` from `lib/rt-render.tsx` and `useSpinnerFrame` (they are being replaced; the comment must not name dead modules).

- [ ] **Step 4: Delete the Ink/rezi kit**

Run:
```bash
git rm -r -q lib/tui/atoms lib/tui/molecules lib/tui/hooks lib/tui/tmux lib/tui/utils/groups.ts lib/tui/utils/modal.ts lib/tui/theme.ts lib/tui/index.ts lib/tui/SKILL.md
```

In `lib/tui.ts`, delete the doc-comment line `* For Rezi/Ink UI components, import from "../lib/tui/index.ts".`

- [ ] **Step 5: Remove the rezi dependencies**

In `package.json` `dependencies`, delete the three `@rezi-ui/core`, `@rezi-ui/jsx`, `@rezi-ui/node` entries. Then run `bun install` so `bun.lock` updates.

- [ ] **Step 6: Run the gates**

Run: `bun test lib/tui/__tests__/palette.test.ts && bunx tsc --noEmit && bun test lib commands packages scripts`
Expected: all pass; tsc 0 errors (if tsc names an importer of a deleted file, that importer was missed in the Task 1 survey; fix it by pointing it at `palette.ts`/`inline-spinner.ts`/`utils/label.ts` or deleting the dead import).

- [ ] **Step 7: Commit**

```bash
git add -A lib/tui lib/tui.ts package.json bun.lock
git commit -m "prune lib/tui to palette, inline-spinner, label; drop @rezi-ui

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1

### Task 3: Protocol fixtures and the TS protocol types

**Files:**
- Create: `ui/fixtures/prompt-select.json`, `ui/fixtures/prompt-multiselect.json`, `ui/fixtures/prompt-confirm.json`, `ui/fixtures/prompt-text.json`, `ui/fixtures/result-select.json`, `ui/fixtures/result-multiselect.json`, `ui/fixtures/result-confirm.json`, `ui/fixtures/result-text.json`, `ui/fixtures/steps-stream.json`
- Create: `lib/ui/protocol.ts`, `lib/ui/__tests__/protocol.test.ts`

**Interfaces:**
- Produces (TS): `PROTOCOL_VERSION = 1`; types `PromptSpec`, `PromptResult`, `StepEvent`; `parsePromptResult(line: string): PromptResult`; `encodeLine(msg: object): string`.

- [ ] **Step 1: Write the fixtures**

`ui/fixtures/prompt-select.json`:
```json
{ "t": "prompt", "protocol": 1, "kind": "select", "title": "Access duration", "hint": "how long the grant lasts",
  "options": [
    { "value": "1h", "label": "1 hour", "hint": "default" },
    { "value": "4h", "label": "4 hours" },
    { "value": "24h", "label": "24 hours", "hint": "requires approval reason" }
  ],
  "initial": "1h", "back": { "label": "back to resources" } }
```

`ui/fixtures/prompt-multiselect.json`:
```json
{ "t": "prompt", "protocol": 1, "kind": "multiselect", "title": "Disable which hooks?",
  "options": [
    { "value": "pre-commit", "label": "pre-commit", "hint": "lint-staged" },
    { "value": "pre-push", "label": "pre-push", "hint": "bun test" },
    { "value": "commit-msg", "label": "commit-msg", "hint": "commitlint" }
  ],
  "initial": ["pre-commit"] }
```

`ui/fixtures/prompt-confirm.json`:
```json
{ "t": "prompt", "protocol": 1, "kind": "confirm", "message": "Run sdm login now?", "default": true, "destructive": false }
```

`ui/fixtures/prompt-text.json`:
```json
{ "t": "prompt", "protocol": 1, "kind": "text", "title": "Plugin name", "hint": "kebab-case", "placeholder": "my-plugin",
  "validate": { "pattern": "^[a-z0-9-]+$", "message": "must be kebab-case: lowercase letters, digits, dashes" } }
```

`ui/fixtures/result-select.json`: `{ "t": "result", "value": "1h" }`
`ui/fixtures/result-multiselect.json`: `{ "t": "result", "values": ["pre-commit", "pre-push"] }`
`ui/fixtures/result-confirm.json`: `{ "t": "result", "ok": true }`
`ui/fixtures/result-text.json`: `{ "t": "result", "text": "linear-tools" }`

`ui/fixtures/steps-stream.json` (an array; each element is one line of a steps stream):
```json
[
  { "t": "hello", "protocol": 1 },
  { "t": "start", "title": "fetching origin…" },
  { "t": "log", "level": "warn", "text": "diverged from origin/main" },
  { "t": "done", "title": "origin fetched", "hint": "3 new commits" }
]
```

- [ ] **Step 2: Write the failing TS test**

`lib/ui/__tests__/protocol.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { PROTOCOL_VERSION, encodeLine, parsePromptResult, type PromptSpec, type StepEvent } from "../protocol.ts";

const FIXTURES = resolve(import.meta.dir, "..", "..", "..", "ui", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

test("protocol version is 1 and every prompt fixture carries it", () => {
  expect(PROTOCOL_VERSION).toBe(1);
  for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith("prompt-"))) {
    const spec = fixture(f) as PromptSpec;
    expect(spec.t).toBe("prompt");
    expect(spec.protocol).toBe(1);
  }
});

test("prompt specs round-trip through encodeLine byte-for-byte as one line", () => {
  for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith("prompt-"))) {
    const spec = fixture(f) as PromptSpec;
    const line = encodeLine(spec);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(spec);
  }
});

test("parsePromptResult accepts every result fixture and rejects junk", () => {
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-select.json"), "utf8"))).toEqual({ t: "result", value: "1h" });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-multiselect.json"), "utf8"))).toEqual({ t: "result", values: ["pre-commit", "pre-push"] });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-confirm.json"), "utf8"))).toEqual({ t: "result", ok: true });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-text.json"), "utf8"))).toEqual({ t: "result", text: "linear-tools" });
  expect(() => parsePromptResult("not json")).toThrow(/rt-ui result/);
  expect(() => parsePromptResult('{"t":"nope"}')).toThrow(/rt-ui result/);
});

test("steps stream fixture is a hello followed by typed events", () => {
  const events = fixture("steps-stream.json") as StepEvent[];
  expect(events[0]).toEqual({ t: "hello", protocol: 1 });
  expect(events.map((e) => e.t)).toEqual(["hello", "start", "log", "done"]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test lib/ui/__tests__/protocol.test.ts`
Expected: FAIL, cannot resolve `../protocol.ts`.

- [ ] **Step 4: Write `lib/ui/protocol.ts`**

```ts
/**
 * Wire types for the rt-ui bridge. One JSON object per line, UTF-8. The
 * same shapes are golden-tested from Go against ui/fixtures/*.json; a
 * change here without a fixture change is a contract break.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

interface PromptBase {
  t: "prompt";
  protocol: typeof PROTOCOL_VERSION;
  /** Domain text only: a description, or the validation message a re-prompt carries. Go composes the keybind header itself. */
  hint?: string;
}

export interface SelectSpec extends PromptBase {
  kind: "select";
  title: string;
  options: PromptOption[];
  initial?: string;
  back?: { label: string };
}

export interface MultiselectSpec extends PromptBase {
  kind: "multiselect";
  title: string;
  options: PromptOption[];
  initial?: string[];
  min?: number;
  max?: number;
}

export interface ConfirmSpec extends PromptBase {
  kind: "confirm";
  message: string;
  default?: boolean;
  destructive?: boolean;
}

export interface TextSpec extends PromptBase {
  kind: "text";
  title: string;
  placeholder?: string;
  initial?: string;
  validate?: { pattern: string; message: string };
}

export type PromptSpec = SelectSpec | MultiselectSpec | ConfirmSpec | TextSpec;

export type PromptResult =
  | { t: "result"; value: string }
  | { t: "result"; values: string[] }
  | { t: "result"; ok: boolean }
  | { t: "result"; text: string };

export type StepLevel = "info" | "warn" | "error" | "success";

export type StepEvent =
  | { t: "hello"; protocol: typeof PROTOCOL_VERSION }
  | { t: "start"; title: string }
  | { t: "log"; level: StepLevel; text: string }
  | { t: "done"; title: string; hint?: string }
  | { t: "fail"; title: string; hint?: string };

export function encodeLine(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

export function parsePromptResult(line: string): PromptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    throw new Error(`rt-ui result: not JSON: ${line.slice(0, 120)}`);
  }
  const r = parsed as Record<string, unknown>;
  if (r?.t !== "result") throw new Error(`rt-ui result: unexpected message ${line.slice(0, 120)}`);
  if (typeof r.value === "string") return { t: "result", value: r.value };
  if (Array.isArray(r.values)) return { t: "result", values: r.values.map(String) };
  if (typeof r.ok === "boolean") return { t: "result", ok: r.ok };
  if (typeof r.text === "string") return { t: "result", text: r.text };
  throw new Error(`rt-ui result: no value/values/ok/text in ${line.slice(0, 120)}`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test lib/ui/__tests__/protocol.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/fixtures lib/ui/protocol.ts lib/ui/__tests__/protocol.test.ts
git commit -m "add rt-ui protocol fixtures and TS wire types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: Go module bootstrap: protocol package, verb dispatch, `ui:build`

**Files:**
- Create: `ui/go.mod`, `ui/internal/protocol/protocol.go`, `ui/internal/protocol/protocol_test.go`, `ui/cmd/rt-ui/main.go`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces (Go): package `protocol` with `Version = 1`, `PromptSpec`, `Option`, `Result`, `StepEvent`, `ReadLine(r *bufio.Reader) ([]byte, error)`, `DecodePrompt([]byte) (PromptSpec, error)`, `EncodeResult(Result) []byte`; `main` with exit codes `ExitOK=0 ExitCancel=130 ExitBack=131 ExitBadSpec=2 ExitInternal=70`.
- Produces (repo): `bun run ui:build` writes `ui/dist/rt-ui`.

- [ ] **Step 1: Initialize the module**

Run:
```bash
mkdir -p ui/cmd/rt-ui ui/internal/protocol && cd ui && go mod init rt-ui && GOFLAGS=-mod=mod go get charm.land/bubbletea/v2@v2.0.9 charm.land/lipgloss/v2@v2.0.6 charm.land/bubbles/v2@v2.2.1 charm.land/huh/v2@v2.0.3 github.com/charmbracelet/colorprofile@v0.4.3 github.com/creack/pty@latest && cd ..
```
Expected: `ui/go.mod` lists those modules; `go 1.26` line present.

- [ ] **Step 2: Write the failing Go fixture test**

`ui/internal/protocol/protocol_test.go`:

```go
package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func canonical(t *testing.T, b []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}

func TestPromptFixturesDecodeAndReencode(t *testing.T) {
	for _, name := range []string{"prompt-select.json", "prompt-multiselect.json", "prompt-confirm.json", "prompt-text.json"} {
		raw := fixture(t, name)
		spec, err := DecodePrompt(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if spec.Protocol != Version {
			t.Fatalf("%s: protocol %d", name, spec.Protocol)
		}
		back, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		if canonical(t, back) != canonical(t, raw) {
			t.Fatalf("%s: re-encode drift\n got %s\nwant %s", name, back, raw)
		}
	}
}

func TestDecodePromptRejectsWrongProtocolAndKind(t *testing.T) {
	if _, err := DecodePrompt([]byte(`{"t":"prompt","protocol":2,"kind":"select","title":"x","options":[]}`)); err == nil {
		t.Fatal("protocol 2 accepted")
	}
	if _, err := DecodePrompt([]byte(`{"t":"prompt","protocol":1,"kind":"slider"}`)); err == nil {
		t.Fatal("unknown kind accepted")
	}
	if _, err := DecodePrompt([]byte(`{"t":"nope"}`)); err == nil {
		t.Fatal("wrong t accepted")
	}
}

func TestResultFixturesMatchEncodeResult(t *testing.T) {
	cases := map[string]Result{
		"result-select.json":      {Value: strPtr("1h")},
		"result-multiselect.json": {Values: []string{"pre-commit", "pre-push"}},
		"result-confirm.json":     {OK: boolPtr(true)},
		"result-text.json":        {Text: strPtr("linear-tools")},
	}
	for name, r := range cases {
		got := EncodeResult(r)
		if !bytes.HasSuffix(got, []byte("\n")) {
			t.Fatalf("%s: no trailing newline", name)
		}
		if canonical(t, got) != canonical(t, fixture(t, name)) {
			t.Fatalf("%s: got %s", name, got)
		}
	}
}

func TestStepsFixtureDecodes(t *testing.T) {
	var lines []json.RawMessage
	if err := json.Unmarshal(fixture(t, "steps-stream.json"), &lines); err != nil {
		t.Fatal(err)
	}
	want := []string{"hello", "start", "log", "done"}
	for i, raw := range lines {
		ev, err := DecodeStep(raw)
		if err != nil {
			t.Fatal(err)
		}
		if ev.T != want[i] {
			t.Fatalf("line %d: t=%q want %q", i, ev.T, want[i])
		}
	}
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ui && go test ./internal/protocol/`
Expected: FAIL to compile (undefined `DecodePrompt`, `Result`, ...).

- [ ] **Step 4: Write `ui/internal/protocol/protocol.go`**

```go
// Package protocol is the rt-ui wire contract: one JSON object per line.
// Field names and shapes are frozen by ui/fixtures/*.json, which the TS side
// tests against too; change both or neither.
package protocol

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
)

const Version = 1

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Hint  string `json:"hint,omitempty"`
}

type Back struct {
	Label string `json:"label"`
}

type Validate struct {
	Pattern string `json:"pattern"`
	Message string `json:"message"`
}

// PromptSpec is the union of the four kinds; unused fields stay zero and
// are omitted on re-encode so fixtures round-trip byte-for-byte.
type PromptSpec struct {
	T        string `json:"t"`
	Protocol int    `json:"protocol"`
	Kind     string `json:"kind"`
	Hint     string `json:"hint,omitempty"`

	// select, multiselect, text
	Title   string   `json:"title,omitempty"`
	Options []Option `json:"options,omitempty"`

	// select
	Initial string `json:"initial,omitempty"`
	Back    *Back  `json:"back,omitempty"`

	// multiselect
	InitialMany []string `json:"-"`
	Min         *int     `json:"min,omitempty"`
	Max         *int     `json:"max,omitempty"`

	// confirm
	Message     string `json:"message,omitempty"`
	Default     *bool  `json:"default,omitempty"`
	Destructive *bool  `json:"destructive,omitempty"`

	// text
	Placeholder string    `json:"placeholder,omitempty"`
	Validate    *Validate `json:"validate,omitempty"`
}

// initial is a string for select/text and a string array for multiselect;
// the custom (un)marshal keeps one struct while honoring both fixtures.
func (p *PromptSpec) UnmarshalJSON(b []byte) error {
	type alias PromptSpec
	var a alias
	var raw struct {
		Initial json.RawMessage `json:"initial"`
	}
	if err := json.Unmarshal(b, &a); err != nil {
		// a multiselect initial is an array, which the string field rejects
		var probe map[string]json.RawMessage
		if err2 := json.Unmarshal(b, &probe); err2 != nil {
			return err
		}
		delete(probe, "initial")
		stripped, _ := json.Marshal(probe)
		if err3 := json.Unmarshal(stripped, &a); err3 != nil {
			return err3
		}
	}
	if err := json.Unmarshal(b, &raw); err == nil && len(raw.Initial) > 0 && raw.Initial[0] == '[' {
		if err := json.Unmarshal(raw.Initial, &a.InitialMany); err != nil {
			return err
		}
		a.Initial = ""
	}
	*p = PromptSpec(a)
	return nil
}

func (p PromptSpec) MarshalJSON() ([]byte, error) {
	type alias PromptSpec
	m := map[string]any{}
	b, err := json.Marshal(alias(p))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if p.Kind == "multiselect" {
		delete(m, "initial")
		if len(p.InitialMany) > 0 {
			m["initial"] = p.InitialMany
		}
	}
	return json.Marshal(m)
}

var ErrBadSpec = errors.New("bad prompt spec")

func DecodePrompt(line []byte) (PromptSpec, error) {
	var s PromptSpec
	if err := json.Unmarshal(line, &s); err != nil {
		return s, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	if s.T != "prompt" {
		return s, fmt.Errorf("%w: t=%q", ErrBadSpec, s.T)
	}
	if s.Protocol != Version {
		return s, fmt.Errorf("%w: protocol %d, rt-ui speaks %d", ErrBadSpec, s.Protocol, Version)
	}
	switch s.Kind {
	case "select", "multiselect", "confirm", "text":
		return s, nil
	}
	return s, fmt.Errorf("%w: kind %q", ErrBadSpec, s.Kind)
}

// Result is one of value/values/ok/text; exactly one is set.
type Result struct {
	Value  *string  `json:"value,omitempty"`
	Values []string `json:"values,omitempty"`
	OK     *bool    `json:"ok,omitempty"`
	Text   *string  `json:"text,omitempty"`
}

func EncodeResult(r Result) []byte {
	m := map[string]any{"t": "result"}
	switch {
	case r.Value != nil:
		m["value"] = *r.Value
	case r.Values != nil:
		m["values"] = r.Values
	case r.OK != nil:
		m["ok"] = *r.OK
	case r.Text != nil:
		m["text"] = *r.Text
	}
	b, _ := json.Marshal(m)
	return append(b, '\n')
}

type StepEvent struct {
	T        string `json:"t"`
	Protocol int    `json:"protocol,omitempty"`
	Title    string `json:"title,omitempty"`
	Hint     string `json:"hint,omitempty"`
	Level    string `json:"level,omitempty"`
	Text     string `json:"text,omitempty"`
}

func DecodeStep(line []byte) (StepEvent, error) {
	var e StepEvent
	if err := json.Unmarshal(line, &e); err != nil {
		return e, fmt.Errorf("%w: %v", ErrBadSpec, err)
	}
	switch e.T {
	case "hello", "start", "log", "done", "fail":
		return e, nil
	}
	return e, fmt.Errorf("%w: step t=%q", ErrBadSpec, e.T)
}

// ReadLine returns one line without its newline; io.EOF when the writer is gone.
func ReadLine(r *bufio.Reader) ([]byte, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	return line[:len(line)-1], nil
}
```

- [ ] **Step 5: Run the protocol tests**

Run: `cd ui && go test ./internal/protocol/`
Expected: PASS.

- [ ] **Step 6: Write the verb dispatcher `ui/cmd/rt-ui/main.go`**

```go
// rt-ui renders rt's interactive screens. stdin/stdout carry the protocol;
// every byte of UI goes to /dev/tty. Exit codes are the contract TS maps.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const (
	ExitOK       = 0
	ExitBadSpec  = 2
	ExitInternal = 70
	ExitCancel   = 130
	ExitBack     = 131
)

// Set by -ldflags "-X main.version=..." at release build time.
var version = "dev"

func main() {
	// A stdout write to a dead parent must surface as an error we handle
	// (restore the terminal, exit), never as a runtime SIGPIPE exit that
	// skips deferred restores.
	signal.Ignore(syscall.SIGPIPE)

	if len(os.Args) < 2 {
		usage()
		os.Exit(ExitBadSpec)
	}
	switch os.Args[1] {
	case "--version", "version":
		fmt.Fprintf(os.Stdout, "rt-ui %s protocol %d\n", version, protocolVersion)
		os.Exit(ExitOK)
	case "prompt":
		os.Exit(runPrompt())
	case "steps":
		os.Exit(runSteps())
	default:
		usage()
		os.Exit(ExitBadSpec)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: rt-ui prompt | rt-ui steps | rt-ui --version")
}
```

And `ui/cmd/rt-ui/verbs.go` with stubs the next tasks replace:

```go
package main

import "rt-ui/internal/protocol"

const protocolVersion = protocol.Version

func runPrompt() int { return ExitInternal }
func runSteps() int  { return ExitInternal }
```

- [ ] **Step 7: Add the build script and ignore the output**

In `package.json` `scripts`, add:
```json
"ui:build": "cd ui && CGO_ENABLED=0 go build -trimpath -ldflags \"-s -w -X main.version=${RT_VERSION:-dev}\" -o dist/rt-ui ./cmd/rt-ui",
"ui:test": "cd ui && go vet ./... && go test ./..."
```
Append to `.gitignore`:
```
ui/dist/
```

- [ ] **Step 8: Build and smoke**

Run: `bun run ui:build && ./ui/dist/rt-ui --version && ./ui/dist/rt-ui; echo "exit=$?"`
Expected: prints `rt-ui dev protocol 1`; the bare invocation prints usage to stderr and `exit=2`.

- [ ] **Step 9: Commit**

```bash
git add ui/go.mod ui/go.sum ui/cmd ui/internal/protocol package.json .gitignore
git commit -m "ui: bootstrap rt-ui module with protocol package and verb dispatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Theme and tty packages

**Files:**
- Create: `ui/internal/theme/theme.go`, `ui/internal/theme/theme_test.go`, `ui/internal/tty/tty.go`, `ui/internal/tty/tty_test.go`

**Interfaces:**
- Produces: `theme.Pink, Mint, Coral, Peach, Cyan, Lav, Text, TextSoft, Dim, Dimmer, Faint, Bg, BgSubtle, SelBg, WarnBg, Rule, Panel` (`color.Color`); glyph consts `GlyphRunning="●"` etc.; `theme.SpinnerFrames []string`; `theme.Huh() huh.Theme` (whose `Group.Base` carries the pink rounded card, so every huh form paints inside rt's card without a host program).
- Produces: `tty.Open(mode tty.Mode) (*os.File, error)` with `tty.ReadWrite | tty.WriteOnly`; `tty.WatchStdinEOF(onEOF func())`; `tty.FirstPaint()` (writes `first-paint <ms>` to stderr once when `RT_UI_BENCH=1`).

- [ ] **Step 1: Write the failing theme test**

`ui/internal/theme/theme_test.go`:

```go
package theme

import (
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
)

func TestPaletteMatchesTokenSheet(t *testing.T) {
	want := map[string]string{
		"pink": "#FF6B9D", "mint": "#62E6A8", "coral": "#FF7979", "peach": "#FFB77A",
		"cyan": "#5AAAFF", "lav": "#BD93F9", "text": "#E6E0FF", "dim": "#A8A0C6",
		"bg": "#161224", "selBg": "#37284B", "warnBg": "#2A2033", "panel": "#34304E",
	}
	got := map[string]string{
		"pink": Hex(Pink), "mint": Hex(Mint), "coral": Hex(Coral), "peach": Hex(Peach),
		"cyan": Hex(Cyan), "lav": Hex(Lav), "text": Hex(Text), "dim": Hex(Dim),
		"bg": Hex(Bg), "selBg": Hex(SelBg), "warnBg": Hex(WarnBg), "panel": Hex(Panel),
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %s, want %s", k, got[k], v)
		}
	}
}

func TestSpinnerFrames(t *testing.T) {
	if strings.Join(SpinnerFrames, "") != "⠋⠙⠹⠸⠼⠴⠦⠧⠣⠏" {
		t.Fatalf("frames %q", SpinnerFrames)
	}
}

func TestHuhGroupBaseIsThePinkRoundedCard(t *testing.T) {
	styles := Huh().Theme(true)
	out := styles.Group.Base.Render("body")
	if !strings.Contains(out, "╭") || !strings.Contains(out, "╰") {
		t.Fatalf("no rounded border in %q", out)
	}
	if !strings.Contains(out, "\x1b[38;2;255;107;157m") {
		t.Fatalf("border is not pink truecolor: %q", out)
	}
	if lipgloss.Width(out) < 8 {
		t.Fatalf("card too narrow: %q", out)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && go test ./internal/theme/`
Expected: FAIL to compile.

- [ ] **Step 3: Write `ui/internal/theme/theme.go`**

```go
// Package theme is the rt-ui token sheet: lib/tui/palette.ts in Go. Every
// color and glyph rt-ui paints comes from here; nothing crosses the wire.
package theme

import (
	"fmt"
	"image/color"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
)

var (
	Bg       = lipgloss.Color("#161224")
	BgSubtle = lipgloss.Color("#1C162C")
	SelBg    = lipgloss.Color("#37284B")
	WarnBg   = lipgloss.Color("#2A2033")
	Rule     = lipgloss.Color("#2A2340")
	Panel    = lipgloss.Color("#34304E")

	Pink     = lipgloss.Color("#FF6B9D")
	PinkSoft = lipgloss.Color("#FF9EC0")
	Mint     = lipgloss.Color("#62E6A8")
	Coral    = lipgloss.Color("#FF7979")
	Peach    = lipgloss.Color("#FFB77A")
	Cyan     = lipgloss.Color("#5AAAFF")
	Lav      = lipgloss.Color("#BD93F9")

	Text     = lipgloss.Color("#E6E0FF")
	TextSoft = lipgloss.Color("#D2CDEB")
	Dim      = lipgloss.Color("#A8A0C6")
	Dimmer   = lipgloss.Color("#8B84A8")
	Faint    = lipgloss.Color("#6E668C")
)

const (
	GlyphRunning = "●"
	GlyphStopped = "○"
	GlyphCrashed = "✗"
	GlyphBar     = "▌"
	GlyphChevron = "❯"
	GlyphOn      = "◉"
	GlyphDone    = "✓"
	GlyphWarn    = "⚠"
	GlyphBack    = "↩"
)

var SpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"}

// Hex renders a palette color back as #RRGGBB; used by tests and the --version banner.
func Hex(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02X%02X%02X", r>>8, g>>8, b>>8)
}

// Huh returns the huh theme that makes its four fields paint with rt's tokens.
// The group base is the prompt card: a rounded pink border, the same frame
// rt's fzf pickers draw (--border=rounded), with the field title as its
// first line and huh's own help line as the dim key legend.
func Huh() huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		s := huh.ThemeBase(isDark)
		base := lipgloss.NewStyle()
		s.Form.Base = base
		s.Group.Base = base.Border(lipgloss.RoundedBorder()).BorderForeground(Pink).Padding(0, 1)
		s.Group.Title = base.Foreground(Pink)
		s.Group.Description = base.Foreground(Faint)
		s.Focused.Base = base
		s.Blurred.Base = base
		s.Focused.Title = base.Foreground(Text).Bold(true)
		s.Blurred.Title = base.Foreground(Dim)
		s.Focused.Description = base.Foreground(Faint)
		s.Blurred.Description = base.Foreground(Faint)
		s.Focused.ErrorMessage = base.Foreground(Coral)
		s.Focused.ErrorIndicator = base.Foreground(Coral)
		s.Focused.SelectSelector = base.Foreground(Pink).SetString(GlyphBar + " ")
		s.Focused.Option = base.Foreground(Text)
		s.Focused.MultiSelectSelector = base.Foreground(Pink).SetString(GlyphBar + " ")
		s.Focused.SelectedOption = base.Foreground(PinkSoft)
		s.Focused.SelectedPrefix = base.Foreground(Mint).SetString(GlyphOn + " ")
		s.Focused.UnselectedOption = base.Foreground(Text)
		s.Focused.UnselectedPrefix = base.Foreground(Faint).SetString(GlyphStopped + " ")
		s.Focused.FocusedButton = base.Foreground(Bg).Background(Pink).Bold(true).Padding(0, 1)
		s.Focused.BlurredButton = base.Foreground(Dim).Padding(0, 1)
		s.Focused.TextInput.Cursor = base.Foreground(Pink)
		s.Focused.TextInput.Placeholder = base.Foreground(Faint)
		s.Focused.TextInput.Prompt = base.Foreground(Pink).SetString(GlyphChevron + " ")
		s.Focused.TextInput.Text = base.Foreground(Text)
		s.Help.ShortKey = base.Foreground(Faint)
		s.Help.ShortDesc = base.Foreground(Dim)
		s.Help.ShortSeparator = base.Foreground(Faint)
		return s
	})
}
```

- [ ] **Step 4: Run the theme tests**

Run: `cd ui && go test ./internal/theme/`
Expected: PASS. If a huh `Styles` field named above does not exist in v2.0.3, `go doc charm.land/huh/v2 FieldStyles` and `go doc charm.land/huh/v2 TextInputStyles` list the real names; adjust the field, not the intent.

- [ ] **Step 5: Write the failing tty test**

`ui/internal/tty/tty_test.go`:

```go
package tty

import (
	"os"
	"testing"
	"time"
)

func TestWatchStdinEOFFiresWhenStdinCloses(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	fired := make(chan struct{}, 1)
	watchEOF(r, func() { fired <- struct{}{} })
	w.Close()
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("EOF watcher never fired")
	}
}

func TestFirstPaintIsSilentWithoutBenchEnv(t *testing.T) {
	t.Setenv("RT_UI_BENCH", "")
	r, w, _ := os.Pipe()
	firstPaintTo(w)
	w.Close()
	buf := make([]byte, 64)
	n, _ := r.Read(buf)
	if n != 0 {
		t.Fatalf("wrote %q without RT_UI_BENCH", buf[:n])
	}
}

func TestFirstPaintWritesOnceWithBenchEnv(t *testing.T) {
	t.Setenv("RT_UI_BENCH", "1")
	r, w, _ := os.Pipe()
	firstPaintTo(w)
	firstPaintTo(w)
	w.Close()
	buf := make([]byte, 256)
	n, _ := r.Read(buf)
	out := string(buf[:n])
	if len(out) == 0 || out[:12] != "first-paint " {
		t.Fatalf("got %q", out)
	}
	if countLines(out) != 1 {
		t.Fatalf("expected one line, got %q", out)
	}
}

func countLines(s string) int {
	n := 0
	for _, c := range s {
		if c == '\n' {
			n++
		}
	}
	return n
}
```

- [ ] **Step 6: Write `ui/internal/tty/tty.go`**

```go
// Package tty owns the terminal handle. UI bytes go to /dev/tty so stdin and
// stdout stay free for the protocol, which is how fzf coexists with rt too.
package tty

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type Mode int

const (
	ReadWrite Mode = iota
	WriteOnly
)

func Open(mode Mode) (*os.File, error) {
	flag := os.O_RDWR
	if mode == WriteOnly {
		flag = os.O_WRONLY
	}
	f, err := os.OpenFile("/dev/tty", flag, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/tty: %w", err)
	}
	return f, nil
}

// WatchStdinEOF calls onEOF once when the parent closes our stdin. The parent
// keeps stdin open for our whole life, so EOF only ever means it died.
func WatchStdinEOF(onEOF func()) { watchEOF(os.Stdin, onEOF) }

func watchEOF(r io.Reader, onEOF func()) {
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := r.Read(buf); err != nil {
				onEOF()
				return
			}
		}
	}()
}

var firstPaintOnce sync.Once

// FirstPaint writes the bench hook line exactly once, only under RT_UI_BENCH=1.
func FirstPaint() { firstPaintTo(os.Stderr) }

func firstPaintTo(w io.Writer) {
	if os.Getenv("RT_UI_BENCH") != "1" {
		return
	}
	firstPaintOnce.Do(func() {
		fmt.Fprintf(w, "first-paint %d\n", time.Now().UnixMilli())
	})
}
```

Note for the test: `firstPaintOnce` is process-global, so the "silent without env" test must run before the "writes once" test in file order (Go runs tests in source order within a file); keep them in the order written above.

- [ ] **Step 7: Run the tty tests and vet**

Run: `cd ui && go vet ./... && go test ./internal/tty/ ./internal/theme/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/internal/theme ui/internal/tty
git commit -m "ui: add theme (token sheet) and tty packages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: The `prompt` verb

**Files:**
- Create: `ui/internal/prompt/prompt.go`, `ui/internal/prompt/prompt_test.go`, `ui/internal/testutil/binary.go`, `ui/internal/testutil/ptyrun.go`
- Modify: `ui/cmd/rt-ui/verbs.go`

**Interfaces:**
- Produces: `prompt.Run(spec protocol.PromptSpec, term *os.File) (protocol.Result, Outcome, error)` where `type Outcome int` with `Answered, Cancelled, Back`.
- Produces (tests): `testutil.Binary(t) string` (builds `rt-ui` once per test run into a temp dir), `testutil.RunPTY(t, argv []string, stdinLines []string, keys []string, env map[string]string) (stdout string, tty string, exit int)`.

- [ ] **Step 1: Write the test helpers**

`ui/internal/testutil/binary.go`:

```go
// Package testutil runs the real rt-ui binary under a pty. Black-box on
// purpose: the contract is the bytes and the exit code, not Go internals.
package testutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

var (
	buildOnce sync.Once
	binPath   string
	buildErr  error
)

func Binary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "rt-ui-test-")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "rt-ui")
		root, _ := filepath.Abs(filepath.Join("..", ".."))
		cmd := exec.Command("go", "build", "-o", binPath, "./cmd/rt-ui")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			buildErr = err
			t.Logf("build output: %s", out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binPath
}
```

`ui/internal/testutil/ptyrun.go`:

```go
package testutil

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

// RunPTY starts argv with a pty as its controlling terminal, a pipe as stdin
// (kept open until exit unless closeStdin), stdout captured. stdinLines are
// written first; keys are typed to the pty after the first tty paint.
func RunPTY(t *testing.T, argv []string, stdinLines []string, keys []string, env map[string]string, closeStdin bool) (stdout, tty string, exit int) {
	t.Helper()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdinW, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 100})
	if err != nil {
		t.Fatal(err)
	}
	defer ptmx.Close()

	var ttyBuf bytes.Buffer
	done := make(chan struct{})
	go func() {
		io.Copy(&ttyBuf, ptmx)
		close(done)
	}()

	for _, l := range stdinLines {
		io.WriteString(stdinW, l+"\n")
	}
	if closeStdin {
		stdinW.Close()
	}

	// Wait for the first paint before typing so keys are not swallowed.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && ttyBuf.Len() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	for _, k := range keys {
		time.Sleep(30 * time.Millisecond)
		io.WriteString(ptmx, k)
	}
	err = cmd.Wait()
	if !closeStdin {
		stdinW.Close()
	}
	select {
	case <-done:
	case <-time.After(time.Second):
	}
	exit = 0
	if ee, ok := err.(*exec.ExitError); ok {
		exit = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("wait: %v", err)
	}
	return out.String(), strings.ToValidUTF8(ttyBuf.String(), ""), exit
}
```

Note: `pty.StartWithSize` sets the pty as the process's controlling tty and as stdin/stdout/stderr; the `StdinPipe`/`Stdout` assignments above override stdin and stdout with our pipes, leaving only the controlling terminal on the pty. If `creack/pty` refuses that combination, use `pty.Open()` and build the `exec.Cmd` with `SysProcAttr{Setsid: true, Setctty: true, Ctty: <slave fd>}` and `ExtraFiles`; the observable contract stays the same.

- [ ] **Step 2: Write the failing prompt tests**

`ui/internal/prompt/prompt_test.go`:

```go
package prompt_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rt-ui/internal/testutil"
)

func spec(t *testing.T, name string) string {
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

const (
	keyEnter = "\r"
	keyDown  = "\x1b[B"
	keyEsc   = "\x1b"
	keyCtrlC = "\x03"
	keyCtrlUp = "\x1b[1;5A"
)

func TestSelectEnterReturnsInitialAndExitsZero(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEnter}, nil, false)
	if exit != 0 {
		t.Fatalf("exit %d", exit)
	}
	var r map[string]any
	if err := json.Unmarshal([]byte(stdout), &r); err != nil {
		t.Fatalf("stdout %q: %v", stdout, err)
	}
	if r["value"] != "1h" {
		t.Fatalf("value %v", r["value"])
	}
	if !strings.Contains(tty, "Access duration") || !strings.Contains(tty, "╭") {
		t.Fatalf("card not painted: %q", tty)
	}
	if !strings.Contains(tty, "back to resources") {
		t.Fatalf("back row missing: %q", tty)
	}
}

func TestSelectDownEnterPicksSecond(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyDown, keyEnter}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"value":"4h"`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

func TestSelectEscExits130WithNoStdout(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyEsc}, nil, false)
	if exit != 130 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

func TestSelectCtrlCExits130(t *testing.T) {
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyCtrlC}, nil, false)
	if exit != 130 {
		t.Fatalf("exit %d", exit)
	}
}

func TestSelectCtrlUpExits131(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{keyCtrlUp}, nil, false)
	if exit != 131 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

func TestSelectBackRowExits131(t *testing.T) {
	// The ↩ row is the first option; the cursor starts on the initial ("1h"), one below it.
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, []string{"\x1b[A", keyEnter}, nil, false)
	if exit != 131 {
		t.Fatalf("exit %d", exit)
	}
}

func TestConfirmYAndNAndCollapse(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-confirm.json")}, []string{"y"}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"ok":true`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "✓") || !strings.Contains(tty, "Run sdm login now?") {
		t.Fatalf("collapsed line missing: %q", tty)
	}
	stdout, _, exit = testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-confirm.json")}, []string{"n"}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"ok":false`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
}

func TestTextValidatesPatternThenAccepts(t *testing.T) {
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-text.json")}, []string{"Bad Name", keyEnter, "\x15", "linear-tools", keyEnter}, nil, false)
	if exit != 0 || !strings.Contains(stdout, `"text":"linear-tools"`) {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "must be kebab-case") {
		t.Fatalf("validation message never shown: %q", tty)
	}
}

func TestMultiselectSpaceTogglesAndEnterSubmits(t *testing.T) {
	stdout, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-multiselect.json")}, []string{keyDown, " ", keyEnter}, nil, false)
	if exit != 0 {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(stdout, `"pre-commit"`) || !strings.Contains(stdout, `"pre-push"`) {
		t.Fatalf("stdout %q", stdout)
	}
}

func TestBadSpecExits2(t *testing.T) {
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{`{"t":"prompt","protocol":9,"kind":"select"}`}, nil, nil, false)
	if exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}

func TestParentDeathRestoresTerminal(t *testing.T) {
	// Closing stdin while the card is up is "the brain died": rt-ui must leave
	// raw mode (the tty stream ends with a cursor-show / reset sequence) and exit.
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "prompt"}, []string{spec(t, "prompt-select.json")}, nil, nil, true)
	if exit == 0 {
		t.Fatalf("exited 0 without an answer")
	}
	if !strings.Contains(tty, "\x1b[?25h") {
		t.Fatalf("cursor never restored: %q", tty)
	}
}

```

(The bench hook is unit-tested in `ui/internal/tty/tty_test.go`; its end-to-end check is Task 14's bench run.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ui && go test ./internal/prompt/`
Expected: every test fails with exit 70 (the stub) or a missing card.

- [ ] **Step 4: Write `ui/internal/prompt/prompt.go`**

```go
// Package prompt renders the four one-shot kinds on huh inside rt's card.
// The keybind header is composed here from the spec's kind and back row;
// TS never sends key text.
package prompt

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
	"rt-ui/internal/tty"
)

type Outcome int

const (
	Answered Outcome = iota
	Cancelled
	Back
)

const backValue = "\x00rt-ui:back"

// Run paints the prompt on term and returns the answer. Cancelled and Back
// are outcomes, not errors; err is reserved for the terminal or huh failing.
func Run(spec protocol.PromptSpec, term *os.File) (protocol.Result, Outcome, error) {
	var (
		result  protocol.Result
		backHit bool
		field   huh.Field
	)

	switch spec.Kind {
	case "select":
		var v string
		opts := make([]huh.Option[string], 0, len(spec.Options)+1)
		if spec.Back != nil {
			opts = append(opts, huh.NewOption(theme.GlyphBack+" "+spec.Back.Label, backValue))
		}
		for _, o := range spec.Options {
			opts = append(opts, huh.NewOption(optionLabel(o), o.Value))
		}
		v = spec.Initial
		if v == "" && len(spec.Options) > 0 {
			v = spec.Options[0].Value
		}
		field = huh.NewSelect[string]().Title(spec.Title).Description(spec.Hint).Options(opts...).Value(&v)
		defer func() {
			if v == backValue {
				backHit = true
			} else {
				result.Value = &v
			}
		}()
	case "multiselect":
		v := append([]string(nil), spec.InitialMany...)
		opts := make([]huh.Option[string], 0, len(spec.Options))
		for _, o := range spec.Options {
			opt := huh.NewOption(optionLabel(o), o.Value)
			for _, sel := range spec.InitialMany {
				if sel == o.Value {
					opt = opt.Selected(true)
				}
			}
			opts = append(opts, opt)
		}
		ms := huh.NewMultiSelect[string]().Title(spec.Title).Description(spec.Hint).Options(opts...).Value(&v)
		if spec.Max != nil {
			ms = ms.Limit(*spec.Max)
		}
		if spec.Min != nil {
			min := *spec.Min
			ms = ms.Validate(func(picked []string) error {
				if len(picked) < min {
					return fmt.Errorf("pick at least %d", min)
				}
				return nil
			})
		}
		field = ms
		defer func() { result.Values = v; if result.Values == nil { result.Values = []string{} } }()
	case "confirm":
		v := spec.Default == nil || *spec.Default
		c := huh.NewConfirm().Title(spec.Message).Description(spec.Hint).Affirmative("yes").Negative("no").Inline(true).Value(&v)
		field = c
		defer func() { result.OK = &v }()
	case "text":
		v := spec.Initial
		in := huh.NewInput().Title(spec.Title).Description(spec.Hint).Placeholder(spec.Placeholder).Value(&v)
		if spec.Validate != nil {
			re, err := regexp.Compile(spec.Validate.Pattern)
			if err != nil {
				return result, Answered, fmt.Errorf("%w: validate.pattern: %v", protocol.ErrBadSpec, err)
			}
			msg := spec.Validate.Message
			in = in.Validate(func(s string) error {
				if !re.MatchString(s) {
					return errors.New(msg)
				}
				return nil
			})
		}
		field = in
		defer func() { result.Text = &v }()
	default:
		return result, Answered, fmt.Errorf("%w: kind %q", protocol.ErrBadSpec, spec.Kind)
	}

	km := huh.NewDefaultKeyMap()
	km.Quit = key.NewBinding(key.WithKeys("ctrl+c", "esc"))

	backRequested := false
	filter := func(_ tea.Model, msg tea.Msg) tea.Msg {
		if k, ok := msg.(tea.KeyPressMsg); ok && k.String() == "ctrl+up" && spec.Back != nil {
			backRequested = true
			return tea.QuitMsg{}
		}
		return msg
	}

	form := huh.NewForm(huh.NewGroup(field)).
		WithTheme(theme.Huh()).
		WithKeyMap(km).
		WithShowHelp(true).
		WithInput(term).
		WithOutput(term).
		WithProgramOptions(tea.WithColorProfile(colorprofile.TrueColor), tea.WithFilter(filter))

	tty.FirstPaint()
	err := form.Run()
	switch {
	case backRequested:
		return result, Back, nil
	case errors.Is(err, huh.ErrUserAborted):
		return result, Cancelled, nil
	case err != nil:
		return result, Answered, err
	}
	if backHit {
		return result, Back, nil
	}
	if spec.Kind == "confirm" {
		writeCollapsed(term, spec.Message, result.OK != nil && *result.OK)
	}
	return result, Answered, nil
}

func optionLabel(o protocol.Option) string {
	if o.Hint == "" {
		return o.Label
	}
	return o.Label + "  " + lipgloss.NewStyle().Foreground(theme.Faint).Render(o.Hint)
}

// The answered confirm collapses to one line so scrollback keeps a record
// without the prompt chrome. huh leaves its last frame on screen after Run;
// erase that many rows first so only the collapsed line survives.
func writeCollapsed(term *os.File, message string, ok bool, formHeight int) {
	answer := "no"
	if ok {
		answer = "yes"
	}
	for i := 0; i < formHeight; i++ {
		fmt.Fprint(term, "\x1b[1A\x1b[2K")
	}
	line := lipgloss.NewStyle().Foreground(theme.Mint).Render(theme.GlyphDone) + " " +
		lipgloss.NewStyle().Foreground(theme.Dim).Render(message) + " " +
		lipgloss.NewStyle().Foreground(theme.TextSoft).Render(answer)
	fmt.Fprint(term, "\r\x1b[2K"+line+"\n")
}
```

In `Run`, capture the form's painted height right before `form.Run()` returns it (huh keeps `form.View()` valid after completion): replace the confirm branch at the end with

```go
	if spec.Kind == "confirm" {
		writeCollapsed(term, spec.Message, result.OK != nil && *result.OK, lipgloss.Height(form.View()))
	}
```

and drop the unused `strings` import from the file's import block.

Then wire the verb in `ui/cmd/rt-ui/verbs.go`:

```go
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"

	"rt-ui/internal/prompt"
	"rt-ui/internal/protocol"
	"rt-ui/internal/tty"
)

const protocolVersion = protocol.Version

func runPrompt() int {
	line, err := protocol.ReadLine(bufio.NewReader(os.Stdin))
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt: no spec on stdin")
		return ExitBadSpec
	}
	spec, err := protocol.DecodePrompt(line)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitBadSpec
	}
	term, err := tty.Open(tty.ReadWrite)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitInternal
	}
	defer term.Close()

	// The parent closing stdin is the only EOF we can ever see; restore and go.
	tty.WatchStdinEOF(func() {
		fmt.Fprint(term, "\x1b[?25h\x1b[0m\r\n")
		os.Exit(ExitInternal)
	})

	result, outcome, err := prompt.Run(spec, term)
	if err != nil {
		if errors.Is(err, protocol.ErrBadSpec) {
			fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
			return ExitBadSpec
		}
		fmt.Fprintln(os.Stderr, "rt-ui prompt:", err)
		return ExitInternal
	}
	switch outcome {
	case prompt.Cancelled:
		return ExitCancel
	case prompt.Back:
		return ExitBack
	}
	if _, err := os.Stdout.Write(protocol.EncodeResult(result)); err != nil {
		// stdout gone: the parent died between our answer and our write.
		return ExitInternal
	}
	return ExitOK
}

func runSteps() int { return ExitInternal }

var _ = io.EOF
```

- [ ] **Step 5: Build and run the prompt tests**

Run: `cd ui && go vet ./... && go test ./internal/prompt/ -count=1`
Expected: PASS. Known places the installed huh API may differ from the code above; fix by `go doc`, never by weakening a test: `Option.Selected` (multiselect initial), `Confirm.Inline`, `Form.WithKeyMap` taking `*KeyMap`, `tea.QuitMsg` being the type `tea.Quit()` returns, `WithFilter`'s model parameter type. If `TestSelectBackRowExits131` fails because huh puts the cursor on the first option regardless of `Value`, set the initial by reordering: keep the back row first and accept that the cursor starts on it; then change the test's keys to `[]string{keyEnter}` and move the initial-selection assertion to `TestSelectDownEnterPicksSecond` (`keyDown` twice).

- [ ] **Step 6: Commit**

```bash
git add ui/internal/prompt ui/internal/testutil ui/cmd/rt-ui/verbs.go
git commit -m "ui: prompt verb (select, multiselect, confirm, text on huh)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7: The `steps` verb

**Files:**
- Create: `ui/internal/steps/steps.go`, `ui/internal/steps/steps_test.go`
- Modify: `ui/cmd/rt-ui/verbs.go` (`runSteps`)

**Interfaces:**
- Produces: `steps.Run(events <-chan protocol.StepEvent, term *os.File) (Outcome)` with `Outcome` in `Done, Failed, Interrupted`.

- [ ] **Step 1: Write the failing tests**

`ui/internal/steps/steps_test.go`:

```go
package steps_test

import (
	"strings"
	"testing"

	"rt-ui/internal/testutil"
)

const hello = `{"t":"hello","protocol":1}`

func TestDoneStepPrintsCheckLineAndExitsZero(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`, `{"t":"done","title":"origin fetched","hint":"3 new commits"}`}
	stdout, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || stdout != "" {
		t.Fatalf("exit %d stdout %q", exit, stdout)
	}
	if !strings.Contains(tty, "✓") || !strings.Contains(tty, "origin fetched") || !strings.Contains(tty, "3 new commits") {
		t.Fatalf("tty %q", tty)
	}
}

func TestFailStepPrintsCrossLine(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"rebasing…"}`, `{"t":"fail","title":"rebase stopped","hint":"conflict in lib/state/db.ts"}`}
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || !strings.Contains(tty, "✗") || !strings.Contains(tty, "rebase stopped") {
		t.Fatalf("exit %d tty %q", exit, tty)
	}
}

func TestLogLinesAppearAboveTheActiveStep(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"pushing…"}`, `{"t":"log","level":"warn","text":"diverged from origin/main"}`, `{"t":"done","title":"pushed"}`}
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	warnAt := strings.Index(tty, "diverged from origin/main")
	doneAt := strings.LastIndex(tty, "pushed")
	if warnAt < 0 || doneAt < 0 || warnAt > doneAt {
		t.Fatalf("order wrong: %q", tty)
	}
	if !strings.Contains(tty, "⚠") {
		t.Fatalf("warn glyph missing: %q", tty)
	}
}

func TestEOFWithoutDoneIsInterrupted(t *testing.T) {
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`}
	_, tty, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	if exit != 0 || !strings.Contains(tty, "interrupted") {
		t.Fatalf("exit %d tty %q", exit, tty)
	}
}

func TestFastStepNeverPaintsASpinnerFrame(t *testing.T) {
	// start and done arrive together: the final line is all that is painted.
	lines := []string{hello, `{"t":"start","title":"fetching origin…"}`, `{"t":"done","title":"origin fetched"}`}
	_, tty, _ := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, lines, nil, nil, true)
	for _, f := range []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"} {
		if strings.Contains(tty, f) {
			t.Fatalf("spinner frame %q painted for an instant step: %q", f, tty)
		}
	}
}

func TestBadHelloExits2(t *testing.T) {
	_, _, exit := testutil.RunPTY(t, []string{testutil.Binary(t), "steps"}, []string{`{"t":"hello","protocol":7}`}, nil, nil, true)
	if exit != 2 {
		t.Fatalf("exit %d", exit)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && go test ./internal/steps/ -count=1`
Expected: FAIL (exit 70 from the stub).

- [ ] **Step 3: Write `ui/internal/steps/steps.go`**

```go
// Package steps renders one step: a spinner line while the parent works,
// then a final ✓/✗ line. The tty is write-only and cooked, so Ctrl-C stays a
// signal to the whole group and the parent's own SIGINT handling runs.
package steps

import (
	"fmt"
	"os"
	"time"

	"charm.land/lipgloss/v2"

	"rt-ui/internal/protocol"
	"rt-ui/internal/theme"
	"rt-ui/internal/tty"
)

type Outcome int

const (
	Done Outcome = iota
	Failed
	Interrupted
)

const frameEvery = 80 * time.Millisecond

var (
	spinStyle = lipgloss.NewStyle().Foreground(theme.Mint)
	textStyle = lipgloss.NewStyle().Foreground(theme.Text)
	hintStyle = lipgloss.NewStyle().Foreground(theme.Faint)
	okGlyph   = lipgloss.NewStyle().Foreground(theme.Mint).Render(theme.GlyphDone)
	badGlyph  = lipgloss.NewStyle().Foreground(theme.Coral).Render(theme.GlyphCrashed)
	warnGlyph = lipgloss.NewStyle().Foreground(theme.Peach).Render(theme.GlyphWarn)
	infoGlyph = lipgloss.NewStyle().Foreground(theme.Faint).Render("•")
)

// Run consumes events until done/fail or the channel closes (parent gone).
// The spinner line is only ever painted once the first frame tick fires, so
// a step that finishes inside 80 ms paints its final line and nothing else.
func Run(events <-chan protocol.StepEvent, term *os.File) Outcome {
	var title string
	painted := false
	frame := 0
	ticker := time.NewTicker(frameEvery)
	defer ticker.Stop()

	clearActive := func() {
		if painted {
			fmt.Fprint(term, "\r\x1b[2K")
		}
	}
	final := func(glyph, t, hint string) {
		clearActive()
		line := "  " + glyph + " " + textStyle.Render(t)
		if hint != "" {
			line += "  " + hintStyle.Render(hint)
		}
		fmt.Fprint(term, line+"\n")
	}

	for {
		select {
		case <-ticker.C:
			if title == "" {
				continue
			}
			if !painted {
				tty.FirstPaint()
			}
			painted = true
			f := theme.SpinnerFrames[frame%len(theme.SpinnerFrames)]
			frame++
			fmt.Fprint(term, "\r\x1b[2K  "+spinStyle.Render(f)+" "+textStyle.Render(title))
		case ev, ok := <-events:
			if !ok {
				if title != "" {
					final(badGlyph, title, "interrupted")
				}
				return Interrupted
			}
			switch ev.T {
			case "start":
				title = ev.Title
			case "log":
				clearActive()
				g := infoGlyph
				switch ev.Level {
				case "warn":
					g = warnGlyph
				case "error":
					g = badGlyph
				case "success":
					g = okGlyph
				}
				fmt.Fprint(term, "  "+g+" "+textStyle.Render(ev.Text)+"\n")
				painted = false
			case "done":
				t := ev.Title
				if t == "" {
					t = title
				}
				final(okGlyph, t, ev.Hint)
				return Done
			case "fail":
				t := ev.Title
				if t == "" {
					t = title
				}
				final(badGlyph, t, ev.Hint)
				return Failed
			}
		}
	}
}
```

And replace `runSteps` in `ui/cmd/rt-ui/verbs.go`:

```go
func runSteps() int {
	r := bufio.NewReader(os.Stdin)
	first, err := protocol.ReadLine(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui steps: no hello on stdin")
		return ExitBadSpec
	}
	hello, err := protocol.DecodeStep(first)
	if err != nil || hello.T != "hello" || hello.Protocol != protocol.Version {
		fmt.Fprintf(os.Stderr, "rt-ui steps: bad hello %s\n", first)
		return ExitBadSpec
	}
	term, err := tty.Open(tty.WriteOnly)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rt-ui steps:", err)
		return ExitInternal
	}
	defer term.Close()

	events := make(chan protocol.StepEvent, 16)
	go func() {
		defer close(events)
		for {
			line, err := protocol.ReadLine(r)
			if err != nil {
				return
			}
			ev, err := protocol.DecodeStep(line)
			if err != nil {
				continue
			}
			events <- ev
		}
	}()
	steps.Run(events, term)
	return ExitOK
}
```
(add `"rt-ui/internal/steps"` to that file's imports.)

- [ ] **Step 4: Run vet and the steps tests**

Run: `cd ui && go vet ./... && go test ./... -count=1`
Expected: PASS across protocol, theme, tty, prompt, steps.

- [ ] **Step 5: Commit**

```bash
git add ui/internal/steps ui/cmd/rt-ui/verbs.go
git commit -m "ui: steps verb (write-only tty, spinner, done/fail/log, EOF = interrupted)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: TS binary resolution

**Files:**
- Create: `lib/ui/resolve.ts`, `lib/ui/__tests__/resolve.test.ts`

**Interfaces:**
- Produces: `resolveRtUi(probes?: ResolveProbes): string` (throws `RtUiMissingError` listing every path tried); `interface ResolveProbes { env: Record<string, string | undefined>; exists(p: string): boolean; bundleRoot(): string | null; sourceRoot(): string | null; which(bin: string): string | null }`.

- [ ] **Step 1: Write the failing test**

`lib/ui/__tests__/resolve.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveRtUi, RtUiMissingError, type ResolveProbes } from "../resolve.ts";

function probes(over: Partial<ResolveProbes>): ResolveProbes {
  return {
    env: {},
    exists: () => false,
    bundleRoot: () => null,
    sourceRoot: () => null,
    which: () => null,
    ...over,
  };
}

test("RT_UI_BIN wins over everything", () => {
  const p = probes({ env: { RT_UI_BIN: "/custom/rt-ui" }, bundleRoot: () => "/Applications/mattstack.app", sourceRoot: () => "/repo", exists: () => true });
  expect(resolveRtUi(p)).toBe("/custom/rt-ui");
});

test("a source checkout wins over an installed bundle (dev mode must never pin a stale helper)", () => {
  const p = probes({
    bundleRoot: () => "/Applications/mattstack-dev.app",
    sourceRoot: () => "/repo",
    exists: (path) => path === "/repo/ui/dist/rt-ui" || path === "/Applications/mattstack-dev.app/Contents/Helpers/rt-ui",
  });
  expect(resolveRtUi(p)).toBe("/repo/ui/dist/rt-ui");
});

test("a source checkout without a build falls through to the bundle, then PATH", () => {
  const bundled = "/Applications/mattstack.app/Contents/Helpers/rt-ui";
  const p = probes({ sourceRoot: () => "/repo", bundleRoot: () => "/Applications/mattstack.app", exists: (path) => path === bundled });
  expect(resolveRtUi(p)).toBe(bundled);
  const onPath = probes({ sourceRoot: () => "/repo", which: (b) => (b === "rt-ui" ? "/opt/homebrew/bin/rt-ui" : null) });
  expect(resolveRtUi(onPath)).toBe("/opt/homebrew/bin/rt-ui");
});

test("a compiled binary outside a bundle skips the source step", () => {
  const p = probes({ sourceRoot: () => null, which: () => "/usr/local/bin/rt-ui" });
  expect(resolveRtUi(p)).toBe("/usr/local/bin/rt-ui");
});

test("nothing found throws with every path tried and the build hint", () => {
  const p = probes({ sourceRoot: () => "/repo", bundleRoot: () => "/Applications/mattstack.app" });
  let err: unknown;
  try {
    resolveRtUi(p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RtUiMissingError);
  const msg = String((err as Error).message);
  expect(msg).toContain("/repo/ui/dist/rt-ui");
  expect(msg).toContain("/Applications/mattstack.app/Contents/Helpers/rt-ui");
  expect(msg).toContain("bun run ui:build");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/ui/__tests__/resolve.test.ts`
Expected: FAIL, cannot resolve `../resolve.ts`.

- [ ] **Step 3: Write `lib/ui/resolve.ts`**

```ts
/**
 * Where rt-ui runs from. Source wins over an installed bundle on purpose: in
 * dev mode the active bundle is the blessed mattstack-dev.app, which is never
 * rebuilt, so bundle-first would pin every source run to a stale helper.
 */
import { existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { appBundleRoot, bundleRootFromExec, HELPERS_DIR } from "../bundle-layout.ts";

export interface ResolveProbes {
  env: Record<string, string | undefined>;
  exists(p: string): boolean;
  /** The .app root rt runs from or is installed as, or null. */
  bundleRoot(): string | null;
  /** The repo root when running from a source checkout, else null. */
  sourceRoot(): string | null;
  which(bin: string): string | null;
}

export class RtUiMissingError extends Error {
  constructor(tried: string[]) {
    super(
      `rt-ui not found. Tried:\n${tried.map((t) => `  ${t}`).join("\n")}\n` +
        `From a source checkout run: bun run ui:build`,
    );
    this.name = "RtUiMissingError";
  }
}

function defaultSourceRoot(): string | null {
  // import.meta.dir is a real directory only when running from source; a
  // compiled binary reports a virtual path that does not exist on disk.
  const here = import.meta.dir;
  if (!here || bundleRootFromExec() !== null) return null;
  try {
    if (!statSync(here).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolve(dirname(here), "..");
}

export const defaultProbes: ResolveProbes = {
  env: process.env,
  exists: existsSync,
  bundleRoot: () => appBundleRoot(),
  sourceRoot: defaultSourceRoot,
  which: (b) => Bun.which(b),
};

export function resolveRtUi(p: ResolveProbes = defaultProbes): string {
  const tried: string[] = [];
  const fromEnv = p.env.RT_UI_BIN;
  if (fromEnv) return fromEnv;

  const src = p.sourceRoot();
  if (src) {
    const candidate = join(src, "ui", "dist", "rt-ui");
    if (p.exists(candidate)) return candidate;
    tried.push(candidate);
  }

  const bundle = p.bundleRoot();
  if (bundle) {
    const candidate = join(bundle, HELPERS_DIR, "rt-ui");
    if (p.exists(candidate)) return candidate;
    tried.push(candidate);
  }

  const onPath = p.which("rt-ui");
  if (onPath) return onPath;
  tried.push("rt-ui on PATH");

  throw new RtUiMissingError(tried);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/ui/__tests__/resolve.test.ts && bunx tsc --noEmit`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add lib/ui/resolve.ts lib/ui/__tests__/resolve.test.ts
git commit -m "ui: rt-ui binary resolution ladder (env, source, bundle, PATH)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9: TS spawn layer and the fake binary

**Files:**
- Create: `lib/ui/spawn.ts`, `lib/ui/__tests__/fake-rt-ui.ts`, `lib/ui/__tests__/spawn.test.ts`

**Interfaces:**
- Produces: `runPrompt(spec: PromptSpec): Promise<PromptResult>` (exits 130 on cancel, throws `BackNavigation` on back, exits 1 with a message on 2/70/other); `openStep(title: string): StepHandle` with `{ log(level, text), done(title?, hint?), fail(title?, hint?) }` where `done`/`fail` resolve when the child exits; `__test__.setSpawnForTests(fn)` is not used; injection is via `RT_UI_BIN`.
- Produces (fake): `fake-rt-ui.ts` reads `RT_UI_FAKE` env: a JSON object `{ "answer": <result object> | "exit": <code>, "record": "<path>" }`; it appends every stdin line it receives to `record` and either prints the answer and exits 0 or exits with `exit`.

- [ ] **Step 1: Write the fake**

`lib/ui/__tests__/fake-rt-ui.ts` (then `chmod +x` it):

```ts
#!/usr/bin/env bun
/**
 * A scripted rt-ui. RT_UI_FAKE carries JSON: { answer?, exit?, record?,
 * holdMs? }. Every stdin line is appended to `record` so tests can assert
 * the exact spec a call site sent. `holdMs` keeps the process alive before
 * answering so tests can observe stdin staying open.
 */
import { appendFileSync } from "fs";

const cfg = JSON.parse(process.env.RT_UI_FAKE ?? "{}") as {
  answer?: unknown;
  exit?: number;
  record?: string;
  holdMs?: number;
};
const verb = process.argv[2];

const lines: string[] = [];
const decoder = new TextDecoder();
let buf = "";
const reader = Bun.stdin.stream().getReader();

async function drainUntil(count: number): Promise<void> {
  while (lines.length < count) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
}

if (verb === "prompt") {
  await drainUntil(1);
  if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
  if (cfg.holdMs) await Bun.sleep(cfg.holdMs);
  if (cfg.exit !== undefined) process.exit(cfg.exit);
  process.stdout.write(JSON.stringify({ t: "result", ...(cfg.answer as object) }) + "\n");
  process.exit(0);
}

if (verb === "steps") {
  // read until done/fail or EOF, record everything
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      const t = (JSON.parse(line) as { t: string }).t;
      if (t === "done" || t === "fail") {
        if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
        process.exit(cfg.exit ?? 0);
      }
    }
  }
  if (cfg.record) appendFileSync(cfg.record, lines.join("\n") + "\n");
  process.exit(cfg.exit ?? 0);
}

process.stderr.write("fake-rt-ui: unknown verb\n");
process.exit(2);
```

Run: `chmod +x lib/ui/__tests__/fake-rt-ui.ts`

- [ ] **Step 2: Write the failing spawn tests**

`lib/ui/__tests__/spawn.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { BackNavigation } from "../../back-navigation.ts";
import { runPrompt, openStep, __test__ } from "../spawn.ts";
import type { PromptSpec } from "../protocol.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
const exits: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-spawn-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  exits.length = 0;
  __test__.setExit((code) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  __test__.setExit(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const spec: PromptSpec = { t: "prompt", protocol: 1, kind: "select", title: "Pick", options: [{ value: "a", label: "A" }] };

test("runPrompt sends exactly one spec line and returns the parsed result", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "a" }, record });
  const r = await runPrompt(spec);
  expect(r).toEqual({ t: "result", value: "a" });
  const sent = readFileSync(record, "utf8").trim().split("\n");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toEqual(spec);
});

test("runPrompt keeps stdin open until the child exits", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "a" }, holdMs: 300 });
  const t0 = Date.now();
  await runPrompt(spec);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
});

test("exit 130 maps to process.exit(130)", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 130 });
  await expect(runPrompt(spec)).rejects.toThrow("exit 130");
  expect(exits).toEqual([130]);
});

test("exit 131 throws BackNavigation", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 131 });
  await expect(runPrompt(spec)).rejects.toBeInstanceOf(BackNavigation);
});

test("exit 2 and 70 exit 1 with a message naming the binary", async () => {
  for (const code of [2, 70]) {
    process.env.RT_UI_FAKE = JSON.stringify({ exit: code });
    await expect(runPrompt(spec)).rejects.toThrow("exit 1");
  }
  expect(exits).toEqual([1, 1]);
});

test("openStep streams hello, start, log, done and resolves on child exit", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  const step = openStep("fetching origin…");
  step.log("warn", "diverged");
  await step.done("origin fetched", "3 new commits");
  const sent = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(sent).toEqual([
    { t: "hello", protocol: 1 },
    { t: "start", title: "fetching origin…" },
    { t: "log", level: "warn", text: "diverged" },
    { t: "done", title: "origin fetched", hint: "3 new commits" },
  ]);
});

test("openStep tolerates a child that died mid-step", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 70 });
  const step = openStep("pushing…");
  await Bun.sleep(150);
  await step.done("pushed");
  expect(exits).toEqual([]);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test lib/ui/__tests__/spawn.test.ts`
Expected: FAIL, cannot resolve `../spawn.ts`.

- [ ] **Step 4: Write `lib/ui/spawn.ts`**

```ts
/**
 * Spawns rt-ui. stdin stays open until the child exits for every verb: EOF
 * is the child's only signal that we died, so it must never come early.
 */
import { BackNavigation } from "../back-navigation.ts";
import { encodeLine, parsePromptResult, PROTOCOL_VERSION, type PromptResult, type PromptSpec, type StepLevel } from "./protocol.ts";
import { resolveRtUi } from "./resolve.ts";

type ExitFn = (code: number) => never;
let exitFn: ExitFn = (code) => process.exit(code);

const live = new Set<ReturnType<typeof Bun.spawn>>();
let exitHookInstalled = false;

function killLiveOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const p of live) {
      try { p.kill("SIGTERM"); } catch { /* already gone */ }
    }
  });
}

function spawnVerb(verb: "prompt" | "steps") {
  const bin = resolveRtUi();
  killLiveOnExit();
  const proc = Bun.spawn([bin, verb], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  live.add(proc);
  proc.exited.then(() => live.delete(proc));
  return { bin, proc };
}

function fail(bin: string, code: number, stderr: string): never {
  const detail = stderr.trim() || `exit ${code}`;
  process.stderr.write(`\n  rt-ui failed (${detail})\n  binary: ${bin}\n\n`);
  return exitFn(1);
}

export async function runPrompt(spec: PromptSpec): Promise<PromptResult> {
  const { bin, proc } = spawnVerb("prompt");
  proc.stdin.write(encodeLine(spec));
  proc.stdin.flush();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  proc.stdin.end();
  switch (code) {
    case 0:
      return parsePromptResult(stdout);
    case 130:
      return exitFn(130);
    case 131:
      throw new BackNavigation();
    default:
      return fail(bin, code, stderr);
  }
}

export interface StepHandle {
  log(level: StepLevel, text: string): void;
  done(title?: string, hint?: string): Promise<void>;
  fail(title?: string, hint?: string): Promise<void>;
}

export function openStep(title: string): StepHandle {
  const { proc } = spawnVerb("steps");
  let dead = false;
  proc.exited.then(() => { dead = true; });

  const send = (msg: object): void => {
    if (dead) return;
    try {
      proc.stdin.write(encodeLine(msg));
      proc.stdin.flush();
    } catch {
      dead = true;
    }
  };
  send({ t: "hello", protocol: PROTOCOL_VERSION });
  send({ t: "start", title });

  const finish = async (t: "done" | "fail", finalTitle?: string, hint?: string): Promise<void> => {
    send({ t, title: finalTitle ?? title, ...(hint ? { hint } : {}) });
    try { proc.stdin.end(); } catch { /* already closed */ }
    await proc.exited;
  };

  return {
    log: (level, text) => send({ t: "log", level, text }),
    done: (t, h) => finish("done", t, h),
    fail: (t, h) => finish("fail", t, h),
  };
}

export const __test__ = {
  setExit(fn: ExitFn | undefined): void {
    exitFn = fn ?? ((code) => process.exit(code));
  },
};
```

- [ ] **Step 5: Run the tests**

Run: `bun test lib/ui/__tests__/spawn.test.ts && bunx tsc --noEmit`
Expected: PASS (7 tests), 0 errors. If `proc.stdin.flush` does not exist on the installed Bun, drop the `.flush()` calls; `write` on a piped stdin is unbuffered enough for one line.

- [ ] **Step 6: Commit**

```bash
git add lib/ui/spawn.ts lib/ui/__tests__/fake-rt-ui.ts lib/ui/__tests__/spawn.test.ts
git commit -m "ui: TS spawn layer for rt-ui prompt and steps, with a scripted fake

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 10: The prompt facade, re-pointed

**Files:**
- Create: `lib/ui/prompts.ts`, `lib/ui/__tests__/prompts.test.ts`
- Modify: `lib/rt-render.tsx` (becomes a shim)

**Interfaces:**
- Produces: `select`, `multiselect`, `confirm`, `textInput` with the exact signatures in today's `lib/rt-render.tsx`, plus `confirm({ destructive?: boolean })`. `stderr` is accepted and ignored.

- [ ] **Step 1: Write the failing facade tests**

`lib/ui/__tests__/prompts.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { select, multiselect, confirm, textInput } from "../prompts.ts";
import { BackNavigation } from "../../back-navigation.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-prompts-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
});
afterEach(() => {
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => JSON.parse(readFileSync(record, "utf8").trim().split("\n")[0]!);

test("select sends a select spec with a back row when backLabel is given, and returns the value", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "4h" }, record });
  const v = await select({ message: "Access duration", options: [{ value: "1h", label: "1 hour", hint: "default" }, { value: "4h", label: "4 hours" }], backLabel: "resources", stderr: true });
  expect(v).toBe("4h");
  expect(sent()).toEqual({
    t: "prompt", protocol: 1, kind: "select", title: "Access duration",
    options: [{ value: "1h", label: "1 hour", hint: "default" }, { value: "4h", label: "4 hours" }],
    back: { label: "resources" },
  });
});

test("select never puts a color on the wire", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "x" }, record });
  await select({ message: "m", options: [{ value: "x", label: "X", color: "\x1b[36m" }] });
  expect(JSON.stringify(sent())).not.toContain("color");
});

test("select back throws BackNavigation", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 131 });
  await expect(select({ message: "m", options: [{ value: "x", label: "X" }], backLabel: "b" })).rejects.toBeInstanceOf(BackNavigation);
});

test("multiselect sends initial values and returns the array", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { values: ["a", "b"] }, record });
  const v = await multiselect({ message: "Disable which hooks?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], initialValues: ["a"], required: true });
  expect(v).toEqual(["a", "b"]);
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "multiselect", title: "Disable which hooks?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], initial: ["a"], min: 1 });
});

test("confirm maps initialValue to default and exposes destructive", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { ok: false }, record });
  const ok = await confirm({ message: "Locate repo?", initialValue: false, destructive: true });
  expect(ok).toBe(false);
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "confirm", message: "Locate repo?", default: false, destructive: true });
});

test("textInput sends placeholder and initial, returns the text", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { text: "linear-tools" }, record });
  const v = await textInput({ message: "Plugin name (kebab-case)", placeholder: "my-plugin", defaultValue: "x" });
  expect(v).toBe("linear-tools");
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "text", title: "Plugin name (kebab-case)", placeholder: "my-plugin", initial: "x" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/ui/__tests__/prompts.test.ts`
Expected: FAIL, cannot resolve `../prompts.ts`.

- [ ] **Step 3: Write `lib/ui/prompts.ts`**

```ts
/**
 * The prompt facade every command calls. Signatures are frozen; only the
 * renderer changed (Ink to rt-ui). `stderr` is accepted for source
 * compatibility and ignored: /dev/tty rendering keeps stdout clean by itself.
 */
import type { SelectOption } from "../fzf-select.ts";
import { PROTOCOL_VERSION, type PromptOption } from "./protocol.ts";
import { runPrompt } from "./spawn.ts";

function wireOptions(options: SelectOption[]): PromptOption[] {
  return options.map((o) => (o.hint ? { value: o.value, label: o.label, hint: o.hint } : { value: o.value, label: o.label }));
}

export async function select(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
  backLabel?: string;
}): Promise<string> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "select",
    title: opts.message,
    options: wireOptions(opts.options),
    ...(opts.backLabel ? { back: { label: opts.backLabel } } : {}),
  });
  if (!("value" in r)) throw new Error("rt-ui select: result had no value");
  return r.value;
}

export async function multiselect(opts: {
  message: string;
  options: SelectOption[];
  initialValues?: string[];
  required?: boolean;
  stderr?: boolean;
}): Promise<string[]> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "multiselect",
    title: opts.message,
    options: wireOptions(opts.options),
    ...(opts.initialValues ? { initial: opts.initialValues } : {}),
    ...(opts.required ? { min: 1 } : {}),
  });
  if (!("values" in r)) throw new Error("rt-ui multiselect: result had no values");
  return r.values;
}

export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
  stderr?: boolean;
  destructive?: boolean;
}): Promise<boolean> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "confirm",
    message: opts.message,
    ...(opts.initialValue !== undefined ? { default: opts.initialValue } : {}),
    ...(opts.destructive ? { destructive: true } : {}),
  });
  if (!("ok" in r)) throw new Error("rt-ui confirm: result had no ok");
  return r.ok;
}

export async function textInput(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  stderr?: boolean;
}): Promise<string> {
  const r = await runPrompt({
    t: "prompt",
    protocol: PROTOCOL_VERSION,
    kind: "text",
    title: opts.message,
    ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
    ...(opts.defaultValue !== undefined ? { initial: opts.defaultValue } : {}),
  });
  if (!("text" in r)) throw new Error("rt-ui text: result had no text");
  return r.text;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test lib/ui/__tests__/prompts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Turn `lib/rt-render.tsx` into the shim**

Replace the whole file with:

```ts
/**
 * Re-export shim. The prompt facade lives in lib/ui/prompts.ts and the step
 * runner in lib/ui/steps.ts (rendered by the bundled rt-ui helper); the fzf
 * pickers live in lib/fzf-select.ts. Nothing here touches Ink any more.
 * New code imports from those modules directly.
 */
export type { SelectOption } from "./fzf-select.ts";
export { filterableSelect, filterableMultiselect } from "./fzf-select.ts";
export { BackNavigation } from "./back-navigation.ts";
export { select, multiselect, confirm, textInput } from "./ui/prompts.ts";
export { createStepRunner, withSpinner, type StepRunner } from "./ui/steps.ts";
```

This will not type-check until Task 11 provides `lib/ui/steps.ts`; the `prompt<T>()` JSX helper is dropped (no caller outside the deleted status dashboard used it; confirm with `grep -rn "prompt<" commands lib --include='*.ts' --include='*.tsx'`, which must return nothing).

- [ ] **Step 6: Commit (tsc red is expected until Task 11)**

```bash
git add lib/ui/prompts.ts lib/ui/__tests__/prompts.test.ts lib/rt-render.tsx
git commit -m "ui: prompt facade on rt-ui; rt-render.tsx becomes a re-export shim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 11: The step runner, re-pointed

**Files:**
- Create: `lib/ui/steps.ts`, `lib/ui/__tests__/steps.test.ts`

**Interfaces:**
- Produces: `createStepRunner(): StepRunner` and `withSpinner<T>(label, task, opts?)` with today's exact signatures; `StepRunner.log(message, style?)` prints in palette truecolor.

- [ ] **Step 1: Write the failing tests**

`lib/ui/__tests__/steps.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createStepRunner, withSpinner } from "../steps.ts";
import { T, toAnsiFg } from "../../tui/palette.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
let out: string[];
const realWrite = process.stdout.write;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-steps-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  out = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("run streams start/done with the done title and hint, and returns the task result", async () => {
  const steps = createStepRunner();
  const r = await steps.run("fetching origin…", async () => 42, { done: "origin fetched", doneHint: "3 new commits" });
  expect(r).toBe(42);
  expect(sent()).toEqual([
    { t: "hello", protocol: 1 },
    { t: "start", title: "fetching origin…" },
    { t: "done", title: "origin fetched", hint: "3 new commits" },
  ]);
});

test("run streams fail with the error message and rethrows", async () => {
  const steps = createStepRunner();
  await expect(steps.run("pushing…", async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
  expect(sent().at(-1)).toEqual({ t: "fail", title: "pushing failed", hint: "rejected" });
});

test("done title defaults to the pending title without its ellipsis", async () => {
  const steps = createStepRunner();
  await steps.run("rebasing…", async () => undefined);
  expect(sent().at(-1)).toEqual({ t: "done", title: "rebasing" });
});

test("log between steps prints a palette-colored line to stdout and spawns nothing", async () => {
  const steps = createStepRunner();
  steps.log("diverged from origin/main", "warn");
  expect(out.join("")).toContain("diverged from origin/main");
  expect(out.join("")).toContain(toAnsiFg(T.peach));
  expect(() => readFileSync(record)).toThrow();
});

test("withSpinner maps doneLabel/failLabel", async () => {
  await withSpinner("fetching origin…", async () => 1, { doneLabel: "origin fetched" });
  expect(sent().at(-1)).toEqual({ t: "done", title: "origin fetched" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/ui/__tests__/steps.test.ts`
Expected: FAIL, cannot resolve `../steps.ts`.

- [ ] **Step 3: Write `lib/ui/steps.ts`**

```ts
/**
 * Step runner: one rt-ui spawn per step so nothing is alive between steps.
 * Static log lines between steps are the one presentation TS keeps; they
 * use the palette's truecolor so they match the helper's theme.
 */
import { T, toAnsiFg } from "../tui/palette.ts";
import { openStep } from "./spawn.ts";

type StepStyle = "info" | "warn" | "error" | "success";

export interface StepRunner {
  /** Run an async step with spinner then done/error transition. */
  run<T>(
    pending: string,
    task: () => Promise<T>,
    opts?: { done?: string; doneHint?: string; errorHint?: string },
  ): Promise<T>;

  /** Print a static line between steps. */
  log(message: string, style?: StepStyle): void;
}

const RESET = "\x1b[0m";
const GLYPH: Record<StepStyle, string> = {
  success: `${toAnsiFg(T.mint)}✓${RESET}`,
  error: `${toAnsiFg(T.coral)}✗${RESET}`,
  warn: `${toAnsiFg(T.peach)}⚠${RESET}`,
  info: `${toAnsiFg(T.dim)}•${RESET}`,
};

function stripEllipsis(s: string): string {
  return s.replace(/…$/, "");
}

export function createStepRunner(): StepRunner {
  return {
    async run<T>(pending, task, opts) {
      const step = openStep(pending);
      try {
        const r = await task();
        await step.done(opts?.done ?? stripEllipsis(pending), opts?.doneHint);
        return r;
      } catch (e) {
        const hint = opts?.errorHint ?? (e instanceof Error ? e.message : undefined);
        await step.fail(opts?.done ?? `${stripEllipsis(pending)} failed`, hint);
        throw e;
      }
    },

    log(message, style = "info") {
      process.stdout.write(`  ${GLYPH[style]} ${toAnsiFg(T.textSoft)}${message}${RESET}\n`);
    },
  };
}

/** Legacy wrapper; use createStepRunner() for new code. */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  opts?: { doneLabel?: string; failLabel?: string },
): Promise<T> {
  return createStepRunner().run(label, task, { done: opts?.doneLabel, errorHint: opts?.failLabel });
}
```

Note: `T.textSoft` does not exist in `palette.ts` yet; add it beside `muted`: `textSoft: [210, 205, 235] as const, // #D2CDEB`. (`muted` already has that value; keep both names, `textSoft` is the token-sheet name.)

- [ ] **Step 4: Grep callers for writes inside a task**

Run: `grep -n 'steps.run\|withSpinner(' commands/sync.ts commands/git/reset.ts commands/git/rebase.ts`
Expected: each task closure is a bare `gitAsync(...)` call (no `process.stdout.write`, no `console.log`, no `steps.log` inside the closure). This is the case today; if any future caller prints inside a task, move the print to `steps.log()` after the step.

- [ ] **Step 5: Run the tests and the whole TS gate**

Run: `bun test lib/ui/__tests__/steps.test.ts && bunx tsc --noEmit && bun test lib commands packages scripts`
Expected: PASS; tsc 0 errors (the shim now resolves). Any test that previously rendered an Ink prompt and now spawns rt-ui must set `RT_UI_BIN` to the fake; find them with the failure output and add the two env lines from `prompts.test.ts`'s `beforeEach`.

- [ ] **Step 6: Commit**

```bash
git add lib/ui/steps.ts lib/ui/__tests__/steps.test.ts lib/tui/palette.ts
git commit -m "ui: step runner on rt-ui steps verb; palette log lines

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 12: Remove Ink from the bundle

**Files:**
- Modify: `package.json`, `bun.lock`, `lib/__tests__/no-eager-tui.test.ts:50`

- [ ] **Step 1: Prove nothing imports Ink or React any more**

Run: `grep -rln "from \"ink\"\|from \"react\"\|@inkjs/ui\|from \"react/" lib commands cli.ts scripts --include='*.ts' --include='*.tsx' | grep -v __tests__`
Expected: no output. (If a file appears, it is a missed importer: re-point it at `lib/ui/prompts.ts` / `lib/ui/steps.ts` and re-run.)

- [ ] **Step 2: Remove the dependencies**

In `package.json`, delete from `dependencies`: `ink`, `react`, `@inkjs/ui`; from `devDependencies`: `@types/react`, `react-devtools-core`. Run `bun install`.

- [ ] **Step 3: Extend the daemon-graph guard**

In `lib/__tests__/no-eager-tui.test.ts` line 50, change the banned set to:
```ts
  const bannedRelativeBasenames = new Set(["repo-arg.ts", "repo.ts", "fzf.ts", "fzf-select.ts", "rt-render.tsx", "spawn.ts", "prompts.ts", "steps.ts"]);
```
(`find lib commands -name spawn.ts -o -name prompts.ts -o -name steps.ts` must list only the three files under `lib/ui/`; if a same-named file exists elsewhere, rename the rt-ui one to `rt-ui-spawn.ts` etc. and update imports.)

- [ ] **Step 4: Run every gate plus the startup bench**

Run: `bunx tsc --noEmit && bun test lib commands packages scripts && bun run docs:check && bun run picker:check && bun build --compile --target=bun-darwin-arm64 ./cli.ts --outfile dist/rt && bun scripts/bench-startup.ts`
Expected: all green; the bench prints a median at or below the previous baseline (record the number in the commit message).

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock lib/__tests__/no-eager-tui.test.ts
git commit -m "drop ink, react, @inkjs/ui from the bundle (rt --version median: <N>ms)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 13: Distribution wiring (checks, release, bundle, clean-room assertion)

**Files:**
- Modify: `.github/workflows/checks.yml`, `.github/workflows/release.yml`, `rt-tray/build.sh:154-175` and the signing loop near line 396, `rt-tray/check-bundle.sh` (after `check_helpers`), `CLAUDE.md`

- [ ] **Step 1: checks.yml gains Go**

After the `oven-sh/setup-bun@v2` step add:
```yaml
      - uses: actions/setup-go@v5
        with:
          go-version-file: ui/go.mod
          cache-dependency-path: ui/go.sum
```
After the `Unit tests` step add:
```yaml
      # The Go helper's own vet + tests, plus the shared protocol fixtures
      # both languages golden-test (lib/ui/__tests__/protocol.test.ts runs
      # in the unit-test step above).
      - name: rt-ui vet and tests
        run: bun run ui:test
```

- [ ] **Step 2: release.yml builds the helper**

After the `Compile rt (arm64)` step add:
```yaml
      - uses: actions/setup-go@v5
        with:
          go-version-file: ui/go.mod
          cache-dependency-path: ui/go.sum
      - name: Build rt-ui (arm64)
        run: bun run ui:build
        env:
          RT_VERSION: ${{ steps.meta.outputs.tag }}
          GOOS: darwin
          GOARCH: arm64
```

- [ ] **Step 3: build.sh embeds and signs it**

In `rt-tray/build.sh`, after the `Embed rt` block (after the `fi` that closes `if [ "$IS_DEV" = true ]`), add:

```bash
# ─── Embed rt-ui (Contents/Helpers/rt-ui) ─────────────────────────────────────
# A first-party helper built from ui/, not a deps.lock row: same signing pass
# as the downloaded helpers, no url/sha256. Dev bundles run from source and
# resolve ui/dist/rt-ui directly, so they carry none.
if [ "$IS_DEV" != true ]; then
    RT_UI_SRC="${RT_UI_BIN:-$REPO_DIR/ui/dist/rt-ui}"
    if [ -f "$RT_UI_SRC" ] && file -b "$RT_UI_SRC" | grep -q "Mach-O"; then
        cp "$RT_UI_SRC" "$CONTENTS/Helpers/rt-ui"; chmod +x "$CONTENTS/Helpers/rt-ui"
        xattr -cr "$CONTENTS/Helpers/rt-ui" 2>/dev/null || true
        HELPER_ENTITLEMENTS+=("$CONTENTS/Helpers/rt-ui	none")
        echo "  ✓ Embedded rt-ui from $RT_UI_SRC"
    else
        echo "  ✗ rt-ui not built at $RT_UI_SRC ... bun run ui:build (or set RT_UI_BIN)"; exit 1
    fi
fi
```
`HELPER_ENTITLEMENTS` is declared before `bundle_helpers`; this block must sit after `bundle_helpers` has run (it does, since the Embed rt block is later in the file) and before the signing loop, which already iterates `HELPER_ENTITLEMENTS`.

- [ ] **Step 4: check-bundle.sh asserts it**

In `rt-tray/check-bundle.sh`, inside `check_helpers` after the deps.lock loop ends, add:

```bash
    # First-party helper (built from ui/, not a deps.lock row).
    local rtui="$app/Contents/Helpers/rt-ui"
    if [ -f "$rtui" ]; then
        pass "$exe ships Helpers/rt-ui"
        assert_eq "$exe rt-ui codesign identifier" "Identifier=com.mattstack.helper.rt-ui" "$(codesign -dv "$rtui" 2>&1 | grep '^Identifier=' || true)"
        "$rtui" --version 2>/dev/null | grep -q '^rt-ui .* protocol 1$' && pass "$exe rt-ui answers --version with protocol 1" || fail "$exe rt-ui --version did not report protocol 1"
    else
        fail "$exe missing Helpers/rt-ui"
    fi
```
(The dev bundle path in `check-bundle.sh` must skip this: guard with the same `IS_DEV`/bundle-id check the script uses for the dev flavor, or key on `[ "$exe" = mattstack ]`.)

- [ ] **Step 5: CLAUDE.md pointer**

Add to `CLAUDE.md` after the "rt chat" section:

```markdown
## rt-ui

rt's prompts and step spinners render through a bundled Go helper
(`ui/`, binary `rt-ui`, `Contents/Helpers/rt-ui`) driven over NDJSON on
stdin/stdout with `/dev/tty` for the screen. Before touching `lib/ui/*`,
`ui/`, or the prompt facade, read
`docs/superpowers/specs/2026-08-29-rt-ui-bridge-design.md`: the protocol,
the exit-code contract, the never-spawn-without-a-TTY gate, and why the
source checkout outranks the installed bundle when resolving the binary.
`bun run ui:build` after any change under `ui/`; the shared fixtures in
`ui/fixtures/` are golden-tested from both languages.
```

- [ ] **Step 6: Local dry run of the bundle path**

Run: `bun run ui:build && RT_REQUIRE_DEPS=0 rt-tray/build.sh debug 2>&1 | grep -E 'rt-ui|Helpers' ; ls -la rt-tray/rt-tray.app/Contents/Helpers/ 2>/dev/null || ls -la rt-tray/mattstack.app/Contents/Helpers/`
Expected: the log shows `✓ Embedded rt-ui` and `✓ Signed Helpers/rt-ui`, and the Helpers dir lists `rt-ui`. Never touch `/Applications/mattstack.app` or `rt-tray/mattstack-dev.app`; the `debug` mode builds into the scratch `rt-tray/` output only.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/checks.yml .github/workflows/release.yml rt-tray/build.sh rt-tray/check-bundle.sh CLAUDE.md
git commit -m "release: build, bundle, sign and assert the rt-ui helper; CLAUDE.md pointer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 14: Bench the real helper on the v2 stack

**Files:**
- Create: `ui/BENCH.md`
- Create: `scripts/bench-rt-ui.py`

- [ ] **Step 1: Write the bench script**

`scripts/bench-rt-ui.py` (a trimmed copy of the spike's harness: the prompt spec goes down a stdin pipe, the pty is the tty):

```python
#!/usr/bin/env python3
"""Spawn -> first paint for `rt-ui prompt` on a 120x40 pty. Run after
`bun run ui:build`. Reports min/median over N runs."""
import fcntl, os, pty, select, struct, subprocess, sys, termios, time

BIN = sys.argv[1] if len(sys.argv) > 1 else "ui/dist/rt-ui"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 10
SPEC = '{"t":"prompt","protocol":1,"kind":"select","title":"Access duration","options":[{"value":"1h","label":"1 hour"},{"value":"4h","label":"4 hours"}]}\n'

def answer_queries(master, chunk):
    if b"\x1b]11;?" in chunk:
        os.write(master, b"\x1b]11;rgb:1616/1212/2424\x1b\\")
    if b"\x1b[6n" in chunk:
        os.write(master, b"\x1b[1;1R")

def run_once():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    err_r, err_w = os.pipe()
    env = dict(os.environ, RT_UI_BENCH="1", TERM="xterm-256color", COLORTERM="truecolor")
    t0 = time.monotonic_ns()
    proc = subprocess.Popen([BIN, "prompt"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err_w,
                            env=env, close_fds=True, preexec_fn=os.setsid)
    # the pty must be the controlling tty for /dev/tty to resolve
    os.close(slave); os.close(err_w)
    proc.stdin.write(SPEC.encode()); proc.stdin.flush()
    first = None; errbuf = b""; deadline = time.monotonic() + 10
    while first is None and time.monotonic() < deadline:
        r, _, _ = select.select([master, err_r], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 65536); answer_queries(master, chunk)
            except OSError:
                break
        if err_r in r:
            chunk = os.read(err_r, 4096)
            if not chunk: break
            errbuf += chunk
            if b"first-paint" in errbuf:
                first = (time.monotonic_ns() - t0) / 1e6
    os.write(master, b"\r")
    try: proc.wait(timeout=3)
    except subprocess.TimeoutExpired: proc.kill()
    for fd in (master, err_r):
        try: os.close(fd)
        except OSError: pass
    return first

samples = [s for s in (run_once() for _ in range(RUNS)) if s is not None]
if not samples:
    print("no first-paint observed; is the pty the controlling tty? (see the preexec/ctty note in the plan)"); sys.exit(1)
samples.sort()
print(f"rt-ui prompt first-paint ms: min={samples[0]:.0f} median={samples[len(samples)//2]:.0f} max={samples[-1]:.0f} (n={len(samples)})")
```

If `/dev/tty` cannot be opened because the child has no controlling terminal under `preexec_fn=os.setsid`, replace that line with `preexec_fn=lambda: (os.setsid(), fcntl.ioctl(slave, termios.TIOCSCTTY, 0))` and move `os.close(slave)` after `Popen` returns (it already is). The Go test helper in Task 6 solved the same problem with `creack/pty`; the two must agree on the answer.

- [ ] **Step 2: Run it and record**

Run: `bun run ui:build && python3 scripts/bench-rt-ui.py ui/dist/rt-ui 10`
Expected: a line like `rt-ui prompt first-paint ms: min=.. median=.. max=..`. The spec's budget is a median under 40 ms. If it is over, the first suspects are an init-time terminal probe (confirm `tea.WithColorProfile` short-circuits the OSC 11 query in v2; if it does not, `go doc charm.land/bubbletea/v2 WithEnvironment` and set `TERM`-based detection) and huh's help rendering; measure again after each change.

Create `ui/BENCH.md`:

```markdown
# rt-ui bench

Measured with `scripts/bench-rt-ui.py` on the machine named below, 120x40 pty,
`rt-ui prompt` with a two-option select. Re-run after any change to
`cmd/rt-ui` or `internal/prompt`.

| date | stack | machine | first-paint ms (min / median / max) |
|---|---|---|---|
| <today> | bubbletea v2.0.9, lipgloss v2.0.6, huh v2.0.3 | <hostname, chip> | <min> / <median> / <max> |

Budget from the spec: median under 40 ms. Spike baseline (bubbletea v1.3.10,
throwaway board, not this binary): 22 / 24 ms.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/bench-rt-ui.py ui/BENCH.md
git commit -m "ui: bench harness and recorded first-paint numbers on the v2 stack

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage (bridge spec, phases 0 and 1):**
- Goal / non-goals: fzf untouched (no task edits `fzf-select.ts`, `navigate.ts`, `command-tree.ts` pickers); Go not the entrypoint (launcher stays Bun); no widget tree (prompt spec has no style fields, Task 10 test asserts no `color`); `rt status` deleted (Task 1).
- Stack pinned: Task 4 `go get` with exact versions; `charm.land` paths throughout.
- Topology, gate, EOF liveness, SIGPIPE: Tasks 6 (`WatchStdinEOF`, `signal.Ignore(SIGPIPE)` in main), 9 (stdin kept open, tested).
- Three verbs: `prompt` Task 6, `steps` Task 7; `session` is phase 2 (out of scope, stated in header).
- Protocol: Tasks 3/4 fixtures + both decoders; exit codes in `main.go` and `spawn.ts` mapping (Task 9 tests 0/130/131/2/70).
- Rendering contract: card + header (theme.Card / KeybindHeader), collapse line (Task 6 `writeCollapsed`, asserted), inline for prompts/steps (no alt screen anywhere in this plan), truecolor via `WithColorProfile`.
- TS side: facade signatures frozen (Task 10 tests), `destructive` added, `stderr` ignored, `rt-render.tsx` shim, `lib/ui/*` modules, exit hook kill (Task 9 `killLiveOnExit`), `openStep` handle name.
- Go side layout: matches the spec's tree minus `session`/`views` (phase 2).
- Lifecycle: restore on EOF/panic/signals (Bubble Tea handles panics/signals inside `form.Run`; EOF watcher restores cursor + resets attributes before exit); TS-dies test (Task 6 `TestParentDeathRestoresTerminal`).
- Distribution: first-party helper, `ui:build`, `.gitignore`, checks + release workflows, build.sh copy + sign, check-bundle assertion, resolution ladder with source-first (Task 8 tests), version banner (`--version`).
- Performance budget: Task 14 bench with the 40 ms gate; fast-step no-flash (Task 7 test).
- Migration table: phase 0 = Tasks 1-2, phase 1 = Tasks 3-14, deletions match the spec's "keep" list.
- Testing: shared fixtures (3/4), fake-rt-ui with shebang + exec bit (9), pty black-box (6/7), exit mapping (9), bench (14).
- Risks: model creep guarded by the no-color test; drift guarded by `--version`/protocol checks and fixtures.

**Placeholder scan:** Task 14's BENCH.md has `<today>`/`<min>` slots that the same task fills from the measured run; the commit step cannot pass with them unfilled (the table row is the deliverable). No TBD/TODO elsewhere.

**Type consistency:** `PromptSpec`/`PromptResult`/`StepEvent` (TS) mirror `protocol.PromptSpec`/`Result`/`StepEvent` (Go) field-for-field via the fixtures. `openStep(title)` in Task 9 is what Task 11 calls; `StepHandle.done/fail(title?, hint?)` match. `resolveRtUi` (Task 8) is what `spawn.ts` imports (Task 9). `theme.Huh/SpinnerFrames` and the glyph consts (Task 5) are what Tasks 6/7 use; the card is the huh theme's `Group.Base`, so no separate `Card` helper exists. `T.textSoft` is added in Task 11 before use.
