/**
 * rt mr-status — Single-branch MR/ticket status card.
 *
 * Spawned by `rt runner` into a tmux pane to show MR details for the
 * currently focused lane entry. Polls the daemon cache every 5 seconds.
 *
 * Usage: rt mr-status <branch>
 */

import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { execSync } from "child_process";
import type { CommandContext } from "../lib/command-tree.ts";
import { fetchStatusData, MRDetailView, DEFAULT_BRANCHES, type CacheEntry, type ActionState } from "./status.tsx";

// Empty action state — this pane is read-only (no merge/approve actions).
const NO_ACTIONS: ActionState = { loading: null, result: null, confirm: null };

function MrStatusApp({ branch }: { branch: string }) {
  const [entry, setEntry] = useState<CacheEntry | null | undefined>(undefined); // undefined = loading

  async function load() {
    const data = await fetchStatusData();
    setEntry(data.branches[branch] ?? null);
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [branch]);

  useInput((input) => {
    if (input === "q") process.exit(0);
    if (input === "o" && entry?.mr?.webUrl) {
      try { execSync(`open ${JSON.stringify(entry.mr.webUrl)}`, { stdio: "ignore" }); } catch {}
    }
  });

  if (!branch || DEFAULT_BRANCHES.has(branch)) {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text dimColor>⎇  {branch || "no branch"}</Text>
        <Text dimColor>   no merge request</Text>
      </Box>
    );
  }

  if (entry === undefined) {
    return <Box marginTop={1}><Spinner label="loading…" /></Box>;
  }

  if (!entry?.mr) {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={1}>
        <Text dimColor>⎇  {branch}</Text>
        <Text dimColor>   no merge request</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <MRDetailView mr={entry.mr} ticket={entry.ticket ?? undefined} actionState={NO_ACTIONS} />
    </Box>
  );
}

export async function showMrStatus(args: string[], _ctx: CommandContext): Promise<void> {
  const branch = args[0] ?? "";
  render(<MrStatusApp branch={branch} />);
}
