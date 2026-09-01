# rt picker redesign — one component, fzf retired

**Status:** Approved design (Matt, 2026-08-31). Canvas signed off.
**Visual contract:** `docs/design/picker/` (committed boards) = the published
canvas https://claude.ai/code/artifact/fc997519-5f71-4011-b1a9-ef662504edbd.
The built TUI is reviewed against those boards; deviations are fixed or
ratified by updating the board in the same change. Never silent drift.

## Goal

Replace every fzf surface in rt with one core picker component rendered by
rt-ui (Go/Bubble Tea), styled to the runner board's design language, plus thin
TypeScript wrappers so the existing call sites (46 awaited picker calls across
~30 modules) keep their current APIs. Big bang, hard cutover: fzf is fully
retired from rt.

## Why

fzf's styling ceiling is colors + border + header strings (~70% of board
quality at best), and rt has a documented history of fighting it: a patched
fzf binary for the border glyph, hand-rolled separator skip-bindings, the
exit-1/`--expect` rewrite, load-race binds, zsh preview quirks. The hard parts
of owning the UI are already paid for: rt-ui exists (theme, NDJSON bridge,
prompt/steps/board verbs), and the board proved the pipeline. fzf's matcher is
importable Go, so ranking quality is kept, not reimplemented.

## Architecture

### Go side: `rt-ui pick` (new one-shot verb)

- Same process shape as `prompt`: spawn, one NDJSON request on stdin, one
  NDJSON result on stdout, exit. `/dev/tty` for the screen; the existing
  never-spawn-without-a-TTY gate applies unchanged.
- stdin stays open after the request: the TS side may push `update` messages
  mid-flight — a state patch carrying any of `rows` (full row-set
  replacement; query and cursor preserved by value), `message` (header, e.g.
  nav's sort suffix), and `actions` (registry replacement, e.g. the ctrl-t
  label flip). One mechanism; consumers: nav's live-refresh watcher,
  progressive enrichment, and event-driven re-lists/chrome updates (nav's
  ctrl-t and sort, cd's ctrl-r — see Events vs exits).
- View code lives in `ui/internal/views/picker/`. New wire messages follow the
  protocol.ts ↔ Go struct + golden fixture discipline (`ui/fixtures/`).
- Matching: import `github.com/junegunn/fzf/src/algo` (FuzzyMatchV2) and
  `src/util` — verified in-process (score + per-char positions). Pin the
  version; golden-test ranking. No `|`/`!` extended syntax (dropped by
  decision); an `exact` option maps to fzf's exact matcher.
- Modals composite via lipgloss v2 `canvas.go`/`layer.go` (verified in dep
  v2.0.6). Kitty keyboard enhancements (bubbletea v2.0.9) for modifier-held
  states; SGR mouse for hover/click/right-click/wheel. All three degrade
  gracefully (static keybar, keyboard-only) on lesser terminals.

### TS side: one core, thin wrappers

- New `lib/ui/pick.ts`: builds the request, spawns `rt-ui pick` (same binary
  resolution as prompts: source checkout outranks installed bundle), streams
  row updates, parses the result. Owns the non-TTY/`--json`/`RT_BATCH` gate
  passthrough (behavior byte-identical to today: same messages, exit codes,
  JSON paths).
- Wrappers keep their names and signatures so call sites don't churn:
  `filterableSelect`, `filterableMultiselect`, `runNavPicker`, `showPicker`
  (command-tree), plus the arg-collector picker. Internally they translate
  options → rows/actions and result → today's return shapes (including
  `BackNavigation` on ctrl-up when `backLabel` is set).
