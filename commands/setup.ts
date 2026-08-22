/**
 * rt setup plan|status — the readiness checklist the mattstack.app installer
 * (and a human running rt directly) reads before Install runs.
 *
 *   rt setup plan [--team <name>] [--json]     pre-install: canInstall reachable
 *   rt setup status [--json]                   post-install health view
 *
 * rt setup <integration> status|connect + rt setup slack create-app — the
 * per-integration verbs the app spawns when a user clicks a row's action.
 * Each mutating verb funnels through one `UserActionableError` → exit-2
 * envelope path (`exitWithUserError`); everything else is a bug and throws.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { readAgeKey, createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { promptSecret } from "../lib/prompt-secret.ts";
import { NoAgeKeyError, createRealSecretsExecSeam, readSecret, writeSecret, type SecretsSeams } from "../lib/secrets/store.ts";
import { listTeams } from "../lib/settings/stores.ts";
import { setSetting } from "../lib/settings/write.ts";
import { envelope, type ConnectField, type Integration } from "../lib/setup/contract.ts";
import { UserActionableError, userErrorPayload } from "../lib/setup/errors.ts";
import { integrationDef, type ValidateCtx } from "../lib/setup/integrations.ts";
import { readIntent, teamRefFromIntent } from "../lib/setup/intent.ts";
import { composePlan, enrichSnapshotForge, realSecretPresence } from "../lib/setup/plan.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { DEFAULT_CALLBACK_PORT, DEFAULT_SCOPE_NEEDS, buildSlackManifest } from "../lib/setup/slack-app.ts";
import { stageSecret } from "../lib/setup/staging.ts";
import { readTeamSnapshot, type TeamSnapshot } from "../lib/setup/team-settings.ts";
import type { Plan, RowStatus } from "../lib/setup/contract.ts";
import type { SecretPresence } from "../lib/setup/validators/accounts.ts";

export interface SetupDeps {
  probes: Probes;
  secrets: SecretPresence;
  print: (s: string) => void;
  /** Optional: only the integration verbs below use it. Falls back to `process.exit` at the one call site that needs it. */
  exit?: (code: number) => never;
}

