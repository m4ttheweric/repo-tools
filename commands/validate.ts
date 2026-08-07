#!/usr/bin/env bun

/**
 * rt validate — the local door to the mattcloud validation farm.
 *
 * Usage:
 *   rt validate [--wait] [--manifest <path>]   snapshot → push → submit
 *                                              exit 0 farm-green / 1 red / 2 infra / 64 usage
 *   rt validate status [<runId>]               per-group results (defaults to the last run)
 *   rt validate logs <runId> <group>           a failed group's log from the controller
 *
 * The worktree's exact state (uncommitted edits included) is snapshotted
 * without touching HEAD/index (lib/snapshot.ts), pushed to the in-cluster
 * git receiver as refs/snapshots/<tree>, and submitted to the controller.
 *
 * CLUSTER-VERIFY PENDING: the controller/receiver are not deployed on any
 * reachable host yet. Everything past the snapshot is exercised only by
 * unit tests with injected fetch/exec fakes; the port-forward spawn, the
 * receiver push, and the HTTP shapes need a live-cluster pass (plan Task 9
 * step 5) before this command is trusted end-to-end.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { repoDataDir } from "../lib/rt-paths.ts";
import { snapshotWorktree } from "../lib/snapshot.ts";
import {
  controllerUrl,
  createControllerClient,
  ensureEndpoints,
  loadGateManifest,
  manifestHash,
  receiverRepoUrl,
  resolveRepoId,
  summarizeRun,
  verdictExitCode,
  type ControllerClient,
  type GroupResult,
  type Run,
} from "../lib/validate-farm.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function usageExit(message: string): never {
  console.error(`\n  ${red}${message}${reset}\n`);
  process.exit(64);
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

function lastRunPath(repoId: string): string {
  return join(repoDataDir(repoId), "validate.json");
}

function saveLastRun(repoId: string, runId: string): void {
  try {
    writeFileSync(lastRunPath(repoId), JSON.stringify({ lastRunId: runId }, null, 2));
  } catch (err) {
    console.error(`  ${dim}could not record last run id: ${(err as Error).message}${reset}`);
  }
}

function loadLastRun(repoId: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(lastRunPath(repoId), "utf8"));
    return typeof parsed.lastRunId === "string" ? parsed.lastRunId : null;
  } catch {
    return null;
  }
}

const STATUS_GLYPH: Record<GroupResult["status"], string> = {
  pass: `${green}✓${reset}`,
  fail: `${red}✗${reset}`,
  skipped: `${dim}-${reset}`,
  inherited: `${yellow}~${reset}`,
  infra: `${red}!${reset}`,
};

function groupLine(g: GroupResult): string {
  const label = g.status === "inherited" ? `${yellow}inherited (matches master baseline)${reset}`
    : g.status === "skipped" ? `${dim}skipped (when-clause)${reset}`
    : g.status === "fail" ? `${red}fail${reset}${g.logRef ? `  ${dim}rt validate logs <runId> ${g.name}${reset}` : ""}`
    : g.status === "infra" ? `${red}infra${reset}`
    : `${green}pass${reset}`;
  return `  ${STATUS_GLYPH[g.status]} ${g.name.padEnd(10)} ${label}`;
}

function printRun(run: Run): void {
  for (const g of run.groups) console.log(groupLine(g));
  console.log(`\n  ${bold}${summarizeRun(run)}${reset}\n`);
}

/** True when the controller answers /healthz. */
async function probeController(): Promise<boolean> {
  try {
    const res = await fetch(`${controllerUrl()}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Port-forwards for the command's lifetime when nothing already serves the
 * endpoints (the daemon may hold long-lived forwards later; this is the
 * fallback). Cluster-verify pending — only the "already up" path is
 * unit-tested.
 */
function spawnKubectlForwards(): { stop: () => void } {
  const specs: string[][] = [
    ["kubectl", "port-forward", "-n", "mc-system", "svc/controller", "8080:8080"],
    ["kubectl", "port-forward", "-n", "mc-system", "svc/receiver", "2222:2222"],
  ];
  const procs = specs.map(argv =>
    Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  );
  return {
    stop: () => {
      for (const p of procs) {
        try { p.kill(); } catch { /* already exited */ }
      }
    },
  };
}

async function requireEndpoints(): Promise<{ stop: () => void }> {
  const handle = await ensureEndpoints({
    probe: probeController,
    spawnForwards: spawnKubectlForwards,
  });
  if (handle.status === "unreachable") {
    console.error(`\n  ${red}controller unreachable at ${controllerUrl()}${reset}`);
    console.error(`  ${dim}is the mattcloud cluster up and kubectl pointed at it? (MC_CONTROLLER_URL overrides)${reset}\n`);
    process.exit(2);
  }
  return handle;
}

// ─── rt validate ─────────────────────────────────────────────────────────────

export async function validateCommand(args: string[], ctx: CommandContext): Promise<void> {
  let wait = false;
  let manifestPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--wait") wait = true;
    else if (arg === "--manifest") {
      manifestPath = args[++i] ?? null;
      if (!manifestPath) usageExit("--manifest requires a path");
    } else usageExit(`unknown argument: ${arg}`);
  }

  const repoId = requireRepoId(ctx);
  const path = manifestPath ?? join(repoDataDir(repoId), "gates.jsonc");
  if (!existsSync(path)) {
    usageExit(`no gate manifest at ${path} — create it or pass --manifest`);
  }
  const manifest = loadGateManifest(path);
  const hash = manifestHash(manifest);

  console.log(`\n  ${dim}snapshotting worktree…${reset}`);
  const snap = await snapshotWorktree(process.cwd());
  console.log(
    `  ${dim}tree ${snap.tree.slice(0, 12)} · ${snap.changedFiles.length} files changed vs merge-base ${snap.mergeBase.slice(0, 12)}${reset}`,
  );

  const endpoints = await requireEndpoints();

  // Push the snapshot commit to the receiver (incremental; the mirror
  // already has master's objects). No local ref is created.
  const pushUrl = receiverRepoUrl(repoId);
  const push = Bun.spawn(["git", "push", pushUrl, `${snap.commit}:refs/snapshots/${snap.tree}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const pushErr = await new Response(push.stderr as ReadableStream).text();
  if ((await push.exited) !== 0) {
    endpoints.stop();
    console.error(`\n  ${red}snapshot push to ${pushUrl} failed${reset}`);
    console.error(`  ${dim}${pushErr.trim()}${reset}\n`);
    process.exit(2);
  }

  const client = createControllerClient();
  const { runId, cached } = await client.submit({
    repoId,
    tree: snap.tree,
    manifestHash: hash,
    manifest,
    changedFiles: snap.changedFiles,
    mergeBase: snap.mergeBase,
  });
  saveLastRun(repoId, runId);

  console.log(`  ${bold}run ${runId}${reset}${cached ? ` ${green}(cached verdict — unchanged tree)${reset}` : ""}\n`);

  if (!wait && !cached) {
    endpoints.stop();
    console.log(`  ${dim}submitted — check with${reset} ${bold}rt validate status${reset}\n`);
    process.exit(0);
  }

  const finalRun = await pollUntilDone(client, runId);
  endpoints.stop();
  printRun(finalRun);
  process.exit(verdictExitCode(finalRun));
}

/** Poll the controller, printing each group's status transition once. */
async function pollUntilDone(client: ControllerClient, runId: string): Promise<Run> {
  const printed = new Map<string, string>();
  while (true) {
    const run = await client.getRun(runId);
    if (!run) {
      console.error(`\n  ${red}run ${runId} disappeared from the controller${reset}\n`);
      process.exit(2);
    }
    for (const g of run.groups) {
      if (printed.get(g.name) !== g.status) {
        printed.set(g.name, g.status);
        console.log(`  ${dim}${g.name} → ${g.status}${reset}`);
      }
    }
    if (run.status === "done" || run.status === "infra") return run;
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ─── rt validate status ──────────────────────────────────────────────────────

export async function statusCommand(args: string[], ctx: CommandContext): Promise<void> {
  const repoId = requireRepoId(ctx);
  const runId = args.find(a => !a.startsWith("--")) ?? loadLastRun(repoId);
  if (!runId) usageExit("no run id given and no previous run recorded — run `rt validate` first");

  if (!(await probeController())) {
    console.error(`\n  ${red}controller unreachable at ${controllerUrl()}${reset}\n`);
    process.exit(2);
  }
  const run = await createControllerClient().getRun(runId);
  if (!run) {
    console.error(`\n  ${red}run ${runId} not found${reset}\n`);
    process.exit(1);
  }

  console.log(`\n  ${bold}${cyan}run ${run.id}${reset} ${dim}(${run.status}, tree ${run.tree.slice(0, 12)})${reset}\n`);
  printRun(run);
  if (run.status === "done" || run.status === "infra") process.exit(verdictExitCode(run));
}

// ─── rt validate logs ────────────────────────────────────────────────────────

export async function logsCommand(args: string[], _ctx: CommandContext): Promise<void> {
  const positional = args.filter(a => !a.startsWith("--"));
  const [runId, group] = positional;
  if (!runId || !group) usageExit("usage: rt validate logs <runId> <group>");

  if (!(await probeController())) {
    console.error(`\n  ${red}controller unreachable at ${controllerUrl()}${reset}\n`);
    process.exit(2);
  }
  const log = await createControllerClient().getGroupLog(runId, group);
  if (log === null) {
    console.error(`\n  ${red}no log for group ${group} on run ${runId}${reset}\n`);
    process.exit(1);
  }
  process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
}
