/**
 * Plan composer — concatenates the four validator groups (mac, accounts,
 * access, tools) into one `Plan`, then applies one id-keyed post-pass for
 * rows only Install itself can satisfy (perm.login-items, tool.daemon,
 * pack.*): required:false in plan mode (so canInstall stays reachable
 * pre-install), required:true in status mode (so a real post-install gap
 * still blocks). The validators emit one fixed shape each — this is the one
 * place that flips it, so a row is never flipped twice.
 */

import { join } from "path";
import type { DaemonResponse } from "../daemon-client.ts";
import { createRealAgeKeySeam } from "../home/age-key.ts";
import { createRealSecretsExecSeam, NoAgeKeyError, readSecret, type SecretsSeams } from "../secrets/store.ts";
import { listTeams } from "../settings/stores.ts";
import { finalizePlan, GROUP_TITLES, row, type Group, type GroupId, type Plan, type Row, type TeamRef } from "./contract.ts";
import { readIntent, teamRefFromIntent, type SetupIntent } from "./intent.ts";
import { fetchPermissions, permissionRows } from "./permissions.ts";
import { createRealProbes, type Probes } from "./probes.ts";
import { readPackRequirements } from "./requirements.ts";
import { stagingDir } from "./staging.ts";
import { forgeFromRemote, readTeamSnapshot, type TeamSnapshot } from "./team-settings.ts";
import { accessRows } from "./validators/access.ts";
import { accountRows, type SecretPresence } from "./validators/accounts.ts";
import { macRows } from "./validators/mac.ts";
import { rtHealthRows } from "./validators/rt-health.ts";
import { toolRows } from "./validators/tools.ts";

export interface PlanInputs {
  p: Probes;
  secrets: SecretPresence;
  ci: boolean;
  mode: "plan" | "status";
  teamOverride?: string;
}

const EMPTY_SNAPSHOT: TeamSnapshot = { slug: "", integrations: {}, trackingIdentities: [], marketplaces: [], plugins: [], remote: null };

function resolveTeam(intent: SetupIntent | null, teams: string[], teamOverride: string | undefined): TeamRef {
  if (teamOverride && teams.includes(teamOverride)) return { slug: teamOverride, name: teamOverride, mode: "none" };
  return teamRefFromIntent(intent, teams);
}

/** Before the team's home repo exists to record it, a create/join intent already knows the forge (from its own remote) — the one signal declaredIntegrations() has no other way to see. */
function enrichSnapshotForge(snapshot: TeamSnapshot, intent: SetupIntent | null): TeamSnapshot {
  if (snapshot.integrations.forge) return snapshot;
  const remote = intent?.mode === "create" ? intent.team?.remote : intent?.mode === "join" ? intent.join?.pointer.remote : null;
  if (!remote) return snapshot;
  const forge = forgeFromRemote(remote);
  if (!forge) return snapshot;
  return { ...snapshot, integrations: { ...snapshot.integrations, forge } };
}

function tccSummary(res: DaemonResponse | null): { blocked: number; total: number } | null {
  if (!res?.ok) return null;
  const data = res.data as { blocked?: unknown[]; totalRepos?: number } | undefined;
  if (!data || !Array.isArray(data.blocked) || typeof data.totalRepos !== "number") return null;
  return { blocked: data.blocked.length, total: data.totalRepos };
}

async function detectHasBrew(p: Probes): Promise<boolean> {
  const res = await p.exec(["brew", "--version"]);
  return res.code === 0;
}

/** A validator group throwing (a bug, an unexpected shape) must degrade to one honest error row, never take the whole plan down. */
async function buildGroup(id: GroupId, build: () => Promise<Row[]>): Promise<Group> {
  try {
    return { id, title: GROUP_TITLES[id], rows: await build() };
  } catch (err) {
    return {
      id,
      title: GROUP_TITLES[id],
      rows: [
        row({
          id: `${id}.group-error`,
          kind: "info",
          title: GROUP_TITLES[id],
          why: "This group's checks could not complete.",
          required: false,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        }),
      ],
    };
  }
}

const INSTALL_SATISFIED_IDS = new Set(["perm.login-items", "tool.daemon"]);
const INSTALL_SATISFIED_NOTE = "Installed by Install.";

function isInstallSatisfied(id: string): boolean {
  return INSTALL_SATISFIED_IDS.has(id) || id.startsWith("pack.");
}

/** The id-keyed set of rows only Install itself can satisfy reads required:false pre-install (canInstall stays reachable) and required:true once `setup status` runs post-install. */
function applyInstallSatisfiedFlip(groups: Group[], mode: "plan" | "status"): Group[] {
  return groups.map((g) => ({
    ...g,
    rows: g.rows.map((r) => {
      if (!isInstallSatisfied(r.id)) return r;
      if (mode === "status") return { ...r, required: true, optionalNote: null };
      return { ...r, required: false, optionalNote: r.optionalNote ?? INSTALL_SATISFIED_NOTE };
    }),
  }));
}

export async function composePlan(i: PlanInputs): Promise<Plan> {
  const intent = readIntent(i.p);
  const teams = listTeams();
  const team = resolveTeam(intent, teams, i.teamOverride);

  const snapshot = enrichSnapshotForge(team.slug ? readTeamSnapshot(i.p, team.slug) : EMPTY_SNAPSHOT, intent);
  const reqs = readPackRequirements(i.p, team.slug);

  const groups = await Promise.all([
    buildGroup("mac", async () => {
      const [permReply, tccRes, macList] = await Promise.all([fetchPermissions(i.p.tray), i.p.daemon("tcc:check"), macRows(i.p)]);
      return [...permissionRows(permReply, tccSummary(tccRes)), ...macList];
    }),
    buildGroup("accounts", () => accountRows(i.p, snapshot, reqs, i.secrets, intent)),
    buildGroup("access", () => accessRows(i.p, snapshot, intent)),
    buildGroup("tools", async () => {
      const [hasBrew, healthRows] = await Promise.all([detectHasBrew(i.p), rtHealthRows(i.p, { ci: i.ci })]);
      const tools = await toolRows(i.p, reqs, { hasBrew });
      return [...tools, ...healthRows];
    }),
  ]);

  return finalizePlan(team, applyInstallSatisfiedFlip(groups, i.mode), i.p.now());
}

/**
 * `has()` prefers the real sops store; a value staged during `rt setup`
 * (staging.ts) but not yet drained by `secrets.write` is the fallback, so a
 * credential the user just entered still reads as present before Install
 * runs. A provably absent age key (NoAgeKeyError) means "nothing decryptable
 * yet", not a failure — the staging fallback still applies.
 */
export function realSecretPresence(): SecretPresence {
  const seams: SecretsSeams = { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() };
  const p = createRealProbes();
  return {
    async has(domain, key) {
      try {
        const stored = await readSecret(domain, key, seams);
        if (stored !== null) return stored;
      } catch (err) {
        if (!(err instanceof NoAgeKeyError)) throw err;
      }
      const raw = p.readFile(join(stagingDir(p.home), `${domain}.json`));
      if (raw === null) return null;
      try {
        return (JSON.parse(raw) as Record<string, string>)[key] ?? null;
      } catch {
        return null;
      }
    },
  };
}
