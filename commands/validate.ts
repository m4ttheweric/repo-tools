#!/usr/bin/env bun

/**
 * rt validate — the local door to the mattcloud validation farm.
 *
 * Usage:
 *   rt validate [--wait] [--force] [--manifest <path>] [--json]
 *                                              snapshot → push → submit
 *                                              exit 0 farm-green / 1 red / 2 infra / 64 usage
 *   rt validate status [<runId>] [--json]      per-group results (defaults to the last run)
 *                                              exit as above, plus 3 still-in-flight / 64 run not found
 *   rt validate logs <runId> <group>           a failed group's log from the controller
 *   rt validate --help                         usage incl. the MC_* env vars (MC_ENV_HELP,
 *                                              lib/validate-farm.ts — documented only there)
 *
 * A farm-side failure (controller unreachable, HTTP error, poll failure, git
 * plumbing) always exits 2 — never 1, which the contract reserves for a red
 * code verdict. A missing default-branch ref exits 64 with the fix.
 *
 * --force sends `force: true` to the controller, which always creates a
 * fresh run — verdict-cache AND in-flight attach are skipped, and the
 * response is never `cached`.
 *
 * --json emits { run: { id, status, groups }, exitCode } for skills to
 * consume (same style as rt sdm / rt verify); progress chatter is suppressed
 * and errors stay on stderr. Infra groups carry `infraReason` (evicted,
 * oom-killed, disrupted, init-failed, create-failed, controller-restart) so
 * an eviction is distinguishable from a code failure. When the farm side
 * dies before a run shape exists, --json emits { error, exitCode } instead;
 * there is no no-JSON exit. The shape is unchanged by --force — it only
 * guarantees the run behind it is fresh.
 *
 * --wait survives tunnel loss: a failed poll re-establishes the kubectl
 * port-forwards with bounded retries, and only repeated failure gives up
 * (exit 2 with the `rt validate status <runId>` remedy).
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
import { kubectlEnv } from "../lib/cloud-secrets.ts";
import { snapshotWorktree } from "../lib/snapshot.ts";
import {
  MC_ENV_HELP,
  controllerUrl,
  createControllerClient,
  ensureEndpoints,
  failureExitCode,
  loadGateManifest,
  manifestHash,
  pollRunUntilDone,
  pushSnapshot,
  receiverSshRemedy,
  resolveBaseRef,
  resolveRepoId,
  runToJson,
  statusExitCode,
  summarizeRun,
  verdictExitCode,
  type GroupResult,
  type Run,
} from "../lib/validate-farm.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function usageExit(message: string): never {
  console.error(`\n  ${red}${message}${reset}\n`);
  process.exit(64);
}

function helpExit(): never {
  console.log(`
  ${bold}rt validate${reset} [--wait] [--force] [--manifest <path>] [--json]
      snapshot → push → submit; exit 0 farm-green / 1 red / 2 infra / 64 usage
  ${bold}rt validate status${reset} [<runId>] [--json]
      per-group results (defaults to the last run); exit as above, plus 3 in flight / 64 not found
  ${bold}rt validate logs${reset} <runId> <group>
      a failed group's log from the controller

  ${bold}Flags${reset}
    --wait      block until the farm verdict instead of returning after submit
    --force     always create a fresh run — skip the verdict-cache and in-flight attach
    --manifest  gate manifest path (default: the repo overlay's gates.jsonc)
    --json      machine-readable { run: { id, status, groups }, exitCode }

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

function groupLine(g: GroupResult, runId: string): string {
  const label = g.status === "inherited" ? `${yellow}inherited (matches master baseline)${reset}`
    : g.status === "skipped" ? `${dim}skipped (when-clause)${reset}`
    : g.status === "fail" ? `${red}fail${reset}${g.logRef ? `  ${dim}rt validate logs ${runId} ${g.name}${reset}` : ""}`
    : g.status === "infra" ? `${red}infra${reset}${g.infraReason ? ` ${yellow}(${g.infraReason}: not a code verdict)${reset}` : ""}${g.logRef ? `  ${dim}rt validate logs ${runId} ${g.name}${reset}` : ""}`
    : `${green}pass${reset}`;
  return `  ${STATUS_GLYPH[g.status]} ${g.name.padEnd(10)} ${label}`;
}

function printRun(run: Run): void {
  for (const g of run.groups) console.log(groupLine(g, run.id));
  console.log(`\n  ${bold}${summarizeRun(run)}${reset}\n`);
}

/** Machine shape shared by `rt validate --json` and `rt validate status --json`. */
function printRunJson(run: Run, exitCode: number): void {
  console.log(JSON.stringify(runToJson(run, exitCode), null, 2));
}

