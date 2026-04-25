/**
 * rt pick-cmd-template — Fuzzy-find picker for switching a lane entry's active
 * command template.
 *
 * Spawned by `rt runner` in a tmux popup when the user presses [l][c].
 * argv[0] is a tmpfile path holding the JSON menu:
 *   [{ cmd: "...", alias?: "..." }, ...]
 * Writes the selected index (as a string) to stdout on success.
 * Exits 0 with no output on cancel.
 */

import { readFileSync } from "node:fs";
import type { CommandContext } from "../lib/command-tree.ts";

interface CmdVariant { cmd: string; alias?: string }

export async function pickCmdTemplate(args: string[], _ctx: CommandContext): Promise<void> {
  const path = args[0];
  if (!path) {
    process.stderr.write("\n  Missing menu file argument.\n\n");
    process.exit(0);
  }

  let menu: CmdVariant[];
  try {
    menu = JSON.parse(readFileSync(path, "utf8")) as CmdVariant[];
  } catch (err) {
    process.stderr.write(`\n  Failed to read menu: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(0);
  }

  if (!Array.isArray(menu) || menu.length === 0) {
    process.stderr.write("\n  No command templates to choose from.\n\n");
    process.exit(0);
  }

  const { filterableSelect } = await import("../lib/rt-render.tsx");

  const options = menu.map((c, i) => ({
    value: String(i),
    label: c.alias ?? c.cmd,
    // When an alias exists, surface the raw command as the fuzzy-search hint
    // so the user can still disambiguate similar aliases by their underlying cmd.
    hint: c.alias ? c.cmd : "",
  }));

  try {
    const picked = await filterableSelect({ message: "Switch command template", options });
    if (!picked) process.exit(0);
    process.stdout.write(picked + "\n");
    process.exit(0);
  } catch {
    process.exit(0);
  }
}
