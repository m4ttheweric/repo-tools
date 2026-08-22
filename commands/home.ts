/**
 * rt home — the git-backed ~/.mattstack/user personal repo, plus per-machine
 * provisioning of the ~/.mattstack tree around it.
 *
 *   rt home init [--dry-run] [--url <remote>] [--profile <key>] [--new-profile]
 *                                                     print, then run, the provisioning plan
 *   rt home key export                          print the age private key once, for a password manager
 *   rt home key import [--stdin] [--force]      bring an external age key into the keychain
 *   rt home snapshot [--status]                       run (or report on) the auto-commit daemon
 *   rt home claim <zone> [--owner] [--note] [--force]  tell the daemon to leave a path alone
 *   rt home release <zone>                             let the daemon resume auto-committing a path
 *
 * `init` gathers state, prints the plan from lib/home/init-plan.ts, and
 * (unless --dry-run) runs it through lib/home/init-exec.ts's injected seam.
 * On a fresh machine (no ~/.mattstack/machine-key yet) it also resolves
 * which `user/local/<key>/` profile to adopt or create — see
 * `chooseMachineProfile` in lib/home/init-plan.ts and the "machine profile
 * picker" section of `homeInit` below. `--profile`/`--new-profile` are only
 * meaningful on that fresh-machine path; passing either once machine-key is
 * already pinned is refused.
 * `key export`/`key import` delegate to lib/home/age-key.ts.
 * `snapshot`/`snapshot --status` are a thin round-trip to the daemon's
 * `home:snapshot`/`home:snapshot-status` handlers (lib/daemon/handlers/home.ts).
 * `claim`/`release` write user/snapshot-owners.jsonc directly via
 * lib/home/snapshot-owners.ts — no daemon round trip — the daemon picks up
 * the change on its next cycle like any other tracked file. A zone is
 * either a directory ("prefs/", or just "prefs" — claims everything under
 * it) or a single file ("scripts/deploy.sh" — claims exactly that path,
 * nothing else): `claim` decides which by checking whether the path is
 * currently a real file on disk. `claim` on a zone already claimed by a
 * DIFFERENT owner refuses unless `--force`; `release` prints who it
 * released, or says so plainly when there was nothing to release.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset, yellow } from "../lib/ansi.ts";
import { isSafeMachineKeySegment, machineKey, mattstackHome } from "../lib/rt-paths.ts";
import {
  buildInitPlan,
  chooseMachineProfile,
  InvalidMachineKeyError,
  InvalidProfileKeyError,
  ProfileChoiceRequiredError,
  ProfileNameCollisionError,
  STATE_DIR_NAMES,
  UnknownProfileFlagError,
  type ChooseMachineProfileResult,
  type HomeState,
  type InitPlan,
  type InitStep,
} from "../lib/home/init-plan.ts";
import { createRealExecSeam, executeInitPlan, type ExecSeam } from "../lib/home/init-exec.ts";
import {
  AgeKeyAbsentError,
  createRealAgeKeySeam,
  ensureAgeKey,
  importAgeKey,
  keyExport,
  renderSopsYaml,
  sopsYamlRecipient,
  type AgeKeySeam,
} from "../lib/home/age-key.ts";
import { claimZone, InvalidZoneError, normalizeZone, releaseZone, ZoneOwnedByOthersError, type ZoneKind } from "../lib/home/snapshot-owners.ts";
import { promptSecret, type PromptIO } from "../lib/prompt-secret.ts";
import { daemonQuery, type DaemonResponse } from "../lib/daemon-client.ts";
import type { SnapshotResult, SnapshotStatus } from "../lib/daemon/home-snapshot.ts";
import {
  planMaterialize,
  runMaterialize,
  RT_OWN_STEP_KINDS,
  type MaterializeEnv,
  type MaterializeExecSeam,
  type MaterializeResult,
  type MaterializeStep,
} from "../lib/home/materialize.ts";
import { runCapture } from "../lib/subprocess.ts";
import { loadRepoIndex } from "../lib/daemon/repo-index.ts";
import { loadMachineRepoTracking } from "../lib/repo-tracking.ts";
import { isDaemonInstalled } from "../lib/daemon-config.ts";
import { getSetting } from "../lib/settings/resolve.ts";

export const DEFAULT_USER_REPO_URL = "https://github.com/m4ttheweric/mattstack-home";

export interface HomeProbes {
  isGitRepo(dir: string): boolean;
  exists(path: string): boolean;
  /** The symlink's target, or null when `path` is absent or not a symlink. */
  readSymlinkTarget(path: string): string | null;
  /** True when `path` exists and is a regular file (not a directory, not a symlink-to-dir) — decides whether `rt home claim` writes a file zone or a dir zone. */
  isFile(path: string): boolean;
  /** Directory names directly under `userLocalDir` that carry settings.local.jsonc — the adoptable machine profiles. Empty (not thrown) when the dir doesn't exist yet. */
  listProfiles(userLocalDir: string): string[];
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
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    listProfiles: (userLocalDir) => {
      let entries: string[];
      try {
        entries = readdirSync(userLocalDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
      return entries.filter((name) => existsSync(join(userLocalDir, name, "settings.local.jsonc")));
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

/** Thrown by parseUrlArg for a `--url` with no usable value — never silently absorbed into the default or into the next flag. */
export class InvalidUrlArgError extends Error {}

function parseUrlArg(args: string[]): string {
  const idx = args.indexOf("--url");
  if (idx === -1) return DEFAULT_USER_REPO_URL;

  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InvalidUrlArgError("--url requires a value, e.g. --url https://github.com/org/mattstack-home");
  }
  return value;
}

/** Thrown by parseProfileArg for a `--profile` with no usable value. */
export class InvalidProfileArgError extends Error {}

function parseProfileArg(args: string[]): string | undefined {
  const idx = args.indexOf("--profile");
  if (idx === -1) return undefined;

  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InvalidProfileArgError("--profile requires a value, e.g. --profile mbp-14");
  }
  return value;
}

/** Seam for the interactive machine-profile prompt — real impl below uses the repo's fzf-backed filterableSelect (lib/rt-render.tsx); tests inject a fake so no real fzf/TTY is ever touched. */
export interface MachineProfilePickerSeam {
  /** Returns the chosen key, or null when the user backed out (Esc/Ctrl-C). */
  pick(profiles: string[], hostnameSlug: string): Promise<string | null>;
}

export function createRealMachineProfilePickerSeam(): MachineProfilePickerSeam {
  return {
    async pick(profiles, hostnameSlug) {
      const { filterableSelect } = await import("../lib/rt-render.tsx");
      const options = [
        ...profiles.map((p) => ({ value: p, label: p })),
        { value: hostnameSlug, label: `new profile (${hostnameSlug})` },
      ];
      return filterableSelect({ message: "Pick a machine profile", options });
    },
  };
}

export type EnsureHomeAgeKeyResult = { ok: true } | { ok: false; message: string };

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
 * EXCEPT when this call's key was JUST MINTED (readAgeKey found the
 * keychain provably empty) and an existing `.sops.yaml` already names a
 * DIFFERENT recipient: that recipient is what the just-cloned `user/secrets/*.json`
 * were actually encrypted to, on some other machine. Rewriting here would
 * silently orphan them (undecryptable on this machine) and, once committed,
 * break every other machine still holding the real key — so this refuses
 * instead, leaving the file untouched. A rotation on a machine that ALREADY
 * held the right key (not minted) is unchanged: that's a deliberate rotation,
 * not a fresh machine guessing.
 *
 * Called only after the init plan (which clones user/ when it's missing)
 * has run to completion, so user/ always already exists by the time this
 * writes into it.
 */
async function ensureHomeAgeKey(
  seams: AgeKeySeam,
  sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam(),
): Promise<EnsureHomeAgeKeyResult> {
  const { publicKey, minted } = await ensureAgeKey(seams);

  // Lives under user/ (not the repo root): sops matches path_regex cwd-relative
  // and every sops spawn pins cwd to <mattstackHome>/user (store.ts), so
  // .sops.yaml must sit there too for that discovery to find it.
  const userDir = join(mattstackHome(), "user");
  const sopsYamlPath = join(userDir, ".sops.yaml");
  const existing = sopsYamlSeam.read(sopsYamlPath);
  const existingRecipient = existing === null ? null : sopsYamlRecipient(existing);

  if (minted && existing !== null && existingRecipient !== publicKey) {
    return {
      ok: false,
      message:
        `secrets are encrypted to ${existingRecipient ?? "an unrecognized recipient"}; ` +
        "import the age key from your password manager (`rt home key import`) before initializing.",
    };
  }

  if (existing === null || existingRecipient !== publicKey) {
    sopsYamlSeam.write(sopsYamlPath, renderSopsYaml(publicKey));
    console.log(
      `rt home init: wrote ${sopsYamlPath} (recipient ${publicKey}) — it's tracked, so commit it:\n` +
        `  git -C ${userDir} add .sops.yaml && git -C ${userDir} commit -m "home: sops recipient"`,
    );
  }

  console.log(
    `rt home init: age key ready — recipient ${publicKey}.\n` +
      "  Run `rt home key export` to save the private key to your password manager.",
  );

  return { ok: true };
}

/** buildInitPlan's only checked failure (InvalidMachineKeyError) turned into the CLI's print-and-exit(1) — shared by every one of homeInit's three plan builds so the three don't drift. */
function planOrExit(state: HomeState, config: { url: string; machineKey: string }): InitPlan {
  try {
    return buildInitPlan(state, config);
  } catch (err) {
    if (err instanceof InvalidMachineKeyError) {
      console.error(`rt home init: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function printPlan(home: string, steps: InitStep[]): void {
  console.log(`rt home init plan for ${home}:`);
  steps.forEach((step, i) => console.log(`  ${i + 1}. ${describeStep(step)}`));
}

function printSkillsSymlinkBlocked(home: string): void {
  console.error(
    `\nrt home init: a real file already exists at ${join(home, "skills.jsonc")} — refusing to overwrite it. ` +
      "Move it aside by hand, then rerun.",
  );
}

// ─── materialize (init's last phase) ────────────────────────────────────────

function defaultMaterializeExec(): MaterializeExecSeam {
  return { run: (argv, opts) => runCapture(argv, { ...opts, stderr: "pipe" }) };
}

/**
 * `which deck`, the repo index, `rt.repoTracking`, and the daemon-install
 * marker — all read-only, no seam of their own beyond `exec` (for `which`).
 * Kept as one function (rather than four separate probes on HomeInitSeams)
 * because nothing here needs independent faking in a test that isn't
 * exercising materialize itself: `homeInit`'s tests inject a whole
 * `materializeEnv` instead.
 */
async function defaultMaterializeEnv(exec: MaterializeExecSeam): Promise<MaterializeEnv> {
  const which = await exec.run(["which", "deck"]);
  const deckOnPath = which.exitCode === 0 && which.stdout.trim().length > 0;

  const index = loadRepoIndex();
  const boardRepoPath = index["mr-board"] ?? null;

  const tracking = loadMachineRepoTracking();
  const trackedRepos = Object.keys(tracking)
    .sort()
    .map((name) => {
      const path = index[name] ?? "";
      return { name, path, present: path !== "" && existsSync(path) };
    });

  return { deckOnPath, boardRepoPath, daemonInstalled: isDaemonInstalled(), trackedRepos };
}

function describeMaterializeStep(step: MaterializeStep): string {
  switch (step.kind) {
    case "rtInterceptInstall":
      return "rt intercept install";
    case "rtDaemonInstall":
      return "rt daemon install";
    case "reportMissingRepos":
      return `tracked repos not present locally (not cloned): ${step.names.join(", ")}`;
    case "deckSetup":
      return "deck setup";
    case "boardSetup":
      return `mr-board setup — run manually, it's interactive: cd ${step.repoPath} && bun run scripts/setup.ts`;
  }
}

function printMaterializeResults(results: MaterializeResult[]): void {
  console.log(`\nrt home init: materializing (regenerating everything re-derivable from settings)…`);
  for (const result of results) {
    const mark = result.ok ? `${green}✓${reset}` : `${red}✗${reset}`;
    console.log(`  ${mark} ${describeMaterializeStep(result.step)}`);
    if (!result.ok && result.stderr) console.log(`    ${dim}${result.stderr}${reset}`);
    else if (result.ok && result.step.kind === "boardSetup") console.log(`    ${dim}${result.stderr}${reset}`);
  }
}

/**
 * `claude.marketplaces`/`claude.plugins` replay is the installer's job, not
 * init's (rt orchestrates materialize; the installer owns the plugin/
 * marketplace replay itself) — this only points at it when either resolves
 * to a value, so a machine with nothing configured stays silent. Pure so the
 * decision is unit-testable without writing through the real settings
 * resolver.
 */
export function claudePluginsPointerMessage(marketplaces: unknown, plugins: unknown): string | null {
  if (marketplaces === undefined && plugins === undefined) return null;
  return (
    "claude.marketplaces/claude.plugins are configured — replaying them is the mattstack installer's job, " +
    "not rt home init's; re-run the installer if this machine needs them applied."
  );
}

function printClaudePluginsPointer(): void {
  const message = claudePluginsPointerMessage(
    getSetting<unknown>("claude.marketplaces").value,
    getSetting<unknown>("claude.plugins").value,
  );
  if (message) console.log(`\n  ${dim}${message}${reset}`);
}

export interface HomeInitSeams {
  probes?: HomeProbes;
  exec?: ExecSeam;
  ageKeySeam?: AgeKeySeam;
  sopsYamlSeam?: SopsYamlSeam;
  /**
   * Evaluated at call time, like every other default here — a real fs read
   * (~/.mattstack/machine-key), so tests inject a fixed value instead of
   * depending on the test-runner's actual hostname/override file. When the
   * machine-key file is absent this doubles as the hostname-slug fallback
   * the profile chooser below offers ("new profile (<this>)").
   */
  key?: string;
  pickerSeam?: MachineProfilePickerSeam;
  isInteractive?: () => boolean;
  /** Gathers the materialize phase's inputs (which deck, repo index, rt.repoTracking, daemon-install marker). Defaults to real reads; tests inject a fixed env instead of faking each underlying probe. */
  materializeEnv?: () => Promise<MaterializeEnv>;
  /** Runs each materialize step's subprocess. Defaults to a real `runCapture` wrap; tests inject a fake that never touches a real binary. */
  materializeExec?: MaterializeExecSeam;
}

export async function homeInit(args: string[], _ctx: CommandContext = {}, seams: HomeInitSeams = {}): Promise<void> {
  const probes = seams.probes ?? defaultProbes();
  const exec = seams.exec ?? createRealExecSeam(mattstackHome());
  const ageKeySeam = seams.ageKeySeam ?? createRealAgeKeySeam();
  const sopsYamlSeam = seams.sopsYamlSeam ?? defaultSopsYamlSeam();
  const key = seams.key ?? machineKey();
  const pickerSeam = seams.pickerSeam ?? createRealMachineProfilePickerSeam();
  const isInteractive = seams.isInteractive ?? (() => Boolean(process.stdin.isTTY));
  const materializeExec = seams.materializeExec ?? defaultMaterializeExec();
  const materializeEnv = seams.materializeEnv ?? (() => defaultMaterializeEnv(materializeExec));

  const dryRun = args.includes("--dry-run");
  const noMaterialize = args.includes("--no-materialize");
  const home = mattstackHome();

  let url: string;
  let profileFlag: string | undefined;
  try {
    url = parseUrlArg(args);
    profileFlag = parseProfileArg(args);
  } catch (err) {
    if (err instanceof InvalidUrlArgError || err instanceof InvalidProfileArgError) {
      console.error(`rt home init: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const newProfileFlag = args.includes("--new-profile");

  let state = gatherHomeState(home, probes, key);
  let chosenKey = key;

  // The profile list under user/local/ only exists once user/ is cloned, but
  // this machine's key (and thus which profile it should adopt) can only be
  // decided from that list — so a machine-key-less machine picks its key
  // AFTER the clone lands, never before. A machine that already has
  // machine-key written is already provisioned; the picker never runs for it.
  if (!state.machineKeyFilePresent) {
    if (!state.userRepoPresent) {
      if (dryRun) {
        const previewPlan = planOrExit(state, { url, machineKey: key });
        printPlan(home, previewPlan.steps);
        if (previewPlan.blocked === "skills-symlink-real-file") printSkillsSymlinkBlocked(home);
        console.log(
          `\n  rt home init: this machine has no machine-key file yet — existing profiles under user/local/ ` +
            `aren't knowable until the repo above is actually cloned, so the key shown here ("${key}") is only ` +
            "the no-profiles-yet fallback. Pass --profile <key> or --new-profile to pin the real choice ahead of time.",
        );
        return;
      }

      // Phase 1: clone only. writeMachineKey/ensureProfileDir/writeSkillsSymlink
      // all wait for phase 2 (below) — the first two because the key isn't
      // chosen yet, the symlink just to keep this phase minimal and focused.
      const cloneOnlyState: HomeState = {
        ...state,
        machineKeyFilePresent: true,
        profileDirPresent: true,
        skillsSymlinkPresent: true,
        skillsSymlinkBlocked: false,
      };
      const clonePlan = planOrExit(cloneOnlyState, { url, machineKey: key });
      printPlan(home, clonePlan.steps);

      const cloneResult = await executeInitPlan(clonePlan.steps, exec, (message) => console.log(`  ${message}`));
      if (!cloneResult.ok) {
        console.error(`\nrt home init: failed at step "${cloneResult.failedStep}":\n${cloneResult.stderr}`);
        process.exit(1);
      }

      // Known true from the steps that just succeeded, not re-probed: fake
      // probes in tests are static and wouldn't reflect the clone anyway,
      // and in production a fresh fs read here would just re-derive the
      // same facts the exec seam already confirmed.
      state = { ...state, userRepoPresent: true, stateDirsMissing: [] };
    }

    const userLocalDir = join(home, "user", "local");
    const profiles = probes.listProfiles(userLocalDir);

    let choice: ChooseMachineProfileResult;
    try {
      choice = chooseMachineProfile({
        profiles,
        hostnameSlug: key,
        flags: { profile: profileFlag, newProfile: newProfileFlag },
        interactive: isInteractive(),
      });
    } catch (err) {
      if (
        err instanceof UnknownProfileFlagError ||
        err instanceof ProfileChoiceRequiredError ||
        err instanceof ProfileNameCollisionError ||
        err instanceof InvalidProfileKeyError
      ) {
        console.error(`rt home init: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    if (choice.source === "prompt-needed") {
      if (dryRun) {
        console.log(
          `rt home init: ${home} needs a machine profile — existing: ${profiles.join(", ")}, or start a new one ` +
            `("${key}"). A prompt would run here interactively; pass --profile <key> or --new-profile to skip it.`,
        );
        return;
      }
      const picked = await pickerSeam.pick(profiles, key);
      if (picked === null || !isSafeMachineKeySegment(picked)) {
        console.error(
          "rt home init: no machine profile selected — aborting. Pass --profile <key> or --new-profile to skip the prompt.",
        );
        process.exit(1);
      }
      chosenKey = picked;
    } else {
      chosenKey = choice.key;
    }

    state = { ...state, profileDirPresent: profiles.includes(chosenKey) };
  } else if (profileFlag !== undefined || newProfileFlag) {
    // --profile/--new-profile only make sense while this machine is still
    // choosing its FIRST profile. Once machine-key is pinned, silently
    // ignoring them would look like the flag worked (see: "fully
    // provisioned" printing on an already-keyed machine passed --profile
    // other-box) when nothing happened at all.
    console.error(
      `rt home init: this machine's machine-key file already pins "${key}" — --profile/--new-profile only apply ` +
        `while choosing a machine's first profile. Edit or remove ~/.mattstack/machine-key and re-run to change it.`,
    );
    process.exit(1);
  }

  const plan = planOrExit(state, { url, machineKey: chosenKey });

  if (plan.steps.length > 0) {
    printPlan(home, plan.steps);
  } else if (!plan.blocked) {
    console.log(`rt home init: ${home} is already fully provisioned — nothing to do.`);
  }

  if (plan.blocked === "skills-symlink-real-file") printSkillsSymlinkBlocked(home);

  if (dryRun) return;

  const result = await executeInitPlan(plan.steps, exec, (message) => console.log(`  ${message}`));

  if (!result.ok) {
    console.error(`\nrt home init: failed at step "${result.failedStep}":\n${result.stderr}`);
    process.exit(1);
  }

  // Mint (or backfill) BEFORE the success line: printing success ahead of a
  // failed mint would tell the operator init worked while `rt secrets set`
  // still has no key or creation rule to encrypt against.
  const ageKeyResult = await ensureHomeAgeKey(ageKeySeam, sopsYamlSeam);
  if (!ageKeyResult.ok) {
    console.error(`\nrt home init: ${ageKeyResult.message}`);
    process.exit(1);
  }

  if (plan.blocked === "skills-symlink-real-file") {
    console.error(`\nrt home init: provisioning finished, but the skills.jsonc symlink is still blocked — see above.`);
    process.exit(1);
  }

  // Materialize is init's LAST phase, run on every non-dry-run invocation —
  // including an already-fully-provisioned machine — so re-derivable state
  // (PATH shims, daemon registration, each installed tool's own setup)
  // stays current without a separate command to remember to run.
  let materializeFailed = false;
  if (noMaterialize) {
    console.log(`\n  ${dim}materialize skipped (--no-materialize)${reset}`);
  } else {
    const env = await materializeEnv();
    const steps = planMaterialize(env);
    const results = await runMaterialize(steps, materializeExec);
    printMaterializeResults(results);
    materializeFailed = results.some((r) => !r.ok && RT_OWN_STEP_KINDS.has(r.step.kind));
  }

  printClaudePluginsPointer();

  console.log(`\nrt home init: ${home} is provisioned.`);

  if (materializeFailed) {
    console.error(`\nrt home init: materialize failed on an rt-owned step — see above.`);
    process.exit(1);
  }
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

export interface AgeKeyInputSeam {
  fromStdin(): Promise<string>;
  fromPrompt(): Promise<string>;
}

/** `stream` is injectable so tests exercise the trimming behavior without touching the real process.stdin. */
export async function readStdinTrimmed(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Both input paths must yield the same shape of value — a `--stdin` paste
 * and a typed-then-Enter prompt answer are otherwise indistinguishable to
 * `importAgeKey`, so both are trimmed here rather than one trimmed
 * (readStdinTrimmed) and the other not. `promptIO`, when passed, is forwarded
 * to `promptSecret` so tests can drive the prompt path without a real TTY.
 */
export function defaultAgeKeyInputSeam(promptIO?: PromptIO): AgeKeyInputSeam {
  return {
    fromStdin: () => readStdinTrimmed(),
    fromPrompt: () => promptSecret("Paste the age private key", promptIO).then((value) => value.trim()),
  };
}

/** First 12 chars + an ellipsis — enough to eyeball-match two recipients in a warning without printing the full key. */
function truncateKey(key: string): string {
  return `${key.slice(0, 12)}…`;
}

/**
 * The counterpart to `rt home init`'s mint-refusal: when a cloned repo's
 * secrets are encrypted to a key this machine doesn't hold, this is what
 * gets it in. Only THIS command's success writes the keychain item from
 * outside key material — `ensureAgeKey` mints, this imports; the two never
 * run against the same "no key yet" state for different reasons.
 *
 * The recipient check runs AFTER a successful import (not before) so the
 * refusal message can name the ACTUAL derived recipient of what was just
 * pasted, not a guess — a wrong paste that happens to parse still gets
 * caught here before the operator believes their secrets are decryptable.
 */
export async function homeKeyImport(
  args: string[],
  _ctx: CommandContext = {},
  seams: AgeKeySeam = createRealAgeKeySeam(),
  sopsYamlSeam: SopsYamlSeam = defaultSopsYamlSeam(),
  input: AgeKeyInputSeam = defaultAgeKeyInputSeam(),
): Promise<void> {
  const force = args.includes("--force");

  let privateKey: string;
  try {
    privateKey = args.includes("--stdin") ? await input.fromStdin() : await input.fromPrompt();
  } catch (err) {
    console.error(`rt home key import: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = await importAgeKey(seams, privateKey, { force });

  if (!result.ok) {
    if (result.reason === "malformed") {
      console.error("rt home key import: not a valid age private key (expected an AGE-SECRET-KEY-1… value)");
    } else {
      console.error(
        `rt home key import: a key already exists in the keychain (recipient ${truncateKey(result.existingPublicKey)}) — ` +
          "pass --force to overwrite it.",
      );
    }
    process.exit(1);
  }

  const { publicKey } = result;

  const userDir = join(mattstackHome(), "user");
  const sopsYamlPath = join(userDir, ".sops.yaml");
  const existing = sopsYamlSeam.read(sopsYamlPath);
  const existingRecipient = existing === null ? null : sopsYamlRecipient(existing);

  if (existingRecipient !== null && existingRecipient !== publicKey) {
    console.error(
      `rt home key import: imported key's recipient (${truncateKey(publicKey)}) does not match this repo's ` +
        `.sops.yaml recipient (${truncateKey(existingRecipient)}) — this key can't decrypt the secrets already here. ` +
        "The wrong key is already stored, so a plain retry will hit the exists-refusal — " +
        "re-run `rt home key import --force` once you have the right key.",
    );
    process.exit(2);
  }

  console.log(`  ${green}✓${reset} imported — recipient ${bold}${truncateKey(publicKey)}${reset}`);
  console.log(`    ${dim}secrets encrypted to this recipient are now decryptable on this machine${reset}`);
}

// ─── snapshot / claim / release ─────────────────────────────────────────────

/** Reaches the daemon's `home:snapshot`/`home:snapshot-status` handlers — daemon-internal, no typed rt-client wrapper, same posture as settings.ts. */
export interface HomeDaemonSeam {
  query(cmd: string, payload?: Record<string, any>): Promise<DaemonResponse | null>;
}

function defaultHomeDaemonSeam(): HomeDaemonSeam {
  return { query: daemonQuery };
}

function daemonDownAndExit(command: string): never {
  console.error(`\n  ${yellow}rt daemon is not running${reset} — start it: ${bold}rt daemon start${reset}\n`);
  process.exit(1);
  throw new Error(`unreachable: process.exit did not stop ${command}`);
}

function formatTimestamp(ms: number): string {
  return ms === 0 ? "never" : new Date(ms).toLocaleString();
}

function printSnapshotResult(result: SnapshotResult): void {
  if (result.skipped) {
    console.log(`  ${dim}snapshot skipped: ${result.skipped}${reset}`);
    return;
  }
  if (!result.committed) {
    console.log(`  ${dim}snapshot: no changes${reset}`);
    return;
  }
  console.log(`  ${green}✓${reset} snapshot committed ${dim}${result.sha ? result.sha.slice(0, 8) : "(no sha)"}${reset}`);
  console.log(`    ${dim}paths: ${result.paths.length > 0 ? result.paths.join(", ") : "(none)"}${reset}`);
}

function printSnapshotStatus(status: SnapshotStatus): void {
  const stateIcon = status.enabled ? `${green}●${reset}` : `${dim}○${reset}`;
  console.log(`  ${stateIcon} home snapshot ${status.enabled ? "enabled" : "disabled"} ${dim}(${status.repoDir})${reset}`);
  console.log(`    ${dim}watching: ${status.watching ? "yes" : "no"}${reset}`);
  console.log(`    ${dim}last run: ${formatTimestamp(status.lastRunAt)}${reset}`);
  console.log(
    `    ${dim}last commit: ${status.lastCommit ? `${status.lastCommit.sha.slice(0, 8)} ${status.lastCommit.message}` : "none"}${reset}`,
  );
  if (status.lastCommitError) {
    console.log(`    ${yellow}commit error: ${status.lastCommitError}${reset}`);
  }
  const pushLine = status.pushPending
    ? "pending"
    : status.lastPushAt !== 0
      ? `last pushed ${formatTimestamp(status.lastPushAt)}`
      : "never pushed";
  console.log(`    ${dim}push: ${pushLine}${reset}`);
  if (status.lastPushError) {
    console.log(`    ${yellow}push error: ${status.lastPushError}${reset}`);
  }
  console.log(
    `    ${dim}claimed zones: ${status.claimedZones.length > 0 ? status.claimedZones.join(", ") : "(none)"}${reset}`,
  );
  if (status.ownersError) {
    console.log(`    ${red}owners file unreadable: ${status.ownersError}${reset}`);
  }
}

export async function homeSnapshot(
  args: string[],
  _ctx: CommandContext = {},
  daemon: HomeDaemonSeam = defaultHomeDaemonSeam(),
): Promise<void> {
  if (args.includes("--status")) {
    const res = await daemon.query("home:snapshot-status");
    if (!res) daemonDownAndExit("rt home snapshot --status");
    if (!res.ok) {
      console.error(`rt home snapshot --status: ${res.error ?? "unknown daemon error"}`);
      process.exit(1);
    }
    printSnapshotStatus(res.data as SnapshotStatus);
    return;
  }

  const res = await daemon.query("home:snapshot", { reason: "manual" });
  if (!res) daemonDownAndExit("rt home snapshot");
  if (!res.ok) {
    console.error(`rt home snapshot: ${res.error ?? "unknown daemon error"}`);
    process.exit(1);
  }
  printSnapshotResult(res.data as SnapshotResult);
}

function defaultOwnersPath(): string {
  return join(mattstackHome(), "user", "snapshot-owners.jsonc");
}

function defaultOwner(): string {
  return `${process.env.USER ?? "unknown"}@${machineKey()}`;
}

/** Splits `args` into `{ zone, owner?, note?, force }`, tolerating `--flag value` and `--flag=value`. */
function parseClaimArgs(args: string[]): { zone: string | undefined; owner: string | undefined; note: string | undefined; force: boolean } {
  let owner: string | undefined;
  let note: string | undefined;
  let force = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--owner") owner = args[++i];
    else if (arg.startsWith("--owner=")) owner = arg.slice("--owner=".length);
    else if (arg === "--note") note = args[++i];
    else if (arg.startsWith("--note=")) note = arg.slice("--note=".length);
    else if (arg === "--force") force = true;
    else positional.push(arg);
  }
  return { zone: positional[0], owner, note, force };
}

function homeRepoRoot(): string {
  return join(mattstackHome(), "user");
}

/** Shared by claim/release: writing (or even mkdir-ing the dir for) snapshot-owners.jsonc into a tree `rt home init` never provisioned would create a bare, non-git ~/.mattstack/user — refuse instead. */
function refuseUnlessProvisioned(command: string, probes: HomeProbes): void {
  const repoRoot = homeRepoRoot();
  if (!probes.isGitRepo(repoRoot)) {
    console.error(`rt home ${command}: ${repoRoot} isn't provisioned yet — run \`rt home init\` first.`);
    process.exit(1);
  }
}

export async function homeClaim(
  args: string[],
  _ctx: CommandContext = {},
  ownersPath: string = defaultOwnersPath(),
  probes: HomeProbes = defaultProbes(),
): Promise<void> {
  const { zone, owner: ownerArg, note, force } = parseClaimArgs(args);
  if (!zone) {
    console.error("rt home claim: a zone is required, e.g. `rt home claim prefs/` or `rt home claim scripts/deploy.sh`");
    process.exit(1);
  }

  refuseUnlessProvisioned("claim", probes);

  const owner = ownerArg ?? defaultOwner();

  let kind: ZoneKind;
  try {
    // Stat the NORMALIZED bare path (kind:"file" never carries a trailing
    // slash), not the raw user string — `rt home claim scripts/deploy.sh/`
    // (a trailing slash on a real file) would otherwise make statSync see
    // ENOTDIR and default to "dir", storing an exclude pathspec that
    // (verified against real git) matches nothing. A REGULAR FILE claims
    // exactly that path; anything else (a directory, or a path that
    // doesn't exist yet — the common case for "claim this directory before
    // I create anything in it") claims the whole subtree.
    kind = probes.isFile(join(homeRepoRoot(), normalizeZone(zone, "file"))) ? "file" : "dir";
    claimZone(ownersPath, zone, owner, { note, kind, force });
  } catch (err) {
    if (err instanceof InvalidZoneError) {
      console.error(`rt home claim: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof ZoneOwnedByOthersError) {
      console.error(`rt home claim: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`  ${green}✓${reset} claimed ${bold}${normalizeZone(zone, kind)}${reset} for ${owner}`);
  console.log(`    ${dim}the daemon snapshots ${ownersPath} like any other path — it'll pick this up on its next cycle${reset}`);
}

export async function homeRelease(
  args: string[],
  _ctx: CommandContext = {},
  ownersPath: string = defaultOwnersPath(),
  probes: HomeProbes = defaultProbes(),
): Promise<void> {
  const zone = args.find((arg) => !arg.startsWith("--"));
  if (!zone) {
    console.error("rt home release: a zone is required, e.g. `rt home release prefs/`");
    process.exit(1);
  }

  refuseUnlessProvisioned("release", probes);

  let result: ReturnType<typeof releaseZone>;
  try {
    result = releaseZone(ownersPath, zone);
  } catch (err) {
    if (err instanceof InvalidZoneError) {
      console.error(`rt home release: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (!result.released) {
    console.log(`  ${dim}nothing to release — "${zone}" isn't claimed${reset}`);
    return;
  }

  console.log(`  ${green}✓${reset} released ${bold}${result.zone}${reset} ${dim}(was claimed by ${result.owner})${reset}`);
  console.log(`    ${dim}the daemon snapshots ${ownersPath} like any other path — it'll pick this up on its next cycle${reset}`);
}
