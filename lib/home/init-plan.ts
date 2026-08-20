/**
 * `rt home init` plan-of-record (RT-30, per MAT-374 rulings 1-3, 5).
 *
 * Pure logic: turns a probed HomeState into an ordered InitStep[]. No fs, no
 * exec — Task 2's init-exec.ts is the seam that runs these against real git
 * and gh.
 */

import { renderHomeGitignore } from "./boundary.ts";

export interface HomeState {
  isRepo: boolean;
  hasUserClone: boolean;
  hasTeamClones: string[];
  cruft: string[];
}

export type InitStep =
  | { kind: "createRepo"; name: string; owner?: string }
  | { kind: "gitInit"; branch: string }
  | { kind: "writeGitignore"; content: string }
  | { kind: "writeOwners"; content: string }
  | { kind: "deleteCruft"; paths: string[] }
  | { kind: "foldInPrefs" }
  | { kind: "adoptCommit"; message: string }
  | { kind: "push" };

export interface InitPlan {
  steps: InitStep[];
  /** Set only when the plan is empty because ~/.mattstack is already a repo. */
  reason?: "already-initialized";
}

export const DEFAULT_HOME_REPO_NAME = "mattstack-home";
export const ADOPT_COMMIT_MESSAGE = "home: adopt the declarative layer";

function renderOwnersFile(): string {
  return "{\n  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n  // auto-commit. Empty until a zone is claimed.\n}\n";
}

/**
 * Idempotence lives here, not in the executor: a repo that already exists
 * gets an empty plan so Task 2's executor never has to re-derive the check.
 */
export function buildInitPlan(state: HomeState): InitPlan {
  if (state.isRepo) return { steps: [], reason: "already-initialized" };

  const steps: InitStep[] = [
    { kind: "createRepo", name: DEFAULT_HOME_REPO_NAME },
    { kind: "gitInit", branch: "main" },
    { kind: "writeGitignore", content: renderHomeGitignore() },
    { kind: "writeOwners", content: renderOwnersFile() },
  ];

  if (state.cruft.length > 0) steps.push({ kind: "deleteCruft", paths: state.cruft });
  if (state.hasUserClone) steps.push({ kind: "foldInPrefs" });

  steps.push({ kind: "adoptCommit", message: ADOPT_COMMIT_MESSAGE });
  steps.push({ kind: "push" });

  return { steps };
}
