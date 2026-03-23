/**
 * FilterableMultiSelect — text filter + multi-select list.
 *
 * Type to filter the option list, arrow keys to navigate,
 * space to toggle, enter to submit.
 *
 * Manages selection state externally so filtering never loses selections.
 */

import React, { useState, useMemo, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ─── Figures (avoid external dep) ────────────────────────────────────────────

const POINTER = "❯";
const CHECK = "✔";
const CHECKBOX_ON = "◉";
const CHECKBOX_OFF = "◯";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FilterableOption {
  label: string;
  value: string;
}

export interface FilterableMultiSelectProps {
  options: FilterableOption[];
  onSubmit: (values: string[]) => void;
  visibleOptionCount?: number;
  defaultValue?: string[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function FilterableMultiSelect({
  options,
  onSubmit,
  visibleOptionCount = 10,
  defaultValue,
}: FilterableMultiSelectProps): React.ReactElement {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultValue ?? []),
  );
  const [focusIndex, setFocusIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!filter) return options;
    const tokens = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return options;
    return options.filter((o) => {
      const haystack = `${o.label} ${o.value}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [options, filter]);

  // Clamp focus when filtered list shrinks
  const clampedFocus = Math.min(focusIndex, Math.max(0, filtered.length - 1));
  if (clampedFocus !== focusIndex) {
    setFocusIndex(clampedFocus);
  }

  // Visible window
  const startIndex = Math.max(
    0,
    Math.min(clampedFocus - Math.floor(visibleOptionCount / 2), filtered.length - visibleOptionCount),
  );
  const visible = filtered.slice(startIndex, startIndex + visibleOptionCount);

  const toggle = useCallback(
    (value: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(value)) {
          next.delete(value);
        } else {
          next.add(value);
        }
        return next;
      });
    },
    [],
  );

  useInput((input, key) => {
    if (key.downArrow) {
      setFocusIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (key.upArrow) {
      setFocusIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.tab) {
      const item = filtered[clampedFocus];
      if (item) toggle(item.value);
      return;
    }
    if (key.return) {
      // Submit all selected values (not just filtered ones)
      const values = options
        .filter((o) => selected.has(o.value))
        .map((o) => o.value);
      onSubmit(values);
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setFocusIndex(0);
      return;
    }
    // Printable characters (including space) → filter
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setFilter((f) => f + input);
      setFocusIndex(0);
    }
  });

  const selectedCount = selected.size;

  return React.createElement(
    Box,
    { flexDirection: "column" },

    // Filter input line
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: "cyan" }, "  filter: "),
      React.createElement(Text, null, filter || ""),
      React.createElement(Text, { dimColor: true }, filter ? "" : "(type to filter)"),
      React.createElement(
        Text,
        { dimColor: true },
        `  ${filtered.length}/${options.length}`,
      ),
      selectedCount > 0 &&
        React.createElement(
          Text,
          { color: "green" },
          `  ${selectedCount} selected`,
        ),
    ),

    // Spacer
    React.createElement(Text, null, ""),

    // Option list
    ...visible.map((opt) => {
      const globalIndex = filtered.indexOf(opt);
      const isFocused = globalIndex === clampedFocus;
      const isSelected = selected.has(opt.value);

      return React.createElement(
        Box,
        { key: opt.value },
        React.createElement(
          Text,
          { color: isFocused ? "cyan" : undefined },
          isFocused ? `  ${POINTER} ` : "    ",
        ),
        React.createElement(
          Text,
          { color: isSelected ? "green" : isFocused ? "cyan" : undefined },
          isSelected ? `${CHECKBOX_ON} ` : `${CHECKBOX_OFF} `,
        ),
        React.createElement(
          Text,
          {
            bold: isFocused,
            color: isSelected ? "green" : undefined,
          },
          renderHighlighted(opt.label, filter),
        ),
      );
    }),

    // Scrollbar hint
    filtered.length > visibleOptionCount &&
      React.createElement(
        Text,
        { dimColor: true },
        `    … ${filtered.length - visibleOptionCount} more (scroll with ↑↓)`,
      ),

    // Help
    React.createElement(Text, null, ""),
    React.createElement(
      Text,
      { dimColor: true },
      "  ↑↓ navigate  tab toggle  enter submit  type to filter",
    ),
  );
}

// ─── Highlight helper ────────────────────────────────────────────────────────

function renderHighlighted(
  label: string,
  filter: string,
): React.ReactElement | string {
  if (!filter) return label;
  const lower = label.toLowerCase();
  const idx = lower.indexOf(filter.toLowerCase());
  if (idx === -1) return label;

  return React.createElement(
    React.Fragment,
    null,
    label.slice(0, idx),
    React.createElement(Text, { color: "yellow", bold: true }, label.slice(idx, idx + filter.length)),
    label.slice(idx + filter.length),
  );
}
