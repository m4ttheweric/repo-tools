#!/usr/bin/env bun

/**
 * rt sandbox — cloud dev environments for herd tickets (mattcloud slice 2).
 *
 * Usage:
 *   rt sandbox create [--ticket CV-XXXX | --branch <name>] [--job <dir>]
 *                     [--flags <k=v>...] [--image <tag>] [--json]
 *                     [--evidence-before <caseId>:<view>:<recipe>[:k=v,...]]...
 *   rt sandbox ls [--json]              all sandboxes + local port state
 *   rt sandbox status [<id>] [--json]   detail incl. container readiness
 *   rt sandbox suspend|resume|destroy <id>
 *   rt sandbox answer <id> [<file>]     deliver answer.md via the mailbox
 *   rt sandbox logs <id> <container> [kubectl-logs args...]
 *   rt sandbox flags <id> <k=v>...      upsert the LD fallback Secret (recycle to apply)
 *
 * Exit codes follow rt validate: 0 ok / 2 controller-or-plumbing failure /
 * 64 usage. The daemon owns port-forwards, dev-ports state mirroring, and
 * event → notification fan-out (lib/sandbox-allocator.ts); these verbs talk
 * to the controller and print its ground truth.
 *
 * CLUSTER-VERIFY PENDING: the controller's sandbox half (mattcloud Task 4)
 * is not deployed anywhere yet; every HTTP/kubectl leg here is exercised
 * only by unit tests with injected fakes until the bring-up (plan Task 8).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { MC_ENV_HELP, resolveBaseRef, resolveRepoId, spawnGitPush } from "../lib/validate-farm.ts";
import { probeController, requireEndpoints } from "./validate.ts";
import { repoDataDir, sandboxAnchorDir } from "../lib/rt-paths.ts";
import {
  createSandboxClient,
  createSandboxFlow,
  findSandboxAnchor,
  parseEvidenceBeforeSpecs,
  parseFlagValues,
  readSandboxAnchor,
  readSandboxConfig,
  removeSandboxAnchor,
  resolveSandboxId,
  sandboxLogsArgv,
  sandboxPickerCandidates,
  sandboxPickerRow,
  upsertFlagsSecret,
  type EvidenceBeforeEntry,
  type SandboxClient,
  type SandboxDetail,
  type SandboxEvent,
  type SandboxPickerVerb,
} from "../lib/sandbox.ts";
import { loadSecrets, fetchTicket } from "../lib/linear.ts";
import { loadBranchNamingConfig, resolveBranchName } from "../lib/branch-naming.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function usageExit(message: string): never {
  console.error(`\n  ${red}${message}${reset}\n`);
  process.exit(64);
}

function helpExit(): never {
  console.log(`
  ${bold}rt sandbox create${reset} [--ticket CV-XXXX | --branch <name>] [--job <dir>] [--flags k=v...] [--image <tag>] [--account <secret-key>] [--attended --tui-account <key>] [--agent-env NAME=value]... [--evidence-before <caseId>:<view>:<recipe>[:k=v,...]]... [--json]
      push branch to the receiver, create the cloud sandbox, anchor it locally;
      a --branch missing locally is created from the default branch head (with a notice);
      --evidence-before (repeatable, max 10) queues before-slot captures with the create;
      --account picks the agent-credentials Secret key (billing identity);
      --attended boots an in-pod herdr server + sshd instead of the lane supervisor
      (attended lanes may omit --job/--ticket: briefless attended is the operator's session);
      --tui-account picks whose TUI credentials land in the pod (excludes --account);
      --agent-env NAME=value (repeatable) sets per-lane agent env (reserved names rejected)
  ${bold}rt sandbox ls${reset} [--json] / ${bold}status${reset} [<id>] [--json]
      controller ground truth + local ports (pool warnings are loud here)
  ${bold}rt sandbox suspend|resume|destroy${reset} [<id>]
      suspend keeps the workspace, drops compute; destroy prunes everything
  ${bold}rt sandbox attach${reset} [<id>] [--exec]   attended lanes: pin the mc-<shortid> ssh alias
      to the daemon's 2422 forward and print (or exec) herdr --remote mc-<shortid>
  ${bold}rt sandbox answer${reset} <id> [<file>]     answer.md via mailbox (stdin when no file)
  ${bold}rt sandbox events${reset} [<id>] [--since <seq>] [--json]
      controller event log (lane state, questions, captures); one line per event
  ${bold}rt sandbox steer${reset} [<id>] [<file>]    steer.md via mailbox (stdin when no file);
      the lane supervisor injects it at the next turn boundary;
      omitting <id> on these verbs opens a picker of actionable sandboxes
  ${bold}rt sandbox logs${reset} <id> <container> [args...]
  ${bold}rt sandbox flags${reset} <id> k=v...        LD fallback Secret; pod recycle applies it

  ${bold}Env${reset}
${MC_ENV_HELP}
`);
  process.exit(0);
}

/** Resolve the farm repoId from the worktree's origin, or exit 64. */
function requireRepoId(ctx: CommandContext): string {
  const repoId = resolveRepoId(ctx.identity!.remoteUrl);
  if (!repoId) {
    usageExit(
      `no farm overlay claims this repo's origin — create ~/.rt/repos/<repoId>/repo.jsonc with { "origin": "${ctx.identity!.remoteUrl}" }`,
    );
  }
  return repoId;
}

