/**
 * access-group validators — network/auth reachability of the team's git
 * remotes and forge/switchboard hosts, distinct from accounts.ts's
 * credential-presence rows: a row here can be "needs-you" even with a valid
 * token, when the token's OWNER hasn't been granted access to a specific
 * repo yet.
 */

import { row, type Action, type Row } from "../contract.ts";
import { isValidHostname, isValidHttpsUrl } from "../host-validate.ts";
import type { SetupIntent } from "../intent.ts";
import type { Probes } from "../probes.ts";
import { forgeFromRemote, type TeamSnapshot, type UserIntegrationOverrides } from "../team-settings.ts";
import { readTeamLocal } from "../../team/team-local.ts";
import type { SecretPresence } from "./accounts.ts";
import { forgeTokenLookupFromPresence } from "../../team/forge-token.ts";
import { probeTeamRepoAccess, forgeLabel, type RepoAccessVerdict } from "../../team/repo-access.ts";
import { integrationDef } from "../integrations.ts";

const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };

function rowFromVerdict(v: RepoAccessVerdict, ctx: { grantedBy: string; provider: "github" | "gitlab" }): Pick<Row, "status" | "detail" | "action"> {
  const forge = forgeLabel(ctx.provider);
  switch (v.kind) {
    case "ok":
      return { status: "ready", detail: v.detail, action: null };
    case "no-clt":
      return { status: "missing", detail: "needs Apple's Command Line Tools first (see the tool row), then re-check", action: RECHECK_ACTION };
    case "no-account":
      return { status: "needs-you", detail: `Connect your ${forge} account so rt can prove access`, action: { type: "connect", label: "Connect", integration: ctx.provider, fields: integrationDef(ctx.provider).fields } };
    case "denied":
      return { status: "needs-you", detail: `your ${forge} account cannot see this repo yet: ask ${ctx.grantedBy} or your org admin to grant read access`, action: RECHECK_ACTION };
    default:
      return { status: "error", detail: v.detail, action: RECHECK_ACTION };
  }
}

/** The canonical out-of-band row: a different human grants access, or the network/VPN changes — no file rt watches ever reflects that, so this only ever updates on an explicit re-check. */
async function teamRepoRow(p: Probes, team: TeamSnapshot, intent: SetupIntent | null, secrets: SecretPresence | undefined): Promise<Row> {
  // A joined (pull-only) clone never pushes, so claiming write access it will never use would be
  // false; read the mode from the machine-local record itself, never from daemon status, so this
  // row still answers with the daemon down.
  const pullOnly = readTeamLocal(p, team.slug).joinedByRt;
  const why = pullOnly
    ? "rt needs read access to your team's home repo to sync settings and packs. Only the team's owner writes it."
    : "rt needs read/write access to your team's home repo to sync settings and packs.";
  const base = { id: "access.team-repo", kind: "access" as const, title: "Team repo", why, required: true, recheck: "on-activate" as const };
  const remote = intent?.team?.remote ?? intent?.join?.pointer.remote ?? team.remote;
  // Screen 2 recomputes the whole plan in-band once a remote exists — nothing to re-check here yet.
  if (!remote) return row({ ...base, status: "missing", detail: "no team remote yet (screen 2)" });

  const provider = forgeFromRemote(remote)?.provider ?? "github";
  const verdict = await probeTeamRepoAccess(p, remote, await forgeTokenLookupFromPresence(remote, secrets));
  const grantedBy = intent?.join?.pointer.owner ?? "the repo's owner";
  return row({ ...base, ...rowFromVerdict(verdict, { grantedBy, provider }) });
}

/** A joined team names its own forge/switchboard host, but a team is not the user — probing (let alone authenticating against) that host is a network access rt takes on the user's behalf, so it waits for the same user-confirmed `rt.integrations` override ctxFor's credential validators require, rather than dialing an inviter-controlled host on its own. */
function connectHostSteps(id: "github" | "gitlab" | "switchboard", declaredHost: string): Action {
  return { type: "steps", label: "Show steps…", steps: [`Run: rt setup ${id} connect --host ${declaredHost}`, "This confirms the host yourself before rt talks to it"] };
}

