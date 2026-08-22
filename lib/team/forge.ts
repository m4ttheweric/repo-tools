/**
 * Grants (and revokes) read access on the team's forge repo for an invited
 * handle, via the `gh`/`glab` CLIs. Never fabricates success: a probe that
 * can't run, or a forge it can't recognize, reports "manual"/"skipped" with
 * the exact steps a human needs — never a guessed "granted".
 */

import { parseRemoteUrl } from "../enrich.ts";
import { forgeFromRemote } from "../setup/team-settings.ts";
import type { Probes } from "../setup/probes.ts";

export type ForgeAccess = "granted" | "manual" | "skipped";

interface ParsedForgeRemote {
  provider: "github" | "gitlab";
  host: string;
  path: string;
}

function parseForgeRemote(remote: string): ParsedForgeRemote | null {
  const forge = forgeFromRemote(remote);
  const parsed = parseRemoteUrl(remote);
  if (!forge || !parsed) return null;
  return { provider: forge.provider, host: forge.host, path: parsed.projectPath };
}

function splitOwnerRepo(path: string): { owner: string; repo: string } {
  const [owner, ...rest] = path.split("/");
  return { owner: owner ?? "", repo: rest.join("/") };
}

/** `glab api` targets gitlab.com by default; a self-hosted instance needs its host named explicitly. */
function glabEnv(host: string): Record<string, string> | undefined {
  return host === "gitlab.com" ? undefined : { GITLAB_HOST: host };
}

async function lookupGitlabUserId(p: Probes, host: string, handle: string): Promise<number | null> {
  const result = await p.exec(["glab", "api", `users?username=${handle}`], { env: glabEnv(host) });
  if (result.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const id = Array.isArray(parsed) ? (parsed[0] as { id?: unknown } | undefined)?.id : undefined;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

function githubManualSteps(owner: string, repo: string, handle: string, action: "Invite" | "Remove"): string[] {
  const target = action === "Invite" ? `${handle} with Read` : `${handle}'s access`;
  return [`Open https://github.com/${owner}/${repo}/settings/access`, `${action} ${target}`];
}

function gitlabManualSteps(host: string, path: string, handle: string, action: "Invite" | "Remove"): string[] {
  const target = action === "Invite" ? `${handle} with Reporter access` : `${handle}'s access`;
  return [`Open https://${host}/${path}/-/project_members`, `${action} ${target}`];
}

export async function grantRead(p: Probes, remote: string, handle: string): Promise<{ access: ForgeAccess; manualSteps: string[] }> {
  const parsed = parseForgeRemote(remote);
  if (!parsed) return { access: "skipped", manualSteps: [] };

  if (parsed.provider === "github") {
    const { owner, repo } = splitOwnerRepo(parsed.path);
    const result = await p.exec(["gh", "api", "-X", "PUT", `/repos/${owner}/${repo}/collaborators/${handle}`, "-f", "permission=pull"]);
    if (result.code === 0) return { access: "granted", manualSteps: [] };
    return { access: "manual", manualSteps: githubManualSteps(owner, repo, handle, "Invite") };
  }

  const manualSteps = gitlabManualSteps(parsed.host, parsed.path, handle, "Invite");
  const userId = await lookupGitlabUserId(p, parsed.host, handle);
  if (userId === null) return { access: "manual", manualSteps };

  const result = await p.exec(
    ["glab", "api", "-X", "POST", `projects/${encodeURIComponent(parsed.path)}/members`, "-f", `user_id=${userId}`, "-f", "access_level=20"],
    { env: glabEnv(parsed.host) },
  );
  if (result.code === 0) return { access: "granted", manualSteps: [] };
  return { access: "manual", manualSteps };
}

export async function revokeRead(p: Probes, remote: string, handle: string): Promise<{ access: ForgeAccess; manualSteps: string[] }> {
  const parsed = parseForgeRemote(remote);
  if (!parsed) return { access: "skipped", manualSteps: [] };

  if (parsed.provider === "github") {
    const { owner, repo } = splitOwnerRepo(parsed.path);
    const result = await p.exec(["gh", "api", "-X", "DELETE", `/repos/${owner}/${repo}/collaborators/${handle}`]);
    if (result.code === 0) return { access: "granted", manualSteps: [] };
    return { access: "manual", manualSteps: githubManualSteps(owner, repo, handle, "Remove") };
  }

  const manualSteps = gitlabManualSteps(parsed.host, parsed.path, handle, "Remove");
  const userId = await lookupGitlabUserId(p, parsed.host, handle);
  if (userId === null) return { access: "manual", manualSteps };

  const result = await p.exec(["glab", "api", "-X", "DELETE", `projects/${encodeURIComponent(parsed.path)}/members/${userId}`], {
    env: glabEnv(parsed.host),
  });
  if (result.code === 0) return { access: "granted", manualSteps: [] };
  return { access: "manual", manualSteps };
}

function parseStringField(stdout: string, field: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return typeof parsed[field] === "string" ? (parsed[field] as string) : null;
  } catch {
    return null;
  }
}

export async function forgeLogin(p: Probes, provider: "github" | "gitlab", host: string): Promise<string | null> {
  if (provider === "github") {
    const result = await p.exec(["gh", "api", "user"]);
    return result.code === 0 ? parseStringField(result.stdout, "login") : null;
  }
  const result = await p.exec(["glab", "api", "user"], { env: glabEnv(host) });
  return result.code === 0 ? parseStringField(result.stdout, "username") : null;
}
