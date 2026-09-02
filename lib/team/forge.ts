/**
 * Grants (and revokes) read access on the team's forge repo for an invited
 * handle, via the `gh`/`glab` CLIs. Never fabricates success: a probe that
 * can't run, an ambiguous CLI exit, or a forge it can't recognize, reports
 * "manual"/"skipped" with the exact steps a human needs — never a guessed
 * "granted"/"revoked".
 */

import { parseRemoteUrl } from "../enrich.ts";
import { forgeFromRemote } from "../setup/team-settings.ts";
import type { ExecResult, Probes } from "../setup/probes.ts";

export type ForgeAccess = "granted" | "manual" | "skipped";
/** Revoke has no "already effective, nothing to do" analog to "granted" — a completed revoke (including a no-op against an already-removed member) is "revoked", never the grant contract's "granted". */
export type RevokeAccess = "revoked" | "manual" | "skipped";

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

type FailureReason = "not-installed" | "not-authenticated" | "org-policy" | "unknown-handle" | "insufficient-permission" | "other";

/** Coarse, honest classification of a failed `gh`/`glab` call from its exit code and stderr shape — the CLIs don't expose a structured error, so this is pattern matching, not certainty; anything unrecognized stays "other" rather than being forced into a wrong bucket. */
function classifyExecFailure(result: Pick<ExecResult, "code" | "stdout" | "stderr">): FailureReason {
  if (result.code === 127) return "not-installed";
  const text = `${result.stdout}\n${result.stderr}`;
  if (/not logged in|HTTP 401|401 Unauthorized/i.test(text)) return "not-authenticated";
  if (/SAML|SSO enforcement/i.test(text)) return "org-policy";
  if (/HTTP 404|404 Not Found/i.test(text)) return "unknown-handle";
  if (/HTTP 403|403 Forbidden/i.test(text)) return "insufficient-permission";
  return "other";
}

function reasonLeadStep(reason: FailureReason, handle: string, cli: "gh" | "glab"): string | null {
  const forgeName = cli === "gh" ? "GitHub" : "GitLab";
  switch (reason) {
    case "not-installed":
      return `Install the ${forgeName} CLI (\`${cli}\`), then run \`${cli} auth login\``;
    case "not-authenticated":
      return `Run \`${cli} auth login\`, then retry \`rt team invite\``;
    case "org-policy":
      return "Authorize the CLI's token for this organization's SAML/SSO enforcement, then retry";
    case "unknown-handle":
      return `Check that "${handle}" is a real ${forgeName} username — it was not found`;
    case "insufficient-permission":
      return "The CLI's token lacks permission for this repo — check its scopes with an admin";
    case "other":
      return null;
  }
}

function withLead(lead: string | null, base: string[]): string[] {
  return lead ? [lead, ...base] : base;
}

function githubBaseSteps(owner: string, repo: string, handle: string, action: "Invite" | "Remove"): string[] {
  const target = action === "Invite" ? `${handle} with Read` : `${handle}'s access`;
  return [`Open https://github.com/${owner}/${repo}/settings/access`, `${action} ${target}`];
}

function gitlabBaseSteps(host: string, path: string, handle: string, action: "Invite" | "Remove"): string[] {
  const target = action === "Invite" ? `${handle} with Reporter access` : `${handle}'s access`;
  return [`Open https://${host}/${path}/-/project_members`, `${action} ${target}`];
}

function githubManualSteps(result: Pick<ExecResult, "code" | "stdout" | "stderr">, owner: string, repo: string, handle: string, action: "Invite" | "Remove"): string[] {
  return withLead(reasonLeadStep(classifyExecFailure(result), handle, "gh"), githubBaseSteps(owner, repo, handle, action));
}

function gitlabManualSteps(reason: FailureReason, host: string, path: string, handle: string, action: "Invite" | "Remove"): string[] {
  return withLead(reasonLeadStep(reason, handle, "glab"), gitlabBaseSteps(host, path, handle, action));
}

type GitlabUserLookup = { id: number } | { id: null; reason: FailureReason };

async function lookupGitlabUserId(p: Probes, host: string, handle: string, token: string | null | undefined): Promise<GitlabUserLookup> {
  const result = await p.exec(["glab", "api", `users?username=${encodeURIComponent(handle)}`], { env: forgeAuthEnv("gitlab", host, token) });
  if (result.code !== 0) return { id: null, reason: classifyExecFailure(result) };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const id = Array.isArray(parsed) ? (parsed[0] as { id?: unknown } | undefined)?.id : undefined;
    if (typeof id === "number") return { id };
    return { id: null, reason: "unknown-handle" };
  } catch {
    return { id: null, reason: "other" };
  }
}

