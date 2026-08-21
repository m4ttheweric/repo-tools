/**
 * `rt home init` plan-of-record.
 *
 * Pure logic: turns a probed HomeState into an ordered InitStep[]. No fs, no
 * exec — a separate execution seam runs these against real git and gh.
 */

import { renderHomeGitignore } from "./boundary.ts";

export interface HomeState {
  isRepo: boolean;
  hasUserClone: boolean;
  hasTeamClones: string[];
  cruft: string[];
  /** origin URL of user/.git, parsed before it's ever unlinked. */
  prefsRemoteUrl?: string;
}

export type InitStep =
  | { kind: "createRepo"; name: string }
  | { kind: "gitInit"; branch: string }
  | { kind: "writeGitignore"; content: string }
  | { kind: "writeOwners"; content: string }
  | { kind: "deleteCruft"; paths: string[] }
  | { kind: "unlinkUserClone" }
  | { kind: "foldInPrefs"; sourceUrl: string }
  | { kind: "adoptCommit"; message: string }
  | { kind: "push"; branch: string };

export interface InitPlan {
  steps: InitStep[];
  /**
   * Set only when the plan is empty:
   * - "already-initialized": ~/.mattstack is already a repo.
   * - "prefs-remote-unreadable": there's a user/ clone to fold in, but its
   *   origin URL couldn't be parsed — never emit a fold the executor can't
   *   actually run.
   */
  reason?: "already-initialized" | "prefs-remote-unreadable";
}

export const DEFAULT_HOME_REPO_NAME = "mattstack-home";
export const DEFAULT_HOME_BRANCH = "main";
export const ADOPT_COMMIT_MESSAGE = "home: adopt the declarative layer";

function renderOwnersFile(): string {
  return "{\n  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n  // auto-commit. Empty until a zone is claimed.\n}\n";
}

/**
 * Idempotence lives here, not in the executor: a repo that already exists
 * gets an empty plan so the executor never has to re-derive the check.
 */
export function buildInitPlan(state: HomeState): InitPlan {
  if (state.isRepo) return { steps: [], reason: "already-initialized" };
  if (state.hasUserClone && !state.prefsRemoteUrl) {
    return { steps: [], reason: "prefs-remote-unreadable" };
  }

  const steps: InitStep[] = [
    { kind: "createRepo", name: DEFAULT_HOME_REPO_NAME },
    { kind: "gitInit", branch: DEFAULT_HOME_BRANCH },
    { kind: "writeGitignore", content: renderHomeGitignore() },
    { kind: "writeOwners", content: renderOwnersFile() },
  ];

  if (state.cruft.length > 0) steps.push({ kind: "deleteCruft", paths: state.cruft });

  // unlinkUserClone runs BEFORE adoptCommit: a live user/.git left in place
  // makes `git add -A` stage `user` as a GITLINK (mode 160000), not the real
  // files under it — the fold-in merge below then sees those files as
  // untracked and refuses. Removing .git first makes `user/**` ordinary
  // tracked files, so the later merge is a clean add/add of identical blobs.
  if (state.hasUserClone) steps.push({ kind: "unlinkUserClone" });

  // adoptCommit runs BEFORE foldInPrefs: folding merges FETCH_HEAD with
  // --allow-unrelated-histories, and a merge into a still-unborn HEAD (no
  // commits yet) refuses to clobber the untracked user/ files already on
  // disk. Committing first turns that merge into a clean 3-way add/add.
  steps.push({ kind: "adoptCommit", message: ADOPT_COMMIT_MESSAGE });
  if (state.hasUserClone) steps.push({ kind: "foldInPrefs", sourceUrl: state.prefsRemoteUrl! });

  steps.push({ kind: "push", branch: DEFAULT_HOME_BRANCH });

  return { steps };
}