/** Fail with 2 (infra) when the controller is unreachable. */
async function requireController(): Promise<void> {
  if (!(await probeController())) {
    console.error(`\n  ${red}controller unreachable${reset}`);
    console.error(`  ${dim}is the mattcloud cluster up? (MC_CONTROLLER_URL overrides; the daemon or rt validate can hold port-forwards)${reset}\n`);
    process.exit(2);
  }
}

function requireId(args: string[], verb: string): string {
  const id = args.find(a => !a.startsWith("--"));
  if (!id) usageExit(`usage: rt sandbox ${verb} <id>`);
  return id;
}

/** Calm empty-picker messages, one per verb — say what would be actionable. */
const PICKER_EMPTY: Record<SandboxPickerVerb, string> = {
  attach: "no running attended lanes to attach — create one with rt sandbox create --attended --tui-account <key>",
  events: "no sandboxes",
  steer: "no running headless lanes to steer",
  suspend: "no running sandboxes to suspend",
  resume: "no suspended sandboxes to resume",
  destroy: "no sandboxes to destroy",
};

/**
 * The no-arg fallback (RT-23): an fzf picker over the sandboxes this verb can
 * act on. Returns the selected full id — from here the verb proceeds exactly
 * as if the id had been typed. Esc/cancel exits 0 with a calm message, like
 * every other rt picker. Interactive seam: the pure parts (candidate filters,
 * row shape) live in lib/sandbox.ts with tests; this stays thin.
 */
async function pickSandboxId(verb: SandboxPickerVerb): Promise<string> {
  await requireController();
  let all: SandboxDetail[];
  try {
    all = await createSandboxClient().list();
  } catch (err) {
    infraExit(err);
  }
  const candidates = sandboxPickerCandidates(all, verb);
  if (candidates.length === 0) {
    console.log(`\n  ${dim}${PICKER_EMPTY[verb]}${reset}\n`);
    process.exit(0);
  }
  const { runNavPicker } = await import("../lib/navigate.ts");
  const now = Date.now();
  const result = await runNavPicker({
    options: candidates.map(d => sandboxPickerRow(d, now)),
    message: `rt sandbox ${verb}`,
  });
  if (!result?.value || result.key === "ctrl-up") {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    process.exit(0);
  }
  return result.value;
}

function infraExit(err: unknown): never {
  console.error(`\n  ${red}sandbox pipeline failed${reset}`);
  console.error(`  ${dim}${err instanceof Error ? err.message : String(err)}${reset}\n`);
  process.exit(2);
}

/**
 * The shared resolve-and-exit dance for id-taking verbs (RT-24): resolve a
 * typed full-or-prefix id against controller ground truth before any client
 * call, so short ids work on the whole verb family, not just attach.
 * Picker-selected ids (RT-23) are already full and re-resolve as exact hits.
 */
export async function resolveSandboxOrExit(
  client: SandboxClient,
  idOrPrefix: string,
): Promise<SandboxDetail> {
  let resolved: Awaited<ReturnType<typeof resolveSandboxId>>;
  try {
    resolved = await resolveSandboxId(client, idOrPrefix);
  } catch (err) {
    infraExit(err);
  }
  if (!resolved.ok) {
    console.error(`\n  ${red}${resolved.message}${reset}\n`);
    process.exit(64);
  }
  return resolved.detail;
}

// ─── rt sandbox create ───────────────────────────────────────────────────────

const CREDENTIAL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const AGENT_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_AGENT_ENV = new Set([
  "SANDBOX_ID", "SANDBOX_PORTS_JSON", "SANDBOX_STATE_FILE", "DOPPLER_ENV_FILE",
  "HOME", "CLAUDE_CODE_OAUTH_TOKEN", "IS_SANDBOX", "CONTROLLER_URL",
]);

