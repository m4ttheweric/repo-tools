/**
 * `rt home init` plan-of-record.
 *
 * Pure logic: turns a probed HomeState into an ordered InitStep[]. No fs, no
 * exec — a separate execution seam (lib/home/init-exec.ts) runs these
 * against real git and the filesystem.
 */

import { renderHomeGitignore } from "./boundary.ts";

/** ~/.mattstack state-zone directories: no repo, never travel. */
export const STATE_DIR_NAMES = ["rt", "deck", "shepherdr", "repos", "work", "teams"];

export interface HomeState {
  userRepoPresent: boolean;
  machineKeyFilePresent: boolean;
  profileDirPresent: boolean;
  skillsSymlinkPresent: boolean;
  /** A REAL file (not a symlink) already occupies the root skills.jsonc path. */
  skillsSymlinkBlocked: boolean;
  stateDirsMissing: string[];
}

export interface InitPlanConfig {
  url: string;
  machineKey: string;
}

export type InitStep =
  | { kind: "ensureStateDirs"; dirs: string[] }
  | { kind: "cloneUserRepo"; url: string }
  | { kind: "writeGitignore"; content: string }
  | { kind: "writeOwners"; content: string }
  | { kind: "writeMachineKey"; key: string }
  | { kind: "ensureProfileDir"; key: string }
  | { kind: "writeSkillsSymlink" };

export interface InitPlan {
  steps: InitStep[];
  /** Set only when writeSkillsSymlink was omitted for skillsSymlinkBlocked — every other applicable step still runs. */
  blocked?: "skills-symlink-real-file";
}

function renderOwnersFile(): string {
  return "{\n  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n  // auto-commit. Empty until a zone is claimed.\n}\n";
}

/**
 * Idempotence lives here, not in the executor: each step is gated on its own
 * probe, so a fully-provisioned machine naturally converges to an empty
 * plan without a special-cased short-circuit.
 */
export function buildInitPlan(state: HomeState, config: InitPlanConfig): InitPlan {
  const steps: InitStep[] = [];

  if (state.stateDirsMissing.length > 0) {
    steps.push({ kind: "ensureStateDirs", dirs: state.stateDirsMissing });
  }

  // writeGitignore/writeOwners ride along with the clone: an already-present
  // user/ repo already carries these from its own history, so re-running
  // init against it is provisioning-only and must not touch them.
  if (!state.userRepoPresent) {
    steps.push({ kind: "cloneUserRepo", url: config.url });
    steps.push({ kind: "writeGitignore", content: renderHomeGitignore() });
    steps.push({ kind: "writeOwners", content: renderOwnersFile() });
  }

  if (!state.machineKeyFilePresent) {
    steps.push({ kind: "writeMachineKey", key: config.machineKey });
  }

  if (!state.profileDirPresent) {
    steps.push({ kind: "ensureProfileDir", key: config.machineKey });
  }

  if (state.skillsSymlinkBlocked) {
    return { steps, blocked: "skills-symlink-real-file" };
  }

  if (!state.skillsSymlinkPresent) {
    steps.push({ kind: "writeSkillsSymlink" });
  }

  return { steps };
}
