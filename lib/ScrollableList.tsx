/**
 * ScrollableList — reusable virtual-scroll container for Ink CLI views.
 *
 * Renders a windowed subset of children that fits the terminal height,
 * with arrow-key navigation and an optional scrollbar track on the right.
 *
 * Usage:
 *   <ScrollableList reservedRows={8}>
 *     <Text>Line 1</Text>
 *     <Text>Line 2</Text>
 *     ...
 *   </ScrollableList>
 */
import React, { useState, useEffect, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  children: ReactNode[];
  /** Number of terminal rows reserved for chrome outside this list (headers, footers, input box). */
  reservedRows?: number;
  /** Whether arrow keys control scrolling. Default true. Set false if parent handles input. */
  handleInput?: boolean;
  /** Scrollbar thumb color. Default 'cyan'. */
  thumbColor?: string;
  /** Auto-scroll to bottom when children change. Default false. */
  followTail?: boolean;
  /**
   * When set, the list scrolls to keep this child index in view.
   * Useful when the parent controls navigation (handleInput=false) and
   * needs the list to follow a focused row.
   */
  focusedIndex?: number;
  /**
   * Called when the user presses up while already at the top.
   * Useful for "load more" / prepend patterns.
   */
  onScrollTop?: () => void;
  /**
   * When N items are prepended to the front of the list, pass the count
   * here so the scroll offset is shifted by N to preserve the visible position.
   */
  prependedCount?: number;
  /**
   * Number of terminal rows each item occupies. Default 1.
   * Set to 2 for two-line rows so the viewport calculation stays correct.
   */
  itemHeight?: number;
}

export function ScrollableList({
  children,
  reservedRows = 6,
  handleInput = true,
  thumbColor = 'cyan',
  followTail = false,
  focusedIndex,
  onScrollTop,
  prependedCount = 0,
  itemHeight = 1,
}: Props) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const items = React.Children.toArray(children);
  const totalItems = items.length;

  const termRows = process.stdout.rows ?? 24;
  // How many items fit in the available rows
  const viewportSize = Math.max(Math.floor((termRows - reservedRows) / itemHeight), 1);

  const maxOffset = Math.max(0, totalItems - viewportSize);

  // ── followTail: auto-scroll to bottom when items grow ──────────────────────
  useEffect(() => {
    if (followTail) {
      setScrollOffset(maxOffset);
    }
  }, [followTail, totalItems, maxOffset]);

  // ── focusedIndex: keep the focused item in the visible window ───────────────
  useEffect(() => {
    if (focusedIndex == null) return;
    setScrollOffset((prev) => {
      if (focusedIndex < prev) return focusedIndex;
      if (focusedIndex >= prev + viewportSize) return focusedIndex - viewportSize + 1;
      return prev;
    });
  }, [focusedIndex, viewportSize]);

  // ── prependedCount: shift offset to preserve visual position on prepend ────
  const prevPrepended = React.useRef(0);
  useEffect(() => {
    const delta = prependedCount - prevPrepended.current;
    if (delta > 0) {
      setScrollOffset((s) => Math.min(s + delta, maxOffset));
    }
    prevPrepended.current = prependedCount;
  }, [prependedCount, maxOffset]);

  // Clamp offset
  const clamped = Math.min(scrollOffset, maxOffset);
  const visible = items.slice(clamped, clamped + viewportSize);

  // Scrollbar
  const needsBar = totalItems > viewportSize;
  const thumbSize = needsBar ? Math.max(1, Math.round((viewportSize / totalItems) * viewportSize)) : 0;
  const thumbStart = needsBar ? Math.round((clamped / Math.max(1, maxOffset)) * (viewportSize - thumbSize)) : 0;

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setScrollOffset((s) => {
          const next = Math.max(0, s - 1);
          if (s === 0 && onScrollTop) onScrollTop();
          return next;
        });
      }
      if (key.downArrow) setScrollOffset((s) => Math.min(s + 1, maxOffset));
    },
    { isActive: handleInput },
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map((child, i) => {
        const isThumb = needsBar && i >= thumbStart && i < thumbStart + thumbSize;
        const barChar = needsBar ? (isThumb ? '█' : '│') : '';

        return (
          <Box key={i}>
            <Box flexGrow={1}>{child}</Box>
            {needsBar && (
              <Text dimColor color={isThumb ? thumbColor : undefined}> {barChar}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
