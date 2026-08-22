/**
 * accounts-group validators — one `account.<integration>` row per integration
 * the team/packs actually declare, plus the owner-once `account.slack-app`
 * row that gates every other member's `account.slack` on one owner running
 * the Slack app creation flow first.
 *
 * `validate()`'s three-valued result is passed straight through to row
 * status — "error" (couldn't determine) is never remapped to "invalid" (the
 * service rejected it), so a network hiccup can never read as a bad
 * credential.
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

/** `def.alternatives` (github's `use-gh`) is only ever a real affordance when the probe behind it succeeded — attaching it unconditionally would offer "use your gh session" on exactly the row where there is no session to use. */
function connectAction(def: IntegrationDef, includeAlternatives: boolean): Action {
  return { type: "connect", label: "Connect", integration: def.id, fields: def.fields, ...(includeAlternatives && def.alternatives ? { alternatives: def.alternatives } : {}) };
}

function secretSpec(def: IntegrationDef): { domain: string; key: string } {
  if (!def.secret) throw new Error(`${def.id} has no secret spec — this integration is CLI-owned and must not reach a code path that reads one`);
  return def.secret;
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

/** why()'s teamHost only makes sense for the row whose OWN integration is the team's declared forge — a pack-declared `account.gitlab` under a github.com forge must not render "...on github.com". */
function whyHostFor(id: Integration, team: TeamSnapshot): string | null {
  return team.integrations.forge?.provider === id ? team.integrations.forge.host : null;
}

interface DeclaredEntry {
  id: Integration;
  required: boolean;
  optionalNote: string | null;
}

/**
 * declared = forge's own provider ∪ linear/slack/switchboard when the team
 * has configured them ∪ every integration a pack names directly ∪ every
 * integration a pack tool's connect field names — first-seen order.
 * Required-ness is derived from the declaring source (T8 precedent,
 * `tools.ts` team-tool rows: `required: !req.optional`): the forge, team
 * config, and `reqs[].integrations` are always required; an integration
 * named ONLY by an `optional: true` tool's connect field is not, and carries
 * that tool's own `why` as its optionalNote. A required source always wins
 * over an optional one regardless of processing order — `require()`
 * unconditionally overwrites, `addOptional()` only inserts when nothing has
 * claimed the id yet.
 */
function declaredIntegrations(team: TeamSnapshot, reqs: PackRequirements[]): DeclaredEntry[] {
  const entries = new Map<Integration, DeclaredEntry>();
  const require = (id: Integration | undefined): void => {
    if (id) entries.set(id, { id, required: true, optionalNote: null });
  };
  const addOptional = (id: Integration, why: string): void => {
    if (!entries.has(id)) entries.set(id, { id, required: false, optionalNote: `Works without this. ${why}` });
  };

  if (team.integrations.forge) require(team.integrations.forge.provider);
  if (team.integrations.linear) require("linear");
  if (team.integrations.slack?.clientId) require("slack");
  if (team.integrations.switchboard) require("switchboard");
  for (const req of reqs) for (const id of req.integrations) require(id);
  for (const req of reqs) {
    for (const tool of req.tools) {
      if (tool.connect && "integration" in tool.connect) {
        if (tool.optional) addOptional(tool.connect.integration, tool.why);
        else require(tool.connect.integration);
      }
    }
  }
  return [...entries.values()];
}

async function githubRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx): Promise<Row> {
  const spec = secretSpec(def);
  const stored = await secrets.has(spec.domain, spec.key);

  if (stored === null) {
    const ghStatus = await p.exec(["gh", "auth", "status"]);
    if (ghStatus.code === 0) {
      const user = parseGhUser(`${ghStatus.stdout}\n${ghStatus.stderr}`);
      return row({ ...base, status: "ready", detail: user ? `via gh (${user})` : "via gh" });
    }
    const detail = ghStatus.code === 127 ? "no GitHub account connected (gh CLI not installed)" : "no GitHub account connected";
    return row({ ...base, status: "missing", detail, action: connectAction(def, false) });
  }

  const result = await def.validate(p, stored, ctx);
  if (result.status === "ready") return row({ ...base, status: "ready", detail: result.detail });

  // A stored token that's now invalid/unreachable still needs a replaceable action — check whether a healthy
  // gh session sits right there before deciding whether "use gh instead" is an affordance that can actually work.
  const ghStatus = await p.exec(["gh", "auth", "status"]);
  return row({ ...base, status: result.status, detail: result.detail, action: connectAction(def, ghStatus.code === 0) });
}

/** The oauth Connect action only makes sense once the team's own Slack app exists (`clientId` set) — before that, this row explains the dependency on account.slack-app instead of offering a flow that would run against an app that doesn't exist yet. */
async function slackRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx, team: TeamSnapshot): Promise<Row> {
  if (!team.integrations.slack?.clientId) {
    return row({ ...base, status: "missing", detail: "waiting on the team's Slack app (see account.slack-app)" });
  }
  const spec = secretSpec(def);
  const stored = await secrets.has(spec.domain, spec.key);
  if (stored === null) return row({ ...base, status: "missing", detail: "no Slack account connected", action: SLACK_OAUTH_ACTION });
  const result = await def.validate(p, stored, ctx);
  if (result.status === "ready") return row({ ...base, status: "ready", detail: result.detail });
  return row({ ...base, status: result.status, detail: result.detail, action: SLACK_OAUTH_ACTION });
}