/** Pull --account / --agent-env / --attended / --tui-account out of a create argv; everything else lands in rest. */
export function parseAgentSelection(
  args: string[],
): { rest: string[]; agentCredentialKey?: string; agentEnv?: Record<string, string>; attended?: boolean; tuiCredentialKey?: string } | { error: string } {
  const rest: string[] = [];
  let agentCredentialKey: string | undefined;
  let agentEnv: Record<string, string> | undefined;
  let attended = false;
  let tuiCredentialKey: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--account") {
      const value = args[++i];
      if (!value || !CREDENTIAL_KEY_RE.test(value)) return { error: `--account: invalid secret key ${value ?? "(missing)"}` };
      agentCredentialKey = value;
    } else if (arg === "--attended") {
      attended = true;
    } else if (arg === "--tui-account") {
      const value = args[++i];
      if (!value || !CREDENTIAL_KEY_RE.test(value)) return { error: `--tui-account: invalid secret key ${value ?? "(missing)"}` };
      tuiCredentialKey = value;
    } else if (arg === "--agent-env") {
      const value = args[++i];
      const eq = value?.indexOf("=") ?? -1;
      if (!value || eq < 1) return { error: `--agent-env: expected NAME=value, got ${value ?? "(missing)"}` };
      const name = value.slice(0, eq);
      if (!AGENT_ENV_NAME_RE.test(name)) return { error: `--agent-env: invalid name ${name}` };
      if (RESERVED_AGENT_ENV.has(name)) return { error: `--agent-env: ${name} is reserved` };
      (agentEnv ??= {})[name] = value.slice(eq + 1);
    } else {
      rest.push(arg);
    }
  }
  // Mirror the controller's attended-lane validation so a bad combination
  // dies here with a friendly message instead of a 400.
  if (attended && !tuiCredentialKey) return { error: "--attended lanes need a TUI account — pass --tui-account <secret-key>" };
  if (tuiCredentialKey && !attended) return { error: "--tui-account only applies to attended lanes — pass --attended" };
  if (attended && agentCredentialKey) return { error: "one auth mode per lane — --attended (TUI credentials) excludes --account (env token)" };
  return {
    rest,
    ...(agentCredentialKey ? { agentCredentialKey } : {}),
    ...(agentEnv ? { agentEnv } : {}),
    ...(attended ? { attended } : {}),
    ...(tuiCredentialKey ? { tuiCredentialKey } : {}),
  };
}

/**
 * Attended lanes may omit the brief — briefless attended is the operator's
 * own session (the pod seeds an empty job.md); headless creates still need
 * one, since the lane agent has nothing else to work from.
 */
export function requireBrief(brief: string | null, attended: boolean): { brief: string } | { error: string } {
  if (brief !== null) return { brief };
  if (attended) return { brief: "" };
  return { error: "no brief — pass --job <dir> (job.md) or --ticket (only attended lanes may omit both)" };
}

export async function createCommand(args: string[], ctx: CommandContext): Promise<void> {
  const selection = parseAgentSelection(args);
  if ("error" in selection) usageExit(selection.error);
  let ticket: string | null = null;
  let branch: string | null = null;
  let branchFlag = false;
  let jobDir: string | null = null;
  let imageTag: string | null = null;
  let json = false;
  const flagPairs: string[] = [];
  const evidenceBeforeSpecs: string[] = [];
  const rest = selection.rest;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--json") json = true;
    else if (arg === "--ticket") { ticket = rest[++i] ?? null; if (!ticket) usageExit("--ticket requires an id"); }
    else if (arg === "--branch") { branch = rest[++i] ?? null; if (!branch) usageExit("--branch requires a name"); branchFlag = true; }
    else if (arg === "--job") { jobDir = rest[++i] ?? null; if (!jobDir) usageExit("--job requires a directory"); }
    else if (arg === "--image") { imageTag = rest[++i] ?? null; if (!imageTag) usageExit("--image requires a tag"); }
    else if (arg === "--flags") { const pair = rest[++i]; if (!pair) usageExit("--flags requires k=v"); flagPairs.push(pair); }
    else if (arg === "--evidence-before") { const spec = rest[++i]; if (!spec) usageExit("--evidence-before requires <caseId>:<view>:<recipe>[:k=v,...]"); evidenceBeforeSpecs.push(spec); }
    else usageExit(`unknown argument: ${arg}`);
  }
  if (ticket && branch) usageExit("--ticket and --branch are mutually exclusive");
  let evidenceBefore: EvidenceBeforeEntry[] = [];
  try {
    evidenceBefore = parseEvidenceBeforeSpecs(evidenceBeforeSpecs);
  } catch (err) {
    usageExit((err as Error).message);
  }

  const repoId = requireRepoId(ctx);
  if (!readSandboxConfig(repoId)) {
    usageExit(
      `overlay ~/.rt/repos/${repoId}/sandbox.jsonc is missing — declare processes (name/port/localPorts) and stateFile first`,
    );
  }

  // Branch + brief. --ticket reuses the provisioning path: Linear lookup +
  // the repo's branch-naming template.
  let brief: string | null = null;
  if (ticket) {
    const apiKey = loadSecrets().linearApiKey;
    if (!apiKey) usageExit("--ticket needs a Linear API key (rt settings linear)");
    const fetched = await fetchTicket(apiKey, ticket);
    if (!fetched) usageExit(`Linear ticket ${ticket} not found`);
    branch = await resolveBranchName(fetched, loadBranchNamingConfig(repoDataDir(repoId)));
    brief = `${fetched.identifier}: ${fetched.title}\n\n${fetched.description ?? ""}`.trim();
  }
  if (jobDir) {
    const jobPath = join(jobDir, "job.md");
    if (!existsSync(jobPath)) usageExit(`no job.md in ${jobDir}`);
    brief = readFileSync(jobPath, "utf8");
  }
  if (!branch) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    } catch { /* fall through to the usage error */ }
    if (!branch || branch === "HEAD") usageExit("no branch given and HEAD is detached — pass --branch or --ticket");
  }
  const briefed = requireBrief(brief, selection.attended ?? false);
  if ("error" in briefed) usageExit(briefed.error);
  brief = briefed.brief;

  let endpoints: { stop: () => void } | null = null;
  try {
    endpoints = await requireEndpoints();
    if (!endpoints) process.exit(2);
    // The flow resolves refs/heads/<branch> itself and aborts when it does
    // not exist; the --ticket path seeds a fresh branch from the base ref
    // (design: "a fresh ticket branch is just master's tree"), and an
    // explicit --branch that is missing locally is created from it
    // (MAT-273 — scratch/acceptance sessions; never a remote touch).
    const out = await createSandboxFlow({
      repoId,
      branch,
      cwd: process.cwd(),
      brief,
      ...(ticket ? { fallbackRef: resolveBaseRef(repoId, process.cwd()) } : {}),
      ...(branchFlag ? { createBranchFromRef: resolveBaseRef(repoId, process.cwd()) } : {}),
      ...(imageTag ? { imageTag } : {}),
      ...(flagPairs.length ? { flags: parseFlagValues(flagPairs) } : {}),
      ...(evidenceBefore.length ? { evidenceBefore } : {}),
      ...(selection.agentCredentialKey ? { agentCredentialKey: selection.agentCredentialKey } : {}),
      ...(selection.agentEnv ? { agentEnv: selection.agentEnv } : {}),
      ...(selection.attended ? { attended: selection.attended } : {}),
      ...(selection.tuiCredentialKey ? { tuiCredentialKey: selection.tuiCredentialKey } : {}),
      client: createSandboxClient(),
      spawn: spawnGitPush,
    });
    if (!out.ok) {
      console.error(`\n  ${red}${out.message}${reset}\n`);
      process.exit(2);
    }
    const anchorDir = sandboxAnchorDir(repoId, out.sandboxId);
    if (json) {
      console.log(JSON.stringify({
        sandboxId: out.sandboxId, repoId, branch, anchorDir,
        ...(out.branchCreatedFrom ? { branchCreatedFrom: out.branchCreatedFrom } : {}),
      }, null, 2));
    } else {
      if (out.branchCreatedFrom) {
        console.log(`\n  ${yellow}branch ${branch} did not exist locally — created from ${out.branchCreatedFrom}${reset}`);
      }
      console.log(`\n  ${green}✓${reset} sandbox ${bold}${out.sandboxId}${reset} creating on ${cyan}${branch}${reset}`);
      console.log(`  ${dim}anchor ${anchorDir}${reset}`);
      console.log(`  ${dim}watch with${reset} ${bold}rt sandbox status ${out.sandboxId}${reset}\n`);
    }
  } catch (err) {
    infraExit(err);
  } finally {
    endpoints?.stop();
  }
}

