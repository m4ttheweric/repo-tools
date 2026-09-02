/**
 * `rt team create` — scaffolds the local team zone (~/.mattstack/teams/<slug>)
 * as a fresh git repo with its starter settings, but never pushes: Install's
 * `team.create` step owns the push, via `publishTeam`.
 *
 * Every step below checks whether a previous attempt already got that far
 * before doing it again, so a failure partway through (network blip on
 * `git init`, a denied `git remote add`) leaves a zone a re-run can finish
 * rather than a permanent `team-exists` wall or a silently empty remote.
 */

import { dirname, join } from "path";
import { parseRemoteUrl } from "../enrich.ts";
import { type AgeKeySeam, createRealAgeKeySeam, ensureAgeKey, renderSopsYamlFor } from "../home/age-key.ts";
import { TEAM_PATH_REGEX } from "../secrets/team-store.ts";
import { updateTeamLocal } from "./team-local.ts";
import { UserActionableError } from "../setup/errors.ts";
import { readIntent, writeIntent } from "../setup/intent.ts";
import { gitUsable } from "../setup/home-git.ts";
import type { ExecResult, Probes } from "../setup/probes.ts";
import { forgeFromRemote, parseOriginUrl, stripUserinfo } from "../setup/team-settings.ts";
import { withoutUrls } from "./redact.ts";
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
  /** Files and intent are on disk but no git ran: CLT was absent, so the
   *  Install re-run owns init/remote/commit once the checklist installs it. */
  gitDeferred?: true;
}

/** The scaffold's own marker: present only once the initial commit has actually happened, so a partially-built dir (mkdirp/git-init done, nothing committed yet) is never mistaken for a finished zone. */
const SCAFFOLD_MARKER = join("mattstack", "mattstack.jsonc");
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
 *
 * `board.projects`/`board.members` are deliberately NOT written: the
 * resolver's board.* keys carry no registry default because a *present*
 * value (even `[]`) flips their store-ownership latch and wins over an
 * existing `config.json` on the creator's own machine — an empty array here
 * would brick a working mr-board install. Only keys with real content
 * (`board.gitlabHost`, `board.title`) are seeded.
 */
export function scaffoldFiles(slug: string, name: string, remote: string, recipients: string[] = []): Record<string, string> {
  const forge = forgeFromRemote(remote);
  const owner = ownerFromRemote(remote) ?? slug;

  const mattstackJsonc = { role: "team", namespace: slug, org: owner };

  const settings: Record<string, unknown> = { "mattstack.integrations": { forge } };
  if (forge?.provider === "gitlab") settings["board.gitlabHost"] = forge.host;
  settings["board.title"] = name;

  const marketplace = { name: slug, owner: { name }, plugins: [] };

  return {
    [SCAFFOLD_MARKER]: `${JSON.stringify(mattstackJsonc, null, 2)}\n`,
    "mattstack/settings.team.jsonc": `${SETTINGS_HEADER}${JSON.stringify(settings, null, 2)}\n`,
    ".claude-plugin/marketplace.json": `${JSON.stringify(marketplace, null, 2)}\n`,
    ".sops.yaml": renderSopsYamlFor(TEAM_PATH_REGEX, recipients),
    ".gitignore": "mattstack/secrets/*.tmp\n.DS_Store\n",
  };
}

function readExistingOrigin(p: Probes, dir: string): string | null {
  const raw = p.readFile(join(dir, ".git", "config"));
  return raw !== null ? parseOriginUrl(raw) : null;
}

/** Every git-step failure becomes one of these — never a plain `Error` that would surface as an unhandled crash instead of a renderable message. */
function gitStepError(code: string, step: string, result: ExecResult): UserActionableError {
  return new UserActionableError(code, `${step} failed (exit ${result.code}): ${withoutUrls(`${result.stdout}\n${result.stderr}`.trim())}`);
}

/**
 * A prior attempt may have already created the gh repo and then failed on a
 * later, purely-local step (git init, a scaffold write) before `.git/config`
 * ever recorded it — reuse that URL from the runtime intent instead of
 * calling `gh repo create` again, which fails outright once the repo
 * already exists remotely. The intent is written the moment gh succeeds
 * (before any filesystem mutation to the zone), so this is the durable
 * checkpoint a resume reads, not `.git/config`.
 */
function cachedRemoteFromIntent(p: Probes, slug: string): string | null {
  const intent = readIntent(p);
  return intent?.mode === "create" && intent.team?.slug === slug ? (intent.team.remote ?? null) : null;
}