/** join redeems the switchboard token as part of accepting the invite — this row just confirms that happened rather than re-probing a health endpoint the redeem flow already exercised. */
async function switchboardRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "recheck">, def: IntegrationDef, secrets: SecretPresence, intent: SetupIntent | null, ctx: ValidateCtx): Promise<Row> {
  const spec = secretSpec(def);
  const stored = await secrets.has(spec.domain, spec.key);
  if (stored === null) return row({ ...base, status: "missing", detail: "no Switchboard token configured", action: connectAction(def, true) });
  if (intent?.mode === "join") return row({ ...base, status: "ready", detail: "redeemed during Join" });
  const result = await def.validate(p, stored, ctx);
  if (result.status === "ready") return row({ ...base, status: "ready", detail: result.detail });
  return row({ ...base, status: result.status, detail: result.detail, action: connectAction(def, true) });
}

async function genericRow(p: Probes, base: Omit<Row, "status" | "detail" | "action" | "recheck">, def: IntegrationDef, secrets: SecretPresence, ctx: ValidateCtx): Promise<Row> {
  if (!def.secret) {
    // CLI-owned session (doppler/ldcli) — rt holds no credential for it; validate() reaches the CLI directly.
    // No action here: the tools group already owns install/sign-in for this CLI (declaredIntegrations forces
    // required:false for these two ids specifically, so an action-less row is never a dead end).
    const result = await def.validate(p, "", ctx);
    return row({ ...base, status: result.status, detail: result.detail });
  }
  const stored = await secrets.has(def.secret.domain, def.secret.key);
  if (stored === null) return row({ ...base, status: "missing", detail: `no ${def.title} account connected`, action: connectAction(def, true) });
  const result = await def.validate(p, stored, ctx);
  if (result.status === "ready") return row({ ...base, status: "ready", detail: result.detail });
  return row({ ...base, status: result.status, detail: result.detail, action: connectAction(def, true) });
}

/** doppler/ldcli's real blocker (install + sign in) already has a required row in the tools group (tool.team.<name>) — a second required, action-less row here for the same fact would be both a duplicate and a dead end. */
const CLI_SESSION_OPTIONAL_NOTE = "Works without a stored credential here — install and sign in are tracked in the Tools group.";

async function accountRowFor(p: Probes, entry: DeclaredEntry, team: TeamSnapshot, secrets: SecretPresence, intent: SetupIntent | null): Promise<Row> {
  const { id } = entry;
  let def: IntegrationDef;
  try {
    def = integrationDef(id);
  } catch (err) {
    return row({ id: `account.${id}`, kind: "account", title: id, why: "Declared by the team or a pack, but rt doesn't know this integration.", required: true, status: "error", detail: err instanceof Error ? err.message : String(err) });
  }

  const cliOwned = !def.secret;
  const base = {
    id: `account.${id}`,
    kind: "account" as const,
    title: def.title,
    why: def.why(whyHostFor(id, team)),
    required: cliOwned ? false : entry.required,
    optionalNote: cliOwned ? CLI_SESSION_OPTIONAL_NOTE : entry.optionalNote,
  };
  const ctx = ctxFor(id, team);

  if (id === "github") return githubRow(p, base, def, secrets, ctx);
  if (id === "slack") return slackRow(p, base, def, secrets, ctx, team);
  if (id === "switchboard") return switchboardRow(p, base, def, secrets, intent, ctx);
  return genericRow(p, base, def, secrets, ctx);
}

const ACCOUNT_RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };

/** One entry's `secrets.has()`/`def.validate()` throwing (a bad recipient, a corrupt staged file, a network stack that throws instead of returning) must degrade to that entry's own error row — never take every other declared integration's row down with it. */
async function accountRowForSafe(p: Probes, entry: DeclaredEntry, team: TeamSnapshot, secrets: SecretPresence, intent: SetupIntent | null): Promise<Row> {
  try {
    return await accountRowFor(p, entry, team, secrets, intent);
  } catch (err) {
    return row({
      id: `account.${entry.id}`,
      kind: "account",
      title: entry.id,
      why: "This account's check could not complete.",
      required: entry.required,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
      action: ACCOUNT_RECHECK_ACTION,
    });
  }
}

function slackAppRow(required: boolean): Row {
  return row({
    id: "account.slack-app",
    kind: "account",
    title: "Slack app",
    why: "Your team needs its own Slack app before anyone can connect Slack — one owner creates it once.",
    required,
    optionalNote: required ? null : "Works without this until the team's Slack app exists — only the team's owner can create it; ask them, or re-check once it does.",
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
  const declared = declaredIntegrations(team, reqs);
  const wantsSlack = declared.some((e) => e.id === "slack");
  const slackAppNeeded = wantsSlack && !team.integrations.slack?.clientId;
  const slackAppRequired = intent?.mode === "create";

  const idRows = await Promise.all(declared.map((entry) => accountRowForSafe(p, entry, team, secrets, intent)));

  const rows: Row[] = [];
  declared.forEach((entry, i) => {
    if (entry.id === "slack" && slackAppNeeded) rows.push(slackAppRow(slackAppRequired));
    rows.push(idRows[i]!);
  });
  return rows;
}