export async function grantRead(p: Probes, remote: string, handle: string, token?: string | null): Promise<{ access: ForgeAccess; manualSteps: string[] }> {
  const parsed = parseForgeRemote(remote);
  if (!parsed) return { access: "skipped", manualSteps: [] };
  const env = forgeAuthEnv(parsed.provider, parsed.host, token);

  if (parsed.provider === "github") {
    const { owner, repo } = splitOwnerRepo(parsed.path);
    const result = await p.exec(["gh", "api", "-X", "PUT", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(handle)}`, "-f", "permission=pull"], env ? { env } : undefined);
    if (result.code === 0) {
      // gh prints the invitation object on a 201 (pending — access isn't effective until accepted) and nothing on a 204 (already effective) — the only signal this call exposes for telling the two apart.
      if (result.stdout.trim().length > 0) {
        return {
          access: "manual",
          manualSteps: [`${handle} must accept the pending GitHub collaboration invite (see github.com/${owner}/${repo}/invitations, or their email)`],
        };
      }
      return { access: "granted", manualSteps: [] };
    }
    return { access: "manual", manualSteps: githubManualSteps(result, owner, repo, handle, "Invite") };
  }

  const lookup = await lookupGitlabUserId(p, parsed.host, handle, token);
  if (lookup.id === null) {
    return { access: "manual", manualSteps: gitlabManualSteps(lookup.reason, parsed.host, parsed.path, handle, "Invite") };
  }

  const result = await p.exec(
    ["glab", "api", "-X", "POST", `projects/${encodeURIComponent(parsed.path)}/members`, "-f", `user_id=${lookup.id}`, "-f", "access_level=20"],
    { env },
  );
  if (result.code === 0) return { access: "granted", manualSteps: [] };
  return { access: "manual", manualSteps: gitlabManualSteps(classifyExecFailure(result), parsed.host, parsed.path, handle, "Invite") };
}

export async function revokeRead(p: Probes, remote: string, handle: string, token?: string | null): Promise<{ access: RevokeAccess; manualSteps: string[] }> {
  const parsed = parseForgeRemote(remote);
  if (!parsed) return { access: "skipped", manualSteps: [] };
  const env = forgeAuthEnv(parsed.provider, parsed.host, token);

  if (parsed.provider === "github") {
    const { owner, repo } = splitOwnerRepo(parsed.path);
    // DELETE collaborators is 204-idempotent on GitHub's side already — a non-collaborator DELETE still returns 204.
    const result = await p.exec(["gh", "api", "-X", "DELETE", `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(handle)}`], env ? { env } : undefined);
    if (result.code === 0) return { access: "revoked", manualSteps: [] };
    return { access: "manual", manualSteps: githubManualSteps(result, owner, repo, handle, "Remove") };
  }

  const lookup = await lookupGitlabUserId(p, parsed.host, handle, token);
  if (lookup.id === null) {
    // No resolvable GitLab account for this handle at all — it cannot be a project member, so there is nothing left to revoke.
    if (lookup.reason === "unknown-handle") return { access: "revoked", manualSteps: [] };
    return { access: "manual", manualSteps: gitlabManualSteps(lookup.reason, parsed.host, parsed.path, handle, "Remove") };
  }

  const result = await p.exec(["glab", "api", "-X", "DELETE", `projects/${encodeURIComponent(parsed.path)}/members/${lookup.id}`], { env });
  if (result.code === 0) return { access: "revoked", manualSteps: [] };
  // Unlike GitHub, GitLab's DELETE members/:id 404s for a non-member — parity with GitHub's own idempotent 204 means that 404 is success here too, not a failure to revoke.
  if (/HTTP 404|404 Not Found/i.test(`${result.stdout}\n${result.stderr}`)) return { access: "revoked", manualSteps: [] };
  return { access: "manual", manualSteps: gitlabManualSteps(classifyExecFailure(result), parsed.host, parsed.path, handle, "Remove") };
}

function parseStringField(stdout: string, field: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return typeof parsed[field] === "string" ? (parsed[field] as string) : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's own token variable, so a machine whose gh/glab was never logged
 * in still acts with the token rt holds. Env only: never argv, never a URL.
 */
function forgeAuthEnv(provider: "github" | "gitlab", host: string, token: string | null | undefined): Record<string, string> | undefined {
  const base = provider === "gitlab" ? glabEnv(host) : undefined;
  if (!token) return base;
  return { ...base, ...(provider === "github" ? { GH_TOKEN: token } : { GITLAB_TOKEN: token }) };
}

export async function forgeLogin(p: Probes, provider: "github" | "gitlab", host: string, token?: string | null): Promise<string | null> {
  const env = forgeAuthEnv(provider, host, token);
  if (provider === "github") {
    const result = await p.exec(["gh", "api", "user"], env ? { env } : undefined);
    return result.code === 0 ? parseStringField(result.stdout, "login") : null;
  }
  const result = await p.exec(["glab", "api", "user"], { env });
  return result.code === 0 ? parseStringField(result.stdout, "username") : null;
}
