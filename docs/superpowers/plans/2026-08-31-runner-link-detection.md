# Runner Link Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner detects the loopback URL a command serves, shows it on the board, and opens it with `o`; detection scans a generous scrollback window continuously and is honest when no URL is found.

**Architecture:** A pure `detectUrl` on the scrollback text, a latched `url` field carried on the existing wire model and golden fixtures, scanning folded into the existing `pollLiveness` (no new timer), a new `open` intent + injected `openUrl` dep, and a Go board URL cell + tail-header status.

**Tech Stack:** Bun 1.3.x + TypeScript (`lib/runner`, `commands`, `lib/ui`), Go + Bubble Tea (`ui/internal/views/board`).

**Spec:** docs/superpowers/specs/2026-08-31-runner-link-detection-design.md

## Global Constraints

- Never use em dashes or en dashes; never write "load bearing"; comments state constraints only, not narration. Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Wire contract: any `BoardEntry` (protocol.ts) / Go `Entry` (model.go) field change ships with the matching `ui/fixtures/*.json` update in the SAME task; the fixtures are golden-tested from Go.
- Detection uses the existing liveness poll and `engine.read`; NO new timer, NO daemon call, NO herdr logic outside `engine.ts`.
- Tests drive injected fakes (fake engine, fake `openUrl`, controllable now/sleep); NEVER a real herdr socket, a real `rt-ui` spawn, or a real browser open.
- Gates: `bunx tsc --noEmit`, `bun test lib/runner commands`, `bun run picker:check`, `bun run docs:check`; for `ui/` changes also `bun run ui:build` and `go test ./...` in `ui/`.
- Branch `feat/runner-link-detection`, stacked off `rt-runner-board` (PR #140). Rebase onto `main` after #140 merges.

---

## File Structure

- `lib/runner/state.ts`: add `detectUrl`, `Entry.url`, wire `url` through `newEntry`/`toModel`.
- `lib/ui/protocol.ts`: `BoardEntry.url`; add `"open"` to `SESSION_INTENT_NAMES`.
- `lib/runner/runner.ts`: scan in `pollLiveness`, clear on `restart`, `RunnerDeps.openUrl`, handle `"open"`.
- `commands/runner.ts`: default `openUrl` in `buildRunnerDeps`.
- `ui/internal/views/board/model.go`: `Entry.Url *string`.
- `ui/internal/views/board/board.go`: `o` keybind emits `open` intent.
- `ui/internal/views/board/render.go`: URL cell on the row + tail-header link status.
- `ui/fixtures/*.json`: the board model fixture gains `url` on entries.

---

### Task 1: `detectUrl` (pure)

**Files:**
- Modify: `lib/runner/state.ts`
- Test: `lib/runner/__tests__/detect-url.test.ts` (new)

**Interfaces:**
- Produces: `export function detectUrl(text: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { detectUrl } from "../state.ts";

test("detects a Vite Local banner", () => {
  expect(detectUrl("  VITE ready\n  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
});
test("detects a bare 127.0.0.1 url with port", () => {
  expect(detectUrl("listening http://127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api");
});
test("prefers localhost over a LAN network address", () => {
  const t = "Network: http://192.168.1.20:3000/\nLocal:   http://localhost:3000/";
  expect(detectUrl(t)).toBe("http://localhost:3000/");
});
test("rewrites 0.0.0.0 to localhost", () => {
  expect(detectUrl("started server on http://0.0.0.0:3000")).toBe("http://localhost:3000");
});
test("ignores a real documentation domain", () => {
  expect(detectUrl("for help see https://vitejs.dev/config/")).toBeNull();
});
test("ignores a loopback host with no port", () => {
  expect(detectUrl("open http://localhost/")).toBeNull();
});
test("returns null when there is no url", () => {
  expect(detectUrl("compiling...\nbuilt in 1.2s")).toBeNull();
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test lib/runner/__tests__/detect-url.test.ts`
Expected: FAIL (`detectUrl` not exported).

- [ ] **Step 3: Implement in `lib/runner/state.ts`**

```ts
// A loopback/LAN dev-server URL, port required. Non-loopback hosts (real
// domains in doc links) never match; 0.0.0.0 is rewritten to localhost
// because browsers do not reliably route it.
const URL_RE = /https?:\/\/(\[::1\]|[a-zA-Z0-9.\-]+):(\d+)(\/[^\s'"()]*)?/g;
const LOOPBACK_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function detectUrl(text: string): string | null {
  const hits: { host: string; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const host = m[1]!;
    if (!LOOPBACK_HOST.test(host)) continue;
    hits.push({ host, url: m[0]! });
  }
  if (hits.length === 0) return null;
  const pick =
    hits.find((h) => h.host === "localhost" || h.host === "127.0.0.1") ??
    hits.find((h) => h.host === "0.0.0.0") ??
    hits[0]!;
  return pick.url.replace("://0.0.0.0", "://localhost");
}
```

- [ ] **Step 4: Run the test**

Run: `bun test lib/runner/__tests__/detect-url.test.ts` and `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/state.ts lib/runner/__tests__/detect-url.test.ts
git commit -m "runner: detectUrl pure scrollback loopback-url detector"
```

---

### Task 2: `url` field on the wire and fixtures

**Files:**
- Modify: `lib/runner/state.ts`, `lib/ui/protocol.ts`, `ui/internal/views/board/model.go`
- Modify (fixture): the board model fixture under `ui/fixtures/` (find it: the JSON whose shape matches `BoardModel` with an `entries` array; likely `session-model-board.json`)
- Test: extend `lib/runner/__tests__/state.test.ts`; the Go golden decode test that already reads the fixture

**Interfaces:**
- Consumes: nothing new.
- Produces: `Entry.url: string | null`; `BoardEntry.url: string | null`; Go `Entry.Url *string`. `newEntry` sets `url: null`; `toModel` maps `url`.

- [ ] **Step 1: Write the failing test** (append to `lib/runner/__tests__/state.test.ts`)

```ts
test("newEntry starts with a null url and toModel carries it", () => {
  const e = newEntry(1, "dev", "bun run dev", "/repo/web", "web", "acme");
  expect(e.url).toBeNull();
  e.url = "http://localhost:3000";
  const m = toModel("ws", [e]);
  expect(m.entries[0]!.url).toBe("http://localhost:3000");
});
```

(Match the existing import style at the top of `state.test.ts` for `newEntry`/`toModel`.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test lib/runner/__tests__/state.test.ts -t "null url"`
Expected: FAIL (`url` not on `Entry`).

- [ ] **Step 3: Implement**

- `lib/runner/state.ts`: add `url: string | null;` to `Entry`; in `newEntry` add `url: null` to the returned object; in `toModel`'s entry map add `url: e.url`.
- `lib/ui/protocol.ts`: add `url: string | null;` to `BoardEntry` (after `error`, before `tail`, to match field order used in the fixture).
- `ui/internal/views/board/model.go`: add `Url *string \`json:"url"\`` to `Entry` (a pointer so `null` decodes cleanly).
- The board model fixture: add `"url": null` (and, on at least one entry, `"url": "http://localhost:3000"`) to each entry object so the golden decode still round-trips and the Go side has a non-null case to exercise.

- [ ] **Step 4: Run the tests + gates**

Run: `bun test lib/runner`, `bunx tsc --noEmit`, then in `ui/`: `go test ./...`
Expected: PASS (Go decode of the updated fixture round-trips `Url`).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/state.ts lib/ui/protocol.ts ui/internal/views/board/model.go ui/fixtures
git commit -m "runner: carry a per-entry url on the wire model and fixtures"
```

---

### Task 3: scan in `pollLiveness`, clear on `restart`

**Files:**
- Modify: `lib/runner/runner.ts`
- Test: extend `lib/runner/__tests__/runner.test.ts`

**Interfaces:**
- Consumes: `detectUrl` (Task 1), `Entry.url` (Task 2), `engine.read`.
- Produces: latched URL detection folded into `pollLiveness`; `restart` clears `url`.

- [ ] **Step 1: Write the failing test** (append to `runner.test.ts`, reusing the file's `FakeEngine`/`FakeSession`/`deps()` and `__test__.pollLiveness`)

```ts
test("pollLiveness latches a url from pane output and does not rescan once found", async () => {
  // Fake engine whose read() returns a Vite banner; count read calls per pane.
  // Launch one entry, run pollLiveness twice.
  // After the first pass: entry.url === "http://localhost:5173/".
  // After the second pass: the url-scan read is NOT issued again for that pane
  //   (assert the engine's url-scan read count for the pane stayed at 1).
});

test("restart clears a latched url so a new port is re-detected", async () => {
  // Given an entry with url set, call restart; assert entry.url === null
  // immediately after (before any new detection).
});
```

Model the FakeEngine's `read` to return the banner text, and follow the existing tests' way of driving a single `pollLiveness` pass via `__test__.pollLiveness(r)`. If the existing FakeEngine.read ignores its `lines` arg, add a small per-pane read-call counter to assert the "does not rescan" behavior; keep it in the test file's fake, not production code.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test lib/runner/__tests__/runner.test.ts -t "url"`
Expected: FAIL (no scanning yet).

- [ ] **Step 3: Implement in `lib/runner/runner.ts`**

- Add a constant near the others: `const URL_SCAN_LINES = 800;`.
- In `pollLiveness`, inside the existing `for (const e of this.entries)` loop, after the state-derivation block, add (still guarded by the same try/catch, and only when a pane exists):

```ts
if (e.url === null) {
  const scan = await this.deps.engine.read(e.paneId, URL_SCAN_LINES);
  const found = detectUrl(scan);
  if (found) e.url = found;
}
```

  Keep it inside the per-entry `try` so a read failure pins the entry like the rest of the loop. Latched entries (`e.url !== null`) skip the extra read. Do NOT add an early give-up: scanning continues every tick while `url === null`.
- Import `detectUrl` from `./state.ts` (add to the existing import).
- In `restart()`, alongside `e.error = null`, add `e.url = null;` so a new run re-detects.

- [ ] **Step 4: Run the tests + gates**

Run: `bun test lib/runner`, `bunx tsc --noEmit`
Expected: PASS (existing runner tests unchanged, new tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/runner.ts lib/runner/__tests__/runner.test.ts
git commit -m "runner: scan pane scrollback for a url each liveness tick, latch and clear on restart"
```

---

### Task 4: the `open` intent and the opener dep

**Files:**
- Modify: `lib/ui/protocol.ts`, `lib/runner/runner.ts`, `commands/runner.ts`, `ui/internal/views/board/board.go`
- Test: extend `lib/runner/__tests__/runner.test.ts`; extend `ui/internal/views/board/board_test.go`

**Interfaces:**
- Consumes: `Entry.url` (Task 2).
- Produces: `"open"` in `SESSION_INTENT_NAMES`; `RunnerDeps.openUrl: (url: string) => Promise<void>`; `runner.handle` `case "open"`; a default `openUrl` in `buildRunnerDeps`; the board `o` keybind.

- [ ] **Step 1: Write the failing tests**

TS (append to `runner.test.ts`): drive a fake session that emits `{ t: "intent", name: "open", entryId: "e1" }` for an entry whose `url` is set, with a fake `openUrl` recording its calls; assert `openUrl` was called once with the entry's url. A second test: an `open` intent for an entry with `url === null` does NOT call `openUrl`.

Go (append to `board_test.go`, following the file's existing keypress-emits-intent pattern): with a model whose selected entry has a non-nil `Url`, pressing `o` emits `Intent{Name: "open", EntryID: <selected>}`; with a nil `Url`, pressing `o` emits nothing.

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test lib/runner/__tests__/runner.test.ts -t "open"` and, in `ui/`, `go test ./internal/views/board/ -run Open`
Expected: FAIL (`"open"` rejected by `parseSessionLine`; no `o` binding; no handler).

- [ ] **Step 3: Implement**

- `lib/ui/protocol.ts`: add `"open"` to `SESSION_INTENT_NAMES` (the array the parser validates against). No other parser change needed (`entryId` is already carried).
- `lib/runner/runner.ts`: add `openUrl: (url: string) => Promise<void>;` to `RunnerDeps`. In `handle`, add before the `push()`:

```ts
case "open": {
  const e = this.find(intent.entryId);
  if (e?.url) {
    try {
      await this.deps.openUrl(e.url);
    } catch (err) {
      this.pin(e, err);
    }
  }
  break;
}
```

- `commands/runner.ts`: in `buildRunnerDeps`, add a default `openUrl`. Reuse an existing repo browser-opener if one exists (grep `commands/` and `lib/` for an `open`/`xdg-open` helper first); otherwise:

```ts
openUrl: async (url: string) => {
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
},
```

- `ui/internal/views/board/board.go`: in `key`, add a case:

```go
case "o":
  e := b.selectedEntry()
  if e == nil || e.Url == nil || *e.Url == "" {
    return b, nil
  }
  return b, b.em.Emit(protocol.Intent{Name: "open", EntryID: b.selected})
```

- [ ] **Step 4: Run the tests + gates**

Run: `bun test lib/runner commands`, `bunx tsc --noEmit`, `bun run picker:check`, and in `ui/` `go test ./...` and `bun run ui:build`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add lib/ui/protocol.ts lib/runner/runner.ts commands/runner.ts ui/internal/views/board/board.go ui/internal/views/board/board_test.go lib/runner/__tests__/runner.test.ts
git commit -m "runner: open the detected url with o via a new open intent and injected opener"
```

---

### Task 5: render the url on the board (SURFACING: option A, ratified)

**Files:**
- Modify: `ui/internal/views/board/render.go`, `ui/internal/views/board/model.go`
- Test: extend `ui/internal/views/board/board_test.go` / a render test in the same package

**Interfaces:**
- Consumes: `Entry.Url` (Task 2), the board's ticking `now` and `Entry.StartedAt`.

> GATE: surfacing is option A (ratified, Matt 2026-08-31): a row cyan cell for a found url + a tail-header link status (`detecting…` / found / `none found` after ~30s). Per the design-before-UI rule, the controller pauses before dispatching this task and produces a real board capture for Matt's sign-off before the branch merges.

- [ ] **Step 1: Write the failing test**

Render an entry with `Url = "http://localhost:3000"` and assert the rendered row contains `localhost:3000`. Render a running entry with `Url == nil` and `StartedAt` older than the give-up threshold with its tail open, and assert the tail header contains the honest `none found` text. Follow the existing `render`/`row`/`tailBox` test idiom in the package (they call `render(b)` / the row helpers against a constructed `Board`).

- [ ] **Step 2: Run it to make sure it fails**

Run (in `ui/`): `go test ./internal/views/board/ -run Url`
Expected: FAIL.

- [ ] **Step 3: Implement in `ui/internal/views/board/render.go`**

- Add `const urlGiveupSeconds = 30`.
- Add a helper `func hostPort(rawURL string) string` that trims the scheme and any trailing path from a detected url, yielding `host:port` for the row cell (e.g. `http://localhost:3000/` -> `localhost:3000`).
- In `row()`, when `e.Url != nil && *e.Url != ""`, render `hostPort(*e.Url)` in a cyan cell on the right (its own fixed-width column left of the status column; recompute `cmdW` to subtract the new column width, mirroring the existing `cmdW` arithmetic). When `e.Url == nil`, render an empty cell (no clutter).
- In `tailBox()`, replace the `refreshing 1s` right-hand text with the link status for `e`: `link: <host:port>` (cyan) when `e.Url` is set; else, when `e.State == "running"` and seconds-since-`StartedAt` `>= urlGiveupSeconds`, `link: none found` (muted); else `link: detecting…` (faint). Compute the elapsed seconds exactly as `Entry.uptime` does (parse `StartedAt` RFC3339 against `b.now`).

- [ ] **Step 4: Run the tests + gates**

Run (in `ui/`): `go test ./...` and `bun run ui:build`; then `bun run docs:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/internal/views/board/render.go ui/internal/views/board/board_test.go
git commit -m "board: show the detected url on the row and link status in the tail header"
```

---

## Self-Review

- Spec coverage: detect (T1), wire+fixtures (T2), continuous latched scan + reset (T3), open intent + opener (T4), surfacing (T5). All four resolved decisions and section 4 covered.
- Placeholder scan: each step carries concrete code or a concrete assertion target; T3/T5 tests describe exact assertions against the named fakes/helpers rather than pasting the whole fake.
- Type consistency: `Entry.url`/`BoardEntry.url`/`Entry.Url` introduced in T2 and consumed in T3/T4/T5; `detectUrl` defined in T1, consumed in T3; `openUrl`/`"open"` produced in T4; `RunnerDeps.openUrl` is set by `buildRunnerDeps` (T4) and consumed by `handle` (T4).