// ─── rt sandbox ls / status ──────────────────────────────────────────────────

function readinessSummary(detail: SandboxDetail): string {
  if (!detail.containers?.length) return "";
  const ready = detail.containers.filter(c => c.ready).length;
  return `${ready}/${detail.containers.length} ready`;
}

/** One sandbox's local view: allocation + loud pool warning when present. */
function localView(detail: SandboxDetail): { ports?: Record<string, number>; warning?: string } {
  const anchor = readSandboxAnchor(detail.repoId, detail.id);
  return {
    ...(anchor?.localPorts ? { ports: anchor.localPorts } : {}),
    ...(anchor?.allocationError ? { warning: anchor.allocationError } : {}),
  };
}

function printDetailLine(detail: SandboxDetail): void {
  const local = localView(detail);
  const ports = local.ports
    ? Object.entries(local.ports).map(([name, port]) => `${name}:${port}`).join(" ")
    : "";
  console.log(
    `  ${bold}${detail.id}${reset}  ${cyan}${detail.branch}${reset}  ${detail.state}` +
    `${detail.podPhase ? ` ${dim}(${detail.podPhase}${readinessSummary(detail) ? `, ${readinessSummary(detail)}` : ""})${reset}` : ""}` +
    `${ports ? `  ${dim}${ports}${reset}` : ""}`,
  );
  if (local.warning) console.log(`    ${red}⚠ ${local.warning}${reset}`);
}

export async function lsCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  await requireController();
  let all: SandboxDetail[];
  try {
    all = await createSandboxClient().list();
  } catch (err) {
    infraExit(err);
  }
  if (json) {
    console.log(JSON.stringify(all.map(d => ({ ...d, local: localView(d) })), null, 2));
    return;
  }
  if (all.length === 0) {
    console.log(`\n  ${dim}no sandboxes${reset}\n`);
    return;
  }
  console.log("");
  for (const detail of all) printDetailLine(detail);
  console.log("");
}

export async function statusCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const id = args.find(a => !a.startsWith("--"));
  if (!id) return lsCommand(args);

  await requireController();
  let detail: SandboxDetail | null;
  try {
    detail = await createSandboxClient().get(id);
  } catch (err) {
    infraExit(err);
  }
  if (!detail) {
    console.error(`\n  ${red}sandbox ${id} not found${reset}\n`);
    process.exit(64);
  }
  const local = localView(detail);
  if (json) {
    console.log(JSON.stringify({ ...detail, local }, null, 2));
    return;
  }
  console.log(`\n  ${bold}${detail.id}${reset}  ${cyan}${detail.branch}${reset}  ${dim}${detail.repoId} · ${detail.imageTag}${reset}`);
  console.log(`  state ${bold}${detail.state}${reset}${detail.podPhase ? ` ${dim}(pod ${detail.podPhase})${reset}` : ""}`);
  for (const c of detail.containers ?? []) {
    console.log(`    ${c.ready ? `${green}✓${reset}` : `${yellow}…${reset}`} ${c.name}`);
  }
  if (local.ports) {
    console.log(`  local ports ${dim}${Object.entries(local.ports).map(([n, p]) => `${n}:${p}`).join("  ")}${reset}`);
  }
  if (local.warning) console.log(`  ${red}⚠ ${local.warning}${reset}`);
  console.log("");
}