- Deleted at cutover (the complete inventory):
  - `lib/fzf.ts` + the patched fzf binary and its bundling/linking.
  - fzf spawn paths in `lib/fzf-select.ts`, `lib/navigate.ts`,
    `lib/command-tree.ts`, `lib/arg-collector.ts`, `commands/commit.ts`, and
    `commands/skills.ts` (the `rt skills surface` palette spawns fzf directly;
    it migrates to the wrapper like everything else).
  - `lib/nav-watch.ts` entirely (it is fzf's `--listen` socket protocol);
    live-refresh becomes a TS `fs.watch` that pushes `update` messages over the open pipe.
  - `lib/nav-fs.ts`'s fzf-specific builders (`buildPreviewCommand` — previews
    are cut; `buildHelpHeaderCommand`/`renderHelpHeader` — the expanded keybar
    is component-rendered). Listing/sort logic in `nav-fs.ts` stays.
  - `lib/setup/validators/rt-health.ts`'s required `tool.fzf` row and the
    `LINK_BUNDLED_FZF` repair action (otherwise `rt verify` reports a missing
    required tool forever), plus `rt deps`' fzf entry.
  - `navSeparator` skip machinery, `RT_FZF_ALT_SCREEN` (including its
    handling in `e2e/interactive.ts`), `buildFzfRows`, the `reloadCommand`
    option, `CD_RELOAD_COMMAND`, and cd's hidden `--emit-rows` verb (see
    Reload below).
  - Unit tests of deleted modules die with them: `lib/__tests__/fzf.test.ts`,
    `fzf-select.test.ts`, `navigate.test.ts`, `pickers-reload.test.ts`,
    `cd-emit-rows.test.ts`, and the fzf-specific parts of `nav-fs.test.ts`.
- Sacred, untouched logic: `commands/run.ts` (queue, presets, variations,
  resolve) and `commands/cd.ts`'s decisions (two-step repo→package,
  auto-select-when-one). `lib/enrich.ts`'s data pipeline (fetching, caching,
  daemon-first reads) is sacred; it gains one presentational addition (see
  Enrichment). The reload/emit-rows *mechanism* in cd.ts is fzf plumbing and
  is replaced (the decision logic around it is not).

## The component contract

### Row model

```
row     = { value, left: Segment[], right: Segment[], match?, group? }
segment = { text, tone? | hex?, bold? }
```

- `tone` = theme ramp (text/soft/dim/dimmer/faint/pink/mint/coral/peach/cyan/
  lav/blue). `hex` = arbitrary truecolor — required because Linear workflow
  stateColor is dynamic. `label`+`hint` callers are sugar over two segments.
- `right[]` pins to the row's right edge and never truncates; `left` clips at
  real overflow only. No pre-baked ellipses anywhere.
- `match` is what filtering sees (default: `left`'s plain text concatenated).
- No-match state (per the Filtering board): count shows `0/N`, an inline faint
  "no matches" row replaces the list, footer swaps to `backspace edit filter ·
  esc quit`. This is the interactive-typed-query state only — an EMPTY
  candidate set still falls through to the caller's existing non-picker error
  path (the picker-conformance convention is unchanged).
- `group` renders a real group header (faint uppercase) — never a focusable
  row, no skip-bindings.
- Enrichment: today's `formatBranchLabelParts` returns ANSI-escaped strings,
  which the segment model cannot consume. `lib/enrich.ts` gains ONE
  presentational sibling, `formatBranchSegments(eb): { left: Segment[];
  right: Segment[] }`, built from the same `EnrichedBranch` fields (Linear
  stateColor as segment `hex`); existing exports stay untouched (the runner
  keeps `BranchLabelParts` until it migrates). The fzf `formatBranchLabel`
  flatten dies. Glyph vocabulary per the Enriched-rows board (pipeline ✓/⟳/✗,
  MR ◉ open / ● merged / ○ closed, `[Local Only]`/`[main branch]` faint,
  ticket ids dimmer).

### Action registry

```
action = { id, label, key?, scope: "item"|"global", group?, primary? }
```

Declared once per picker (replaceable mid-flight via `update`); the component derives: grouped keybar (lav group ·
faint key · dim label · right-pinned quit), right-click context menu (item
scope above the rule, globals below), ctrl-k menu on the cursor row (same
modal), the ⌃-held key map, and clickable keybar keys. Keyless actions appear
in menus only. Defaults (select/cancel/back) exist with zero declarations.
Result: `{ action, value | values, query }`.

### Selection & multi

- Cursor: pink `▌` + SelBg row. Multi: mint `◉` / faint `○` prefixes,
  space=toggle, tab=toggle+next, **ctrl-a=all/none** (component-level), pinned
  selected panel (BgSubtle strip under the filter) always visible, count in
  the header (`◉ 3 selected · 6/6`).
- Preselected values supported (initialValues). Initial query, resume value /
  cursor position supported (round-trip callers).

### Modals

Sort, ctrl-k, and right-click share one modal layer over the live picker:
parent dims (fg re-rendered dimmer), modal sits on **Surface #221A35** with a
Panel border and box-drawing rounded corners. esc or click-outside dismisses.
The parent never tears down — filter and cursor survive by construction.
Two menu mechanisms, by ownership: registry-derived menus (ctrl-k,
right-click) render Go-locally from the registry the component already holds
— no TS round trip; caller-defined submenus with TS logic (sort's
reverse-on-reselect) arrive as nested `modal` pick requests over the pipe.

### Events vs exits (the terminal-ownership rule)

One test decides every action: does its handler need the terminal? 
- **Events** (picker stays live; Go sends `event`, TS handles, optionally
  pushes an `update`): nav's ctrl-t (toggle + re-list, with the flipped keybar label in the same patch), ctrl-f (`open` returns
  immediately), enter-on-a-file (`open`, then keep browsing — today's
  reopen-with-resume dance becomes simply never closing), cd's ctrl-r
  (TS recomputes rows in-process and pushes them), and menu actions like
  reveal/copy-path.
