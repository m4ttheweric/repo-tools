---
name: rt-tui Component Library
description: >
  Atomic TUI component library for building terminal dashboards with Rezi (@rezi-ui).
  Provides atoms → molecules → organisms in a composable three-tier hierarchy.
  Use this whenever building a new `rt` terminal dashboard command.
---

# rt-tui — Terminal Dashboard Component Library

A three-tier atomic component library extracted from `rt runner` (commands/runner.tsx).
Every pattern here has a proven production reference in that file.

```
ATOMS         Smallest indivisible pieces. Pure JSX, no internal state.
  ↓ compose
MOLECULES     Reusable patterns. Combine atoms into complete UI blocks.
  ↓ compose
ORGANISMS     Full dashboards. One createNodeApp() wired with molecules + atoms.
```

---

## Directory Map

```
lib/tui/
  SKILL.md              ← you are here — full agent guide
  theme.ts              ← color palette (T tokens) + semantic roles (C) + runnerTheme
  index.ts              ← barrel export — import everything from here
  atoms/                ← leaf components, no internal state, no side effects
    cursor-glyph.tsx    ← ❯ / " " cursor indicator (pink when selected, dim otherwise)
    status-icon.tsx     ← ● ○ ✗ ❄ ⠋ process status icons + SPINNER_FRAMES + STATUS_COLOR
    key-badge.tsx       ← [k] keybinding badge + dim CmdLabel
    section-label.tsx   ← cyan SectionLabel, · Pipe, ╌╌ Divider, GroupHeader
    port-label.tsx      ← :4001 PortLabel + StateLabel (running / warm / starting…)
  hooks/                ← for Ink (React) dashboards; Rezi uses interval+safeUpdate pattern
    use-spinner.ts      ← useSpinnerFrame(active) — animated braille char
    use-toast.ts        ← useToast() — timed ephemeral toast message
    use-safe-update.ts  ← useSafeUpdate(ref) — guards app.update() after dispose
  utils/                ← pure functions, no JSX, no side effects
    groups.ts           ← computeGroups(items, keyFn), clampIdx()
    modal.ts            ← returnToNormal(), createModalMachine() pattern docs
    label.ts            ← truncate(), rpad(), lpad(), timeAgo(), rowBg()
  molecules/            ← composed UI blocks (atoms → molecules)
    card.tsx            ← <TuiCard> — bordered box, selection-sensitive border weight
    grouped-list.tsx    ← <GroupedList> — headered groups with cursor + renderItem
    keybind-bar.tsx     ← <KeybindBar> — sectioned [key] label command hint rows
    bottom-bar.tsx      ← <BottomBar> — toast › confirm › input › hints stack
  tmux/                 ← imperative tmux integration (side effects, NOT pure)
    popup.ts            ← openPopup() — ephemeral display-popup -E
    split-pane.ts       ← createSplitPaneManager() — background pane pool + display swap
    focus.ts            ← restoreFocus(), attachLoopCmd()
```

---

## Quick Start: Building a New Rezi Dashboard

### Step 1 — Import from the barrel

```typescript
import {
  // theme
  C, runnerTheme,
  // atoms
  CursorGlyph, StatusIcon, KeyBadge, SectionLabel, Pipe, GroupHeader, Divider,
  PortLabel, StateLabel, rowBg,
  // molecules
  TuiCard, GroupedList, KeybindBar, BottomBar,
  // utils
  computeGroups, clampIdx, returnToNormal, truncate,
  // tmux
  openPopup, openTempPane, createSplitPaneManager,
} from "../lib/tui/index.ts";
```

### Step 2 — Define your state

```typescript
interface MyState {
  items:        MyItem[];
  selectedIdx:  number;
  spinnerFrame: number;   // incremented by setInterval at 80ms for animations
  toast:        string | null;
  mode:         { type: "normal" } | { type: "confirm-delete"; itemId: string };
}
```

### Step 3 — Create the Rezi app

```typescript
/** @jsxImportSource @rezi-ui/jsx */
import { createNodeApp } from "@rezi-ui/node";
import { C, runnerTheme } from "../lib/tui/index.ts";

const app = createNodeApp<MyState>({
  initialState: {
    items: [], selectedIdx: 0, spinnerFrame: 0, toast: null,
    mode: { type: "normal" },
  },
  theme: runnerTheme,
});
```

### Step 4 — Build the view

