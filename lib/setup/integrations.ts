/**
 * The per-integration connect/validate table — one definition per credential
 * rt can hold, pinned in code (not pack-declared) since each validate() call
 * is a specific API shape. Every validate() reaches the network only through
 * `p.fetch`/`p.exec`, never a bare `fetch`/child_process call, so it stays
 * honest under test and never silently guesses a ready status.
 */

import type { ConnectField, Integration } from "./contract.ts";
import { UserActionableError } from "./errors.ts";
import type { Probes } from "./probes.ts";

export interface ValidateResult {
  status: "ready" | "invalid";
  detail: string;
  scopesSeen: string[];
}

export interface ValidateCtx {
  host: string | null;
  team: { slug: string; remote: string | null };
  /** mattstack.integrations.linear.teamKey, when the pack declares one — undeclared means "any team the token can see" is fine. */
  linearTeamKey?: string | null;
}

export interface IntegrationDef {
  id: Integration;
  title: string;
  why: (teamHost: string | null) => string;
  fields: ConnectField[];
  alternatives?: { id: "use-gh"; label: string }[];
  /** Where connect stores the credential (user-scope secrets). Absent for a CLI-owned session (doppler/ldcli) that rt never holds a token for. */
  secret?: { domain: "rt" | "board"; key: string };
  validate(p: Probes, token: string, ctx: ValidateCtx): Promise<ValidateResult>;
}

function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function parseGithubRemote(remote: string): { owner: string; repo: string } | null {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = remote.match(re);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return null;
}

/** Same three remote shapes as parseGithubRemote, generalized to any host (self-hosted GitLab). Returns the project's full namespace/path, undecoded. */
function parseProjectPath(remote: string, host: string): string | null {
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^https?://(?:[^@/]+@)?${escapedHost}/(.+?)(?:\\.git)?/?$`),
    new RegExp(`^git@${escapedHost}:(.+?)(?:\\.git)?$`),
    new RegExp(`^ssh://git@${escapedHost}/(.+?)(?:\\.git)?$`),
  ];
  for (const re of patterns) {
    const m = remote.match(re);
    if (m) return m[1]!;
  }
  return null;
}