// ─── rt sandbox suspend / resume / destroy ───────────────────────────────────

/**
 * Resolve a typed full-or-prefix id, then dispatch one lifecycle action;
 * returns the full id the controller saw. Exported seam: the RT-24
 * regression pins that a typed short id reaches the controller resolved.
 */
export async function dispatchLifecycle(
  client: SandboxClient,
  verb: "suspend" | "resume" | "destroy",
  idOrPrefix: string,
): Promise<string> {
  const { id } = await resolveSandboxOrExit(client, idOrPrefix);
  if (verb === "suspend") await client.suspend(id);
  else if (verb === "resume") await client.up(id);
  else await client.destroy(id);
  return id;
}

/**
 * Resolve a typed full-or-prefix id, then post one mailbox file; the seam
 * answer and steer share (RT-24), pinned so the mailbox sees full ids only.
 */
export async function deliverMailbox(
  client: SandboxClient,
  idOrPrefix: string,
  file: { name: string; content: string },
): Promise<void> {
  const { id } = await resolveSandboxOrExit(client, idOrPrefix);
  await client.postMailbox(id, file);
}

async function lifecycleVerb(
  args: string[],
  verb: "suspend" | "resume" | "destroy",
): Promise<void> {
  // No id → picker filtered to what the verb can act on (RT-23).
  const typedId = args.find(a => !a.startsWith("--")) ?? await pickSandboxId(verb);
  await requireController();
  // Short ids welcome (RT-24): resolve before the lifecycle call, so the
  // messages and anchor cleanup below carry the full id too.
  let id: string;
  try {
    id = await dispatchLifecycle(createSandboxClient(), verb, typedId);
  } catch (err) {
    infraExit(err);
  }
  if (verb === "destroy") {
    const anchor = findSandboxAnchor(id);
    if (anchor) removeSandboxAnchor(anchor.repoId, id);
    console.log(`\n  ${green}✓${reset} sandbox ${id} destroyed — PVC, Secrets, and receiver refs pruned by the controller\n`);
    return;
  }
  console.log(
    verb === "suspend"
      ? `\n  ${green}✓${reset} sandbox ${id} suspending — compute drops to zero, workspace kept; local forwards release within a few seconds\n`
      : `\n  ${green}✓${reset} sandbox ${id} resuming — the daemon re-establishes forwards when the pod is ready\n`,
  );
}

export async function suspendCommand(args: string[]): Promise<void> {
  await lifecycleVerb(args, "suspend");
}

export async function resumeCommand(args: string[]): Promise<void> {
  await lifecycleVerb(args, "resume");
}

export async function destroyCommand(args: string[]): Promise<void> {
  await lifecycleVerb(args, "destroy");
}

// ─── rt sandbox answer ───────────────────────────────────────────────────────

export async function answerCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  const [id, file] = positional;
  if (!id) usageExit("usage: rt sandbox answer <id> [<file>]");

  let content: string;
  if (file) {
    if (!existsSync(file)) usageExit(`no such file: ${file}`);
    content = readFileSync(file, "utf8");
  } else {
    if (process.stdin.isTTY) usageExit("no file given and stdin is a TTY — pipe the answer or pass a file");
    content = await new Response(Bun.stdin.stream()).text();
  }
  if (!content.trim()) usageExit("refusing to deliver an empty answer.md");

  await requireController();
  try {
    await deliverMailbox(createSandboxClient(), id, { name: "answer.md", content });
  } catch (err) {
    infraExit(err);
  }
  console.log(`\n  ${green}✓${reset} answer.md queued — the watcher materializes it and consumes question.md\n`);
}

// ─── rt sandbox events / steer ───────────────────────────────────────────────

/**
 * Pure argv parse for `rt sandbox events`, exported for tests.
 * A missing id is not an error: `id: null` signals the no-arg picker
 * fallback (RT-23).
 */
export function parseEventsArgs(
  args: string[],
): { id: string | null; since: number; json: boolean } | { error: string } {
  let id: string | undefined, since = 0, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--since") {
      const v = args[++i];
      if (!v || !/^\d+$/.test(v)) return { error: `--since: integer seq required, got ${v ?? "(missing)"}` };
      since = Number(v);
    } else if (!arg.startsWith("--") && !id) id = arg;
    else return { error: `unknown argument: ${arg}` };
  }
  return { id: id ?? null, since, json };
}