/**
 * A --json caller must always get JSON on stdout, even when the farm side
 * dies before a run shape exists (tunnel loss, unreachable controller, push
 * failure) -- a bare exit 2 is indistinguishable from a crash.
 */
function printErrorJson(message: string, exitCode: number): void {
  console.log(JSON.stringify({ error: message, exitCode }, null, 2));
}

/** True when the controller answers /healthz. (Shared with commands/sandbox.ts.) */
export async function probeController(): Promise<boolean> {
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
 * fallback). A process-exit backstop reaps the children even when the
 * command bails through process.exit before its finally runs.
 * Cluster-verify pending — only the "already up" path is unit-tested.
 */
function spawnKubectlForwards(): { stop: () => void } {
  const specs: string[][] = [
    ["kubectl", "port-forward", "-n", "mc-system", "svc/controller", "8080:8080"],
    ["kubectl", "port-forward", "-n", "mc-system", "svc/receiver", "2222:2222"],
  ];
  const procs = specs.map(argv =>
    Bun.spawn(argv, { env: kubectlEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  );
  const killAll = () => {
    for (const p of procs) {
      try { p.kill(); } catch { /* already exited */ }
    }
  };
  process.on("exit", killAll);
  return {
    stop: () => {
      process.off("exit", killAll);
      killAll();
    },
  };
}

/** Make the controller reachable, or print why and return null (exit 2). (Shared with commands/sandbox.ts.) */
export async function requireEndpoints(): Promise<{ stop: () => void } | null> {
  const handle = await ensureEndpoints({
    probe: probeController,
    spawnForwards: spawnKubectlForwards,
  });
  if (handle.status === "unreachable") {
    console.error(`\n  ${red}controller unreachable at ${controllerUrl()}${reset}`);
    console.error(`  ${dim}is the mattcloud cluster up and kubectl pointed at it? (MC_CONTROLLER_URL overrides)${reset}\n`);
    return null;
  }
  return handle;
}

// ─── rt validate ─────────────────────────────────────────────────────────────

export async function validateCommand(args: string[], ctx: CommandContext): Promise<void> {
  let wait = false;
  let force = false;
  let json = false;
  let manifestPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") helpExit();
    else if (arg === "--wait") wait = true;
    else if (arg === "--force") force = true;
    else if (arg === "--json") json = true;
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

  // Everything from here can fail farm-side or in git plumbing; the shared
  // try/catch maps those to the contract (2 infra / 64 missing base ref —
  // never an uncaught exit 1, which would read as farm-red), and the
  // finally always reaps any port-forward children we spawned.
  let endpoints: { stop: () => void } | null = null;
  // Wait-mode polls dial through localhost port-forwards that can die mid-run;
  // the poll loop calls this to stand fresh ones up before giving up.
  const reconnect = async (): Promise<boolean> => {
    console.error(`  ${yellow}controller connection lost — re-establishing port-forwards…${reset}`);
    endpoints?.stop();
    endpoints = await requireEndpoints();
    return endpoints !== null;
  };
  let exitCode: number;
  try {
    if (!json) console.log(`\n  ${dim}snapshotting worktree…${reset}`);
    const baseRef = resolveBaseRef(repoId, process.cwd());
    const snap = await snapshotWorktree(process.cwd(), baseRef);
    if (!json) {
      console.log(
        `  ${dim}tree ${snap.tree.slice(0, 12)} · ${snap.changedFiles.length} files changed vs merge-base ${snap.mergeBase.slice(0, 12)}${reset}`,
      );
    }

    endpoints = await requireEndpoints();
    if (!endpoints) {
      exitCode = 2; // requireEndpoints already printed why
      if (json) printErrorJson(`controller unreachable at ${controllerUrl()}`, exitCode);
    } else {
      exitCode = await submitAndReport({ repoId, snap, manifest, hash, wait, force, json, reconnect });
    }
  } catch (err) {
    exitCode = failureExitCode(err);
    const message = err instanceof Error ? err.message : String(err);
    if (exitCode === 64) {
      console.error(`\n  ${red}${message}${reset}\n`);
    } else {
      console.error(`\n  ${red}farm pipeline failed — not a code verdict${reset}`);
      console.error(`  ${dim}${message}${reset}\n`);
    }
    if (json) printErrorJson(message, exitCode);
  } finally {
    endpoints?.stop();
  }
  process.exit(exitCode);
}

/** Push the snapshot, submit the run, and report — returns the exit code. */
async function submitAndReport(opts: {
  repoId: string;
  snap: Awaited<ReturnType<typeof snapshotWorktree>>;
  manifest: ReturnType<typeof loadGateManifest>;
  hash: string;
  wait: boolean;
  force: boolean;
  json: boolean;
  reconnect: () => Promise<boolean>;
}): Promise<number> {
  const { repoId, snap, manifest, hash, wait, force, json, reconnect } = opts;

  // Push the snapshot commit to the receiver (incremental; the mirror
  // already has master's objects). No local ref is created.
  const push = await pushSnapshot({
    repoId,
    commit: snap.commit,
    tree: snap.tree,
    cwd: process.cwd(),
  });
  if (!push.ok) {
    console.error(`\n  ${red}snapshot push to ${push.pushUrl} failed${reset}`);
    console.error(`  ${dim}${push.stderr.trim()}${reset}`);
    const remedy = receiverSshRemedy(push.stderr, { repoId, url: push.pushUrl });
    if (remedy) console.error(`  ${yellow}${remedy}${reset}`);
    console.error("");
    if (json) printErrorJson(`snapshot push to ${push.pushUrl} failed`, 2);
    return 2;
  }

  const client = createControllerClient();
  const { runId, cached } = await client.submit({
    repoId,
    tree: snap.tree,
    manifestHash: hash,
    manifest,
    changedFiles: snap.changedFiles,
    mergeBase: snap.mergeBase,
    // The flag is omitted (not force: false) when unforced — the controller
    // contract keys on the presence of `force: true`.
    ...(force ? { force: true as const } : {}),
  });
  saveLastRun(repoId, runId);

  if (!json) {
    console.log(`  ${bold}run ${runId}${reset}${cached ? ` ${green}(cached verdict — unchanged tree)${reset}` : ""}\n`);
  }

  if (!wait && !cached) {
    if (json) {
      const run = await client.getRun(runId);
      printRunJson(
        run ?? { id: runId, repoId, tree: snap.tree, manifestHash: hash, status: "pending", groups: [], createdAt: "" },
        0,
      );
    } else {
      console.log(`  ${dim}submitted — check with${reset} ${bold}rt validate status${reset}\n`);
    }
    return 0;
  }

  const finalRun = await pollRunUntilDone(client, runId, {
    reconnect,
    ...(json
      ? {}
      : { onTransition: (group, status) => console.log(`  ${dim}${group} → ${status}${reset}`) }),
  });
  const exitCode = verdictExitCode(finalRun);
  if (json) printRunJson(finalRun, exitCode);
  else printRun(finalRun);
  return exitCode;
}

// ─── rt validate status ──────────────────────────────────────────────────────

export async function statusCommand(args: string[], ctx: CommandContext): Promise<void> {
  const json = args.includes("--json");
  const repoId = requireRepoId(ctx);
  const runId = args.find(a => !a.startsWith("--")) ?? loadLastRun(repoId);
  if (!runId) usageExit("no run id given and no previous run recorded — run `rt validate` first");

  if (!(await probeController())) {
    console.error(`\n  ${red}controller unreachable at ${controllerUrl()}${reset}\n`);
    if (json) printErrorJson(`controller unreachable at ${controllerUrl()}`, 2);
    process.exit(2);
  }
  let run: Run | null;
  try {
    run = await createControllerClient().getRun(runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${red}farm pipeline failed — not a code verdict${reset}`);
    console.error(`  ${dim}${message}${reset}\n`);
    if (json) printErrorJson(message, 2);
    process.exit(2);
  }
  const exitCode = statusExitCode(run); // 64 not found / 3 in flight / verdict
  if (!run) {
    console.error(`\n  ${red}run ${runId} not found${reset}\n`);
    if (json) printErrorJson(`run ${runId} not found`, exitCode);
    process.exit(exitCode);
  }

  if (json) {
    printRunJson(run, exitCode);
  } else {
    console.log(`\n  ${bold}${cyan}run ${run.id}${reset} ${dim}(${run.status}, tree ${run.tree.slice(0, 12)})${reset}\n`);
    printRun(run);
    if (exitCode === 3) console.log(`  ${dim}still in flight — exit 3${reset}\n`);
  }
  process.exit(exitCode);
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
  let log: string | null;
  try {
    log = await createControllerClient().getGroupLog(runId, group);
  } catch (err) {
    console.error(`\n  ${red}farm pipeline failed — not a code verdict${reset}`);
    console.error(`  ${dim}${err instanceof Error ? err.message : String(err)}${reset}\n`);
    process.exit(2);
  }
  if (log === null) {
    console.error(`\n  ${red}no log for group ${group} on run ${runId}${reset}\n`);
    process.exit(1);
  }
  process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
}