export function realSetupDeps(): SetupDeps {
  return { probes: createRealProbes(), secrets: realSecretPresence(), print: (s) => console.log(s), exit: process.exit };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const GLYPH: Record<RowStatus, string> = {
  ready: "✓",
  missing: "✗",
  invalid: "✗",
  error: "✗",
  "needs-you": "!",
  skipped: "–",
  checking: "…",
};

export function renderPlanHuman(plan: Plan): string[] {
  const lines: string[] = [];
  for (const group of plan.groups) {
    lines.push(group.title);
    for (const r of group.rows) lines.push(`  ${GLYPH[r.status]} ${r.title}  ${r.detail}`);
  }
  lines.push(plan.canInstall ? "Install: ready" : `Install: blocked by: ${plan.requiredMissing.join(", ")}`);
  return lines;
}

async function runPlan(args: string[], deps: SetupDeps, mode: "plan" | "status", verb: string, header?: string): Promise<void> {
  const json = args.includes("--json");
  let plan: Plan;
  try {
    plan = await composePlan({
      p: deps.probes,
      secrets: deps.secrets,
      ci: process.env.CI === "true",
      mode,
      teams: listTeams(),
      teamOverride: flagValue(args, "--team"),
    });
  } catch (err) {
    if (err instanceof UserActionableError) exitWithUserError(err, json, verb, deps);
    throw err;
  }

  if (json) {
    deps.print(JSON.stringify(plan));
    return;
  }
  if (header) deps.print(header);
  for (const line of renderPlanHuman(plan)) deps.print(line);
}

export async function setupPlan(args: string[], _ctx: CommandContext = {}, deps: SetupDeps = realSetupDeps()): Promise<void> {
  await runPlan(args, deps, "plan", "setup");
}

export async function setupStatus(args: string[], _ctx: CommandContext = {}, deps: SetupDeps = realSetupDeps()): Promise<void> {
  await runPlan(args, deps, "status", "setup", "rt setup status");
}

// Today this is the same health view `rt setup status` gives.
export const setupInteractive = setupStatus;

// ─── Per-integration verbs ─────────────────────────────────────────────────

/** Prints the exit-2 envelope (JSON or a one-line human message) then exits 2, through `deps.exit` so tests never kill the process. */
function exitWithUserError(err: UserActionableError, json: boolean, verb: string, deps: SetupDeps): never {
  deps.print(json ? JSON.stringify(userErrorPayload(err)) : `rt ${verb}: ${err.message}`);
  return (deps.exit ?? process.exit)(2);
}

/** Reads and writes user-scope credentials behind the age key: present → the real sops store; absent → the connect-verb caller stages instead. */
export interface SecretWriter {
  hasAgeKey(): Promise<boolean>;
  write(domain: "rt" | "board", key: string, value: string): Promise<void>;
}

export function realSecretWriter(): SecretWriter {
  const seams: SecretsSeams = { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() };
  return {
    async hasAgeKey() {
      return "key" in (await readAgeKey(seams.ageKeySeam));
    },
    async write(domain, key, value) {
      await writeSecret(domain, key, value, seams);
    },
  };
}

/**
 * Team-scoped secrets (Slack's client/signing secret, a future shared service
 * token). Backed today by the same single-recipient sops store `SecretWriter`
 * uses, keyed under a team-qualified domain — correct for the current
 * single-operator machine and swappable behind this same interface once a
 * real multi-recipient team store exists.
 */
export interface TeamSecrets {
  read(slug: string, domain: "rt" | "board", key: string): Promise<string | null>;
  write(slug: string, domain: "rt" | "board", key: string, value: string): Promise<void>;
}

function teamScopedDomain(slug: string, domain: string): string {
  return `team-${slug}-${domain}`;
}

export function realTeamSecrets(): TeamSecrets {
  const seams: SecretsSeams = { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() };
  return {
    async read(slug, domain, key) {
      try {
        return await readSecret(teamScopedDomain(slug, domain), key, seams);
      } catch (err) {
        if (err instanceof NoAgeKeyError) return null;
        throw err;
      }
    },
    async write(slug, domain, key, value) {
      await writeSecret(teamScopedDomain(slug, domain), key, value, seams);
    },
  };
}

export interface ConnectDeps extends SetupDeps {
  exit: (code: number) => never;
  /** Reads the full stdin body: valid JSON parses to its value; anything else (a bare token line) comes back as the trimmed raw string; empty stdin is null. Never throws. */
  stdin: () => Promise<unknown>;
  isTTY: () => boolean;
  promptField: (field: ConnectField) => Promise<string>;
  writer: SecretWriter;
  teamSecrets: TeamSecrets;
  writeSetting: typeof setSetting;
  /** Opens one OAuth callback listener on `port` and resolves with the `code` query param from the first request. */
  listen: (port: number) => Promise<string>;
}

async function readSmartStdin(): Promise<unknown> {
  const text = (await new Response(Bun.stdin.stream()).text()).trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function realOAuthListen(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port,
      fetch(req) {
        const code = new URL(req.url).searchParams.get("code");
        setTimeout(() => server.stop(), 0);
        if (code) resolve(code);
        else reject(new Error("slack callback request carried no code"));
        return new Response("You can close this tab and return to rt.");
      },
    });
  });
}

export function realConnectDeps(): ConnectDeps {
  return {
    ...realSetupDeps(),
    exit: process.exit,
    stdin: readSmartStdin,
    isTTY: () => process.stdin.isTTY === true,
    promptField: (field) => promptSecret(field.label),
    writer: realSecretWriter(),
    teamSecrets: realTeamSecrets(),
    writeSetting: setSetting,
    listen: realOAuthListen,
  };
}

const EMPTY_SNAPSHOT: TeamSnapshot = { slug: "", integrations: {}, trackingIdentities: [], marketplaces: [], plugins: [], remote: null };

/** Mirrors composePlan's own team resolution (readIntent → teamRefFromIntent → readTeamSnapshot → forge enrichment) without the `--team` override these single-integration verbs don't take. */
function resolveTeamSnapshot(p: Probes): TeamSnapshot {
  const intent = readIntent(p);
  const ref = teamRefFromIntent(intent, listTeams());
  const snapshot = ref.slug ? readTeamSnapshot(p, ref.slug) : EMPTY_SNAPSHOT;
  return enrichSnapshotForge(snapshot, intent);
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function printIntegrationResult(deps: SetupDeps, json: boolean, body: Record<string, unknown>): void {
  if (json) {
    deps.print(JSON.stringify(envelope(body, deps.probes.now())));
    return;
  }
  deps.print(`${body.integration}: ${body.status} — ${body.detail}`);
}

// ─── status ─────────────────────────────────────────────────────────────

type IntegrationRowStatus = "ready" | "missing" | "invalid";

interface IntegrationEval {
  status: IntegrationRowStatus;
  detail: string;
  scopesSeen: string[];
  handle?: string;
  owners?: string[];
}

/** Narrows a validate() result to the two-valued row status, throwing the honest exit-2 error for the third ("error" = couldn't determine, never reported as a row status). */
function nonErrorEval(r: { status: "ready" | "invalid" | "error"; detail: string; scopesSeen: string[] }): IntegrationEval {
  if (r.status === "error") throw new UserActionableError("unreachable", r.detail);
  return { status: r.status, detail: r.detail, scopesSeen: r.scopesSeen };
}

function parseLogin(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { login?: unknown };
    return typeof parsed.login === "string" ? parsed.login : null;
  } catch {
    return null;
  }
}

