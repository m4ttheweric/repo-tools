/**
 * access-group validators — network/auth reachability of the team's git
 * remotes and forge/switchboard hosts, distinct from accounts.ts's
 * credential-presence rows: a row here can be "needs-you" even with a valid
 * token, when the token's OWNER hasn't been granted access to a specific
 * repo yet.
 */

import { row, type Row } from "../contract.ts";
import type { SetupIntent } from "../intent.ts";
import type { Probes } from "../probes.ts";
import type { TeamSnapshot } from "../team-settings.ts";

const LS_REMOTE_TIMEOUT_MS = 15000;
/** Never prompts for credentials on a headless probe — an interactive prompt would hang setup indefinitely instead of surfacing the honest "no access yet" row. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
/** git's own wording for "the remote exists but this credential can't read it" — distinguished from a genuinely unreachable host so the two never share a detail string. */
const AUTH_FAILURE_PATTERN = /Authentication|403|Permission denied|could not read Username/;

interface LsRemoteOutcome {
  status: "ready" | "needs-you" | "error";
  detail: string;
}

/** Shared by access.team-repo and access.repo.<slug> — same three-way remote-reachability read, just a different remote per caller. */
async function lsRemoteOutcome(p: Probes, remote: string): Promise<LsRemoteOutcome> {
  const res = await p.exec(["git", "ls-remote", "--exit-code", remote, "HEAD"], { timeoutMs: LS_REMOTE_TIMEOUT_MS, env: GIT_ENV });
  if (res.code === 0) return { status: "ready", detail: "reachable" };
  if (res.code === 2) return { status: "ready", detail: "empty repo (will be initialized)" };
  if (res.code === 128 && AUTH_FAILURE_PATTERN.test(res.stderr)) {
    return { status: "needs-you", detail: "you don't have access yet: ask the owner to grant you access" };
  }
  if (res.code === 124) return { status: "error", detail: "unreachable: git ls-remote timed out" };
  const firstLine = res.stderr.trim().split("\n")[0] || `exit ${res.code}`;
  return { status: "error", detail: `unreachable: ${firstLine}` };
}

async function teamRepoRow(p: Probes, team: TeamSnapshot, intent: SetupIntent | null): Promise<Row> {
  const base = { id: "access.team-repo", kind: "access" as const, title: "Team repo", why: "rt needs read/write access to your team's home repo to sync settings and packs.", required: true };
  const remote = intent?.team?.remote ?? intent?.join?.pointer.remote ?? team.remote;
  if (!remote) return row({ ...base, status: "missing", detail: "no team remote yet (screen 2)" });

  const outcome = await lsRemoteOutcome(p, remote);
  return row({ ...base, status: outcome.status, detail: outcome.detail });
}

async function forgeRow(p: Probes, team: TeamSnapshot): Promise<Row> {
  const base = { id: "access.forge", kind: "access" as const, title: "Forge reachability", why: "Confirms your network can reach the team's forge host before rt tries to open PRs/MRs there.", required: true };
  const host = team.integrations.forge?.host;
  if (!host) return row({ ...base, status: "missing", detail: "no forge configured yet" });

  const res = await p.fetch(`https://${host}/`, { method: "HEAD", timeoutMs: 5000 });
  if (res.status > 0) return row({ ...base, status: "ready", detail: `${host} reachable (status ${res.status})` });
  return row({ ...base, status: "error", detail: `couldn't reach ${host} — check your network or proxy` });
}

async function repoRow(p: Probes, identity: string): Promise<Row> {
  const base = {
    id: `access.repo.${identity.replace(/\//g, "-")}`,
    kind: "access" as const,
    title: identity,
    why: "Lets the board show this repo's MRs/PRs.",
    required: false,
    optionalNote: "Works without this; the board won't show this repo",
  };
  const outcome = await lsRemoteOutcome(p, `https://${identity}.git`);
  return row({ ...base, status: outcome.status, detail: outcome.detail });
}

async function switchboardRow(p: Probes, team: TeamSnapshot): Promise<Row | null> {
  const url = team.integrations.switchboard?.url;
  if (!url) return null;
  const base = {
    id: "access.switchboard",
    kind: "access" as const,
    title: "Switchboard reachability",
    why: "Confirms the team's switchboard service is reachable from this machine.",
    required: false,
    optionalNote: "Works without this; only matters if your pack uses switchboard.",
  };
  const res = await p.fetch(`${url}/health`);
  if (res.status === 200) return row({ ...base, status: "ready", detail: "reachable" });
  if (res.status === 0) return row({ ...base, status: "error", detail: `couldn't reach ${url} — check your network or proxy` });
  return row({ ...base, status: "error", detail: `switchboard /health returned ${res.status}` });
}

export async function accessRows(p: Probes, team: TeamSnapshot, intent: SetupIntent | null): Promise<Row[]> {
  const rows: Row[] = [await teamRepoRow(p, team, intent), await forgeRow(p, team)];
  for (const identity of team.trackingIdentities) rows.push(await repoRow(p, identity));
  const switchboard = await switchboardRow(p, team);
  if (switchboard) rows.push(switchboard);
  return rows;
}
