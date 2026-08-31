# Runner link detection

## Goal

The runner detects the URL a command serves on (a dev server's
`http://localhost:PORT`) from its output, surfaces it on the board, and opens
it in the browser with a single `o` keypress. The URL is often NOT at the tail:
a monorepo build can print hundreds of lines before the server announces its
address, so detection scans a generous scrollback window continuously until it
finds one, and is honest in the UI when it has not.

## Background (current behavior)

- The runner (`lib/runner/runner.ts`) owns entries and polls herdr on two
  timers: `pollLiveness` (every 1500ms, visits EVERY entry, reads process info
  and, only when stopped, `engine.read(paneId, 50)` for the exit sentinel) and
  `pollTail` (every 1000ms, only the one entry whose tail box is open,
  `engine.read(paneId, 200)`).
- `engine.read(paneId, lines)` returns the last `lines` of pane scrollback with
  ANSI already stripped (`source: "recent_unwrapped"`, `strip_ansi: true`).
- The wire model (`lib/ui/protocol.ts`) is golden-tested from Go against
  `ui/fixtures/*.json`: a `BoardEntry` field change here without a matching
  fixture change is a contract break. `BoardEntry` today = `{ id, name,
  command, pkg, repo, state, startedAt, exitCode, error, tail }`.
- Intents are a closed set: `SESSION_INTENT_NAMES = ["add","restart","stop",
  "focus","tail","quit"]`. The Go board (`ui/internal/views/board/board.go`)
  emits them from keypresses; `parseSessionLine` validates the name against
  that set. `SessionIntent` already carries an optional `entryId`.
- The Go `Entry` (`model.go`) mirrors `BoardEntry`; `uptime(now)` already parses
  `startedAt` (RFC3339) against the board's own ticking `now`. `render.go`'s
  `row()` lays out prefix · glyph · name(10) · command(flex) · pkg·repo(24) ·
  right(14, uptime/status).

## Design

A latched, continuously-scanned URL per entry, detected in the TS runner,
carried on the wire, rendered by the Go board, and opened via a new intent.

### 1. Detect (pure)

`detectUrl(text: string): string | null` in `lib/runner/state.ts`. Loopback/LAN
HTTP URLs only, and only with an explicit port (the false-positive guard: a
doc link like `https://vitejs.dev/config` is never a server, and a
port-less host is not reliably openable):

- Host must be one of: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, or a
  private-range LAN IP (`10.*`, `192.168.*`, `172.16-31.*`).
- Port is REQUIRED (`:\d+`).
- Collect all matches in the text; pick the most openable: prefer
  `localhost`/`127.0.0.1`, then rewrite `0.0.0.0` to `localhost` (browsers do
  not reliably route `0.0.0.0`), then fall back to a LAN IP. Return the
  canonical openable URL (scheme+host+port+path).
- Any non-loopback/non-LAN host (a real domain) yields no match on its own.

This catches Vite (`➜  Local:   http://localhost:5173/`), Next
(`http://localhost:3000`), CRA, and bare `http://127.0.0.1:8080/...` with one
regex and no per-framework rules.

### 2. Latch and scan continuously

- `Entry` (state.ts) and `BoardEntry` (protocol.ts) gain `url: string | null`.
  `newEntry` initializes `url: null`; `toModel` maps it; the Go `Entry` gains
  `Url *string` and a fixture is updated.
- In `pollLiveness`, for each entry with `url == null` and a `paneId`, read a
  generous window `engine.read(paneId, URL_SCAN_LINES)` (URL_SCAN_LINES = 800)
  and run `detectUrl`; on a match, set `entry.url` and stop scanning that entry
  (latched, first match wins). This is one extra herdr read per un-latched
  entry per liveness tick; a latched entry costs nothing. The existing guarded
  polling prevents overlapping ticks.
- Scanning NEVER gives up while `url == null` (Matt, 2026-08-31): a two-minute
  build that finally prints its URL still latches it. The time limit is a
  DISPLAY concern only (see 4), not an end to scanning.
- `restart()` clears `entry.url = null` so a new port on the next run is
  re-detected.

### 3. Open (new intent)

- Add `"open"` to `SESSION_INTENT_NAMES` in protocol.ts (Go `Intent.Name` is a
  bare string; no Go struct change).
- Go board: `o` emits `Intent{Name: "open", EntryID: selected}` ONLY when the
  selected entry has a non-empty `Url` (otherwise a no-op, like `t`/`s` on an
  empty selection).
