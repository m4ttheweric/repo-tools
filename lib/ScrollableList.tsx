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
}

export function ScrollableList({
  children,
  reservedRows = 6,
  handleInput = true,
  thumbColor = 'cyan',
  followTail = false,
}: Props) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const items = React.Children.toArray(children);
  const totalLines = items.length;
  const availableRows = Math.max((process.stdout.rows ?? 24) - reservedRows, 3);

  // Auto-scroll to bottom when items change (tail mode)
  useEffect(() => {
    if (followTail) {
      const max = Math.max(0, totalLines - availableRows);
      setScrollOffset(max);
    }
  }, [followTail, totalLines, availableRows]);

  // Clamp offset
  const maxOffset = Math.max(0, totalLines - availableRows);
  const clamped = Math.min(scrollOffset, maxOffset);
  const visible = items.slice(clamped, clamped + availableRows);

  // Scrollbar
  const needsBar = totalLines > availableRows;
  const thumbSize = needsBar ? Math.max(1, Math.round((availableRows / totalLines) * availableRows)) : 0;
  const thumbStart = needsBar ? Math.round((clamped / Math.max(1, maxOffset)) * (availableRows - thumbSize)) : 0;

  useInput(
    (_input, key) => {
      if (key.downArrow) setScrollOffset((s) => Math.min(s + 1, maxOffset));
      if (key.upArrow) setScrollOffset((s) => Math.max(0, s - 1));
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
