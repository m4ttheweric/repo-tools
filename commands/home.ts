/**
 * rt home — the git-backed ~/.mattstack home repo.
 *
 *   rt home init [--dry-run]   print the adoption plan; --dry-run stops there
 *
 * This command only gathers state and prints the plan produced by
 * lib/home/init-plan.ts; it does not run it.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { mattstackHome, teamsDir } from "../lib/rt-paths.ts";
import { buildInitPlan, type HomeState, type InitStep } from "../lib/home/init-plan.ts";

/** Stray root cruft deleted at init time, not adopted into the repo. */
const CRUFT_CANDIDATES = ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"];

export interface HomeProbes {
  isGitRepo(dir: string): boolean;
  exists(path: string): boolean;
  listTeamClones(): string[];
}

function defaultProbes(): HomeProbes {
  return {
    isGitRepo: (dir) => existsSync(join(dir, ".git")),
    exists: (path) => existsSync(path),
    listTeamClones: () => {
      const dir = teamsDir();
      if (!existsSync(dir)) return [];
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
  };
}

export function gatherHomeState(home: string, probes: HomeProbes): HomeState {
  return {
    isRepo: probes.isGitRepo(home),
    // hasUserClone gates foldInPrefs, which runs `git filter-repo` against
    // this directory — a plain (non-git) user/ must not trigger it.
    hasUserClone: probes.isGitRepo(join(home, "user")),
    hasTeamClones: probes.listTeamClones(),
    cruft: CRUFT_CANDIDATES.filter((name) => probes.exists(join(home, name))),
  };
}

function describeStep(step: InitStep): string {
  switch (step.kind) {
    case "createRepo":
      return `create the private GitHub repo ${step.name}`;
    case "gitInit":
      return `git init -b ${step.branch}`;
    case "writeGitignore":
      return "write the boundary .gitignore";
    case "writeOwners":
      return "write snapshot-owners.jsonc";
    case "deleteCruft":
      return `delete stray cruft: ${step.paths.join(", ")}`;
    case "foldInPrefs":
      return "fold mattstack-prefs history into user/ (git filter-repo)";
    case "adoptCommit":
      return `commit: "${step.message}"`;
    case "push":
      return `push -u origin ${step.branch}`;
  }
}

export async function homeInit(
  args: string[],
  _ctx: CommandContext = {},
  probes: HomeProbes = defaultProbes(),
): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const home = mattstackHome();
  const state = gatherHomeState(home, probes);
  const plan = buildInitPlan(state);

  if (plan.reason === "already-initialized") {
    console.log(`rt home init: ${home} is already a git repo — nothing to do.`);
    return;
  }

  console.log(`rt home init plan for ${home}:`);
  plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${describeStep(step)}`));

  if (dryRun) return;

  console.log("\nExecution lands with the next build — this plan was printed, not run.");
}