```tsx
app.view((s) => {
  const groups = computeGroups(s.items, (item) => item.category);

  return (
    <column p={1} gap={1}>
      {/* App header */}
      <row gap={0}>
        <text style={{ fg: C.pink, bold: true }}>rt</text>
        <text style={{ bold: true }}>  my-dashboard</text>
      </row>

      {/* Main content using molecules */}
      <TuiCard title=" My Items " selected={true}>
        <GroupedList
          groups={groups}
          cursor={s.selectedIdx}
          renderItem={(item, idx, isSelected) => {
            const bg = rowBg(isSelected);
            return (
              <row key={item.id} gap={1}>
                <CursorGlyph selected={isSelected} />
                <text style={{ fg: C.white, bg }}>{item.name}</text>
              </row>
            );
          }}
        />
      </TuiCard>

      {/* Bottom hint bar (auto-promotes toast/confirm/input) */}
      <BottomBar
        toast={s.toast}
        hints={[
          { name: "navigate", cmds: [{ k: "j/k", l: "up/down" }] },
          { name: "action",   cmds: [{ k: "↵", l: "select" }, { k: "q", l: "quit" }] },
        ]}
      />
    </column>
  );
});
```

### Step 5 — Wire keys

```typescript
app.keys({
  j: ({ state, update }) =>
    update((s) => ({ ...s, selectedIdx: clampIdx(s.selectedIdx + 1, s.items) })),
  k: ({ state, update }) =>
    update((s) => ({ ...s, selectedIdx: clampIdx(s.selectedIdx - 1, s.items) })),
  q: () => app.stop(),
});

await app.run();
```

---

## Core Concepts

### Theme: T tokens → C semantic roles

The theme uses a **two-layer system** so you only edit one place to retheme.

```typescript
// Tier 1 — raw palette tokens (EDIT HERE to retheme)
T.bgBase   // [22, 18, 36]   dark plum canvas
T.pink     // [255, 107, 157] primary accent / borders / active
T.mint     // [98, 230, 168]  running / healthy / proxy up
T.coral    // [255, 121, 121] errors / stopped
T.warm     // [255, 210, 100] warm/idle state (process suspended)
T.cyan     // [90, 170, 255]  group headers / secondary info
T.dim      // [168, 160, 198] secondary text / muted borders

// Tier 2 — semantic roles (USE THESE in JSX — never raw T values)
C.pink    // primary accent
C.mint    // running / healthy
C.coral   // error / stopped
C.dim     // secondary text
C.muted   // tertiary text
C.white   // primary text
C.selBg   // selected row background
C.cyan    // group headers
C.lav     // section labels in hint bar (lavender)
C.peach   // warnings / toasts
```

### Background color in rows

In Rezi terminals, background color must be applied to **every `<text>` cell** in a row — not just the container. Use `rowBg()` for consistency:

```tsx
const bg = rowBg(isSelected); // returns C.selBg or undefined

<row gap={1}>
  <text style={{ fg: C.pink, bg }}>❯</text>
  <text style={{ fg: C.white, bg }}>some label</text>
  <spacer flex={1} />
  <text style={{ fg: C.dim,  bg }}>:4001</text>
</row>
```

### Spinner animation

In Rezi dashboards, the spinner frame is app state (not a React hook):

```typescript
// In your state: spinnerFrame: number
// Timer in runOnce():
const spinnerTimer = setInterval(() => {
  safeUpdate((s) => {
    const hasTransient = [...s.someStates.values()].some(st => st === "starting");
    if (!hasTransient) return s; // skip re-render when nothing is animating
    return { ...s, spinnerFrame: s.spinnerFrame + 1 };
  });
}, 80);

// In view, pass the frame to StatusIcon:
<StatusIcon state={entry.state} spinnerFrame={s.spinnerFrame} />
```

### openPopup vs openTempPane

| Function | tmux primitive | Use for |
|---|---|---|
| `openPopup(cmd, opts)` | `display-popup -E` | Pickers, editors, one-off scripts. **Blocks** until exit. No pane ID returned. |
| `openTempPane(cmd, opts)` | `split-window -v` | Persistent log viewers, interactive shells. Returns a pane ID. |

Example — opening a branch picker in a popup:
```typescript
openPopup(`${process.execPath} ${CLI_PATH} branch`, {
  cwd: entry.worktree,
  title: "rt branch",
  width: "100",
  height: "20",
});
```