- **Exits** (terminal `result`; caller may re-invoke with `initialQuery`/
  `resumeValue`): ctrl-o (editor — `openDirectoryInEditor` can prompt),
  and ctrl-k's terminal-owning actions: Open with… (the app may be a
  terminal editor), Quick Look (blocks with a stderr notice), Open
  terminal here (`$SHELL`).
Resume plumbing therefore survives only for the exit cases; everything else
keeps state by never closing.

Pipe message vocabulary (the whole protocol):
- TS→Go: the initial `pick` request; `update` (state patch, any time: any of
  `rows` full replacement, `message` header text, `actions` registry
  replacement — live chrome like nav's sort suffix and the ctrl-t keybar
  label ride this); `modal` (a nested pick rendered as an overlay on the
  live picker).
- Go→TS: `event` (a registry action whose logic lives in TS and must not
  close the picker — e.g. ctrl-s pressed; carries `{action, value, query}`);
  `modal-result` (the overlay's selection or dismissal); and the terminal
  `result`, which flows exactly once and ends the process.
- Worked example (sort): ctrl-s → Go sends `event(sort)` → TS sends `modal`
  with the sort options → user picks → Go sends `modal-result`, overlay
  closes → TS re-sorts and sends one `update` (rows + the header sort suffix) → picker continues live. Actions
  whose handler must own the terminal (editor, shell, Quick Look) are NOT
  events — they return as the terminal `result` and the caller re-invokes.

### Reload (cd's ctrl-r)

`ctrl-r` is a registry action handled as an `event`: cd recomputes rows
in-process and pushes them; the picker never closes. The fzf-exec mechanism
dies with fzf: the hidden `rt cd --emit-rows` verb, `CD_RELOAD_COMMAND`,
`buildFzfRows`, and the `reloadCommand` option are all deleted (their tests
with them).

### Mouse

Hover = HoverBg (never steals the keyboard cursor); click = focus;
double-click = accept; click `◉/○` = toggle; wheel = viewport only; right-click
= registry menu; breadcrumb segments and nav path segments are clickable
navigation; keybar keys are clickable. SGR protocol, native BT v2.

### Modifier-held states (Kitty protocol; static fallback)

- ⌥ held: header flips to `⌥ with args`, rows without args dim, cursor row
  shows an `enter → pick args` badge (lav).
- ⌃ held: the full key map (registry-derived) slides into the footer while
  held.

### Sizing & scrolling

`viewport = min(caller cap [default 14], list length, pane height − chrome)`;
caller may raise or lower the cap; the pane is the hard ceiling; SIGWINCH
re-derives live. Content-anchored: short lists collapse to content (no
full-pane void). 2-row scrolloff; wheel moves viewport only; pgup/pgdn; drag
the 1-cell Panel thumb rail; footer range `4–17 of 118` only when overflowing.
Filtering rebinds to top. The board's "edge fade" where content continues is
RULED OUT (a CSS effect; the thumb rail + range indicator carry that signal).
Note the global behavior change: today every picker fills the pane
(`--height=-3`); content-anchoring at the 14-row default cap applies to ALL
callers, not just nav/cd.

### Theme

Board tokens (`ui/internal/theme/theme.go`) plus three new: **HoverBg
#251E3D**, **Surface #221A35** (ramp: Bg → BgSubtle → Surface → HoverBg →
SelBg), and **Blue #6B9DFF** (merged-MR ●, matching `lib/enrich.ts`'s blue
and the Enriched-rows board). There is no shared edge token to migrate: the
huh prompt bar is `GlyphBar` ("▌") painted Pink/Peach by `themed()` and is
untouched; the pickers' full-height edge was fzf's `--border=left` + patched
glyph and dies with fzf. Two stale theme.go comments must be updated at
cutover: `Huh()`'s "the same edge rt's fzf pickers draw" comparison and
`CardWidth`'s "The fzf pickers stay full width".
Breadcrumb = board header grammar. Match
highlight = cyan bold. Filter prompt = pink `❯` (accent lives in the selection: pink ▌ + SelBg). Nav folder icon = Nerd Font
U+F07B (Ghostty builtin symbols fallback; `▸` degrade). No emoji anywhere.