/** One human line per event; exported for tests. */
export function renderSandboxEvent(event: SandboxEvent): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  let summary: string;
  switch (event.type) {
    case "question": summary = "question.md written — answer with rt sandbox answer"; break;
    case "report": summary = "report.md written"; break;
    case "blocked": summary = "blocked.md written"; break;
    case "process-dead": summary = `agent died (${p.reason ?? "unknown"}${p.exitCode !== undefined ? `, exit ${p.exitCode}` : ""})`; break;
    case "state": summary = `state -> ${p.state ?? "?"}${p.message ? `: ${p.message}` : ""}`; break;
    case "captured":
      if (p.file === "lane.json" && typeof p.content === "string") {
        try {
          const lane = JSON.parse(p.content) as { state?: string; turns?: number };
          summary = `lane: ${lane.state ?? "?"} (turn ${lane.turns ?? "?"})`;
          break;
        } catch { /* fall through to generic */ }
      }
      summary = `captured ${p.file ?? "?"}`;
      break;
    default: summary = `${event.type}${p.requestId ? ` ${p.requestId}` : ""}`;
  }
  return `[${event.seq}] ${event.ts} ${summary}`;
}

/**
 * Resolve a typed full-or-prefix id, then read the event log; the events
 * verb's client seam (RT-24), pinned so the query carries the full id.
 */
export async function fetchSandboxEvents(
  client: SandboxClient,
  idOrPrefix: string,
  since: number,
): Promise<SandboxEvent[]> {
  const { id } = await resolveSandboxOrExit(client, idOrPrefix);
  return client.events(id, since);
}

export async function eventsCommand(args: string[]): Promise<void> {
  const parsed = parseEventsArgs(args);
  if ("error" in parsed) usageExit(parsed.error);
  // No id → picker; --since/--json still apply to the selection.
  const id = parsed.id ?? await pickSandboxId("events");
  await requireController();
  try {
    const events = await fetchSandboxEvents(createSandboxClient(), id, parsed.since);
    if (parsed.json) console.log(JSON.stringify(events, null, 2));
    else for (const event of events) console.log(renderSandboxEvent(event));
  } catch (err) {
    infraExit(err);
  }
}

export async function steerCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  // No id → picker of steerable lanes; the steer body then comes from stdin
  // (fzf reads the keyboard from /dev/tty, so a piped stdin still pickers).
  const file = positional[1];
  const id = positional[0] ?? await pickSandboxId("steer");
  let content: string;
  if (file) {
    if (!existsSync(file)) usageExit(`no such file: ${file}`);
    content = readFileSync(file, "utf8");
  } else {
    if (process.stdin.isTTY) usageExit("no file given and stdin is a TTY — pipe the steer or pass a file");
    content = await new Response(Bun.stdin.stream()).text();
  }
  if (!content.trim()) usageExit("refusing to deliver an empty steer.md");
  await requireController();
  try {
    await deliverMailbox(createSandboxClient(), id, { name: "steer.md", content });
  } catch (err) {
    infraExit(err);
  }
  console.log(`\n  ${green}✓${reset} steer.md queued — the supervisor injects it at the next turn boundary (ack: lane.json steerAck)\n`);
}

// ─── rt sandbox logs ─────────────────────────────────────────────────────────

/**
 * Resolve a typed full-or-prefix id, then shape the kubectl-logs argv; the
 * logs verb's seam (RT-24) — the pod is named by the full id, so a raw
 * prefix would miss it just like the controller 404ed.
 */
export async function resolveSandboxLogsArgv(
  client: SandboxClient,
  idOrPrefix: string,
  container: string,
  extra: string[],
): Promise<string[]> {
  const { id } = await resolveSandboxOrExit(client, idOrPrefix);
  return sandboxLogsArgv(id, container, extra);
}

export async function logsCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  const [id, container, ...rest] = positional;
  if (!id || !container) usageExit("usage: rt sandbox logs <id> <container> [kubectl-logs args...]");
  // Flags after the container (e.g. -f, --tail) pass straight through.
  const extra = [...rest, ...args.filter(a => a.startsWith("--") && a !== "--json")];
  // Short ids welcome (RT-24): resolution needs controller ground truth even
  // though the logs themselves come from kubectl.
  await requireController();
  const argv = await resolveSandboxLogsArgv(createSandboxClient(), id, container, extra);
  const { kubectlEnv } = await import("../lib/cloud-secrets.ts");
  const proc = Bun.spawn(argv, {
    env: kubectlEnv(), stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await proc.exited);
}

// ─── rt sandbox ship ─────────────────────────────────────────────────────────

