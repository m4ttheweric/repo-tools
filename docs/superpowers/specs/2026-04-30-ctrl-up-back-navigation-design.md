# ctrl-up Back Navigation — Design

**Date:** 2026-04-30
**Status:** Approved

## Problem

`filterableSelect` and `rt nav` prepend visible sentinel rows (`↩ Switch repo`, `↩ Switch worktree`, `↰ ..`) to picker lists to allow back navigation. This clutters every picker with a row the user has to skip past, and the sentinel must be manually offset from the initial cursor position.

## Goal

Replace all list sentinels used for back/up navigation with `ctrl-up`, showing a header hint for discoverability. The `↻ last run` sentinel in `run.ts` is a feature (not navigation) and is out of scope.

## Architecture

Four touch points, each independent:

| File | Change |
|---|---|
| `lib/rt-render.tsx` | `filterableSelect` always uses `--expect=ctrl-up` + `--print-query`; uniform 3-line output parsing; `ctrl-up` with `backLabel` → throw `BackNavigation`; `ctrl-up` without `backLabel` → return `null`; remove `↩` sentinel from options; add `ctrl-up: back` to header when `backLabel` set; remove sentinel-offset start position logic |
| `lib/pickers.ts` | `pickWorktreeWithSwitch` drops hardcoded `SWITCH_REPO` sentinel; uses `backLabel: "Switch to a different repo"` instead; all callers unchanged |
| `commands/nav.ts` | Remove `↰ ..` entry, `UP` constant, and `if (choice === UP)` branch; `ctrl-up` already works |
| `lib/rt-render.tsx` (Ink fallback) | `select()` keeps `↩` sentinel — Ink cannot intercept ctrl-up; this path only fires when fzf is absent |

No changes to callers of `filterableSelect`. The `backLabel` prop and `BackNavigation` exception remain the public API.

## filterableSelect Output Parsing

`--expect=ctrl-up` and `--print-query` are always passed. fzf output is always 3 lines:

```
line 0: query (filter text the user typed)
line 1: key   ("" for normal Enter, "ctrl-up" if pressed)
line 2: value (tab-delimited selected row)
```

Post-parse logic:
- `status !== 0` → cancelled → return `null` (unchanged)
- `key === "ctrl-up"` and `backLabel` set → throw `BackNavigation`
- `key === "ctrl-up"` and no `backLabel` → return `null` (nowhere to go up; treat as cancel)
- Otherwise → return `value` or throw `BackNavigation` if `value === BACK`

## Header Format

When `backLabel` is set, the fzf header becomes:

```
enter: select  |: OR  !: exclude  ctrl-up: back
```

Consistent with nav.ts's existing header style.

## Cursor Start Position

The current `startBindings` logic offsets the cursor past leading `↩` / `BACK` sentinel rows. With those sentinels gone, `firstRealIdx` is always 0 and `startBindings` is always empty — the block can be removed entirely. The `↻ last run` sentinel in `run.ts` is unaffected: its value is not `BACK` and its label starts with `↻`, so it never triggered the offset.

## Out of Scope

- `filterableMultiselect` — no back navigation use case today
- `nav.ts` internal `runFzf` refactor — it stays self-contained
- The Ink `select()` fallback sentinel — kept as-is
