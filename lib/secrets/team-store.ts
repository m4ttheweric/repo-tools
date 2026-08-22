/**
 * The team-scope sops secrets store: `~/.mattstack/teams/<slug>/mattstack/secrets/<domain>.json`,
 * encrypted to every team member's age public key via
 * `~/.mattstack/teams/<slug>/.sops.yaml` (path_regex `mattstack/secrets/.*`).
 * This is the N-recipient counterpart to `store.ts`'s single-recipient
 * personal store — every encrypt/decrypt still routes through that module's
 * `SecretsLocation` machinery (`decryptAtLocation`/`writeAtLocation`), just
 * pointed at the team clone's own file and cwd instead of `user/`.
 *
 * A team WRITE still needs THIS machine's own age private key: sops
 * decrypts an existing multi-recipient file with whichever recipient's
 * private key it's handed, and this codebase only ever hands it the one
 * personal identity from `lib/home/age-key.ts` — so writing a team secret
 * for the first time requires that identity to already be one of the
 * `.sops.yaml` recipients (added via `addTeamRecipient`). No age key on this
 * machine yet throws the same `NoAgeKeyError` a personal write would
 * (`sopsAgeKeyEnv`, inside `writeAtLocation`) — callers (commands/setup.ts's
 * `realTeamSecrets`) already know to catch that and fall back to staging.
 *
 * No per-process memo here (unlike the personal store's `domainMemo`): team
 * membership changes underfoot more than a single personal domain does (a
 * `rt team members sync` re-encrypting every file), and this store is read
 * far less often than it's written, so the simpler always-fresh read isn't
 * worth the staleness-tracking complexity.
 */

import { join } from "path";
import { createRealAgeKeySeam, renderSopsYamlFor } from "../home/age-key.ts";
import { teamsDir } from "../rt-paths.ts";
import {
  createRealSecretsExecSeam,
  decryptAtLocation,
  validateDomain,
  validateKey,
  validateSlug,
  writeAtLocation,
  type SecretsExecSeam,
  type SecretsLocation,
  type SecretsSeams,
} from "./store.ts";

/** Thrown by `writeTeamSecret` when the team's `.sops.yaml` names no recipients yet — nothing can be encrypted to nobody. */
export class NoTeamRecipientsError extends Error {
  constructor(slug: string) {
    super(`team "${slug}" has no recipients yet — run \`rt team members sync\``);
  }
}

const TEAM_PATH_REGEX = "mattstack/secrets/.*";

function teamCloneRoot(slug: string): string {
  validateSlug(slug);
  return join(teamsDir(), slug);
}

/** `~/.mattstack/teams/<slug>/mattstack/secrets/<domain>.json` */
export function teamSecretsFile(slug: string, domain: string): string {
  validateDomain(domain);
  return join(teamCloneRoot(slug), "mattstack", "secrets", `${domain}.json`);
}

/** `~/.mattstack/teams/<slug>/.sops.yaml` — recipients for every `mattstack/secrets/*.json` file in this clone. */
export function teamSopsYamlPath(slug: string): string {
  return join(teamCloneRoot(slug), ".sops.yaml");
}

function teamSecretsDir(slug: string): string {
  return join(teamCloneRoot(slug), "mattstack", "secrets");
}

function teamLocation(slug: string, domain: string): SecretsLocation {
  return {
    filePath: teamSecretsFile(slug, domain),
    filenameOverride: join("mattstack", "secrets", `${domain}.json`),
    cwd: teamCloneRoot(slug),
  };
}

/**
 * Pure builder for the team seam's Bun.spawn opts — the `buildSecretsSpawnOptions`-style
 * unit-testable pin, mirroring `store.ts`'s own (personal-store) builder but
 * fixed to this team's clone root instead of `<mattstackHome>/user`.
 */
export function buildTeamSpawnOptions(
  slug: string,
  opts?: { env?: Record<string, string> },
): { cwd: string; env: Record<string, string | undefined>; stdout: "pipe"; stderr: "pipe" } {
  return { cwd: teamCloneRoot(slug), env: { ...process.env, ...opts?.env }, stdout: "pipe", stderr: "pipe" };
}

/** Real seams for one team: the same personal age identity, a `SecretsExecSeam` whose sops spawns are pinned to this team's clone root. */
export function createRealTeamSecretsSeams(slug: string): SecretsSeams {
  const execSeam: SecretsExecSeam = createRealSecretsExecSeam(teamCloneRoot(slug));
  return { ageKeySeam: createRealAgeKeySeam(), execSeam };
}