function parseOrgLogins(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is { login: string } => typeof (o as { login?: unknown })?.login === "string").map((o) => o.login);
  } catch {
    return [];
  }
}

/** Handle/owners come from a live `gh` session regardless of which credential source produced the row's own status — a stored token and a gh session are independent facts. */
async function evalGithub(p: Probes, secrets: SecretPresence, ctx: ValidateCtx): Promise<IntegrationEval> {
  const def = integrationDef("github");
  const ghStatus = await p.exec(["gh", "auth", "status"]);
  const ghAuthed = ghStatus.code === 0;
  const stored = await secrets.has("rt", "githubToken");

  let base: IntegrationEval;
  if (stored === null) {
    base = ghAuthed
      ? { status: "ready", detail: "via gh", scopesSeen: [] }
      : { status: "missing", detail: ghStatus.code === 127 ? "no GitHub account connected (gh CLI not installed)" : "no GitHub account connected", scopesSeen: [] };
  } else {
    base = nonErrorEval(await def.validate(p, stored, ctx));
  }

  if (!ghAuthed) return base;
  const userRes = await p.exec(["gh", "api", "user"]);
  const handle = userRes.code === 0 ? parseLogin(userRes.stdout) : null;
  if (!handle) return base;
  const orgsRes = await p.exec(["gh", "api", "user/orgs"]);
  return { ...base, handle, owners: [handle, ...parseOrgLogins(orgsRes.stdout)] };
}

async function evalSlack(p: Probes, secrets: SecretPresence, snapshot: TeamSnapshot): Promise<IntegrationEval> {
  const def = integrationDef("slack");
  if (!snapshot.integrations.slack?.clientId) {
    return { status: "missing", detail: "waiting on the team's Slack app (see account.slack-app)", scopesSeen: [] };
  }
  const stored = await secrets.has(def.secret!.domain, def.secret!.key);
  if (stored === null) return { status: "missing", detail: "no Slack account connected", scopesSeen: [] };
  return nonErrorEval(await def.validate(p, stored, ctxFor("slack", snapshot)));
}

async function evalGeneric(id: Integration, p: Probes, secrets: SecretPresence, ctx: ValidateCtx): Promise<IntegrationEval> {
  const def = integrationDef(id);
  if (!def.secret) {
    return nonErrorEval(await def.validate(p, "", ctx));
  }
  const stored = await secrets.has(def.secret.domain, def.secret.key);
  if (stored === null) return { status: "missing", detail: `no ${def.title} account connected`, scopesSeen: [] };
  return nonErrorEval(await def.validate(p, stored, ctx));
}

export async function integrationStatus(id: Integration, args: string[], deps: SetupDeps): Promise<void> {
  const json = args.includes("--json");
  const verb = `setup ${id} status`;
  try {
    const snapshot = resolveTeamSnapshot(deps.probes);
    const ctx = ctxFor(id, snapshot);
    const r =
      id === "github" ? await evalGithub(deps.probes, deps.secrets, ctx)
      : id === "slack" ? await evalSlack(deps.probes, deps.secrets, snapshot)
      : await evalGeneric(id, deps.probes, deps.secrets, ctx);

    const body: Record<string, unknown> = { integration: id, status: r.status, detail: r.detail, scopesSeen: r.scopesSeen };
    if (r.handle) body.handle = r.handle;
    if (r.owners) body.owners = r.owners;
    printIntegrationResult(deps, json, body);
  } catch (err) {
    if (err instanceof UserActionableError) return exitWithUserError(err, json, verb, deps);
    throw err;
  }
}

// ─── connect ────────────────────────────────────────────────────────────

async function ghAuthToken(p: Probes): Promise<string> {
  const res = await p.exec(["gh", "auth", "token"]);
  if (res.code !== 0) throw new UserActionableError("gh-token-failed", "gh auth token failed — run `gh auth login` first");
  return res.stdout.trim();
}

async function storeCredential(deps: ConnectDeps, domain: "rt" | "board", key: string, value: string): Promise<{ staged: boolean }> {
  if (await deps.writer.hasAgeKey()) {
    await deps.writer.write(domain, key, value);
    return { staged: false };
  }
  stageSecret(deps.probes, domain, key, value);
  return { staged: true };
}