## Surface-by-surface (see the boards for exact renders)

- **Command palette** (dispatcher `showPicker`): breadcrumb + count,
  name/description columns, alt-enter with-args, ctrl-up back.
- **rt run** (4 states): package idle with presets group; queue-active with
  queue pinned on top (✓ rows + lav variation suffix, `Launch all`,
  `Save as preset…`; presets hidden); script stage with mint `↻ last run`
  sentinel (age hint) + command-preview hints; variations with `+ Add
  variation…`. Footers swap with queue state exactly as today.
- **rt cd**: repo picker (ctrl-r as an event: TS recomputes and pushes an update,
  picker stays live); worktree picker
  with full enrichment + progressive enrichment (instant open, rows upgrade
  in place).
- **Multi-selects** (worktree dispose, daemon, settings, port, extension):
  pinned panel + ctrl-a.
- **rt commit**: plain multi-pick, right-pinned stats column (+mint/−coral,
  `new` tag), ctrl-a. Diff preview cut.
- **rt nav**: browse with cwd-as-clickmap header, sort suffix, live-refresh,
  ctrl-t hidden, ctrl-s sort modal, ctrl-k actions modal (= right-click),
  ctrl-/ expanded keybar (in-card second keybar row, NOT a modal; labels
  `commands`/`less`), empty-folder inline state, ctrl-space/ctrl-o/ctrl-f.
  **Cut:** deep-jump, preview pane, image previews.
- **Recent runs / arg-collector / simple selects**: the plain patterns.

## Contracts preserved byte-identical

Non-TTY / `--json` / `RT_BATCH` gating (picker-conformance suite must stay
green), ctrl-up = back everywhere (BackNavigation), alt-enter = with-args,
stderr output discipline (`stderr: true` callers), exit codes.

## Testing

One focused test suite for the picker component (Go side: golden-render +
behavior tests against fixtures; TS side: wrapper translation + gate tests
with a fake rt-ui). Ranking parity: golden tests over FuzzyMatchV2 at the
pinned version.

Existing-suite fates at cutover (deferring the e2e *rewrite* is not deferring
these decisions):
- DELETED with the cutover commit: the fzf-driving Termwright suites —
  `e2e/tests/picker-basics`, `picker-identity`, `picker-navigation`,
  `picker-separators`, `nav-cycle`, `nav-live-refresh`, `nav-sort` — plus the
  unit tests listed in the deletion inventory. Replacement e2e suites are the
  deferred follow-up (Matt's call on timing).
- UPDATED, not deleted: `e2e/tests/verify.test.ts` and `setup.test.ts` (their
  fzf assertions track rt-health's new reality), `e2e/interactive.ts`
  (RT_FZF_ALT_SCREEN handling removed), and the unit suites that assert fzf's
  presence in the toolchain: `lib/setup/__tests__/validators-rt-health.test.ts`
  (the `tool.fzf` block + required-ids list), `lib/__tests__/deps-lock-file.test.ts`
  (fzf bundled-status assertions), `lib/__tests__/deps-lock-live.test.ts`
  (fzf among live-verified deps).
- Release-gate stance: `bun test` (unit) and `picker:check` must be green at
  cutover; `test:all`'s e2e count shrinks by the deleted suites and that is
  accepted until the replacement suites land.

## Terminal-fidelity deltas (ratified)

No drop shadows; cell-quantized density; 1-cell scrollbar; rounded corners
only as box-drawing glyphs on modals. The boards show CSS approximations of
these four things; everything else on the boards is the contract.

## Out of scope

Other repos' fzf usage (gitq/board have their own); the huh prompt surfaces
(already themed); preview panes of any kind; `|`/`!` search syntax.
