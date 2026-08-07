#!/usr/bin/env bun

/**
 * rt sandbox — cloud dev environments for herd tickets (mattcloud slice 2).
 *
 * Usage:
 *   rt sandbox create [--ticket CV-XXXX | --branch <name>] [--job <dir>]
 *                     [--flags <k=v>...] [--image <tag>] [--json]
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
  parseFlagValues,
  readSandboxAnchor,
  readSandboxConfig,
  removeSandboxAnchor,
  sandboxLogsArgv,
  upsertFlagsSecret,
  type SandboxDetail,
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
  ${bold}rt sandbox create${reset} [--ticket CV-XXXX | --branch <name>] [--job <dir>] [--flags k=v...] [--image <tag>] [--json]
      push branch to the receiver, create the cloud sandbox, anchor it locally
  ${bold}rt sandbox ls${reset} [--json] / ${bold}status${reset} [<id>] [--json]
      controller ground truth + local ports (pool warnings are loud here)
  ${bold}rt sandbox suspend|resume|destroy${reset} <id>
      suspend keeps the workspace, drops compute; destroy prunes everything
  ${bold}rt sandbox answer${reset} <id> [<file>]     answer.md via mailbox (stdin when no file)
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

function infraExit(err: unknown): never {
  console.error(`\n  ${red}sandbox pipeline failed${reset}`);
  console.error(`  ${dim}${err instanceof Error ? err.message : String(err)}${reset}\n`);
  process.exit(2);
}

// ─── rt sandbox create ───────────────────────────────────────────────────────

export async function createCommand(args: string[], ctx: CommandContext): Promise<void> {
  let ticket: string | null = null;
  let branch: string | null = null;
  let jobDir: string | null = null;
  let imageTag: string | null = null;
  let json = false;
  const flagPairs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--json") json = true;
    else if (arg === "--ticket") { ticket = args[++i] ?? null; if (!ticket) usageExit("--ticket requires an id"); }
    else if (arg === "--branch") { branch = args[++i] ?? null; if (!branch) usageExit("--branch requires a name"); }
    else if (arg === "--job") { jobDir = args[++i] ?? null; if (!jobDir) usageExit("--job requires a directory"); }
    else if (arg === "--image") { imageTag = args[++i] ?? null; if (!imageTag) usageExit("--image requires a tag"); }
    else if (arg === "--flags") { const pair = args[++i]; if (!pair) usageExit("--flags requires k=v"); flagPairs.push(pair); }
    else usageExit(`unknown argument: ${arg}`);
  }
  if (ticket && branch) usageExit("--ticket and --branch are mutually exclusive");

  const repoId = requireRepoId(ctx);
  if (!readSandboxConfig(repoId)) {
    usageExit(
      `overlay ~/.rt/repos/${repoId}/config.json has no "sandbox" section — declare processes (name/port/localPorts) and stateFile first`,
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
  if (!brief) usageExit("no brief — pass --job <dir> (job.md) or --ticket");

  // The branch head to hand the receiver; a fresh ticket branch is just the
  // base ref's tree (design: "a fresh ticket branch is just master's tree").
  let commit: string;
  try {
    commit = execFileSync("git", ["rev-parse", branch], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    try {
      commit = execFileSync("git", ["rev-parse", resolveBaseRef(repoId, process.cwd())], { cwd: process.cwd(), encoding: "utf8" }).trim();
    } catch (err) {
      infraExit(err);
    }
  }

  let endpoints: { stop: () => void } | null = null;
  try {
    endpoints = await requireEndpoints();
    if (!endpoints) process.exit(2);
    const out = await createSandboxFlow({
      repoId,
      branch,
      commit,
      cwd: process.cwd(),
      brief,
      ...(imageTag ? { imageTag } : {}),
      ...(flagPairs.length ? { flags: parseFlagValues(flagPairs) } : {}),
      client: createSandboxClient(),
      spawn: spawnGitPush,
    });
    if (!out.ok) {
      console.error(`\n  ${red}${out.message}${reset}\n`);
      process.exit(2);
    }
    const anchorDir = sandboxAnchorDir(repoId, out.sandboxId);
    if (json) {
      console.log(JSON.stringify({ sandboxId: out.sandboxId, repoId, branch, anchorDir }, null, 2));
    } else {
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

async function lifecycleVerb(
  args: string[],
  verb: "suspend" | "resume" | "destroy",
): Promise<void> {
  const id = requireId(args, verb);
  await requireController();
  const client = createSandboxClient();
  try {
    if (verb === "suspend") await client.suspend(id);
    else if (verb === "resume") await client.up(id);
    else await client.destroy(id);
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
    await createSandboxClient().postMailbox(id, { name: "answer.md", content });
  } catch (err) {
    infraExit(err);
  }
  console.log(`\n  ${green}✓${reset} answer.md queued — the watcher materializes it and consumes question.md\n`);
}

// ─── rt sandbox logs ─────────────────────────────────────────────────────────

export async function logsCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  const [id, container, ...rest] = positional;
  if (!id || !container) usageExit("usage: rt sandbox logs <id> <container> [kubectl-logs args...]");
  // Flags after the container (e.g. -f, --tail) pass straight through.
  const extra = [...rest, ...args.filter(a => a.startsWith("--") && a !== "--json")];
  const proc = Bun.spawn(sandboxLogsArgv(id, container, extra), {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
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

/** True when something accepts a TCP connection on 127.0.0.1:port. */
async function probeLocalListener(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) { clearTimeout(timer); socket.end(); resolve(true); },
        error() { clearTimeout(timer); resolve(false); },
        data() {},
        close() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

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
  const { notify } = await import("../lib/notifier.ts");
  const out = await openQaTunnel({
    sandboxId: id,
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

// ─── rt sandbox flags ────────────────────────────────────────────────────────

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
  const outcome = await upsertFlagsSecret({ sandboxId: id, flags });
  if (outcome.exitCode !== 0) {
    console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
    process.exit(outcome.exitCode);
  }
  console.log(`\n  ${green}✓${reset} ${outcome.message}`);
  console.log(`  ${dim}caveat: the fallback file replaces LaunchDarkly — unlisted flags fall to code defaults${reset}\n`);
}