async function forgeRow(p: Probes, team: TeamSnapshot, intent: SetupIntent | null, overrides: UserIntegrationOverrides): Promise<Row> {
  const base = { id: "access.forge", kind: "access" as const, title: "Forge reachability", why: "Confirms your network can reach the team's forge host before rt tries to open PRs/MRs there.", required: true, recheck: "on-activate" as const };
  const declaredHost = team.integrations.forge?.host;
  // No forge configured yet is resolved by an earlier screen, same as team-repo's missing branch.
  if (!declaredHost) return row({ ...base, status: "missing", detail: "no forge configured yet" });

  // A team the user is creating declares only the host of the remote they
  // pasted themselves — nothing an inviter chose, nothing left to confirm.
  const ownRemoteHost = intent?.mode === "create" && intent.team?.remote ? forgeFromRemote(intent.team.remote)?.host ?? null : null;
  const confirmedHost =
    overrides.forgeHost && isValidHostname(overrides.forgeHost) ? overrides.forgeHost : ownRemoteHost === declaredHost ? declaredHost : null;
  if (!confirmedHost) {
    const verb = team.integrations.forge?.provider === "github" ? "github" : "gitlab";
    return row({ ...base, status: "needs-you", detail: `your team declares forge host "${declaredHost}" — unverified; confirm it yourself before rt reaches out to it`, action: connectHostSteps(verb, declaredHost) });
  }

  const res = await p.fetch(`https://${confirmedHost}/`, { method: "HEAD", timeoutMs: 5000 });
  if (res.status > 0) return row({ ...base, status: "ready", detail: `${confirmedHost} reachable (status ${res.status})` });
  return row({ ...base, status: "error", detail: `couldn't reach ${confirmedHost} — check your network or proxy`, action: RECHECK_ACTION });
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
  const remote = `https://${identity}.git`;
  const provider = forgeFromRemote(remote)?.provider ?? "github";
  const probed = await probeTeamRepoAccess(p, remote, { kind: "absent" });
  // A tracked repo is never probed with rt's token, so git having no
  // credential says nothing about whether the user connected an account:
  // offering a Connect action here would change nothing on the next probe.
  const verdict: RepoAccessVerdict =
    probed.kind === "no-account"
      ? { kind: "indeterminate", detail: "couldn't determine access: this row probes without rt's token, so git had nothing to send" }
      : probed;
  return row({ ...base, ...rowFromVerdict(verdict, { grantedBy: "that repo's admin", provider }) });
}

async function switchboardRow(p: Probes, team: TeamSnapshot, overrides: UserIntegrationOverrides): Promise<Row | null> {
  const declaredUrl = team.integrations.switchboard?.url;
  if (!declaredUrl) return null;
  const base = {
    id: "access.switchboard",
    kind: "access" as const,
    title: "Switchboard reachability",
    why: "Confirms the team's switchboard service is reachable from this machine.",
    required: false,
    optionalNote: "Works without this; only matters if your pack uses switchboard.",
  };

  const confirmedUrl = overrides.switchboardUrl && isValidHttpsUrl(overrides.switchboardUrl) ? overrides.switchboardUrl : null;
  if (!confirmedUrl) {
    return row({ ...base, status: "needs-you", detail: `your team declares switchboard at "${declaredUrl}" — unverified; confirm it yourself before rt reaches out to it`, action: connectHostSteps("switchboard", declaredUrl) });
  }

  const res = await p.fetch(`${confirmedUrl}/health`);
  if (res.status === 200) return row({ ...base, status: "ready", detail: "reachable" });
  if (res.status === 0) return row({ ...base, status: "error", detail: `couldn't reach ${confirmedUrl} — check your network or proxy` });
  return row({ ...base, status: "error", detail: `switchboard /health returned ${res.status}` });
}

/** Every probe here is independent (different remote/host/URL each), so they run concurrently — worst-case latency is the slowest single probe, not their sum; team-repo/forge/switchboard/each tracking identity all keep their own bounded timeout. */
export async function accessRows(p: Probes, team: TeamSnapshot, intent: SetupIntent | null, overrides: UserIntegrationOverrides = {}, secrets?: SecretPresence): Promise<Row[]> {
  const [teamRepo, forge, switchboard, ...repos] = await Promise.all([
    teamRepoRow(p, team, intent, secrets),
    forgeRow(p, team, intent, overrides),
    switchboardRow(p, team, overrides),
    ...team.trackingIdentities.map((identity) => repoRow(p, identity)),
  ]);

  const rows: Row[] = [teamRepo!, forge!, ...repos];
  if (switchboard) rows.push(switchboard);
  return rows;
}
