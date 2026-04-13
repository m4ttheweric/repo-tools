/**
 * rt-tui — Terminal Dashboard Component Library
 *
 * Barrel export for the full library.
 * Import everything you need from this one file.
 *
 * Quick reference for building a new Rezi dashboard:
 *   → Read SKILL.md first for the full guide and composing patterns.
 *
 * Import example:
 *   import {
 *     C, runnerTheme,
 *     CursorGlyph, StatusIcon, KeyBadge, Pipe, GroupHeader, Divider,
 *     PortLabel, StateLabel, rowBg,
 *     TuiCard, GroupedList, KeybindBar, BottomBar,
 *     computeGroups, clampIdx, flattenGroups, returnToNormal, truncate,
 *     openPopup, openTempPane, createSplitPaneManager,
 *   } from "../lib/tui/index.ts";
 */

// ─── Theme ───────────────────────────────────────────────────────────────────
export { T, C, STATUS_COLOR, SPINNER_FRAMES, runnerTheme } from "./theme.ts";

// ─── Atoms ────────────────────────────────────────────────────────────────────
export { CursorGlyph } from "./atoms/cursor-glyph.tsx";
export { StatusIcon, STATUS_ICON, type EntryState } from "./atoms/status-icon.tsx";
export { KeyBadge, CmdLabel, Cmd } from "./atoms/key-badge.tsx";
export { SectionLabel, Sep, Pipe, Divider, GroupHeader } from "./atoms/section-label.tsx";
export { PortLabel, StateLabel } from "./atoms/port-label.tsx";

// ─── Hooks (Ink / React only) ─────────────────────────────────────────────────
export { useSpinnerFrame } from "./hooks/use-spinner.ts";
export { useToast, type ToastController } from "./hooks/use-toast.ts";
export { createSafeUpdater } from "./hooks/use-safe-update.ts";

// ─── Utils (pure functions) ───────────────────────────────────────────────────
export {
  computeGroups,
  clampIdx,
  flattenGroups,
  groupForIdx,
  type Group,
} from "./utils/groups.ts";
export { returnToNormal, type BaseMode, type NormalMode } from "./utils/modal.ts";
export {
  truncate,
  rpad,
  lpad,
  timeAgo,
  rowBg,
  entryCommandLabel,
} from "./utils/label.ts";

// ─── Molecules ────────────────────────────────────────────────────────────────
export { TuiCard, type TuiCardProps } from "./molecules/card.tsx";
export { GroupedList, type GroupedListProps } from "./molecules/grouped-list.tsx";
export {
  KeybindBar,
  type KeybindBarProps,
  type KeybindSection,
} from "./molecules/keybind-bar.tsx";
export {
  BottomBar,
  type BottomBarProps,
  type BottomBarInputConfig,
} from "./molecules/bottom-bar.tsx";

// ─── Tmux ─────────────────────────────────────────────────────────────────────
export {
  openPopup,
  openTempPane,
  type PopupOptions,
  type TempPaneOptions,
} from "./tmux/popup.ts";
export {
  createSplitPaneManager,
  type SplitPaneManager,
  type SplitPaneManagerOptions,
} from "./tmux/split-pane.ts";
export { restoreFocus, attachLoopCmd } from "./tmux/focus.ts";