function parseHeaderList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const INTEGRATIONS: Record<Integration, IntegrationDef> = {
  github: {
    id: "github",
    title: "GitHub",
    why: (teamHost) => (teamHost ? `Lets rt open PRs, check CI, and read repo metadata on ${teamHost}.` : "Lets rt open PRs, check CI status, and read repo metadata on GitHub."),
    fields: [{ name: "token", label: "GitHub token", secret: true, hint: "repo, read:org" }],
    alternatives: [{ id: "use-gh", label: "Use your existing gh CLI session instead" }],
    secret: { domain: "rt", key: "githubToken" },
    async validate(p, token, ctx) {
      const userRes = await p.fetch("https://api.github.com/user", { headers: githubHeaders(token) });
      if (userRes.status !== 200) return { status: "invalid", detail: `github /user returned ${userRes.status}`, scopesSeen: [] };
      const scopesSeen = parseHeaderList(userRes.headers["x-oauth-scopes"]);

      const project = ctx.team.remote ? parseGithubRemote(ctx.team.remote) : null;
      if (project) {
        const repoRes = await p.fetch(`https://api.github.com/repos/${project.owner}/${project.repo}`, { headers: githubHeaders(token) });
        if (repoRes.status === 404) return { status: "invalid", detail: `token can't see ${project.owner}/${project.repo}`, scopesSeen };
        if (repoRes.status !== 200) return { status: "invalid", detail: `github repo lookup returned ${repoRes.status}`, scopesSeen };
      }
      return { status: "ready", detail: "github token valid", scopesSeen };
    },
  },

  gitlab: {
    id: "gitlab",
    title: "GitLab",
    why: (teamHost) => (teamHost ? `Lets rt open MRs, check pipelines, and read project metadata on ${teamHost}.` : "Lets rt open MRs, check pipelines, and read project metadata on GitLab."),
    fields: [{ name: "token", label: "GitLab token", secret: true, hint: "read_api, read_user" }],
    secret: { domain: "rt", key: "gitlabToken" },
    async validate(p, token, ctx) {
      const host = ctx.host ?? "gitlab.com";
      const headers = { "PRIVATE-TOKEN": token };

      const userRes = await p.fetch(`https://${host}/api/v4/user`, { headers });
      if (userRes.status !== 200) return { status: "invalid", detail: `gitlab /user returned ${userRes.status}`, scopesSeen: [] };

      let scopesSeen: string[] = [];
      const selfRes = await p.fetch(`https://${host}/api/v4/personal_access_tokens/self`, { headers });
      if (selfRes.status === 200) {
        try {
          const parsed = JSON.parse(selfRes.body) as { scopes?: string[] };
          scopesSeen = parsed.scopes ?? [];
        } catch {
          // scopes stay [] — the token check above already succeeded, so this is cosmetic only
        }
      }

      const path = ctx.team.remote ? parseProjectPath(ctx.team.remote, host) : null;
      if (path) {
        const projRes = await p.fetch(`https://${host}/api/v4/projects/${encodeURIComponent(path)}`, { headers });
        if (projRes.status !== 200) return { status: "invalid", detail: `token can't see ${path}`, scopesSeen };
      }
      return { status: "ready", detail: "gitlab token valid", scopesSeen };
    },
  },

  linear: {
    id: "linear",
    title: "Linear",
    why: () => "Lets rt read and update Linear issues for your team.",
    fields: [{ name: "apiKey", label: "Linear API key", secret: true, hint: "lin_api_…" }],
    secret: { domain: "rt", key: "linearApiKey" },
    async validate(p, token, ctx) {
      const res = await p.fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id } teams { nodes { key } } }" }),
      });
      if (res.status !== 200) return { status: "invalid", detail: `linear API returned ${res.status}`, scopesSeen: [] };

      let teamKeys: string[] = [];
      try {
        const parsed = JSON.parse(res.body) as { data?: { teams?: { nodes?: { key: string }[] } } };
        teamKeys = parsed.data?.teams?.nodes?.map((n) => n.key) ?? [];
      } catch {
        return { status: "invalid", detail: "linear API returned malformed JSON", scopesSeen: [] };
      }

      if (!ctx.linearTeamKey) return { status: "ready", detail: "viewer ok", scopesSeen: [] };
      if (teamKeys.includes(ctx.linearTeamKey)) return { status: "ready", detail: `viewer ok, team ${ctx.linearTeamKey} found`, scopesSeen: [] };
      return { status: "invalid", detail: `token can't see team ${ctx.linearTeamKey}`, scopesSeen: [] };
    },
  },

  slack: {
    id: "slack",
    title: "Slack",
    why: () => "Lets rt post and read messages in your team's Slack workspace.",
    fields: [],
    secret: { domain: "board", key: "slackUserToken" },
    async validate(p, token) {
      const res = await p.fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      let data: { ok?: boolean; team?: string; error?: string } = {};
      try {
        data = JSON.parse(res.body);
      } catch {
        // falls through to the generic failure below
      }
      if (res.status === 200 && data.ok === true) return { status: "ready", detail: `connected as ${data.team ?? "unknown team"}`, scopesSeen: [] };
      return { status: "invalid", detail: data.error ? `slack error: ${data.error}` : `slack auth.test failed (status ${res.status})`, scopesSeen: [] };
    },
  },

  switchboard: {
    id: "switchboard",
    title: "Switchboard",
    why: () => "Lets rt reach your team's switchboard service.",
    fields: [{ name: "token", label: "Switchboard token", secret: true }],
    secret: { domain: "rt", key: "switchboardToken" },
    async validate(p, token, ctx) {
      if (!ctx.host) return { status: "invalid", detail: "switchboard host not configured", scopesSeen: [] };
      const res = await p.fetch(`${ctx.host}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 200) return { status: "ready", detail: "switchboard reachable", scopesSeen: [] };
      return { status: "invalid", detail: `switchboard /health returned ${res.status}`, scopesSeen: [] };
    },
  },

  sdm: {
    id: "sdm",
    title: "StrongDM",
    why: () => "Lets rt confirm you're logged into StrongDM before driving database tunnels.",
    fields: [{ name: "email", label: "StrongDM email", secret: false }],
    secret: { domain: "rt", key: "sdmEmail" },
    async validate(p, email) {
      const res = await p.exec(["sdm", "status"]);
      if (res.code === 127) return { status: "invalid", detail: "sdm not installed", scopesSeen: [] };
      if (res.code === 0 && res.stdout.includes(email)) return { status: "ready", detail: `sdm session active for ${email}`, scopesSeen: [] };
      return { status: "invalid", detail: "sdm status did not show an active session for this email", scopesSeen: [] };
    },
  },

  doppler: {
    id: "doppler",
    title: "Doppler",
    why: () => "Lets rt confirm you're logged into Doppler before reading team secrets.",
    fields: [],
    async validate(p) {
      const res = await p.exec(["doppler", "me", "--json"]);
      if (res.code === 127) return { status: "invalid", detail: "doppler not installed", scopesSeen: [] };
      if (res.code === 0) return { status: "ready", detail: "doppler session active", scopesSeen: [] };
      return { status: "invalid", detail: "doppler me failed", scopesSeen: [] };
    },
  },

  ldcli: {
    id: "ldcli",
    title: "LaunchDarkly",
    why: () => "Lets rt confirm you're logged into the LaunchDarkly CLI before reading flags.",
    fields: [],
    async validate(p) {
      const res = await p.exec(["ldcli", "config", "--list"]);
      if (res.code === 127) return { status: "invalid", detail: "ldcli not installed", scopesSeen: [] };
      if (res.code === 0) return { status: "ready", detail: "ldcli session active", scopesSeen: [] };
      return { status: "invalid", detail: "ldcli config --list failed", scopesSeen: [] };
    },
  },
};

export function integrationDef(id: string): IntegrationDef {
  const def = (INTEGRATIONS as Record<string, IntegrationDef>)[id];
  if (!def) throw new UserActionableError("unknown-integration", `unknown integration "${id}"`);
  return def;
}