async function resolveFieldValue(def: { fields: ConnectField[] }, input: unknown, deps: ConnectDeps): Promise<string> {
  const field = def.fields[0];
  if (typeof input === "string" && input.trim() !== "") return input.trim();
  if (isPlainObject(input) && field) {
    const v = input[field.name];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  if (input === null && field) {
    if (deps.isTTY()) return deps.promptField(field);
    throw new UserActionableError("bad-stdin", `no ${field.label} provided — pipe JSON on stdin, or run interactively`);
  }
  throw new UserActionableError("bad-stdin", "stdin did not contain a recognizable credential");
}

async function connectCredential(id: Integration, args: string[], deps: ConnectDeps): Promise<void> {
  const def = integrationDef(id);
  const ctx = ctxFor(id, resolveTeamSnapshot(deps.probes));

  let value: string;
  let sourceDetail: string | null = null;

  if (id === "github" && args.includes("--use-gh")) {
    value = await ghAuthToken(deps.probes);
    sourceDetail = "via gh";
  } else {
    const input = await deps.stdin();
    if (id === "github" && isPlainObject(input) && input.useGh === true) {
      value = await ghAuthToken(deps.probes);
      sourceDetail = "via gh";
    } else {
      value = await resolveFieldValue(def, input, deps);
    }
  }

  const result = await def.validate(deps.probes, value, ctx);
  if (result.status === "invalid") throw new UserActionableError("invalid-credential", result.detail);
  if (result.status === "error") throw new UserActionableError("unreachable", result.detail);

  let staged = false;
  if (def.secret) {
    staged = (await storeCredential(deps, def.secret.domain, def.secret.key, value)).staged;
  }

  const detail = staged
    ? sourceDetail
      ? `${sourceDetail} — staged until Install creates your key`
      : "staged until Install creates your key"
    : (sourceDetail ?? result.detail);

  printIntegrationResult(deps, args.includes("--json"), { integration: id, status: "ready", detail, scopesSeen: result.scopesSeen });
}

async function connectCliSession(id: "doppler" | "ldcli", args: string[], deps: ConnectDeps): Promise<void> {
  await deps.probes.exec(id === "doppler" ? ["doppler", "login"] : ["ldcli", "login"], { inherit: true });
  const def = integrationDef(id);
  const ctx = ctxFor(id, resolveTeamSnapshot(deps.probes));
  const result = await def.validate(deps.probes, "", ctx);
  if (result.status === "invalid") throw new UserActionableError("invalid-credential", result.detail);
  if (result.status === "error") throw new UserActionableError("unreachable", result.detail);
  printIntegrationResult(deps, args.includes("--json"), { integration: id, status: "ready", detail: result.detail, scopesSeen: result.scopesSeen });
}

async function connectSlack(args: string[], deps: ConnectDeps): Promise<void> {
  const snapshot = resolveTeamSnapshot(deps.probes);
  const clientId = snapshot.integrations.slack?.clientId;
  if (!clientId) throw new UserActionableError("slack-app-missing", "your team has no Slack app yet — its owner needs to create one first");

  const callbackPort = snapshot.integrations.slack?.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${callbackPort}/callback`;
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&user_scope=${encodeURIComponent(DEFAULT_SCOPE_NEEDS.user.join(","))}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  await deps.probes.exec(["open", authUrl]);
  const code = await deps.listen(callbackPort);

  const clientSecret = await deps.teamSecrets.read(snapshot.slug, "board", "slackClientSecret");
  if (!clientSecret) throw new UserActionableError("slack-app-missing", "the team's Slack app credentials are missing — recreate the app");

  const tokenRes = await deps.probes.fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
  });
  if (tokenRes.status === 0) throw new UserActionableError("unreachable", "couldn't reach slack.com — check your network or proxy");

  let data: { ok?: boolean; error?: string; authed_user?: { access_token?: string } };
  try {
    data = JSON.parse(tokenRes.body);
  } catch {
    throw new UserActionableError("unreachable", "slack oauth.v2.access returned unparsable JSON");
  }
  const accessToken = data.ok ? data.authed_user?.access_token : undefined;
  if (!accessToken) throw new UserActionableError("invalid-credential", data.error ? `slack error: ${data.error}` : "slack oauth.v2.access returned no user token");

  const { staged } = await storeCredential(deps, "board", "slackUserToken", accessToken);
  printIntegrationResult(deps, args.includes("--json"), {
    integration: "slack",
    status: "ready",
    detail: staged ? "staged until Install creates your key" : "slack connected",
    scopesSeen: [],
  });
}

export async function integrationConnect(id: Integration, args: string[], deps: ConnectDeps): Promise<void> {
  const json = args.includes("--json");
  const verb = `setup ${id} connect`;
  try {
    if (id === "slack") return await connectSlack(args, deps);
    if (id === "doppler" || id === "ldcli") return await connectCliSession(id, args, deps);
    return await connectCredential(id, args, deps);
  } catch (err) {
    if (err instanceof UserActionableError) return exitWithUserError(err, json, verb, deps);
    throw err;
  }
}

export const setupGithubStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("github", a, d);
export const setupGithubConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("github", a, d);
export const setupGitlabStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("gitlab", a, d);
export const setupGitlabConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("gitlab", a, d);
export const setupLinearStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("linear", a, d);
export const setupLinearConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("linear", a, d);
export const setupSlackStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("slack", a, d);
export const setupSlackConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("slack", a, d);
export const setupSwitchboardStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("switchboard", a, d);
export const setupSwitchboardConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("switchboard", a, d);
export const setupSdmStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("sdm", a, d);
export const setupSdmConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("sdm", a, d);
export const setupDopplerStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("doppler", a, d);
export const setupDopplerConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("doppler", a, d);
export const setupLdcliStatus = (a: string[], _c?: CommandContext, d: SetupDeps = realConnectDeps()) => integrationStatus("ldcli", a, d);
export const setupLdcliConnect = (a: string[], _c?: CommandContext, d: ConnectDeps = realConnectDeps()) => integrationConnect("ldcli", a, d);

// ─── slack create-app ───────────────────────────────────────────────────

interface SlackManifestResponse {
  ok?: boolean;
  error?: string;
  app_id?: string;
  credentials?: { client_id: string; client_secret: string; signing_secret: string };
}

function parseManifestResponse(body: string, status: number): SlackManifestResponse {
  try {
    return JSON.parse(body);
  } catch {
    return { ok: false, error: `slack apps.manifest.create returned unparsable JSON (status ${status})` };
  }
}

async function readConfigToken(deps: ConnectDeps): Promise<string> {
  const input = await deps.stdin();
  if (typeof input === "string" && input.trim() !== "") return input.trim();
  if (isPlainObject(input) && typeof input.configToken === "string" && input.configToken.trim() !== "") return input.configToken;
  if (input === null) {
    if (deps.isTTY()) return deps.promptField({ name: "configToken", label: "App configuration token", secret: true });
    throw new UserActionableError("bad-stdin", "no Slack app configuration token provided on stdin");
  }
  throw new UserActionableError("bad-stdin", "stdin did not contain a recognizable configuration token");
}

export async function setupSlackCreateApp(args: string[], _ctx: CommandContext = {}, deps: ConnectDeps = realConnectDeps()): Promise<void> {
  const json = args.includes("--json");
  const verb = "setup slack create-app";
  try {
    const configToken = await readConfigToken(deps);
    const snapshot = resolveTeamSnapshot(deps.probes);
    if (!snapshot.slug) throw new UserActionableError("unknown-team", "no team to create a Slack app for — set up your team first");

    const callbackPort = snapshot.integrations.slack?.callbackPort ?? DEFAULT_CALLBACK_PORT;
    const manifest = buildSlackManifest({ name: `mattstack (${snapshot.slug})`, callbackPort, scopes: DEFAULT_SCOPE_NEEDS });

    const res = await deps.probes.fetch("https://slack.com/api/apps.manifest.create", {
      method: "POST",
      headers: { Authorization: `Bearer ${configToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    if (res.status === 0) throw new UserActionableError("unreachable", "couldn't reach slack.com — check your network or proxy");

    const data = parseManifestResponse(res.body, res.status);
    if (!data.ok || !data.credentials || !data.app_id) {
      throw new UserActionableError("slack-manifest-failed", data.error ?? `slack apps.manifest.create returned ok:false (status ${res.status})`);
    }

    deps.writeSetting(
      "mattstack.integrations",
      { slack: { appId: data.app_id, clientId: data.credentials.client_id, callbackPort } },
      "team",
      { team: snapshot.slug },
    );
    await deps.teamSecrets.write(snapshot.slug, "board", "slackClientSecret", data.credentials.client_secret);
    await deps.teamSecrets.write(snapshot.slug, "board", "slackSigningSecret", data.credentials.signing_secret);

    printIntegrationResult(deps, json, { integration: "slack", status: "ready", detail: "Slack app created", scopesSeen: [] });
  } catch (err) {
    if (err instanceof UserActionableError) return exitWithUserError(err, json, verb, deps);
    throw err;
  }
}
