/**
 * rt git pull — Mirror of GitHub Desktop's "Pull origin" button.
 *
 * Faithful to desktop/desktop app/src/lib/git/pull.ts:
 *   git -c rebase.backend=merge pull [--ff] --recurse-submodules --progress [--no-verify] <remote>
 *
 * The merge-vs-rebase decision is delegated to the user's git config
 * (pull.rebase, branch.*.rebase), matching Desktop. --ff is added only
 * when pull.ff is unset, also matching Desktop.
 */

import { spawnSync, execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../../lib/tui.ts";
import { getCurrentBranch, hasUncommittedChanges } from "../../lib/git-ops.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasPullFfConfig(cwd: string): boolean {
  const r = spawnSync("git", ["config", "--get", "pull.ff"], {
    cwd, stdio: "pipe", encoding: "utf8",
  });
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

export async function pullCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  if (hasUncommittedChanges(cwd)) {
    console.error(`\n  ${red}uncommitted changes — commit or stash before pulling${reset}\n`);
    process.exit(1);
  }

  const remote = argValue(args, "--remote") ?? "origin";
  const dryRun = args.includes("--dry-run");
  const noVerify = args.includes("--no-verify");
  const forceRebase = args.includes("--rebase");
  const forceNoRebase = args.includes("--no-rebase");

  const gitArgs: string[] = ["-c", "rebase.backend=merge", "pull"];

  if (!hasPullFfConfig(cwd)) gitArgs.push("--ff");
  if (forceRebase) gitArgs.push("--rebase");
  if (forceNoRebase) gitArgs.push("--no-rebase");
  gitArgs.push("--recurse-submodules", "--progress");
  if (noVerify) gitArgs.push("--no-verify");
  gitArgs.push(remote);

  console.log(`\n  ${bold}${cyan}rt git pull${reset} ${dim}(${branch} ← ${remote})${reset}`);
  console.log(`  ${dim}git ${gitArgs.join(" ")}${reset}\n`);

  if (dryRun) {
    console.log(`  ${yellow}--dry-run — not running${reset}\n`);
    return;
  }

  const r = spawnSync("git", gitArgs, { cwd, stdio: "inherit" });
  if (r.status === 0) {
    console.log(`\n  ${green}✓${reset} pulled ${bold}${branch}${reset} from ${remote}\n`);
    return;
  }

  process.exit(r.status ?? 1);
}