export async function shipCommand(args: string[], ctx: CommandContext): Promise<void> {
  const id = requireId(args, "ship");
  const repoId = requireRepoId(ctx);

  // Branch from the local anchor; a sandbox created elsewhere falls back to
  // the controller record.
  let branch = findSandboxAnchor(id)?.branch ?? null;
  if (!branch) {
    await requireController();
    try {
      branch = (await createSandboxClient().get(id))?.branch ?? null;
    } catch (err) {
      infraExit(err);
    }
    if (!branch) usageExit(`sandbox ${id} is unknown locally and to the controller`);
  }

  const { shipSandbox, runGit } = await import("../lib/sandbox-ship.ts");
  const { confirm } = await import("../lib/rt-render.tsx");
  const out = await shipSandbox({
    repoId,
    sandboxId: id,
    branch,
    baseRef: resolveBaseRef(repoId, process.cwd()),
    cwd: process.cwd(),
    git: runGit,
    confirm: async (summary) => {
      console.log(`\n  ${bold}${summary.branch}${reset} ${dim}(${summary.commit.slice(0, 12)} from sandbox ${id})${reset}\n`);
      if (summary.log) console.log(summary.log.split("\n").map(l => `  ${l}`).join("\n"));
      if (summary.diffstat) console.log(`\n${summary.diffstat.split("\n").map(l => `  ${dim}${l}${reset}`).join("\n")}\n`);
      return await confirm({
        message: `Push ${summary.branch} to origin under your identity?`,
        initialValue: false,
      });
    },
  });

  if (!out.ok) {
    console.error(`\n  ${red}✗ ${out.message}${reset}\n`);
    process.exit(2);
  }
  if (!out.pushed) {
    console.log(`\n  ${yellow}nothing pushed${reset} ${dim}— the branch stays on the receiver (refs/sandboxes/${id}/${branch})${reset}\n`);
    process.exit(1);
  }
  console.log(`\n  ${green}✓${reset} ${bold}${branch}${reset} pushed to origin under your local identity`);
  console.log(`  ${dim}continue with the normal local flow (MR creation / ship skill) from here${reset}\n`);
}

// ─── rt sandbox qa-tunnel ────────────────────────────────────────────────────

/** Resolve an sdm resource's local listener port from `sdm status`. */
async function resolveSdmListenerPort(resource: string): Promise<number> {
  const { getSdmSnapshot } = await import("../lib/sdm/core.ts");
  const snapshot = await getSdmSnapshot(true);
  const state = snapshot.resources.get(resource);
  if (!state) usageExit(`sdm knows no resource "${resource}" — check \`rt sdm status\``);
  if (!state.connected || !state.address) {
    usageExit(`sdm resource "${resource}" is not connected — connect it first (rt sdm)`);
  }
  const port = Number(state.address.split(":")[1]);
  if (!Number.isFinite(port)) usageExit(`sdm address "${state.address}" carries no local port`);
  return port;
}

export async function qaTunnelCommand(args: string[]): Promise<void> {
  let resource: string | null = null;
  let localPort: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--resource") { resource = args[++i] ?? null; if (!resource) usageExit("--resource requires a name"); }
    else if (arg === "--local-port") { localPort = Number(args[++i]); if (!Number.isFinite(localPort)) usageExit("--local-port requires a number"); }
    else if (arg.startsWith("--")) usageExit(`unknown argument: ${arg}`);
    else positional.push(arg);
  }
  const id = positional[0];
  if (!id) usageExit("usage: rt sandbox qa-tunnel <id> [--resource <name> | --local-port <n>]");
  if (localPort === null) {
    if (!resource) usageExit("pass --resource <sdm resource> or --local-port <n> for the local SDM listener");
    localPort = await resolveSdmListenerPort(resource);
  }

  const anchor = findSandboxAnchor(id);
  const overlay = anchor ? readSandboxConfig(anchor.repoId) : null;

  const { openQaTunnel, spawnTunnel } = await import("../lib/qa-tunnel.ts");
  const { probeLocalListener } = await import("../lib/sandbox-allocator.ts");
  const { notify } = await import("../lib/notifier.ts");
  const out = await openQaTunnel({
    sandboxId: id,
    repoId: anchor?.repoId ?? null,
    localPort,
    ...(overlay?.qaPostgresUrlTemplate ? { urlTemplate: overlay.qaPostgresUrlTemplate } : {}),
    probeListener: probeLocalListener,
    spawn: spawnTunnel,
    exec: (await import("../lib/cloud-secrets.ts")).spawnExec,
    onDeath: (code) => {
      notify("QA tunnel died", `sandbox ${id}: ssh -R exited ${code} — the in-pod backend will see DB errors`, undefined, "sandbox_qa_tunnel");
    },
  });
  if (!out.ok) {
    console.error(`\n  ${red}✗ ${out.message}${reset}\n`);
    process.exit(2);
  }

  console.log(`\n  ${green}✓${reset} QA tunnel up: 127.0.0.1:${localPort} ${dim}→${reset} ${bold}receiver.mc-system.svc:${out.clusterPort}${reset} ${dim}(in-cluster)${reset}`);
  console.log(`  POSTGRES_URL override ${dim}${out.postgresUrl}${reset}`);
  console.log(`  ${dim}recycle the pod (rt sandbox suspend ${id} && rt sandbox resume ${id}) to apply${reset}`);
  console.log(`  ${dim}the tunnel lives in this process and dies with your laptop session — Ctrl-C to close${reset}\n`);

  process.on("SIGINT", () => {
    out.handle.kill();
    console.log(`\n  ${dim}tunnel closed${reset}\n`);
    process.exit(0);
  });
  const code = await out.handle.exited;
  console.error(`\n  ${red}tunnel exited (${code}) — the in-pod backend will see DB errors until reopened${reset}\n`);
  process.exit(code === 0 ? 0 : 2);
}

