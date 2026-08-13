#!/usr/bin/env bun

/**
 * rt db push — mattcloud cluster database freshness + recovery.
 *
 * Dumps the local `assured` database, restores it into the cluster's
 * `assured_tpl` template, then recreates the live `assured` from that
 * template server-side. Credentials are read from the cluster's
 * postgres-credentials Secret at runtime and never persisted; the port-forward
 * is held only for the command's lifetime (lib/db-push.ts).
 *
 * Recovery: assured_tpl always holds the last successfully pushed snapshot,
 * so a trashed live assured is one `rt db push` (or a manual
 * `CREATE DATABASE assured TEMPLATE assured_tpl`) away from being restored.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { createStepRunner } from "../lib/rt-render.tsx";
import {
  LIVE_DB,
  TEMPLATE_DB,
  pushDatabase,
  spawnExec,
  spawnPostgresForward,
  type PushConfirmSummary,
} from "../lib/db-push.ts";

function usageExit(message: string): never {
  console.error(`\n  ${red}${message}${reset}\n`);
  process.exit(64);
}

function helpExit(): never {
  console.log(`
  ${bold}rt db push${reset}
      dump local ${LIVE_DB} → cluster ${TEMPLATE_DB} → recreate live ${LIVE_DB} from it
      exit 0 ok / 1 pg_dump or psql tooling failure / 2 cluster failure mid-flight / 64 unreachable or usage / 130 declined
`);
  process.exit(0);
}

function formatBytes(n: number | null): string {
  if (n === null) return "size unknown";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

async function confirmPush(summary: PushConfirmSummary): Promise<boolean> {
  const { confirm } = await import("../lib/rt-render.tsx");
  console.log(`\n  ${bold}target${reset}  ${summary.cluster}`);
  console.log(`  ${bold}source${reset}  ${summary.sourceDb} ${dim}(${formatBytes(summary.dumpSizeBytes)})${reset}`);
  console.log(`  ${yellow}drops and recreates ${TEMPLATE_DB} and the live ${LIVE_DB} on the cluster${reset}`);
  return await confirm({
    message: `Push local ${LIVE_DB} to the mattcloud cluster?`,
    initialValue: false,
  });
}

/**
 * The Docker container publishing the local Postgres port, when there is one.
 * Dumping through its own binary keeps the dump's major version matched to
 * both servers; a newer host pg_dump emits SET statements PG16 rejects.
 */
async function detectSourceContainer(): Promise<{ docker: string } | undefined> {
  const res = await spawnExec(["docker", "ps", "--filter", "publish=5432", "--format", "{{.Names}}"]);
  if (res.exitCode !== 0) return undefined;
  const name = res.stdout.trim().split("\n")[0]?.trim();
  return name ? { docker: name } : undefined;
}

export async function pushCommand(args: string[], _ctx: CommandContext): Promise<void> {
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") helpExit();
    else usageExit(`unknown argument: ${arg}`);
  }

  const steps = createStepRunner();

  const out = await pushDatabase({
    exec: spawnExec,
    dumpVia: await detectSourceContainer(),
    spawnForward: spawnPostgresForward,
    confirm: confirmPush,
    runPhase: (phase, task) => {
      const start = Date.now();
      // The runner reads doneHint after the task settles, so the elapsed time
      // can be filled in here and still reach the ✓ line.
      const opts: { doneHint?: string } = {};
      return steps.run(`${phase}…`, async () => {
        try {
          return await task();
        } finally {
          opts.doneHint = `${((Date.now() - start) / 1000).toFixed(1)}s`;
        }
      }, opts);
    },
  });

  if (out.ok) {
    console.log(`\n  ${green}✓${reset} ${out.message}\n`);
    return;
  }

  console.error(`\n  ${red}✗ ${out.message}${reset}\n`);
  const exitCode = out.code === "declined" ? 130 : out.code === "tooling" ? 1 : out.code === "unreachable" ? 64 : 2;
  process.exit(exitCode);
}
