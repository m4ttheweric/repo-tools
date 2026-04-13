/** @jsxImportSource @rezi-ui/jsx */
/**
 * MOLECULE: BottomBar
 *
 * The bottom area of a dashboard. Renders exactly one "layer" based on priority:
 *
 *   1. toast   — ephemeral message (highest priority, overrides everything)
 *   2. confirm — a yes/no confirmation prompt
 *   3. input   — an active text input field
 *   4. hints   — the default KeybindBar
 *
 * The consumer controls which layer is active by passing the appropriate prop.
 * Unset layers (null/undefined/false) are skipped. The first non-null layer wins.
 *
 * Composed from: KeybindBar molecule + Rezi <input> / <focusTrap> primitives.
 *
 * Usage:
 *   <BottomBar
 *     toast={s.toast}
 *     confirm={s.mode.type === "confirm-delete" ? "Delete this item? [y] yes  [n / Esc] cancel" : null}
 *     input={s.mode.type === "text-input" ? {
 *       label: "Rename:",
 *       value: s.inputValue,
 *       onInput: (v) => app.update((st) => ({ ...st, inputValue: v })),
 *     } : null}
 *     hints={[
 *       { name: "navigate", cmds: [{ k: "j/k", l: "up/down" }] },
 *       { name: "global",   cmds: [{ k: "q",   l: "quit" }] },
 *     ]}
 *   />
 *
 * Source: commands/runner.tsx Bottom component (lines 1292-1325)
 */

import { C } from "../theme.ts";
import { KeybindBar } from "./keybind-bar.tsx";
import type { KeybindSection } from "./keybind-bar.tsx";

export interface BottomBarInputConfig {
  /** Label shown before the text cursor: e.g. "Edit port:" */
  label: string;
  /** Current input value (controlled). */
  value: string;
  /** Called with the new value on every keystroke. */
  onInput: (value: string) => void;
  /** Hint shown after the input field: e.g. "[↵] confirm  [Esc] cancel" */
  hint?: string;
}

export interface BottomBarProps {
  /** Ephemeral toast message. Overrides all other layers when set. */
  toast?: string | null;
  /**
   * Confirmation prompt text. Shown when a destructive action needs y/n.
   * The text should include key hints inline: "Reset all? [y] confirm  [n / Esc] cancel"
   */
  confirm?: string | null;
  /** Active text input. Shown when the user is editing a field. */
  input?: BottomBarInputConfig | null;
  /** The default KeybindBar sections. Always shown when no other layer is active. */
  hints: KeybindSection[];
}

export function BottomBar({ toast, confirm, input, hints }: BottomBarProps) {
  // Layer 1: toast
  if (toast) {
    return <text style={{ fg: C.peach }}>{toast}</text>;
  }

  // Layer 2: confirmation prompt
  if (confirm) {
    return <text style={{ fg: C.coral }}>{confirm}</text>;
  }

  // Layer 3: text input
  if (input) {
    return (
      <focusTrap id="bottom-bar-trap" active={true} initialFocus="bottom-bar-input">
        <row gap={1}>
          <text style={{ fg: C.muted }}>{input.label}</text>
          <input
            id="bottom-bar-input"
            value={input.value}
            onInput={input.onInput}
          />
          {input.hint && (
            <text style={{ fg: C.dim }}>{input.hint}</text>
          )}
        </row>
      </focusTrap>
    );
  }

  // Layer 4: default hint bar
  return <KeybindBar sections={hints} />;
}
