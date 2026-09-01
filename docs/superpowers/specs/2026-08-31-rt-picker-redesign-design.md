# rt picker redesign — one component, fzf retired

**Status:** Approved design (Matt, 2026-08-31). Canvas signed off.
**Visual contract:** `docs/design/picker/` (committed boards) = the published
canvas https://claude.ai/code/artifact/fc997519-5f71-4011-b1a9-ef662504edbd.
The built TUI is reviewed against those boards; deviations are fixed or
ratified by updating the board in the same change. Never silent drift.

## Goal

Replace every fzf surface in rt with one core picker component rendered by
rt-ui (Go/Bubble Tea), styled to the runner board's design language, plus thin
TypeScript wrappers so ~30 call sites keep their current APIs. Big bang, hard
cutover: fzf is fully retired from rt.

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
- stdin stays open after the request: the TS side may push `rows` messages
  mid-flight (full row-set replacement; query and cursor preserved by value).
  One mechanism, three consumers: nav's live-refresh watcher, cd's ctrl-r
  reload, progressive enrichment.
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
- Deleted at cutover: `lib/fzf.ts` (and the patched fzf binary + its bundling),
  fzf spawn paths in `lib/fzf-select.ts`/`lib/navigate.ts`/`lib/command-tree.ts`
  /`lib/arg-collector.ts`/`commands/commit.ts`, `navSeparator` skip machinery,
  `RT_FZF_ALT_SCREEN`, nav's `resumeQuery`/`resumeValue` plumbing.
- Sacred, untouched logic: `commands/run.ts` (queue, presets, variations,
  resolve), `commands/cd.ts` (two-step repo→package, auto-select-when-one,
  reload), `lib/enrich.ts` (data + caching). They only render differently.

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
- `group` renders a real group header (faint uppercase) — never a focusable
  row, no skip-bindings.
- Enrichment consumes `lib/enrich.ts`'s `BranchLabelParts` natively:
  leading → `left`, trailing → `right`. The `formatBranchLabel` flatten dies.
  Glyph vocabulary per the Enriched-rows board (pipeline ✓/⟳/✗, MR ◉/●/○,
  `[Local Only]`/`[main branch]` faint, ticket ids dimmer).

### Action registry

```
action = { id, label, key?, scope: "item"|"global", group?, primary? }
```

Declared once per picker; the component derives: grouped keybar (lav group ·
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
Modal submenus are themselves pick requests (nested, over the same pipe) so
their logic (e.g. sort's reverse-on-reselect) stays in TS.

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
Filtering rebinds to top.

### Theme

Board tokens (`ui/internal/theme/theme.go`) plus two new: **HoverBg #251E3D**,
**Surface #221A35** (ramp: Bg → BgSubtle → Surface → HoverBg → SelBg). The
full-height left edge is retired for pickers (accent lives in the selection);
huh prompts keep their pink bar. Breadcrumb = board header grammar. Match
highlight = cyan bold. Filter prompt = pink `❯`. Nav folder icon = Nerd Font
U+F07B (Ghostty builtin symbols fallback; `▸` degrade). No emoji anywhere.

## Surface-by-surface (see the boards for exact renders)

- **Command palette** (dispatcher `showPicker`): breadcrumb + count,
  name/description columns, alt-enter with-args, ctrl-up back.
- **rt run** (4 states): package idle with presets group; queue-active with
  queue pinned on top (✓ rows + lav variation suffix, `Launch all`,
  `Save as preset…`; presets hidden); script stage with mint `↻ last run`
  sentinel (age hint) + command-preview hints; variations with `+ Add
  variation…`. Footers swap with queue state exactly as today.
- **rt cd**: repo picker (ctrl-r refresh re-requests rows); worktree picker
  with full enrichment + progressive enrichment (instant open, rows upgrade
  in place).
- **Multi-selects** (worktree dispose, daemon, settings, port, extension):
  pinned panel + ctrl-a.
- **rt commit**: plain multi-pick, right-pinned stats column (+mint/−coral,
  `new` tag), ctrl-a. Diff preview cut.
- **rt nav**: browse with cwd-as-clickmap header, sort suffix, live-refresh,
  ctrl-t hidden, ctrl-s sort modal, ctrl-k actions modal (= right-click),
  ctrl-/ help overlay, empty-folder inline state, ctrl-space/ctrl-o/ctrl-f.
  **Cut:** deep-jump, preview pane, image previews.
- **Recent runs / arg-collector / simple selects**: the plain patterns.

## Contracts preserved byte-identical

Non-TTY / `--json` / `RT_BATCH` gating (picker-conformance suite must stay
green), ctrl-up = back everywhere (BackNavigation), alt-enter = with-args,
stderr output discipline (`stderr: true` callers), exit codes.

## Testing

One focused test suite for the picker component (Go side: golden-render +
behavior tests against fixtures; TS side: wrapper translation + gate tests
with a fake rt-ui). Termwright e2e rewrite is explicitly deferred (Matt).
Ranking parity: golden tests over FuzzyMatchV2 at the pinned version.

## Terminal-fidelity deltas (ratified)

No drop shadows; cell-quantized density; 1-cell scrollbar; rounded corners
only as box-drawing glyphs on modals. The boards show CSS approximations of
these four things; everything else on the boards is the contract.

## Out of scope

Other repos' fzf usage (gitq/board have their own); the huh prompt surfaces
(already themed); preview panes of any kind; `|`/`!` search syntax.
