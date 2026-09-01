# rt Picker Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every fzf surface in rt with one core picker component in rt-ui (Go/Bubble Tea) plus thin TS wrappers, and fully retire fzf.

**Architecture:** A new one-shot `rt-ui pick` verb renders a board-styled picker (fzf's FuzzyMatchV2 imported headless for ranking); TS keeps one core (`lib/ui/pick.ts`) behind the existing wrapper names so 46 call sites don't churn. Live pickers receive `update` state patches; TS-logic actions round-trip as `event`s; submenus are `modal` overlays. Big-bang cutover deletes all fzf plumbing.

**Tech Stack:** Go (bubbletea v2.0.9, lipgloss v2.0.6 canvas/layer, huh v2 theme tokens), `github.com/junegunn/fzf/src/algo` (pinned), Bun/TypeScript, NDJSON over stdio.

**Spec:** `docs/superpowers/specs/2026-08-31-rt-picker-redesign-design.md` (Approved after a 5-round adversarial review). **Visual contract:** `docs/design/picker/` — every rendered surface is scrutinized against those boards; deviations are fixed or ratified by updating the board in the same change.

## Global Constraints

- Big bang: at cutover no fzf spawn path remains; the deletion inventory in the spec ("Deleted at cutover") is executed in full, including the patched fzf binary, `lib/nav-watch.ts`, rt-health's `tool.fzf` row + `LINK_BUNDLED_FZF`, `RT_FZF_ALT_SCREEN`, and the listed unit tests.
- Contracts preserved byte-identical: non-TTY/`--json`/`RT_BATCH` gates (picker-conformance stays green), `ctrl-up`=back everywhere (`BackNavigation` when `backLabel` set), `alt-enter`=with-args, `stderr: true` output discipline, exit codes.
- Sacred logic untouched: `commands/run.ts` (queue/presets/variations/resolve), `commands/cd.ts` decisions (two-step, auto-select-when-one), `lib/enrich.ts` data pipeline (it gains ONLY `formatBranchSegments`).
- The TS CLI stays UI-free (no ink/react/jsx/.tsx; `lib/__tests__/no-ui-in-cli.test.ts`).
- New command modules (none expected) would need `lib/module-registry.ts`; `rt-ui pick` is a Go verb, not a TS module.
- Theme: three new tokens exactly — `HoverBg #251E3D`, `Surface #221A35`, `Blue #6B9DFF`. `GlyphBar` untouched. Update the two stale theme.go comments (`Huh()`'s fzf comparison, `CardWidth`'s "fzf pickers stay full width").
- Wire messages: TS→Go `pick` / `update` (patch: any of `rows`, `message`, `actions`) / `modal`; Go→TS `event` / `modal-result` / terminal `result` exactly once. Every new message ships TS type + Go struct + golden fixture together (`ui/fixtures/`).
- Terminal-ownership rule: events = ctrl-t, ctrl-f, enter-on-file, cd ctrl-r, reveal, copy-path (picker stays live); exits = ctrl-o, Open with…, Quick Look, Open terminal here (result + optional re-invoke with resume).
- Viewport = min(caller cap [default 14], list length, pane height − chrome); content-anchored; 2-row scrolloff; wheel moves viewport only; footer range only when overflowing; no edge fades.
- No `|`/`!` search syntax. No preview panes. No emoji. Never em/en dashes in any output. Clean-code comments only. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (executor's model name if different).
- After any change under `ui/`: `bun run ui:build`. Never run the compiled `rt` binary outside an isolated HOME. Tests never touch live herdr/tmux/daemon or the real `~/.rt`.
- Gate per phase: `bun test <touched areas>`, `bun run tsc --noEmit`, `bun run picker:check`, and (Go) `cd ui && go test ./...`.

## Model tiering (per Matt's request)

- Controller: opus (`claude-opus-4-8[1m]`).
- Implementers: **sonnet** for all Go view tasks and TS core/wrapper tasks (integration-grade); **haiku is NOT used** (no pure-transcription tasks — code blocks here define contracts, not complete files).
- Task reviewers: **sonnet** for mechanical diffs (fixtures, deletions), **opus** for Phase 2-6 diffs (rendering, protocol, migrations).
- Final whole-branch review: **opus** minimum; fable if Matt has budget.

## File Structure (locked)

- `ui/internal/views/picker/` — `picker.go` (model/update), `render.go` (layout zones), `match.go` (fzf algo wrapper), `actions.go` (registry→keybar/menus/keymap), `modal.go` (overlay stack), `mouse.go`, `scroll.go` (pure viewport math), `picker_test.go` + golden tests.
- `ui/internal/theme/theme.go` — +3 tokens, 2 comment fixes.
- `ui/cmd/rt-ui/main.go` — `pick` verb wiring.
- `lib/ui/protocol.ts` — pick message types (mirrored Go structs in `ui/internal/wire/`, fixtures in `ui/fixtures/`).
- `lib/ui/pick.ts` (new) — spawn + stream + gates. `lib/ui/pick-fake.ts` (new, test double).
- `lib/pick-wrappers.ts` (new) — `filterableSelect`, `filterableMultiselect`, `runNavPicker`, arg-collector picker, re-exported from their current homes so import sites don't move.
- Rewritten in place: `lib/command-tree.ts` `showPicker`, `commands/commit.ts` picker, `commands/skills.ts` palette, `commands/nav.ts` loop (events model), `commands/cd.ts` (ctrl-r event; `formatBranchSegments` consumption), `lib/pickers.ts`.
- `lib/enrich.ts` — add `formatBranchSegments` only.
- Deleted: per the spec inventory (Phase 7 executes it verbatim).

## Phases

**Phase 0 — foundations:** Task 1 (fzf algo dep + match wrapper), Task 2 (theme tokens).
**Phase 1 — wire protocol:** Task 3 (TS types + Go structs + fixtures).
**Phase 2 — Go picker core:** Tasks 4-8 (scaffold+verb, list+filter+highlight, viewport/scroll, chrome zones, no-match/groups).
**Phase 3 — Go interactions:** Tasks 9-12 (actions/keybar/menus, modals, multi, mouse+modifiers).
**Phase 4 — TS core:** Task 13 (`pick.ts` + gates + fake).
**Phase 5 — wrappers:** Tasks 14-16 (select/multi, showPicker+arg-collector, runNavPicker).
**Phase 6 — surface migrations:** Tasks 17-21 (commit, skills, cd+segments, nav events rebuild, run/pickers polish).
**Phase 7 — cutover sweep:** Task 22 (deletion inventory + rt-health/deps + test fates + docs).
**Phase 8 — parity:** Task 23 (board-parity review + Ghostty captures + CLAUDE.md).

Tasks within a phase are sequential; phases are sequential (each phase leaves the tree green — fzf paths keep working until Phase 6 flips call sites, Phase 7 deletes).

---

### Task 1: Headless matcher (`ui/internal/views/picker/match.go`)

**Model:** sonnet. **Files:** Create `ui/internal/views/picker/match.go`, `match_test.go`. Modify `ui/go.mod` (add `github.com/junegunn/fzf v0.74.3` — pin exactly).

**Interfaces — Produces:**
```go
package picker
type Match struct { Index int; Score int; Positions []int }
// Rank returns matches sorted by score desc, then input order; empty query = all rows, no positions.
func Rank(query string, targets []string, exact bool) []Match
```

- [ ] Step 1: failing test `match_test.go`:
```go
func TestRankScoresAndPositions(t *testing.T) {
	ms := Rank("wprov", []string{"worktree provision", "create", "provision"}, false)
	if ms[0].Index != 0 || ms[0].Score == 0 || len(ms[0].Positions) != 5 { t.Fatalf("%+v", ms[0]) }
}
func TestRankEmptyQueryKeepsOrder(t *testing.T) {
	ms := Rank("", []string{"b", "a"}, false)
	if len(ms) != 2 || ms[0].Index != 0 || ms[1].Index != 1 { t.Fatalf("%+v", ms) }
}
func TestRankExactMode(t *testing.T) {
	if len(Rank("prov", []string{"worktree"}, true)) != 0 { t.Fatal("exact should not fuzz") }
}
```
- [ ] Step 2: `cd ui && go test ./internal/views/picker/` → FAIL (undefined Rank).
- [ ] Step 3: implement using `algo.Init("default")` once (sync.Once), `util.ToChars`, `algo.FuzzyMatchV2(false, true, true, &chars, []rune(query), true, nil)` (exact mode: `algo.ExactMatchNaive`). Case-insensitivity: lowercase both (smart-case is out of scope). Sort stable by (-Score, Index).
- [ ] Step 4: test → PASS. `go mod tidy`; verify `go.mod` pins v0.74.3.
- [ ] Step 5: commit `picker: headless fzf matcher (FuzzyMatchV2, pinned v0.74.3)`.

### Task 2: Theme tokens

**Model:** sonnet. **Files:** Modify `ui/internal/theme/theme.go`, `ui/internal/theme/theme_test.go`.

**Produces:** `theme.HoverBg` (#251E3D), `theme.Surface` (#221A35), `theme.Blue` (#6B9DFF).

- [ ] Step 1: failing test asserting `Hex(HoverBg)=="#251E3D"`, `Hex(Surface)=="#221A35"`, `Hex(Blue)=="#6B9DFF"`.
- [ ] Step 2: FAIL → Step 3: add the three vars beside the existing palette; rewrite the two stale comments: `Huh()`'s "the same edge rt's fzf pickers draw (--border=left, patched glyph)" → "the prompt bar edge" (drop the fzf comparison); `CardWidth`'s "The fzf pickers stay full width…" sentence → the picker card is content-anchored and does its own sizing.
- [ ] Step 4: `go test ./internal/theme/` PASS → Step 5: commit.

### Task 3: Wire protocol (TS + Go + fixtures)

**Model:** sonnet; reviewer opus. **Files:** Modify `lib/ui/protocol.ts`; Create `ui/internal/wire/pick.go` (or extend the existing wire structs file — match how board messages live); Create fixtures `ui/fixtures/pick-request.json`, `pick-update.json`, `pick-modal.json`, `pick-event.json`, `pick-modal-result.json`, `pick-result.json`; extend both golden tests (`lib/ui/__tests__/protocol-golden.test.ts` pattern and the Go side) the same way board fixtures are tested.

**Produces (verbatim TS; Go structs mirror with json tags):**
```ts
export interface PickSegment { text: string; tone?: string; hex?: string; bold?: boolean }
export interface PickRow { value: string; left: PickSegment[]; right?: PickSegment[]; match?: string; group?: string }
export interface PickAction { id: string; label: string; key?: string; scope: "item" | "global"; group?: string; primary?: boolean }
export interface PickRequest {
  kind: "pick"; message: string; breadcrumb?: string[]; rows: PickRow[]; actions?: PickAction[];
  multi?: boolean; initialValues?: string[]; initialQuery?: string; resumeValue?: string;
  exact?: boolean; cap?: number; selectedPanel?: boolean;
}
export interface PickUpdate { kind: "update"; rows?: PickRow[]; message?: string; actions?: PickAction[] }
export interface PickModal { kind: "modal"; message: string; rows: PickRow[] }
export interface PickEvent { kind: "event"; action: string; value: string | null; query: string }
export interface PickModalResult { kind: "modal-result"; value: string | null }
export interface PickResult { kind: "result"; action: string; value: string | null; values?: string[]; query: string }
```

- [ ] Step 1: fixtures written first (one realistic instance each — use the worktree palette rows from the Branch board); failing golden tests on both sides (TS parses fixture into the type; Go unmarshals into the struct and re-marshals byte-stably like the board fixtures do).
- [ ] Step 2: FAIL both sides → Step 3: add types/structs → Step 4: `bun test lib/ui` + `go test ./internal/wire/...` PASS → Step 5: commit.

### Task 4: Verb scaffold (`rt-ui pick`)

**Model:** sonnet. **Files:** Create `ui/internal/views/picker/picker.go`; Modify `ui/cmd/rt-ui/main.go` (add `pick` to usage + dispatch, same TTY gate and exit-code contract as `prompt`).

**Produces:** `picker.Run(req wire.PickRequest, input io.Reader, output io.Writer) error` — reads NDJSON messages from `input` after the initial request, writes exactly one `result` line to `output`. Program options: inline (NOT alt-screen — content-anchored), `tea.WithMouseAllMotion()`, keyboard enhancements with release events.

- [ ] Step 1: failing Go test: feeding a request with 2 rows and a scripted `tea` sequence (down, enter) through the model's `Update` yields `PickResult{action:"select", value:"b", query:""}` (test the model pure, not the pty).
- [ ] Steps 2-4: scaffold model struct `{req, query, cursor, viewportTop, matches []Match, selected map[string]bool, modal *modalState, held modifiers, hover int}`; wire main.go; PASS.
- [ ] Step 5: commit.

### Task 5: List + filter + highlight render

**Model:** sonnet; reviewer opus. **Files:** Create `ui/internal/views/picker/render.go`; extend `picker_test.go` with golden renders (strip-ANSI string compare like board tests).

Layout per the Branch/Filtering boards: breadcrumb line (`Text bold` segments joined by faint `›`, count right-justified — cyan matched-count when filtering), pink `❯ ` filter line with Faint placeholder `filter…`, Rule line, rows, Rule, keybar (Task 9 stubs it). Row: 1-col cursor gutter (`▌` pink on cursor row, space otherwise), SelBg full-row background on cursor, HoverBg on hover, left segments (tone/hex/bold via lipgloss), spacer, right segments pinned; matched chars re-styled cyan bold via `Match.Positions` mapped through the concatenated left text. Left clips with `…` ONLY at real overflow (`clip()` like the board's); right never clips.

- [ ] Step 1: golden test: 3-row request, query "re", 92-col width → assert breadcrumb text, `3/9`-style count, cursor row contains the highlighted label, right segment at line end.
- [ ] Steps 2-4: implement; PASS. Step 5: commit.

### Task 6: Viewport math (`scroll.go`, pure)

**Model:** sonnet. **Files:** Create `ui/internal/views/picker/scroll.go`, tests in `picker_test.go`.

**Produces:**
```go
// Viewport returns [top, top+h) given cursor, list length, caller cap, pane rows, chrome rows.
func Viewport(cursor, top, n, cap_, paneRows, chromeRows int) (newTop, h int)
```
Rules (spec verbatim): `h = min(cap_ or 14, n, paneRows-chromeRows)`; scrolloff 2 (cursor stays ≥2 from each visible edge where possible); wheel/pgup adjust `top` directly with cursor clamped into view by the caller.

- [ ] Step 1: table-driven failing tests: n=118 cap=14 pane=50 → h=14; cursor walking down keeps `cursor-top>=2` until list end; n=5 → h=5 (content-anchored); cap=40 pane=20 chrome=6 → h=14 (pane ceiling); resize recompute.
- [ ] Steps 2-5: implement, PASS, commit. Render integration (thumb rail 1-col Panel block sized `h*h/n`, footer range `4–17 of 118` only when `n>h`) lands in render.go in this same task with one golden test.

### Task 7: Chrome states (no-match, groups, empty-guard)

**Model:** sonnet. **Files:** `render.go`, `picker.go`, tests.

Per Filtering/RunChain boards: no-match = count `0/N`, inline faint `no matches` row, footer swaps to `backspace edit filter · esc quit`. `group` field renders a faint uppercase header line above its first row; headers are skipped by cursor movement *by construction* (cursor indexes matches, headers are render-only). Empty candidate set: `pick.ts` (Task 13) never spawns for it — Go may assume ≥1 row.

- [ ] Steps: failing golden tests for both states → implement → PASS → commit.

### Task 8: Update patches + events

**Model:** sonnet; reviewer opus. **Files:** `picker.go`, tests.

`update` handling: replace rows (re-rank current query; keep cursor on the same `value` if it survives, else clamp), replace message, replace actions. `event` emission: an action whose id is in the request's `events` set... NO — the classification lives in TS (it knows the handlers); protocol addition NOT needed: TS marks event-actions in the registry. Add `event?: boolean` to `PickAction` in protocol.ts + Go + the `pick-request.json`/`pick-update.json` fixtures (extend Task 3's fixtures in this task; both golden tests updated together). On an `event:true` action: Go writes `PickEvent` and stays open; on any other action: terminal `PickResult`.

- [ ] Step 1: failing model tests: (a) update with new rows preserves cursor by value; (b) pressing an `event:true` action's key writes an event line and the model keeps running; (c) a non-event action produces the terminal result.
- [ ] Steps 2-5: implement, PASS, commit.

### Task 9: Action registry rendering (keybar, ctrl-k, right-click menu)

**Model:** sonnet; reviewer opus. **Files:** Create `ui/internal/views/picker/actions.go`; `render.go`; tests.

Keybar exactly per boards: lav group labels, faint keys, dim labels, `justify(width, left, right)` with esc/quit pinned right (reuse the board's justify pattern; copy it into picker's render rather than importing across views if not shared). Menu content derivation: item-scope actions (cursor row context) above a rule, globals below; keys right-aligned faint; keyless actions appear menu-only. Defaults injected when no registry passed: select(enter), cancel(esc), back(ctrl-up, only when breadcrumb depth>1 or backLabel semantics per request flag). ctrl-k opens the menu on the cursor row; menu renders via Task 10's modal layer.

- [ ] Step 1: failing tests: keybar golden for the Branch-board registry; menu row derivation (item-first, rule, globals; keyless present; keys aligned).
- [ ] Steps 2-5: implement, PASS, commit.

### Task 10: Modal layer

**Model:** sonnet; reviewer opus. **Files:** Create `ui/internal/views/picker/modal.go`; `picker.go`; tests.

lipgloss v2 canvas/layer compositing: parent rendered with all fg tones stepped down (map tone→dimmer variant; precompute a dim lookup), modal on `Surface` bg with `Panel` rounded border (`╭─╮`), centered, own mini filter + cursor. Two mechanisms per spec: registry menus render Go-locally and dispatch the chosen action exactly as if its key was pressed; `modal` messages from TS render the same layer and answer with `modal-result` (esc/click-outside → `value:null`).

- [ ] Step 1: failing tests: (a) `modal` message → view contains Surface-styled overlay + dimmed parent (golden); (b) selection writes `modal-result` and closes; (c) esc writes `modal-result{value:null}`; (d) ctrl-k menu choice on an `event` action emits the event.
- [ ] Steps 2-5: implement, PASS, commit.

### Task 11: Multi-select

**Model:** sonnet. **Files:** `picker.go`, `render.go`, tests.

Mint `◉`/faint `○` prefixes; space toggle; tab toggle+next; **ctrl-a all/none** (all-visible if any unselected, else none); pinned selected panel (BgSubtle strip under filter listing selected labels mint, `·`-joined, clipped) when `selectedPanel` or by default for multi; header `◉ N selected · x/y`; enter → result `values`. `initialValues` preselect. Footer per Multi board (`space toggle · tab toggle & next · ctrl-a all/none · enter confirm`).

- [ ] Step 1: failing tests: toggle/ctrl-a state matrix; result carries values in input order; golden for the panel+header.
- [ ] Steps 2-5: implement, PASS, commit.

### Task 12: Mouse + modifier-held

**Model:** sonnet; reviewer opus. **Files:** Create `ui/internal/views/picker/mouse.go`; `picker.go`; tests.

Grammar per Mouse board: hover=HoverBg (never moves cursor); click row=cursor; double-click=accept; click marker cell=toggle (multi); wheel=viewport only; right-click=menu at row; breadcrumb segment click emits `event` `{action:"crumb", value:"<index>"}` ONLY when the request opts in (`crumbEvents?: boolean` on PickRequest — add to protocol+fixtures here); keybar keys clickable (hit-zones recorded at render). Modifier-held via key press/release events: alt held → header badge `⌥ with args`, rows whose action set lacks the with-args action dim, cursor row badge; ctrl held → keybar swaps to the full keymap. Terminals without release events: no-op (states never trigger).

- [ ] Step 1: failing tests: hit-zone math (row Y→index incl. group headers offset); wheel changes top not cursor; double-click result; alt-held golden.
- [ ] Steps 2-5: implement, PASS, commit. `bun run ui:build` must succeed.

### Task 13: TS core (`lib/ui/pick.ts` + fake)

**Model:** sonnet; reviewer opus. **Files:** Create `lib/ui/pick.ts`, `lib/ui/pick-fake.ts`, `lib/ui/__tests__/pick.test.ts`.

**Produces:**
```ts
export interface PickHandle {
  update(patch: Omit<PickUpdate, "kind">): void;
  modal(message: string, rows: PickRow[]): Promise<string | null>;
  result: Promise<PickResult>;
}
export interface PickCallbacks { onEvent?: (e: PickEvent) => void | Promise<void> }
export function runPick(req: Omit<PickRequest, "kind">, cb?: PickCallbacks): PickHandle;
// Non-TTY guard is the CALLER's (wrapper's) responsibility, preserving each
// call site's exact current message/exit — runPick throws if stdin/stderr are
// not TTYs (programming error, mirrors prompt spawn gate).
```
Spawns `rt-ui pick` via the same resolution as `lib/ui/spawn.ts` (source checkout first). Parses the NDJSON stream: events→`onEvent` (serialized, one at a time), modal-result resolves the pending `modal()`, result resolves `result`. `pick-fake.ts`: an injectable in-process fake implementing the same surface from a scripted interaction list — every wrapper/surface test uses it (never the real binary).

- [ ] Step 1: failing tests against the fake-driver harness: request serialization, event callback ordering, modal round trip, result resolution, spawn-guard throw.
- [ ] Steps 2-5: implement, PASS, commit.

### Task 14: Wrappers — `filterableSelect` + `filterableMultiselect`

**Model:** sonnet; reviewer opus. **Files:** Create `lib/pick-wrappers.ts`; Modify `lib/fzf-select.ts` to re-export from it (spawn code deleted in Phase 7; until then the old path stays for un-migrated callers — the wrapper flip happens per call site in Phases 5-6 via the re-export switch); Test `lib/__tests__/pick-wrappers.test.ts`.

Same signatures as today (spec: wrappers keep names/signatures). Translation: options→rows (`label` bold text segment + `hint` dim right? NO — hint is a second left segment per the boards' two-column look: label padded via a `minWidth` computed from the longest label, hint as dim segment; the component's segment model carries the padding as spaces in the label segment text). `backLabel` → back action + throw `BackNavigation` on `result.action==="back"`. `stderr` flag → today's semantics (all chrome already goes to the TTY; the flag only gates which stream any pre/post prints use — preserve per-call behavior). Non-TTY guard REPLICATED from today's call sites: wrappers check `interactive()` exactly where the old code did and fall through identically.

- [ ] Step 1: failing tests with the fake: value returned; null on cancel; BackNavigation thrown; multi initialValues preselect passthrough; exact flag passthrough.
- [ ] Steps 2-5: implement, PASS, commit.

### Task 15: Wrappers — `showPicker` + arg-collector

**Model:** sonnet. **Files:** Modify `lib/command-tree.ts` (`showPicker` body only — same return contract `{command, withArgs} | BACK | null`), `lib/arg-collector.ts` (its fzf multi → `filterableMultiselect`); tests extend `lib/__tests__/command-tree.test.ts` pattern with the fake.

showPicker: breadcrumb array passed through (component renders `rt › worktree` per board — dev-mode `(dev mode)` chip stays in `renderHeader` for non-picker output, the picker breadcrumb shows plain names); rows = name bold + description dim; alt-enter = with-args action (`withArgs` from `result.action==="with-args"`); ctrl-up→BACK per current depth rule; `fullscreen` nodes unchanged.

- [ ] Steps: failing tests (select, with-args, back, cancel) → implement → PASS → commit.

### Task 16: Wrapper — `runNavPicker`

**Model:** sonnet; reviewer opus. **Files:** Modify `lib/navigate.ts` (keep `NavOption`/`NavResult`/`NavPickerOpts` shapes; body now translates to `runPick`); tests.

Translation table: `options` (+`separator`→`group` boundaries: a separator becomes the `group` name for subsequent rows, auto-labeled), `headerParts`→actions-derived footer (headerParts become label-only global actions so the keybar shows them; their keys parsed from the `"key: label"` strings), `expectKeys`→actions with `event:false` (exits, preserving each caller's key contract), `initialQuery`/`resumeValue`/`initialPos`, `exact`, `captureQueryOnNoMatch` (enter on no-match → result `{action:"select", value:null, query}` when set — add a `acceptNoMatch?: boolean` request flag to protocol+fixtures in this task), `colorOverrides` DROPPED (tone/hex segments supersede; delete the option and its uses). `preview`/`previewHidden`/`helpHeader`/`resizeHeaderCommand`/`watch` become no-ops here — their callers are rebuilt in Phase 6 before Phase 7 deletes the options.

- [ ] Steps: failing tests (result triple, expect-key exits, separator→group, no-match capture) → implement → PASS → commit.

### Task 17: Migrate `rt commit`

**Model:** sonnet. **Files:** Modify `commands/commit.ts` (delete `buildPreviewCmd`/delta plumbing; picker = `filterableMultiselect` with rows: staged marker + path left, right segments `+adds` mint / `-dels` coral / `new` faint tag from `git diff --numstat` it already computes); test with the fake.

- [ ] Steps: failing test (rows carry stats right-pinned; ctrl-a; selection returns paths) → implement → PASS → commit. Board: Commit.

### Task 18: Migrate `rt skills surface` palette

**Model:** sonnet. **Files:** Modify `commands/skills.ts` (the direct fzf spawn → `filterableSelect`), test.

- [ ] Steps: red → green → commit.

### Task 19: Migrate `rt cd` + `formatBranchSegments`

**Model:** sonnet; reviewer opus. **Files:** Modify `lib/enrich.ts` (ADD `formatBranchSegments(eb: EnrichedBranch): { left: PickSegment[]; right: PickSegment[] }` — same fields as `formatBranchLabelParts`, tones per the glyph vocabulary, ticket stateColor as `hex`); Modify `lib/pickers.ts` + `commands/cd.ts`: repo/worktree pickers on the wrappers, worktree rows from `formatBranchSegments`, ctrl-r as an `event:true` action whose handler re-lists repos in-process and calls `handle.update({rows})`; progressive enrichment: open with `dirName · branch` rows immediately, then `handle.update({rows: enriched})` when `enrichBranches` resolves (silent mode; no spinner). Delete cd's use of `reloadCommand` (option dies in Phase 7). Tests: segments golden (ticket/[Local Only]/icons cases from enrich fixtures), ctrl-r update flow, progressive update with the fake.

- [ ] Steps: red → green → commit. Boards: Cd, Enrichment.

### Task 20: Rebuild `rt nav` on the events model

**Model:** sonnet; reviewer opus (the largest migration). **Files:** Modify `commands/nav.ts`; Modify `lib/nav-fs.ts` (delete preview/help-header builders; keep listing/sort); tests with the fake.

One `runPick` per cwd (not per interaction). Registry: enter(open — event for files, exit... NO: enter on a folder must descend = TS logic + full re-request? Descend re-lists rows for the new cwd and updates message — an EVENT (`update` rows+message), picker stays live. Enter on a file = event (`open`, returns immediately). So `enter` is `event:true`; the handler branches d:/f: values); ctrl-t event (toggle+update rows+actions with flipped label), ctrl-f event, ctrl-s event (sort modal via `handle.modal(...)`, reverse-on-reselect logic in TS, then update rows+message with sort suffix), ctrl-up event (up-dir → update; at root no-op), ctrl-h exit (cd here → prints path), ctrl-space exit (cd selected), ctrl-o exit (editor; re-invoke with resume), ctrl-k registry menu with Open with…(exit)/Quick Look(exit)/Reveal(event)/Copy path(event)/Terminal here(exit), ctrl-/ event (expanded keybar = actions update swapping to the two-line grouped registry). Watcher: `fs.watch(cwd)` → debounce 150ms → `handle.update({rows})`; closed on descend/exit. Empty dir: the inline empty-folder request per NavMenus board. stdout/stderr path discipline preserved verbatim (the `cdAndExit` dance).

- [ ] Step 1: failing tests: descend-updates-in-place (no respawn), ctrl-t flips rows+label, sort modal→update with suffix, watcher push, exits produce path on real stdout, Quick Look/terminal exits re-invoke with resume.
- [ ] Steps 2-5: implement, PASS, commit. Boards: Nav, NavMenus, Actions, Mouse.

### Task 21: run/pickers polish pass

**Model:** sonnet. **Files:** Modify `commands/run.ts` picker call sites ONLY where presentation moved (queue rows as a `queue` group with mint ✓ segments + lav variation suffix; `Launch all`/`Save as preset…` rows; `↻ last run` sentinel mint + age; footers via actions per queue state — all values/flow logic untouched); `lib/pickers.ts` repo option rows. Tests with the fake asserting group/row composition for both queue states.

- [ ] Steps: red → green → commit. Board: RunChain (all 4 states).

### Task 22: Cutover sweep (the deletion inventory)

**Model:** sonnet; reviewer sonnet (mechanical but broad). **Files:** execute the spec's "Deleted at cutover" list verbatim; Modify `lib/setup/validators/rt-health.ts` (+ its test), `lib/__tests__/deps-lock-file.test.ts`, `deps-lock-live.test.ts`, `e2e/tests/verify.test.ts`, `setup.test.ts`, `e2e/interactive.ts`; Delete the 7 Termwright picker/nav suites + the listed unit tests; remove fzf from deps-lock/bundling (`scripts/` deps-lock entries, bundle layout).

- [ ] Step 1: `rg -l "fzf" lib commands scripts e2e ui --glob '!*.md'` inventory BEFORE, saved to the ledger.
- [ ] Step 2: execute deletions/updates; the AFTER rg must show zero non-comment fzf references outside `ui/go.*` (the matcher dep) and historical docs.
- [ ] Step 3: full gate: `bun test lib commands scripts`, `tsc --noEmit`, `picker:check`, `cd ui && go test ./...`, `bun run ui:build`.
- [ ] Step 4: commit.

### Task 23: Board-parity review + docs

**Model:** opus (judgment). **Files:** Modify `CLAUDE.md` (picker section replaces fzf mentions; points at `docs/design/picker/`), `docs/design/picker/README.md` untouched.

- [ ] Step 1: run each surface in a real Ghostty pane under an isolated HOME (`env -i HOME=<tmp>` with a seeded repo fixture) via `bun run cli.ts`; capture: command palette, filtering, no-match, run queue state, cd enriched, multi panel, commit, nav browse + sort modal + ctrl-k, tall pane. Compare against the boards; file deviations as fix-or-ratify items and resolve each.
- [ ] Step 2: CLAUDE.md update; commit.
- [ ] Step 3: whole-branch final review (opus/fable) per subagent-driven-development, then finishing-a-development-branch (Matt decides merge).

---

## Self-review notes (done at write time)

- Spec coverage: every spec section maps (protocol→T3/T8, matcher→T1, tokens→T2, core render→T5-7, updates/events→T8, registry→T9, modals→T10, multi→T11, mouse/modifiers→T12, TS core→T13, wrappers→T14-16, surfaces→T17-21, deletion+test fates+rt-health→T22, parity+docs→T23, enrichment→T19, terminal-ownership rule→T20 registry classification).
- The `event` flag and `acceptNoMatch`/`crumbEvents` flags are protocol additions made in T8/T12/T16 with fixtures updated in the same task (fixture discipline preserved).
- Type consistency: `PickSegment/PickRow/PickAction/PickRequest/PickUpdate/PickEvent/PickResult` names used uniformly; `runPick/PickHandle` consistent across T13-21.
- Phases keep the tree green: wrappers re-export so un-migrated callers stay on fzf until their phase-6 task; Phase 7 deletes only after all call sites are off.