async function resolveRemote(p: Probes, slug: string, opts: CreateTeamOpts): Promise<string> {
  if (opts.remote) return opts.remote;

  const cached = cachedRemoteFromIntent(p, slug);
  if (cached) return cached;

  if (!opts.createRepoOwner) {
    throw new UserActionableError("remote-required", "a git remote is required (gh-created or pasted)");
  }

  const repoPath = `${opts.createRepoOwner}/mattstack-team-${slug}`;
  const result = await p.exec(["gh", "repo", "create", repoPath, "--private"]);
  if (result.code !== 0) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/already exists/i.test(text)) {
      throw new UserActionableError(
        "create-repo-exists",
        `gh repo create ${repoPath}: a repo already exists there — pass --remote <its URL> instead of --create-repo to finish setting up this team`,
      );
    }
    throw new UserActionableError("create-repo-failed", `gh repo create ${repoPath} failed: ${withoutUrls(text.trim())}`);
  }
  const url = result.stdout.split("\n")[0]?.trim();
  if (!url) {
    throw new UserActionableError("create-repo-failed", `gh repo create ${repoPath} printed no URL to use as the remote`);
  }

  // Provenance, recorded at the one moment it is knowable: rt just created
  // this remote. It confers no rights — it only lets the membership permission
  // be OFFERED later, so rt never asks whether it should administer a repo it
  // was merely pointed at (MAT-387). The permission itself stays off until a
  // human grants it.
  updateTeamLocal(p, slug, { createdByRt: true });

  writeIntent(p, { v: 1, at: p.now().toISOString(), mode: "create", team: { slug, name: opts.name, remote: url, others: opts.others } });
  return url;
}

export async function createTeam(p: Probes, opts: CreateTeamOpts, ageKeySeam: AgeKeySeam = createRealAgeKeySeam()): Promise<CreateTeamResult> {
  const slug = slugify(opts.name);
  const dir = join(p.home, ".mattstack", "teams", slug);

  const originConfigured = p.exists(dir) ? readExistingOrigin(p, dir) : null;
  if (originConfigured !== null && opts.remote !== null && opts.remote !== originConfigured) {
    throw new UserActionableError(
      "team-exists",
      `team "${slug}" already exists at ${dir} with a different remote — pass the same --remote it was created with, or remove ${dir} to start over`,
    );
  }

  const scaffolded = p.exists(join(dir, SCAFFOLD_MARKER));
  if (originConfigured !== null && scaffolded) {
    writeIntent(p, {
      v: 1,
      at: p.now().toISOString(),
      mode: "create",
      team: { slug, name: opts.name, remote: originConfigured, others: opts.others },
    });
    return { slug, name: opts.name, remote: stripUserinfo(originConfigured), dir, created: false };
  }

  // Past here the zone is either absent or partially built (dir exists, but
  // not yet fully scaffolded/committed) — every step below is a no-op when a
  // prior attempt already got that far.
  const remote = originConfigured ?? (await resolveRemote(p, slug, opts));

  p.mkdirp(dir);

  const { publicKey } = await ensureAgeKey(ageKeySeam);
  const writeScaffold = () => {
    for (const [relPath, content] of Object.entries(scaffoldFiles(slug, opts.name, remote, [publicKey]))) {
      const fullPath = join(dir, relPath);
      if (p.exists(fullPath)) continue; // a resumed partial zone already has this file — never clobber real content with the scaffold's own placeholder
      p.mkdirp(dirname(fullPath));
      p.writeFile(fullPath, content);
    }
  };
  const recordIntent = () =>
    writeIntent(p, {
      v: 1,
      at: p.now().toISOString(),
      mode: "create",
      team: { slug, name: opts.name, remote, others: opts.others },
    });

  // The Team screen reaches here before the checklist installs CLT, when
  // /usr/bin/git is Apple's stub: it fails and pops the install dialog. Leave
  // the zone git-less; Install re-runs this once CLT exists and finishes it.
  if (!p.exists(join(dir, ".git")) && !(await gitUsable(p.exec))) {
    writeScaffold();
    recordIntent();
    return { slug, name: opts.name, remote: stripUserinfo(remote), dir, created: true, gitDeferred: true };
  }

  if (!p.exists(join(dir, ".git"))) {
    const initResult = await p.exec(["git", "init", "-b", "main"], { cwd: dir });
    if (initResult.code !== 0) throw gitStepError("git-init-failed", "git init -b main", initResult);
  }

  if (originConfigured === null) {
    const remoteAddResult = await p.exec(["git", "remote", "add", "origin", remote], { cwd: dir });
    if (remoteAddResult.code !== 0) throw gitStepError("git-remote-failed", "git remote add origin", remoteAddResult);
  }

  writeScaffold();

  const addResult = await p.exec(["git", "add", "-A"], { cwd: dir });
  if (addResult.code !== 0) throw gitStepError("git-add-failed", "git add -A", addResult);

  const commitResult = await p.exec(["git", "commit", "-m", `team: scaffold ${slug}`], { cwd: dir });
  if (commitResult.code !== 0 && !/nothing to commit/i.test(`${commitResult.stdout}\n${commitResult.stderr}`)) {
    throw gitStepError("git-commit-failed", "git commit", commitResult);
  }

  recordIntent();

  return { slug, name: opts.name, remote: stripUserinfo(remote), dir, created: true };
}
