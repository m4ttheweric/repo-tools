/**
 * rt git push        — Push the current branch, guaranteeing upstream is
 *                      origin/<branch>. Detects post-rebase divergence and
 *                      points the user at `rt git push force`.
 * rt git push force  — Same, with --force-with-lease (for rebased/amended
 *                      branches). Plain --force is intentionally unsupported.
 * rt git upstream    — Fix branch.<name>.remote / .merge without pushing.
 *
 * Fixes the common "new feature branch tracks origin/master" issue by
 * rewriting the tracking config pre-push AND using an explicit
 * `git push -u origin <branch>` refspec (so a stale upstream can't
 * misdirect the push).
 */

import { execSync, spawnSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../../lib/tui.ts";
import { getCurrentBranch } from "../../lib/git-ops.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

interface UpstreamConfig {
  remote: string;
  merge: string;
}

function gitConfigGet(key: string, cwd: string): string | null {
  const r = spawnSync("git", ["config", "--get", key], {
    cwd, stdio: "pipe", encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const value = (r.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

function getUpstreamConfig(branch: string, cwd: string): UpstreamConfig | null {
  const remote = gitConfigGet(`branch.${branch}.remote`, cwd);
  const merge = gitConfigGet(`branch.${branch}.merge`, cwd);
  if (!remote || !merge) return null;
  return { remote, merge };
}

function setUpstreamConfig(branch: string, remote: string, cwd: string): void {
  execSync(`git config branch.${branch}.remote ${remote}`, { cwd, stdio: "pipe" });
  execSync(`git config branch.${branch}.merge refs/heads/${branch}`, { cwd, stdio: "pipe" });
}

function labelUpstream(u: UpstreamConfig | null): string {
  if (!u) return "(unset)";
  return `${u.remote}/${u.merge.replace(/^refs\/heads\//, "")}`;
}

function isUpstreamCorrect(
  current: UpstreamConfig | null,
  branch: string,
  remote: string,
): boolean {
  return !!current
    && current.remote === remote
    && current.merge === `refs/heads/${branch}`;
}

// ─── rt git upstream ────────────────────────────────────────────────────────

export async function upstreamCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dryRun = args.includes("--dry-run");
  const remote = argValue(args, "--remote") ?? "origin";

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  const current = getUpstreamConfig(branch, cwd);
  const desired: UpstreamConfig = { remote, merge: `refs/heads/${branch}` };

  console.log(`\n  ${bold}${cyan}rt git upstream${reset} ${dim}(${branch})${reset}\n`);
  console.log(`  ${dim}current:${reset} ${labelUpstream(current)}`);
  console.log(`  ${dim}desired:${reset} ${labelUpstream(desired)}`);

  if (isUpstreamCorrect(current, branch, remote)) {
    console.log(`\n  ${green}✓${reset} upstream already ${bold}${labelUpstream(desired)}${reset}\n`);
    return;
  }

  if (dryRun) {
    console.log(`\n  ${yellow}--dry-run — not applying${reset}\n`);
    return;
  }

  setUpstreamConfig(branch, remote, cwd);
  console.log(`\n  ${green}✓${reset} upstream set to ${bold}${labelUpstream(desired)}${reset}\n`);
}

// ─── rt git push ────────────────────────────────────────────────────────────

/**
 * Returns true if origin/<branch> is an ancestor of HEAD (fast-forward push
 * possible), false if they've diverged (force needed), or null if the remote
 * branch doesn't exist yet (first push).
 */
function isFastForwardPossible(
  branch: string,
  remote: string,
  cwd: string,
): boolean | null {
  const verify = spawnSync("git", ["rev-parse", "--verify", `${remote}/${branch}`], {
    cwd, stdio: "pipe",
  });
  if (verify.status !== 0) return null;

  const r = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${remote}/${branch}`, "HEAD"],
    { cwd, stdio: "pipe" },
  );
  return r.status === 0;
}

interface PushOptions {
  force: boolean;
}

async function runPush(
  args: string[],
  ctx: CommandContext,
  opts: PushOptions,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const dryRun = args.includes("--dry-run");
  const noVerify = args.includes("--no-verify");
  const remote = argValue(args, "--remote") ?? "origin";

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  let force = opts.force;

  // Non-force path: detect divergence up front. Offer force-with-lease
  // interactively so the user doesn't have to re-invoke the command.
  if (!force) {
    const ff = isFastForwardPossible(branch, remote, cwd);
    if (ff === false) {
      if (process.stdin.isTTY) {
        const { select } = await import("../../lib/rt-render.tsx");
        const choice = await select({
          message: `local has diverged from ${remote}/${branch} (likely after a rebase) — force push?`,
          options: [
            { value: "force", label: "Force push with --force-with-lease" },
            { value: "cancel", label: "Cancel" },
          ],
        });
        if (choice !== "force") {
          console.log(`\n  ${dim}cancelled${reset}\n`);
          return;
        }
        force = true;
      } else {
        console.error(`\n  ${yellow}local has diverged from ${remote}/${branch} (likely after a rebase or amend)${reset}`);
        console.error(`  ${dim}use${reset} ${bold}rt git push force${reset} ${dim}for --force-with-lease${reset}\n`);
        process.exit(1);
      }
    }
  }

  // Pre-push: rewrite branch config so a later bare `git push` also works.
  // This is the fix for the "new branch tracks origin/master" problem.
  const current = getUpstreamConfig(branch, cwd);
  const upstreamWasWrong = !isUpstreamCorrect(current, branch, remote);
  if (upstreamWasWrong && !dryRun) {
    setUpstreamConfig(branch, remote, cwd);
  }

  const label = opts.force ? "rt git push force" : "rt git push";

  const gitArgs: string[] = ["push"];
  if (force) gitArgs.push("--force-with-lease");
  if (noVerify) gitArgs.push("--no-verify");
  gitArgs.push("-u", remote, branch);

  console.log(`\n  ${bold}${cyan}${label}${reset} ${dim}(${branch} → ${remote}/${branch})${reset}`);
  if (upstreamWasWrong) {
    console.log(`  ${dim}upstream:${reset} ${labelUpstream(current)} ${dim}→${reset} ${remote}/${branch}`);
  }
  console.log(`  ${dim}git ${gitArgs.join(" ")}${reset}\n`);

  if (dryRun) {
    console.log(`  ${yellow}--dry-run — not running${reset}\n`);
    return;
  }

  const r = spawnSync("git", gitArgs, { cwd, stdio: "inherit" });
  if (r.status === 0) {
    console.log(`\n  ${green}✓${reset} pushed ${bold}${branch}${reset} to ${remote}/${branch}\n`);
    return;
  }
  process.exit(r.status ?? 1);
}

export async function pushCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  return runPush(args, ctx, { force: false });
}

export async function forcePushCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  return runPush(args, ctx, { force: true });
}