- `RunnerDeps` gains `openUrl: (url: string) => Promise<void>`. `runner.handle`
  gets a `case "open"`: find the entry, and if `e.url`, `await
  this.deps.openUrl(e.url)` (pin any error to the entry like other verbs).
- `buildRunnerDeps` (`commands/runner.ts`) provides the default opener. Reuse
  the repo's existing browser-opener if one exists; otherwise
  `Bun.spawn(["open", url])` (macOS). Tests inject a fake `openUrl` and assert
  it was called with the detected URL; NEVER spawn a real `open`.

### 4. Surface (board render): option A (ratified, Matt 2026-08-31)

The row-cell + tail-header split, which keeps rows clean for non-server
commands while staying honest where the user is looking:

- **Row, right side:** when `url != null`, show the host:port (e.g.
  `localhost:3000`) in a cyan cell, clipped. This is the openable payoff; `o`
  acts on the selected row.
- **Tail-box header:** for the focused entry, show the full detection status:
  `link: localhost:3000` (found, cyan) · `link: detecting…` (running, `url ==
  null`, within URL_GIVEUP display window) · `link: none found` (running, `url
  == null`, past URL_GIVEUP_SECONDS, muted). URL_GIVEUP_SECONDS (~30) is a Go
  display threshold computed from `startedAt` vs the board's `now`, exactly like
  `uptime`. Scanning continues underneath regardless, so `none found` upgrades
  to the URL live if it appears late.

Rows show nothing in the URL cell for a command that never serves; the honest
"none found" lives in the tail peek, which the user opens on a command they are
actually waiting on. A layout mock and the alternative (honest label inline on
every running row) are in Open decisions.

```
  ● dev        bun run dev              acme-web · acme      localhost:3000  1:04
  ● api        node server.js           acme-api · acme      localhost:4000  1:04
  ◐ worker     turbo run build          acme-jobs · acme                     0:31

  ╭─ tail · dev ──────────────  link: localhost:3000 · refreshing 1s ─╮
```

## Behavior

- Start a dev server on the board; within a poll or two of it printing its
  address, `localhost:PORT` appears on its row. Press `o` on that row to open
  it. Restart re-detects (new port picked up).
- A command that prints its URL only after a long build: the row stays blank in
  the URL cell, the tail header reads `detecting…` then `none found` after the
  threshold, and flips to the URL the moment the build finishes and the server
  announces.
- A command that never serves: URL cell always blank; the tail header reads
  `none found` after the threshold (honest, and only visible when tailed).

## Contracts preserved

- Detection reuses the existing liveness poll and `engine.read`; no new timer,
  no daemon call, no herdr logic outside `engine.ts`.
- The wire stays golden-tested: every `BoardEntry`/`Entry` field change ships
  with a `ui/fixtures/*.json` update in the same task.
- `run()` still resolves only after the session ends and teardown ran, and
  never calls `process.exit`.
- The board's two locked contracts hold (quit via `tea.Sequence`; `stopping`
  held until `__rt_exit`). The `o` keybind is a no-op in the confirm layer.
- Tests drive injected fakes (fake engine, fake `openUrl`, controllable
  now/sleep). NEVER a real herdr socket, a real `rt-ui` spawn, or a real
  browser open.

## Non-goals

- No per-framework parsing, no HTTP probing of the detected URL, no HTTPS cert
  handling. Regex on the scrollback only.
- No persistence of URLs across board sessions.
- Not detecting non-HTTP endpoints (databases, gRPC).
- No change to preset save/load or to `rt run` resolution.

## Global constraints

- Bun 1.3.x + TypeScript; Go for `ui/`. Never use em dashes or en dashes; never
  write "load bearing"; comments state constraints, not narration. Commit
  trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gates: `bunx tsc --noEmit`, `bun test lib/runner commands`, `bun run
  picker:check`, `bun run docs:check`, and (for `ui/` changes) `bun run
  ui:build` plus `go test ./...` in `ui/`.
- Branch `feat/runner-link-detection`, stacked off `rt-runner-board` (PR #140).
  Rebase onto `main` after #140 merges.

## Open decisions

- RESOLVED: continuous scan, no give-up; time limit governs the honest label
  only (Matt, 2026-08-31).
- RESOLVED: `o` opens the URL in the browser (Matt, 2026-08-31).
- RESOLVED: loopback/LAN + explicit-port regex only, strict `http(s)://` (Matt,
  2026-08-31).
- RESOLVED: surfacing = option A, the row-cell + tail-header split (Matt,
  2026-08-31), over an honest inline label on every running row. The
  design-before-UI rule still applies: Task 5 pauses and the SDD's final review
  produces a real board capture for sign-off before merge.
