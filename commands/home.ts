/**
 * rt home — the git-backed ~/.mattstack/user personal repo, plus per-machine
 * provisioning of the ~/.mattstack tree around it.
 *
 *   rt home init [--dry-run] [--url <remote>]   print, then run, the provisioning plan
 *   rt home key export                          print the age private key once, for a password manager
 *
 * `init` gathers state, prints the plan from lib/home/init-plan.ts, and
 * (unless --dry-run) runs it through lib/home/init-exec.ts's injected seam.
 * `key export` delegates entirely to lib/home/age-key.ts.
 */

import { existsSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { machineKey, mattstackHome } from "../lib/rt-paths.ts";
import { buildInitPlan, STATE_DIR_NAMES, type HomeState, type InitStep } from "../lib/home/init-plan.ts";
import { createRealExecSeam, executeInitPlan, type ExecSeam } from "../lib/home/init-exec.ts";
import {
  AgeKeyAbsentError,
  createRealAgeKeySeam,
  ensureAgeKey,
  keyExport,
  renderSopsYaml,
  sopsYamlRecipient,
  type AgeKeySeam,
} from "../lib/home/age-key.ts";

export const DEFAULT_USER_REPO_URL = "https://github.com/m4ttheweric/mattstack-home";

export interface HomeProbes {
  isGitRepo(dir: string): boolean;
  exists(path: string): boolean;
  /** The symlink's target, or null when `path` is absent or not a symlink. */
  readSymlinkTarget(path: string): string | null;
}

export interface SopsYamlSeam {
  read(path: string): string | null;
  write(path: string, content: string): void;
}

function defaultSopsYamlSeam(): SopsYamlSeam {
  return {
    read: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write: (path, content) => writeFileSync(path, content),
  };
}

function defaultProbes(): HomeProbes {
  return {
    isGitRepo: (dir) => existsSync(join(dir, ".git")),
    exists: (path) => existsSync(path),
    readSymlinkTarget: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
  };
}

const SKILLS_SYMLINK_TARGET = join("user", "skills.jsonc");

export function gatherHomeState(home: string, probes: HomeProbes, machineKeyValue: string): HomeState {
  const userRepoPresent = probes.isGitRepo(join(home, "user"));
  const machineKeyFilePresent = probes.exists(join(home, "machine-key"));
  const profileDirPresent = probes.exists(join(home, "user", "local", machineKeyValue));

  const skillsPath = join(home, "skills.jsonc");
  const symlinkTarget = probes.readSymlinkTarget(skillsPath);
  const skillsSymlinkPresent = symlinkTarget === SKILLS_SYMLINK_TARGET;
  const skillsSymlinkBlocked = symlinkTarget === null && probes.exists(skillsPath);

  const stateDirsMissing = STATE_DIR_NAMES.filter((name) => !probes.exists(join(home, name)));

  return {
    userRepoPresent,
    machineKeyFilePresent,
    profileDirPresent,
    skillsSymlinkPresent,
    skillsSymlinkBlocked,
    stateDirsMissing,
  };
}

function describeStep(step: InitStep): string {
  switch (step.kind) {
    case "ensureStateDirs":
      return `create missing state dirs: ${step.dirs.join(", ")}`;
    case "cloneUserRepo":
      return `clone ${step.url} into user/`;
    case "writeGitignore":
      return "write the user repo's .gitignore";
    case "writeOwners":
      return "write user/snapshot-owners.jsonc";
    case "writeMachineKey":
      return `write the machine-key file (${step.key})`;
    case "ensureProfileDir":
      return `create user/local/${step.key}/`;
    case "writeSkillsSymlink":
      return "link skills.jsonc -> user/skills.jsonc";
  }
}

function parseUrlArg(args: string[]): string {
  const idx = args.indexOf("--url");
  const value = idx !== -1 ? args[idx + 1] : undefined;
  return value && value.length > 0 ? value : DEFAULT_USER_REPO_URL;
}

/**
 * The sole mint site: `key export` (lib/home/age-key.ts:keyExport) refuses
 * to mint, precisely so a keychain-access error there can never be mistaken
 * for "no key yet". Idempotent (ensureAgeKey mints only on provable
 * absence), so it's safe to run on every init — including a fully-
 * provisioned machine, for a home repo that predates this step.
 *
 * Also (re)writes `.sops.yaml` whenever it's missing or its recipient
 * doesn't match the current key — the one place `rt secrets set` gets a
 * creation rule to encrypt against. A hand-edited file already carrying the
 * right recipient is left untouched. `.sops.yaml` is a TRACKED file, so a
 * write here needs a human commit — the snapshot daemon doesn't exist yet.
 *
 * Called only after the init plan (which clones user/ when it's missing)
 * has run to completion, so user/ always already exists by the time this
 * writes into it.
 */
async function ensureHomeAgeKey(seams: AgeKeySeam, sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam()): Promise<void> {
  const { publicKey } = await ensureAgeKey(seams);

  // Lives under user/ (not the repo root): sops matches path_regex cwd-relative
  // and every sops spawn pins cwd to <mattstackHome>/user (store.ts), so
  // .sops.yaml must sit there too for that discovery to find it.
  const sopsYamlPath = join(mattstackHome(), "user", ".sops.yaml");
  const existing = sopsYamlSeam.read(sopsYamlPath);
  if (existing === null || sopsYamlRecipient(existing) !== publicKey) {
    sopsYamlSeam.write(sopsYamlPath, renderSopsYaml(publicKey));
    console.log(
      `rt home init: wrote ${sopsYamlPath} (recipient ${publicKey}) — it's tracked, so commit it:\n` +
        `  git -C ${mattstackHome()} add user/.sops.yaml && git -C ${mattstackHome()} commit -m "home: sops recipient"`,
    );
  }

  console.log(
    `rt home init: age key ready — recipient ${publicKey}.\n` +
      "  Run `rt home key export` to save the private key to your password manager.",
  );
}

export async function homeInit(
  args: string[],
  _ctx: CommandContext = {},
  probes: HomeProbes = defaultProbes(),
  exec: ExecSeam = createRealExecSeam(mattstackHome()),
  ageKeySeam: AgeKeySeam = createRealAgeKeySeam(),
  sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam(),
  // Evaluated at call time, like every other default here — a real fs read
  // (~/.mattstack/machine-key), so tests inject a fixed value instead of
  // depending on the test-runner's actual hostname/override file.
  key: string = machineKey(),
): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const home = mattstackHome();
  const url = parseUrlArg(args);
  const state = gatherHomeState(home, probes, key);
  const plan = buildInitPlan(state, { url, machineKey: key });

  if (plan.steps.length === 0) {
    console.log(`rt home init: ${home} is already fully provisioned — nothing to do.`);
  } else {
    console.log(`rt home init plan for ${home}:`);
    plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${describeStep(step)}`));
  }

  if (plan.blocked === "skills-symlink-real-file") {
    console.error(
      `\nrt home init: a real file already exists at ${join(home, "skills.jsonc")} — refusing to overwrite it. ` +
        "Move it aside by hand, then rerun.",
    );
  }

  if (dryRun) return;

  const result = await executeInitPlan(plan.steps, exec, (message) => console.log(`  ${message}`));

  if (!result.ok) {
    console.error(`\nrt home init: failed at step "${result.failedStep}":\n${result.stderr}`);
    process.exit(1);
  }

  // Mint (or backfill) BEFORE the success line: printing success ahead of a
  // failed mint would tell the operator init worked while `rt secrets set`
  // still has no key or creation rule to encrypt against.
  await ensureHomeAgeKey(ageKeySeam, sopsYamlSeam);

  if (plan.blocked === "skills-symlink-real-file") {
    console.error(`\nrt home init: provisioning finished, but the skills.jsonc symlink is still blocked — see above.`);
    process.exit(1);
  }

  console.log(`\nrt home init: ${home} is provisioned.`);
}

export async function homeKeyExport(
  _args: string[],
  _ctx: CommandContext = {},
  seams: AgeKeySeam = createRealAgeKeySeam(),
): Promise<void> {
  try {
    await keyExport(seams, (text) => console.log(text));
  } catch (err) {
    if (err instanceof AgeKeyAbsentError) {
      console.error(`rt home key export: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
