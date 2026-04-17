/**
 * rt pick-lane — Interactive repo + port picker for adding a new runner lane.
 *
 * Spawned by `rt runner` in a tmux popup when the user presses [l] then [a].
 * Writes { repoName, port } as JSON to stdout so the runner can read it
 * from a temp file. All interactive prompts go to stderr (which is /dev/tty).
 */

import { getKnownRepos } from "../lib/repo.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export async function pickLane(_args: string[], _ctx: CommandContext): Promise<void> {
  const repos = getKnownRepos();

  if (repos.length === 0) {
    process.stderr.write("\n  No known repos. Run rt from inside a git repo first.\n\n");
    process.exit(0);
  }

  const { filterableSelect, textInput } = await import("../lib/rt-render.tsx");

  // ── Step 1: pick a repo ───────────────────────────────────────────────────
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
    process.exit(0);
  }

  // ── Step 2: prompt for canonical port ────────────────────────────────────
  let portStr: string;
  try {
    portStr = await textInput({ message: "Canonical port for this lane", placeholder: "e.g. 3000" });
  } catch {
    process.exit(0);
  }

  const port = parseInt(portStr.trim(), 10);
  if (!port || port <= 1024 || port >= 65536) {
    process.stderr.write("\n  Invalid port number.\n\n");
    process.exit(0);
  }

  // ── Write result to stdout (runner redirects to tmpFile) ─────────────────
  process.stdout.write(JSON.stringify({ repoName, port }) + "\n");
  process.exit(0);
}
