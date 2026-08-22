/**
 * accounts-group validators — one `account.<integration>` row per integration
 * the team/packs actually declare, plus the owner-once `account.slack-app`
 * row that gates every other member's `account.slack` on one owner running
 * the Slack app creation flow first.
 *
 * Every status here comes straight from `IntegrationDef.validate`'s
 * three-valued result (RULING R-T4b) — "error" (couldn't determine) is never
 * remapped to "invalid" (the service rejected it), so a network hiccup can
 * never read as a bad credential.
 */

import type { Action, Integration, Row } from "../contract.ts";
import { row } from "../contract.ts";
import { integrationDef, type IntegrationDef, type ValidateCtx } from "../integrations.ts";
import type { SetupIntent } from "../intent.ts";
import type { Probes } from "../probes.ts";
import type { PackRequirements } from "../requirements.ts";
import type { TeamSnapshot } from "../team-settings.ts";

/** Reads user-scope secrets: the real implementation goes through lib/secrets/store.readSecret (null on NoAgeKeyError) plus staged values (staging.ts) — that wiring is a later task's job; validators only depend on this narrow shape. */
export interface SecretPresence {
  has(domain: string, key: string): Promise<string | null>;
}

const SLACK_OAUTH_ACTION: Action = { type: "oauth", label: "Connect", integration: "slack", verb: ["setup", "slack", "connect"] };

function connectAction(def: IntegrationDef): Action {
  return { type: "connect", label: "Connect", integration: def.id, fields: def.fields, ...(def.alternatives ? { alternatives: def.alternatives } : {}) };
}

/** `gh auth status` prints "Logged in to <host> as <user>" (older) or "... account <user>" (current) — either way the username is the token right after that verb. */
function parseGhUser(output: string): string | null {
  const match = output.match(/Logged in to \S+ (?:as|account) (\S+)/);
  return match ? match[1]! : null;
}

function ctxFor(id: Integration, team: TeamSnapshot): ValidateCtx {
  const host =
    id === "gitlab"
      ? team.integrations.forge?.provider === "gitlab"
        ? team.integrations.forge.host
        : null
      : id === "switchboard"
        ? (team.integrations.switchboard?.url ?? null)
        : null;
  return { host, team: { slug: team.slug, remote: team.remote }, linearTeamKey: team.integrations.linear?.teamKey ?? null };
}

/** declared = forge's own provider ∪ linear/slack/switchboard when the team has configured them ∪ every integration a pack (or a pack tool's connect field) names — first-seen order, deduped. */
function declaredIntegrations(team: TeamSnapshot, reqs: PackRequirements[]): Integration[] {
  const ids: Integration[] = [];
  const add = (id: Integration | undefined): void => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  if (team.integrations.forge) add(team.integrations.forge.provider);
  if (team.integrations.linear) add("linear");
  if (team.integrations.slack?.clientId) add("slack");
  if (team.integrations.switchboard) add("switchboard");
  for (const req of reqs) for (const id of req.integrations) add(id);
  for (const req of reqs) {
    for (const tool of req.tools) {
      if (tool.connect && "integration" in tool.connect) add(tool.connect.integration);
    }
  }
  return ids;
}

async function githubRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "optionalNote" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx): Promise<Row> {
  const stored = await secrets.has("rt", "githubToken");
  if (stored === null) {
    const ghStatus = await p.exec(["gh", "auth", "status"]);
    if (ghStatus.code === 0) {
      const user = parseGhUser(`${ghStatus.stdout}\n${ghStatus.stderr}`);
      return row({ ...base, status: "ready", detail: user ? `via gh (${user})` : "via gh" });
    }
    return row({ ...base, status: "missing", detail: "no GitHub account connected", action: connectAction(def) });
  }
  const result = await def.validate(p, stored, ctx);
  return row({ ...base, status: result.status, detail: result.detail });
}

async function slackRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "optionalNote" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx): Promise<Row> {
  const stored = await secrets.has("board", "slackUserToken");
  if (stored === null) return row({ ...base, status: "missing", detail: "no Slack account connected", action: SLACK_OAUTH_ACTION });
  const result = await def.validate(p, stored, ctx);
  return row({ ...base, status: result.status, detail: result.detail });
}

/** join redeems the switchboard token as part of accepting the invite — this row just confirms that happened rather than re-probing a health endpoint the redeem flow already exercised. */
async function switchboardRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "optionalNote" | "recheck">, def: IntegrationDef, secrets: SecretPresence, intent: SetupIntent | null, ctx: ValidateCtx): Promise<Row> {
  const stored = await secrets.has("rt", "switchboardToken");
  if (stored === null) return row({ ...base, status: "missing", detail: "no Switchboard token configured", action: connectAction(def) });
  if (intent?.mode === "join") return row({ ...base, status: "ready", detail: "redeemed during Join" });
  const result = await def.validate(p, stored, ctx);
  return row({ ...base, status: result.status, detail: result.detail });
}

async function genericRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "optionalNote" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx): Promise<Row> {
  if (!def.secret) {
    // CLI-owned session (doppler/ldcli) — rt holds no credential for it; validate() reaches the CLI directly.
    const result = await def.validate(p, "", ctx);
    return row({ ...base, status: result.status, detail: result.detail });
  }
  const stored = await secrets.has(def.secret.domain, def.secret.key);
  if (stored === null) return row({ ...base, status: "missing", detail: `no ${def.title} account connected`, action: connectAction(def) });
  const result = await def.validate(p, stored, ctx);
  return row({ ...base, status: result.status, detail: result.detail });
}

async function accountRowFor(p: Probes, id: Integration, team: TeamSnapshot, secrets: SecretPresence, intent: SetupIntent | null): Promise<Row> {
  let def: IntegrationDef;
  try {
    def = integrationDef(id);
  } catch (err) {
    return row({ id: `account.${id}`, kind: "account", title: id, why: "Declared by the team or a pack, but rt doesn't know this integration.", required: true, status: "error", detail: err instanceof Error ? err.message : String(err) });
  }

  const base = { id: `account.${id}`, kind: "account" as const, title: def.title, why: def.why(team.integrations.forge?.host ?? null), required: true };
  const ctx = ctxFor(id, team);

  if (id === "github") return githubRow(p, base, def, secrets, ctx);
  if (id === "slack") return slackRow(p, base, def, secrets, ctx);
  if (id === "switchboard") return switchboardRow(p, base, def, secrets, intent, ctx);
  return genericRow(p, base, def, secrets, ctx);
}

function slackAppRow(): Row {
  return row({
    id: "account.slack-app",
    kind: "account",
    title: "Slack app",
    why: "Your team needs its own Slack app before anyone can connect Slack — one owner creates it once.",
    required: true,
    status: "missing",
    detail: "the team has no Slack app yet",
    action: {
      type: "owner-once",
      label: "Create the team's Slack app…",
      integration: "slack",
      fields: [{ name: "configToken", label: "App configuration token", secret: true }],
    },
  });
}

export async function accountRows(p: Probes, team: TeamSnapshot, reqs: PackRequirements[], secrets: SecretPresence, intent: SetupIntent | null): Promise<Row[]> {
  const ids = declaredIntegrations(team, reqs);
  const wantsSlack = reqs.some((r) => r.integrations.includes("slack"));
  const slackAppNeeded = wantsSlack && !team.integrations.slack?.clientId && (intent === null || intent.mode === "create");

  const rows: Row[] = [];
  for (const id of ids) {
    if (id === "slack" && slackAppNeeded) rows.push(slackAppRow());
    rows.push(await accountRowFor(p, id, team, secrets, intent));
  }
  return rows;
}