/**
 * Parses a `.sops.yaml`'s `age:` recipient value — a single line
 * (`age: key1,key2`, what `writeTeamRecipients` always renders) or a
 * wrapped/indented block (a hand-edited file) — up to the next top-level
 * `- ` rule or end of file. Comma- and newline-separated entries both split
 * out; blank entries (a trailing comma, a blank line) are dropped.
 */
function parseAgeRecipients(content: string): string[] {
  const match = content.match(/age:\s*([\s\S]*?)(?=\n\s*-\s|\n*$)/);
  if (!match) return [];
  return match[1]!
    .replace(/>-/, "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The team's current `age:` recipients — [] when `.sops.yaml` doesn't exist yet (no team members synced). */
export function readTeamRecipients(slug: string, seams: SecretsSeams): string[] {
  const path = teamSopsYamlPath(slug);
  if (!seams.execSeam.fileExists(path)) return [];
  return parseAgeRecipients(seams.execSeam.readFile(path));
}

/** Renders and writes `.sops.yaml` with exactly `recipients` (sorted, deduped) as the `mattstack/secrets/.*` rule's recipients. */
export function writeTeamRecipients(slug: string, recipients: string[], seams: SecretsSeams): void {
  const unique = [...new Set(recipients)].sort();
  seams.execSeam.writeFile(teamSopsYamlPath(slug), renderSopsYamlFor(TEAM_PATH_REGEX, unique));
}

export async function readTeamSecret(slug: string, domain: string, key: string, seams: SecretsSeams): Promise<string | null> {
  validateKey(key);
  const payload = await decryptAtLocation(teamLocation(slug, domain), seams);
  return payload === null ? null : payload[key] ?? null;
}

/** Names only for one team domain — mirrors `store.ts`'s `listSecretNames`, never call this to expose values. */
export async function listTeamSecretNames(slug: string, domain: string, seams: SecretsSeams): Promise<string[]> {
  const payload = await decryptAtLocation(teamLocation(slug, domain), seams);
  return payload === null ? [] : Object.keys(payload);
}

export async function writeTeamSecret(slug: string, domain: string, key: string, value: string, seams: SecretsSeams): Promise<void> {
  validateKey(key);
  const recipients = readTeamRecipients(slug, seams);
  if (recipients.length === 0) throw new NoTeamRecipientsError(slug);

  const location = teamLocation(slug, domain); // also validates domain
  await writeAtLocation(location, `team-${slug}-${domain}`, key, value, seams);
}

function listTeamDomainFiles(slug: string, seams: SecretsSeams): string[] {
  const dir = teamSecretsDir(slug);
  const names = seams.execSeam.listDir ? seams.execSeam.listDir(dir) : [];
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort();
}

/**
 * `sops updatekeys -y` per existing domain file — the mechanic behind both
 * member add/remove (called after `writeTeamRecipients`) and `rt secrets
 * rotate --team <slug>` with no domain/key (re-encrypt everything to the
 * current recipient set). A member REMOVED from `.sops.yaml` keeps whatever
 * plaintext they already decrypted before removal — this only stops them
 * from decrypting the file going forward, it can't retroactively revoke
 * what they already read. Callers should say so in their own output.
 */
export async function reencryptTeamSecrets(slug: string, seams: SecretsSeams): Promise<string[]> {
  const files = listTeamDomainFiles(slug, seams);
  const reencrypted: string[] = [];
  for (const file of files) {
    const result = await seams.execSeam.run(["sops", "updatekeys", "-y", file], { sensitive: true });
    if (result.code !== 0) {
      throw new Error(`sops updatekeys -y ${file}: ${result.stderr}`);
    }
    reencrypted.push(file);
  }
  return reencrypted;
}

export async function addTeamRecipient(slug: string, publicKey: string, seams: SecretsSeams): Promise<{ added: boolean; reencrypted: string[] }> {
  const current = readTeamRecipients(slug, seams);
  if (current.includes(publicKey)) return { added: false, reencrypted: [] };

  writeTeamRecipients(slug, [...current, publicKey], seams);
  const reencrypted = await reencryptTeamSecrets(slug, seams);
  return { added: true, reencrypted };
}

export async function removeTeamRecipient(slug: string, publicKey: string, seams: SecretsSeams): Promise<{ removed: boolean; reencrypted: string[] }> {
  const current = readTeamRecipients(slug, seams);
  if (!current.includes(publicKey)) return { removed: false, reencrypted: [] };

  writeTeamRecipients(slug, current.filter((k) => k !== publicKey), seams);
  const reencrypted = await reencryptTeamSecrets(slug, seams);
  return { removed: true, reencrypted };
}