Example — opening a shell that Esc closes:
```typescript
openTempPane(process.env.SHELL ?? "zsh", {
  cwd: entry.targetDir,
  target: displayPaneId,
  escToClose: true,
});
```

### computeGroups

Groups items by a key function, maintaining insertion order of first occurrence:

```typescript
const groups = computeGroups(entries, (e) => e.commandTemplate);
// → [{ key: "npm run dev", label: "my-pkg · dev", items: [...] }, ...]

// Custom label function (2nd arg, receives first item of each group):
const groups = computeGroups(entries, keyFn, (firstItem) => firstItem.title);
```

### Modal pattern (mode union type)

```typescript
type Mode =
  | { type: "normal" }
  | { type: "confirm-delete"; itemId: string }
  | { type: "text-input"; purpose: "rename" };

// Enter a modal:
update((s) => ({ ...s, mode: { type: "confirm-delete", itemId: "abc" } }));
app.setMode("confirm-delete");

// Exit a modal (reset to normal, clear inputValue):
returnToNormal(update);
app.setMode("default");

// Handle modal-specific keys:
app.modes({
  "confirm-delete": {
    y: ({ state }) => {
      doDelete(state.mode.itemId); // always narrow the type
      returnToNormal(update);
      app.setMode("default");
    },
    n:      ({ update }) => { returnToNormal(update); app.setMode("default"); },
    escape: ({ update }) => { returnToNormal(update); app.setMode("default"); },
  },
});
```

### createSplitPaneManager

Manages a background tmux window containing parked panes, and a display slot (right-side split) that swaps which pane is visible based on navigation:

```typescript
const panes = createSplitPaneManager({
  runnerPaneId: process.env.TMUX_PANE ?? "",
  attachLoopCmd,     // from tmux/focus.ts
});

// Create background pane for an item:
panes.createBgPane(itemId, processId, "lane 1 · :3000");

// Swap into display on first item:
panes.initDisplayPane(firstItemId);

// Switch display when user navigates:
panes.switchDisplay(newItemId);    // j/k handler

// Cleanup on exit:
panes.cleanup();
```

---

## File-by-File Reference

| File | Exports | Notes |
|---|---|---|
| `theme.ts` | `T`, `C`, `runnerTheme`, `STATUS_COLOR`, `SPINNER_FRAMES` | SOURCE OF TRUTH for all colors |
| `atoms/cursor-glyph.tsx` | `<CursorGlyph selected>` | ❯ or space |
| `atoms/status-icon.tsx` | `<StatusIcon state spinnerFrame>`, `EntryState` | Animated when starting/stopping |
| `atoms/key-badge.tsx` | `<KeyBadge k>`, `<CmdLabel l>` | Used in keybind bar |
| `atoms/section-label.tsx` | `<SectionLabel name>`, `<Pipe>`, `<Divider>`, `<GroupHeader label>` | — |
| `atoms/port-label.tsx` | `<PortLabel port>`, `<StateLabel state>` | — |
| `hooks/use-spinner.ts` | `useSpinnerFrame(active)` | Ink (React) only |
| `hooks/use-toast.ts` | `useToast()` | Ink (React) only |
| `hooks/use-safe-update.ts` | `createSafeUpdater(runningRef)` | Rezi pattern |
| `utils/groups.ts` | `computeGroups()`, `clampIdx()` | Pure functions |
| `utils/modal.ts` | `returnToNormal()` | Pure function |
| `utils/label.ts` | `truncate()`, `rpad()`, `lpad()`, `timeAgo()`, `rowBg()` | Pure functions |
| `molecules/card.tsx` | `<TuiCard>` | Bordered box, selection weight |
| `molecules/grouped-list.tsx` | `<GroupedList>` | Groups with renderItem |
| `molecules/keybind-bar.tsx` | `<KeybindBar>` | Sectioned hints |
| `molecules/bottom-bar.tsx` | `<BottomBar>` | Toast/confirm/input/hints stack |
| `tmux/popup.ts` | `openPopup()`, `openTempPane()` | Require tmux |
| `tmux/split-pane.ts` | `createSplitPaneManager()` | Require tmux |
| `tmux/focus.ts` | `restoreFocus()`, `attachLoopCmd()` | tmux helpers |

---

## Production Reference

`commands/runner.tsx` is the full production implementation of every pattern in this library. When in doubt, grep that file for working examples.

```
grep -n "openPopup\|TuiCard\|computeGroups\|returnToNormal" commands/runner.tsx
```
