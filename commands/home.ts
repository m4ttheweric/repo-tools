/**
 * rt home — the git-backed ~/.mattstack home repo.
 *
 *   rt home init [--dry-run]   print, then run, the adoption plan
 *   rt home key export        print the age private key once, for a password manager
 *
 * `init` gathers state, prints the plan from lib/home/init-plan.ts, and
 * (unless --dry-run) runs it through lib/home/init-exec.ts's injected seam.
 * `key export` delegates entirely to lib/home/age-key.ts.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { mattstackHome, teamsDir } from "../lib/rt-paths.ts";
import { buildInitPlan, type HomeState, type InitStep } from "../lib/home/init-plan.ts";
import { createRealExecSeam, executeInitPlan, type ExecResult, type ExecSeam } from "../lib/home/init-exec.ts";
import { parseOriginUrl } from "../lib/home/git-config.ts";
import {
  AgeKeyAbsentError,
  createRealAgeKeySeam,
  ensureAgeKey,
  keyExport,
  renderSopsYaml,
  sopsYamlRecipient,
  type AgeKeySeam,
} from "../lib/home/age-key.ts";

/** Stray root cruft deleted at init time, not adopted into the repo. */
const CRUFT_CANDIDATES = ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"];

export interface HomeProbes {
  isGitRepo(dir: string): boolean;
  exists(path: string): boolean;
  listTeamClones(): string[];
  /** Pure fs read; null when the file is missing or unreadable. */
  readFile(path: string): string | null;
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
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function gatherHomeState(home: string, probes: HomeProbes): HomeState {
  // hasUserClone gates foldInPrefs, which runs `git filter-repo` against
  // this directory — a plain (non-git) user/ must not trigger it.
  const hasUserClone = probes.isGitRepo(join(home, "user"));
  // Read while user/.git still exists — unlinkUserClone (lib/home/init-exec.ts)
  // removes it before the fold-in re-clones from this URL.
  const prefsRemoteUrl = hasUserClone
    ? (parseOriginUrl(probes.readFile(join(home, "user", ".git", "config")) ?? "") ?? undefined)
    : undefined;

  return {
    isRepo: probes.isGitRepo(home),
    hasUserClone,
    hasTeamClones: probes.listTeamClones(),
    cruft: CRUFT_CANDIDATES.filter((name) => probes.exists(join(home, name))),
    prefsRemoteUrl,
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
    case "unlinkUserClone":
      return "unlink user/.git (fold-in re-clones from the origin remote)";
    case "foldInPrefs":
      return `fold mattstack-prefs history into user/ (git filter-repo, from ${step.sourceUrl})`;
    case "adoptCommit":
      return `commit: "${step.message}"`;
    case "push":
      return `push -u origin ${step.branch}`;
  }
}

/**
 * The sole mint site: `key export` (lib/home/age-key.ts:keyExport) refuses
 * to mint, precisely so a keychain-access error there can never be mistaken
 * for "no key yet". Idempotent (ensureAgeKey mints only on provable
 * absence), so it's safe to run on every init — including the
 * already-initialized short-circuit, for a home repo that predates this
 * step.
 *
 * Also (re)writes `.sops.yaml` whenever it's missing or its recipient
 * doesn't match the current key — the one place `rt secrets set` gets a
 * creation rule to encrypt against. A hand-edited file already carrying the
 * right recipient is left untouched. `.sops.yaml` is a TRACKED file, so a
 * write here needs a human commit — the snapshot daemon doesn't exist yet.
 */
async function ensureHomeAgeKey(seams: AgeKeySeam, sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam()): Promise<void> {
  const { publicKey } = await ensureAgeKey(seams);

  const sopsYamlPath = join(mattstackHome(), ".sops.yaml");
  const existing = sopsYamlSeam.read(sopsYamlPath);
  if (existing === null || sopsYamlRecipient(existing) !== publicKey) {
    sopsYamlSeam.write(sopsYamlPath, renderSopsYaml(publicKey));
    console.log(
      `rt home init: wrote ${sopsYamlPath} (recipient ${publicKey}) — it's tracked, so commit it:\n` +
        `  git -C ${mattstackHome()} add .sops.yaml && git -C ${mattstackHome()} commit -m "home: sops recipient"`,
    );
  }

  console.log(
    `rt home init: age key ready — recipient ${publicKey}.\n` +
      "  Run `rt home key export` to save the private key to your password manager.",
  );
}

const GH_AUTH_HINT = "gh is not authenticated. Run:\n  gh auth login";
const FILTER_REPO_HINT = "git-filter-repo is not installed. Run:\n  brew install git-filter-repo";

/**
 * A missing binary makes the seam's `run()` throw (Bun.spawn rejects on
 * ENOENT) rather than return a non-zero code, so each check needs its own
 * catch — an uncaught throw here would surface as a raw stack instead of the
 * install hint.
 */
async function preflight(exec: ExecSeam): Promise<string | null> {
  let auth: ExecResult;
  try {
    auth = await exec.run(["gh", "auth", "status"]);
  } catch {
    return GH_AUTH_HINT;
  }
  if (auth.code !== 0) return GH_AUTH_HINT;

  let filterRepo: ExecResult;
  try {
    filterRepo = await exec.run(["git", "filter-repo", "--version"]);
  } catch {
    return FILTER_REPO_HINT;
  }
  if (filterRepo.code !== 0) return FILTER_REPO_HINT;

  return null;
}

export async function homeInit(
  args: string[],
  _ctx: CommandContext = {},
  probes: HomeProbes = defaultProbes(),
  exec: ExecSeam = createRealExecSeam(mattstackHome()),
  ageKeySeam: AgeKeySeam = createRealAgeKeySeam(),
  sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam(),
): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const home = mattstackHome();
  const state = gatherHomeState(home, probes);
  const plan = buildInitPlan(state);

  if (plan.reason === "already-initialized") {
    console.log(`rt home init: ${home} is already a git repo — nothing to do.`);
    if (!dryRun) await ensureHomeAgeKey(ageKeySeam, sopsYamlSeam);
    return;
  }

  if (plan.reason === "prefs-remote-unreadable") {
    console.error(
      `rt home init: could not read the origin URL from ${join(home, "user", ".git", "config")} — ` +
        "refusing to fold in a remote it can't identify.",
    );
    process.exit(1);
  }

  console.log(`rt home init plan for ${home}:`);
  plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${describeStep(step)}`));

  if (dryRun) return;

  const preflightError = await preflight(exec);
  if (preflightError) {
    console.error(`\nrt home init: preflight failed — nothing was run.\n${preflightError}`);
    process.exit(1);
  }

  console.log("");
  const result = await executeInitPlan(plan.steps, exec, (message) => console.log(`  ${message}`));

  if (!result.ok) {
    console.error(`\nrt home init: failed at step "${result.failedStep}":\n${result.stderr}`);
    process.exit(1);
  }

  // Mint (or backfill) BEFORE the success line: printing success ahead of a
  // failed mint would tell the operator init worked while `rt secrets set`
  // still has no key or creation rule to encrypt against.
  await ensureHomeAgeKey(ageKeySeam, sopsYamlSeam);
  console.log(`\nrt home init: ${home} is now the git-backed home repo.`);
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
