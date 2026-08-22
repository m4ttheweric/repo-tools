/**
 * `rt home init` plan-of-record.
 *
 * Pure logic: turns a probed HomeState into an ordered InitStep[]. No fs, no
 * exec — a separate execution seam (lib/home/init-exec.ts) runs these
 * against real git and the filesystem.
 */

import { isSafeMachineKeySegment } from "../rt-paths.ts";
import { renderHomeGitignore } from "./boundary.ts";

/** ~/.mattstack state-zone directories: no repo, never travel. */
export const STATE_DIR_NAMES = ["rt", "deck", "shepherdr", "repos", "ci-attendants", "work", "teams"];

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

/**
 * The seeded owners-file template — exported so lib/home/snapshot-owners.ts
 * writes the identical text (one definition, no drift between init and the
 * claim/release path). The "zones" property must already exist: jsonc-parser's
 * `modify` inserting the FIRST property into a property-less-but-braced
 * object reorders the header comment below it, but editing an EXISTING
 * "zones": {} in place leaves the comment untouched (verified against the
 * installed jsonc-parser 3.3.1).
 */
export function renderOwnersFile(): string {
  return (
    "{\n" +
    "  // snapshot-owners.jsonc — claimed zones the snapshot daemon must never\n" +
    "  // auto-commit. Empty until a zone is claimed.\n" +
    '  // A key ending in "/" is a DIRECTORY zone (claims everything under it),\n' +
    '  // e.g. "prefs/". A key with NO trailing slash is a single-FILE zone\n' +
    '  // (claims exactly that path), e.g. "scripts/deploy.sh".\n' +
    '  "zones": {}\n' +
    "}\n"
  );
}

/** A machine-key value that would fail machineKey()'s own override guard — refused before it can ever be written and then silently ignored. */
export class InvalidMachineKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a safe machine-key segment (empty, ".", "..", or containing "/" or "\\")`);
  }
}

// ─── Machine-profile picker (rt home init on a fresh/keyless machine) ──────

export interface ChooseMachineProfileInput {
  /** Existing `user/local/<key>/` profiles (dirs carrying settings.local.jsonc) — only knowable once `user/` is cloned. */
  profiles: string[];
  hostnameSlug: string;
  flags: { profile?: string; newProfile?: boolean };
  /** True only when stdin is a real TTY — gates whether "prompt-needed" is reachable at all. */
  interactive: boolean;
}

export type ChooseMachineProfileSource = "flag" | "existing" | "hostname" | "prompt-needed";

export interface ChooseMachineProfileResult {
  /** Empty when source is "prompt-needed" — the caller must run the interactive picker; this function never blocks on I/O itself. */
  key: string;
  source: ChooseMachineProfileSource;
}

/** `--profile <key>` named something not already in `profiles`, and `--new-profile` wasn't passed to say that's intentional. */
export class UnknownProfileFlagError extends Error {
  constructor(profile: string, profiles: string[]) {
    super(
      `--profile ${profile} isn't one of the existing profiles (${profiles.length > 0 ? profiles.join(", ") : "none yet"}) — ` +
        "pass --new-profile as well to create it.",
    );
  }
}

/** Multiple profiles exist, no flag picked one, and stdin isn't a TTY to prompt on — never silently guess. */
export class ProfileChoiceRequiredError extends Error {
  constructor(profiles: string[]) {
    super(
      `${profiles.length} existing machine profile(s) (${profiles.join(", ")}) and no terminal to prompt on — ` +
        "pass --profile <key> to adopt one, or --new-profile to start a new one.",
    );
  }
}

/** Mirrors InvalidMachineKeyError for a profile key chosen by flag or hostname slug, before it ever reaches buildInitPlan. */
export class InvalidProfileKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a safe machine-profile key (empty, ".", "..", or containing "/" or "\\")`);
  }
}

/**
 * Pure decision only — never touches fs, git, or a terminal. `profiles` and
 * `interactive` are probed by the caller (post-clone, since the profile list
 * only exists once `user/local/` has landed); this just resolves what those
 * facts, plus the flags, mean. "prompt-needed" hands the interactive picker
 * back to the caller rather than running one here.
 */
export function chooseMachineProfile(input: ChooseMachineProfileInput): ChooseMachineProfileResult {
  const { profiles, hostnameSlug, flags, interactive } = input;

  function resolved(key: string, source: ChooseMachineProfileSource): ChooseMachineProfileResult {
    if (!isSafeMachineKeySegment(key)) throw new InvalidProfileKeyError(key);
    return { key, source };
  }

  if (flags.profile !== undefined) {
    if (profiles.includes(flags.profile)) return resolved(flags.profile, "existing");
    if (flags.newProfile) return resolved(flags.profile, "flag");
    throw new UnknownProfileFlagError(flags.profile, profiles);
  }

  if (flags.newProfile) return resolved(hostnameSlug, "flag");

  if (profiles.length === 0) return resolved(hostnameSlug, "hostname");

  if (!interactive) throw new ProfileChoiceRequiredError(profiles);

  return { key: "", source: "prompt-needed" };
}

/**
 * Idempotence lives here, not in the executor: each step is gated on its own
 * probe, so a fully-provisioned machine naturally converges to an empty
 * plan without a special-cased short-circuit.
 */
export function buildInitPlan(state: HomeState, config: InitPlanConfig): InitPlan {
  // Refused here, not left to machineKey()'s own guard: a bad key that
  // slipped through would get written to disk by writeMachineKey and then
  // silently rejected on the next read, stranding ensureProfileDir's
  // user/local/<bad>/ as a dead directory while the resolver quietly falls
  // back to the hostname slug.
  if (!isSafeMachineKeySegment(config.machineKey)) {
    throw new InvalidMachineKeyError(config.machineKey);
  }

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
