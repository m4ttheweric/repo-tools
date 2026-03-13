/**
 * WorktreeSelector — connector that manages cursor/selection state.
 * Delegates all rendering to WorktreeSelectorView.
 */
import React, { useState, useCallback } from "react";
import { useInput } from "ink";
import type { DetectedWorktree } from "../lib";
import { WorktreeSelectorView, type WorktreeSelectorItem } from "./WorktreeSelectorView.tsx";

export interface WorktreeSelectorProps {
  worktrees: DetectedWorktree[];
  savedSelection: string[] | null;
  onConfirm: (selected: DetectedWorktree[]) => void;
}

export function WorktreeSelector({ worktrees, savedSelection, onConfirm }: WorktreeSelectorProps) {
  const [cursor, setCursor] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [checked, setChecked] = useState<boolean[]>(() =>
    worktrees.map((wt) => (savedSelection ? savedSelection.includes(wt.dir) : true)),
  );

  const items: WorktreeSelectorItem[] = worktrees.map((wt, i) => ({
    worktree: wt,
    label: wt.dir.split("/").pop() ?? wt.dir,
    branch: wt.branch,
    checked: checked[i],
  }));

  const toggle = useCallback((index: number) => {
    setChecked((prev) => prev.map((v, i) => (i === index ? !v : v)));
  }, []);

  const toggleAll = useCallback(() => {
    setChecked((prev) => {
      const allChecked = prev.every(Boolean);
      return prev.map(() => !allChecked);
    });
  }, []);

  useInput((input, key) => {
    if (submitted) return;

    if (key.upArrow) {
      setCursor((c) => (c - 1 + worktrees.length) % worktrees.length);
    } else if (key.downArrow) {
      setCursor((c) => (c + 1) % worktrees.length);
    } else if (input === " ") {
      toggle(cursor);
    } else if (input === "a") {
      toggleAll();
    } else if (key.return) {
      const selected = worktrees.filter((_, i) => checked[i]);
      if (selected.length > 0) {
        setSubmitted(true);
        onConfirm(selected);
      }
    }
  });

  return <WorktreeSelectorView items={items} cursor={cursor} submitted={submitted} />;
}
