/**
 * rt pick-lane — Interactive repo + port picker for adding a new runner lane.
 *
 * Spawned by `rt runner` in a tmux pane when the user presses [l].
 * Writes { repoName, port } as JSON to stdout so the runner can read it
 * from a temp file. All interactive prompts go to stderr (which is /dev/tty).
 */

import { createInterface } from "readline";
import { getKnownRepos } from "../lib/repo.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export async function pickLane(_args: string[], _ctx: CommandContext): Promise<void> {
  const repos = getKnownRepos();

  if (repos.length === 0) {
    process.stderr.write("\n  No known repos. Run rt from inside a git repo first.\n\n");
    process.exit(1);
  }

  // ── Step 1: pick a repo ───────────────────────────────────────────────────
  const { filterableSelect } = await import("../lib/rt-render.tsx");

  const repoOptions = repos.map((r) => ({
    value: r.repoName,
    label: r.repoName,
    hint: r.worktrees.length > 1
      ? `${r.worktrees.length} worktrees`
      : (r.worktrees[0]?.path.replace(process.env.HOME ?? "", "~") ?? ""),
  }));

  let repoName: string;
  try {
    repoName = await filterableSelect({ message: "Select a repo for this lane", options: repoOptions });
  } catch {
    process.exit(1);
  }

  // ── Step 2: prompt for canonical port ────────────────────────────────────
  const port = await promptPort();
  if (!port) process.exit(1);

  // ── Write result to stdout (runner redirects to tmpFile) ─────────────────
  process.stdout.write(JSON.stringify({ repoName, port }) + "\n");
  process.exit(0);
}

function promptPort(): Promise<number | null> {
  return new Promise((resolve) => {
    // Open /dev/tty directly so stdin can be redirected to a file by the caller.
    const tty = process.stderr.isTTY ? process.stderr : process.stdout;
    const rl = createInterface({ input: process.stdin, output: tty, terminal: true });
    tty.write("\n  Canonical port for this lane: ");
    rl.question("", (answer) => {
      rl.close();
      const n = parseInt(answer.trim(), 10);
      resolve(n > 1024 && n < 65536 ? n : null);
    });
    rl.once("close", () => resolve(null));
  });
}
