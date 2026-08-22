/**
 * `rt team create` — scaffolds the local team zone (~/.mattstack/teams/<slug>)
 * as a fresh git repo with its starter settings, but never pushes: Install's
 * `team.create` step owns the push, via `publishTeam`.
 */

import { dirname, join } from "path";
import { parseRemoteUrl } from "../enrich.ts";
import { type AgeKeySeam, createRealAgeKeySeam, ensureAgeKey, renderSopsYamlFor } from "../home/age-key.ts";
import { UserActionableError } from "../setup/errors.ts";
import { writeIntent } from "../setup/intent.ts";
import type { Probes } from "../setup/probes.ts";
import { forgeFromRemote, parseOriginUrl } from "../setup/team-settings.ts";
import { slugify } from "./slug.ts";

export interface CreateTeamOpts {
  name: string;
  remote: string | null;
  createRepoOwner?: string;
  others: boolean;
}

export interface CreateTeamResult {
  slug: string;
  name: string;
  remote: string;
  dir: string;
  /** false when the dir already existed — nothing was written or committed. */
  created: boolean;
}

const TEAM_SOPS_PATH_REGEX = "mattstack/secrets/.*";
const SETTINGS_HEADER = "// mattstack team settings — created by `rt team create`. JSONC: comments and trailing commas are fine.\n";

/** The remote's path prefix (`owner/repo`, `group/subgroup/repo`) — its first segment is the repo's owner/namespace. Null on an unparseable remote. */
function ownerFromRemote(remote: string): string | null {
  const parsed = parseRemoteUrl(remote);
  const owner = parsed?.projectPath.split("/")[0];
  return owner && owner.length > 0 ? owner : null;
}

/**
 * The scaffold's five tracked files, keyed by path relative to the team zone
 * root. `recipients` seeds `.sops.yaml` at creation so a fresh team never
 * passes through a zero-recipient state — see `createTeam`, which always
 * supplies the creator's own age key here.
 */
export function scaffoldFiles(slug: string, name: string, remote: string, recipients: string[] = []): Record<string, string> {
  const forge = forgeFromRemote(remote);
  const owner = ownerFromRemote(remote) ?? slug;

  const mattstackJsonc = { role: "team", namespace: slug, org: owner };

  const settings: Record<string, unknown> = { "mattstack.integrations": { forge } };
  if (forge?.provider === "gitlab") settings["board.gitlabHost"] = forge.host;
  settings["board.projects"] = [];
  settings["board.members"] = [];
  settings["board.title"] = name;

  const marketplace = { name: slug, owner: { name }, plugins: [] };

  return {
    "mattstack/mattstack.jsonc": `${JSON.stringify(mattstackJsonc, null, 2)}\n`,
    "mattstack/settings.team.jsonc": `${SETTINGS_HEADER}${JSON.stringify(settings, null, 2)}\n`,
    ".claude-plugin/marketplace.json": `${JSON.stringify(marketplace, null, 2)}\n`,
    ".sops.yaml": renderSopsYamlFor(TEAM_SOPS_PATH_REGEX, recipients),
    ".gitignore": "mattstack/secrets/*.tmp\n.DS_Store\n",
  };
}

function readExistingOrigin(p: Probes, dir: string): string | null {
  const raw = p.readFile(join(dir, ".git", "config"));
  return raw !== null ? parseOriginUrl(raw) : null;
}

async function resolveRemote(p: Probes, slug: string, opts: CreateTeamOpts): Promise<string> {
  if (opts.remote) return opts.remote;

  if (!opts.createRepoOwner) {
    throw new UserActionableError("remote-required", "a git remote is required (gh-created or pasted)");
  }

  const repoPath = `${opts.createRepoOwner}/mattstack-team-${slug}`;
  const result = await p.exec(["gh", "repo", "create", repoPath, "--private"]);
  if (result.code !== 0) {
    throw new UserActionableError("create-repo-failed", `gh repo create ${repoPath} failed: ${result.stderr.trim()}`);
  }
  const url = result.stdout.split("\n")[0]?.trim();
  if (!url) {
    throw new UserActionableError("create-repo-failed", `gh repo create ${repoPath} printed no URL to use as the remote`);
  }
  return url;
}

export async function createTeam(p: Probes, opts: CreateTeamOpts, ageKeySeam: AgeKeySeam = createRealAgeKeySeam()): Promise<CreateTeamResult> {
  const slug = slugify(opts.name);
  const dir = join(p.home, ".mattstack", "teams", slug);

  if (p.exists(dir)) {
    const existingRemote = readExistingOrigin(p, dir);
    if (opts.remote !== null) {
      if (existingRemote === opts.remote) {
        return { slug, name: opts.name, remote: opts.remote, dir, created: false };
      }
      throw new UserActionableError(
        "team-exists",
        `team "${slug}" already exists at ${dir} with a different remote (${existingRemote ?? "none recorded"})`,
      );
    }
    // No remote was given to compare against (--create-repo or neither) — the
    // zone on disk is authoritative rather than risking a duplicate `gh repo
    // create` for a team that's already scaffolded.
    return { slug, name: opts.name, remote: existingRemote ?? "", dir, created: false };
  }

  const remote = await resolveRemote(p, slug, opts);
  const { publicKey } = await ensureAgeKey(ageKeySeam);

  p.mkdirp(dir);
  const initResult = await p.exec(["git", "init", "-b", "main"], { cwd: dir });
  if (initResult.code !== 0) {
    throw new Error(`git init -b main failed at ${dir}: ${initResult.stderr}`);
  }

  for (const [relPath, content] of Object.entries(scaffoldFiles(slug, opts.name, remote, [publicKey]))) {
    const fullPath = join(dir, relPath);
    p.mkdirp(dirname(fullPath));
    p.writeFile(fullPath, content);
  }

  const addResult = await p.exec(["git", "add", "-A"], { cwd: dir });
  if (addResult.code !== 0) {
    throw new Error(`git add -A failed at ${dir}: ${addResult.stderr}`);
  }
  const commitResult = await p.exec(["git", "commit", "-m", `team: scaffold ${slug}`], { cwd: dir });
  if (commitResult.code !== 0) {
    throw new Error(`git commit failed at ${dir}: ${commitResult.stderr}`);
  }
  const remoteAddResult = await p.exec(["git", "remote", "add", "origin", remote], { cwd: dir });
  if (remoteAddResult.code !== 0) {
    throw new Error(`git remote add origin failed at ${dir}: ${remoteAddResult.stderr}`);
  }

  writeIntent(p, {
    v: 1,
    at: p.now().toISOString(),
    mode: "create",
    team: { slug, name: opts.name, remote, others: opts.others },
  });

  return { slug, name: opts.name, remote, dir, created: true };
}