// ─── rt sandbox attach ───────────────────────────────────────────────────────

/**
 * Pure argv parse for `rt sandbox attach`, exported for tests.
 * A missing id is not an error: `id: null` signals the no-arg picker
 * fallback (RT-23) — the command falls into an fzf picker of candidates.
 */
export function parseAttachArgs(args: string[]): { id: string | null; exec: boolean } | { error: string } {
  let id: string | undefined, exec = false;
  for (const arg of args) {
    if (arg === "--exec") exec = true;
    else if (!arg.startsWith("--") && !id) id = arg;
    else return { error: `unknown argument: ${arg}` };
  }
  return { id: id ?? null, exec };
}

export async function attachCommand(args: string[]): Promise<void> {
  const parsed = parseAttachArgs(args);
  if ("error" in parsed) usageExit(parsed.error);
  // No id → picker of attachable lanes; flags like --exec still apply.
  const id = parsed.id ?? await pickSandboxId("attach");

  await requireController();
  // Short ids welcome: resolve full-or-prefix against controller ground truth.
  const detail = await resolveSandboxOrExit(createSandboxClient(), id);

  const { prepareAttendedAttach } = await import("../lib/sandbox.ts");
  const { spawnExec } = await import("../lib/cloud-secrets.ts");
  const out = await prepareAttendedAttach({ sandboxId: detail.id, detail, exec: spawnExec });
  if (!out.ok) {
    console.error(`\n  ${red}✗ ${out.message}${reset}\n`);
    process.exit(2);
  }
  if (out.mintedKey) {
    console.log(`\n  ${yellow}⚠ attended ssh key freshly minted${reset} — this pod does not trust it yet:`);
    console.log(`    ${bold}rt cloud secrets sync-attended-key${reset} ${dim}then recycle the pod (suspend + resume)${reset}`);
  }
  if (parsed.exec) {
    const proc = Bun.spawn(out.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }
  console.log(`\n  ${green}✓${reset} ssh alias ${bold}${out.alias}${reset} ready ${dim}(~/.ssh/config, daemon-held forward)${reset}`);
  console.log(`  attach with ${bold}${out.command.join(" ")}${reset} ${dim}(or rerun with --exec)${reset}\n`);
}

// ─── rt cloud secrets sync-attended-key ──────────────────────────────────────

/**
 * Mint the attended keypair when missing and ship the pub half into the
 * attended-ssh-key Secret. Lives in this module (not commands/cloud.ts)
 * because the attended-lane machinery is sandbox-owned; the tree parks the
 * verb under `rt cloud secrets` beside its sibling syncs.
 */
export async function syncAttendedKeyCommand(_args: string[]): Promise<void> {
  const { ensureAttendedSshKey, attendedSshKeyPath } = await import("../lib/sandbox.ts");
  const { spawnExec, syncAttendedSshKey } = await import("../lib/cloud-secrets.ts");
  const key = await ensureAttendedSshKey({ exec: spawnExec });
  if (!key.ok) {
    console.error(`\n  ${red}✗ ${key.message}${reset}\n`);
    process.exit(1);
  }
  if (key.created) console.log(`\n  ${green}✓${reset} minted ${attendedSshKeyPath()} (ed25519, private half stays local)`);
  const outcome = await syncAttendedSshKey({ publicKey: key.publicKey });
  if (outcome.exitCode !== 0) {
    console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
    process.exit(outcome.exitCode);
  }
  console.log(`${key.created ? "" : "\n"}  ${green}✓${reset} ${outcome.message}`);
  console.log(`  ${dim}attended pods created from now on accept this key; existing pods need a recycle${reset}\n`);
}

// ─── rt sandbox flags ────────────────────────────────────────────────────────

/**
 * Resolve a typed full-or-prefix id, then upsert the LD fallback Secret; the
 * flags verb's seam (RT-24) — the Secret is named sandbox-<full id>-flags,
 * so a raw prefix would silently create a Secret no pod ever mounts.
 */
export async function upsertFlagsForSandbox(
  client: SandboxClient,
  idOrPrefix: string,
  flags: Record<string, unknown>,
  exec?: import("../lib/cloud-secrets.ts").Exec,
): Promise<{ exitCode: number; message: string }> {
  const { id } = await resolveSandboxOrExit(client, idOrPrefix);
  return upsertFlagsSecret({ sandboxId: id, flags, ...(exec ? { exec } : {}) });
}

export async function flagsCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  const [id, ...pairs] = positional;
  if (!id || pairs.length === 0) usageExit("usage: rt sandbox flags <id> <k=v>...");
  let flags: Record<string, unknown>;
  try {
    flags = parseFlagValues(pairs);
  } catch (err) {
    usageExit((err as Error).message);
  }
  await requireController();
  const outcome = await upsertFlagsForSandbox(createSandboxClient(), id, flags);
  if (outcome.exitCode !== 0) {
    console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
    process.exit(outcome.exitCode);
  }
  console.log(`\n  ${green}✓${reset} ${outcome.message}`);
  console.log(`  ${dim}caveat: the fallback file replaces LaunchDarkly — unlisted flags fall to code defaults${reset}\n`);
}
