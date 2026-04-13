/**
 * rt gitx — Git passthrough with rt-resolved CWD.
 *
 * Convenience for running any git command in the right directory.
 * Uses requireIdentity() to resolve the repo root, then exec's git.
 *
 * Usage:
 *   rt gitx status              → git status (in repo root)
 *   rt gitx log --oneline -10   → git log (in repo root)
 *   rt gitx diff HEAD~3         → git diff (in repo root)
 */

import { spawnSync } from "child_process";
import { dim, yellow, reset } from "../lib/tui.ts";
import type { CommandContext } from "../lib/command-tree.ts";

export async function gitPassthrough(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  if (args.length === 0) {
    console.log(`\n  ${dim}usage: rt gitx <git-command> [args...]${reset}`);
    console.log(`  ${dim}runs git in ${cwd}${reset}\n`);
    return;
  }

  const result = spawnSync("git", args, {
    cwd,
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
}
