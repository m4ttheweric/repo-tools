/**
 * access-group validators — network/auth reachability of the team's git
 * remotes and forge/switchboard hosts, distinct from accounts.ts's
 * credential-presence rows: a row here can be "needs-you" even with a valid
 * token, when the token's OWNER hasn't been granted access to a specific
 * repo yet.
 */

import { row, type Action, type Row } from "../contract.ts";
import { isValidHostname, isValidHttpsUrl } from "../host-validate.ts";
import { gitUsable } from "../home-git.ts";
import type { SetupIntent } from "../intent.ts";
import type { Probes } from "../probes.ts";
import { forgeFromRemote, type TeamSnapshot, type UserIntegrationOverrides } from "../team-settings.ts";
import { forgeTokenKey, gitWithToken } from "../../team/git-credential.ts";
import { withoutUrls } from "../../team/redact.ts";
import { readTeamLocal } from "../../team/team-local.ts";
import type { SecretPresence } from "./accounts.ts";

const LS_REMOTE_TIMEOUT_MS = 15000;
/** Never prompts for credentials on a headless probe — an interactive prompt would hang setup indefinitely instead of surfacing the honest "no access yet" row. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
/** git's own wording for "the forge actually refused this identity" — distinct from NO_CREDENTIAL_PATTERN's "there was nothing to refuse". */
const AUTH_REFUSAL_PATTERN = /Authentication failed|403|Permission denied/;
/** git had no credential to offer at all (no helper configured, and GIT_TERMINAL_PROMPT=0 suppressed the interactive prompt) — a could-not-determine, not a verdict that this identity was refused: rt holds its forge tokens in its own store, not necessarily in git's credential helper, so a user who DOES have access can hit this. */
const NO_CREDENTIAL_PATTERN = /could not read Username/;
const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };

interface LsRemoteOutcome {
  status: "ready" | "needs-you" | "error";
  detail: string;
}

/** The forge token rt itself holds for a remote's host (stored, or staged during setup), so the probe can answer on a machine whose git has no credential helper yet. */
async function forgeTokenFor(remote: string, secrets: SecretPresence | undefined): Promise<string | null> {
  const key = secrets ? forgeTokenKey(remote) : null;
  if (!key) return null;
  try {
    return await secrets!.has("rt", key);
  } catch {
    return null;
  }
}

/**
 * Shared by access.team-repo and access.repo.<slug> — same remote-reachability
 * read, just a different remote per caller. A token rides in the environment
 * and reaches git through an inline credential helper: never argv (visible in
 * ps), never the URL (echoed into stderr).
 */
async function lsRemoteOutcome(p: Probes, remote: string, token: string | null = null): Promise<LsRemoteOutcome> {
  const cmd = gitWithToken(["ls-remote", "--exit-code", remote, "HEAD"], token, GIT_ENV);
  const res = await p.exec(cmd.argv, { timeoutMs: LS_REMOTE_TIMEOUT_MS, env: cmd.env });
  if (res.code === 0) return { status: "ready", detail: "reachable" };
  if (res.code === 2) return { status: "ready", detail: "empty repo (will be initialized)" };
  if (res.code === 128) {
    if (NO_CREDENTIAL_PATTERN.test(res.stderr)) {
      return { status: "error", detail: "git has no credential configured for this host yet — couldn't determine access" };
    }
    if (AUTH_REFUSAL_PATTERN.test(res.stderr)) {
      return { status: "needs-you", detail: "you don't have access yet: ask the owner to grant you access" };
    }
  }
  if (res.code === 124) return { status: "error", detail: "unreachable: git ls-remote timed out" };
  const firstLine = withoutUrls(res.stderr.trim().split("\n")[0] || `exit ${res.code}`);
  return { status: "error", detail: `unreachable: ${firstLine}` };
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
  // Without the Command Line Tools, git is the xcode-select shim: it fails
  // and raises Apple's install dialog on every probe.
  if (!(await gitUsable(p.exec))) {
    return row({ ...base, status: "missing", detail: "needs Apple's Command Line Tools first (see the tool row), then re-check", action: RECHECK_ACTION });
  }

  const outcome = await lsRemoteOutcome(p, remote, await forgeTokenFor(remote, secrets));
  const action = outcome.status === "ready" ? null : RECHECK_ACTION;
  return row({ ...base, status: outcome.status, detail: outcome.detail, action });
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
  const outcome = await lsRemoteOutcome(p, `https://${identity}.git`);
  return row({ ...base, status: outcome.status, detail: outcome.detail });
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
