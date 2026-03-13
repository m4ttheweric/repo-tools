/**
 * WorktreeSelectorView — pure presentational multi-select.
 * No side effects, no useInput. All state managed by parent.
 */
import React from "react";
import { Box, Text } from "ink";
import type { DetectedWorktree } from "../lib";

export interface WorktreeSelectorItem {
  worktree: DetectedWorktree;
  label: string;
  branch: string;
  checked: boolean;
}

export interface WorktreeSelectorViewProps {
  items: WorktreeSelectorItem[];
  cursor: number;
  submitted: boolean;
}

export function WorktreeSelectorView({ items, cursor, submitted }: WorktreeSelectorViewProps) {
  if (submitted) {
    const selected = items.filter((item) => item.checked);
    return (
      <Box>
        <Text color="green">✔</Text>
        <Text bold> Select worktrees to run </Text>
        <Text>{selected.map((s) => s.label).join(", ")}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan">?</Text>
        <Text bold> Select worktrees to run</Text>
        <Text dimColor>  (space to toggle, enter to confirm, a to toggle all)</Text>
      </Box>
      {items.map((item, i) => {
        const isCursor = i === cursor;
        const check = item.checked ? "◉" : "◯";
        const checkColor = item.checked ? "green" : "gray";

        return (
          <Box key={item.worktree.dir} gap={1}>
            <Text>{isCursor ? "❯" : " "}</Text>
            <Text color={checkColor}>{check}</Text>
            <Text bold={isCursor}>{item.label}</Text>
            <Text dimColor>{item.branch}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
