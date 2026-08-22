/**
 * rt home — the git-backed ~/.mattstack/user personal repo, plus per-machine
 * provisioning of the ~/.mattstack tree around it.
 *
 *   rt home init [--dry-run] [--url <remote>]   print, then run, the provisioning plan
 *   rt home key export                          print the age private key once, for a password manager
 *   rt home snapshot [--status]                       run (or report on) the auto-commit daemon
 *   rt home claim <zone> [--owner] [--note] [--force]  tell the daemon to leave a path alone
 *   rt home release <zone>                             let the daemon resume auto-committing a path
 *
 * `init` gathers state, prints the plan from lib/home/init-plan.ts, and
 * (unless --dry-run) runs it through lib/home/init-exec.ts's injected seam.
 * `key export` delegates entirely to lib/home/age-key.ts.
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

import { existsSync, readFileSync, readlinkSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset, yellow } from "../lib/ansi.ts";
import { machineKey, mattstackHome } from "../lib/rt-paths.ts";
import { buildInitPlan, InvalidMachineKeyError, STATE_DIR_NAMES, type HomeState, type InitStep } from "../lib/home/init-plan.ts";
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

export const DEFAULT_USER_REPO_URL = "https://github.com/m4ttheweric/mattstack-home";

export interface HomeProbes {
  isGitRepo(dir: string): boolean;
  exists(path: string): boolean;
  /** The symlink's target, or null when `path` is absent or not a symlink. */
  readSymlinkTarget(path: string): string | null;
  /** True when `path` exists and is a regular file (not a directory, not a symlink-to-dir) — decides whether `rt home claim` writes a file zone or a dir zone. */
  isFile(path: string): boolean;
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

  let url: string;
  try {
    url = parseUrlArg(args);
  } catch (err) {
    if (err instanceof InvalidUrlArgError) {
      console.error(`rt home init: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const state = gatherHomeState(home, probes, key);

  let plan: ReturnType<typeof buildInitPlan>;
  try {
    plan = buildInitPlan(state, { url, machineKey: key });
  } catch (err) {
    if (err instanceof InvalidMachineKeyError) {
      console.error(`rt home init: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (plan.steps.length > 0) {
    console.log(`rt home init plan for ${home}:`);
    plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${describeStep(step)}`));
  } else if (!plan.blocked) {
    console.log(`rt home init: ${home} is already fully provisioned — nothing to do.`);
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
  const ageKeyResult = await ensureHomeAgeKey(ageKeySeam, sopsYamlSeam);
  if (!ageKeyResult.ok) {
    console.error(`\nrt home init: ${ageKeyResult.message}`);
    process.exit(1);
  }

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
