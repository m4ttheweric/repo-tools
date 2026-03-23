/**
 * Reusable Ink-based TUI components for the rt CLI.
 *
 * Re-exports from @inkjs/ui for standard components,
 * plus custom additions for rt-specific patterns.
 */

// ─── Re-exports from @inkjs/ui ──────────────────────────────────────────────

export {
  Select,
  MultiSelect,
  ConfirmInput,
  TextInput,
  Spinner,
  StatusMessage,
  Badge,
  ProgressBar,
} from "@inkjs/ui";

export type {
  SelectProps,
  MultiSelectProps,
  ConfirmInputProps,
  TextInputProps,
} from "@inkjs/ui";

// ─── Re-exports from ink ────────────────────────────────────────────────────

export { Box, Text, Newline, Spacer, useInput, useApp } from "ink";
