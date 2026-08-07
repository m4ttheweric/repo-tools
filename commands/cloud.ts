#!/usr/bin/env bun

/**
 * rt cloud — mattcloud cluster operations.
 *
 * Usage:
 *   rt cloud secrets sync    doppler env snapshot → k8s Secret upsert
 *                            (exit 0 ok / 1 tooling failure / 64 refused)
 *
 * The env snapshot never touches disk: doppler → memory → kubectl stdin
 * (lib/cloud-secrets.ts). Refuses when `doppler` on PATH is the mattcloud
 * in-pod shim rather than the real CLI.
 *
 * CLUSTER-VERIFY PENDING: the kubectl leg is unit-tested with injected
 * exec fakes only; it needs a pass against the live cluster (plan Task 9
 * step 5) before being trusted end-to-end.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset } from "../lib/tui.ts";
import { repoDataDir } from "../lib/rt-paths.ts";
import { syncSecrets } from "../lib/cloud-secrets.ts";
import { loadGateManifest, resolveRepoId } from "../lib/validate-farm.ts";

export async function secretsSyncCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoId = resolveRepoId(ctx.identity!.remoteUrl);
  if (!repoId) {
    console.error(`\n  ${red}no farm overlay claims this repo's origin${reset}`);
    console.error(`  ${dim}create ~/.rt/repos/<repoId>/repo.jsonc with { "origin": "${ctx.identity!.remoteUrl}" }${reset}\n`);
    process.exit(64);
  }

  const manifestPath = join(repoDataDir(repoId), "gates.jsonc");
  if (!existsSync(manifestPath)) {
    console.error(`\n  ${red}no gate manifest at ${manifestPath}${reset}\n`);
    process.exit(64);
  }
  const manifest = loadGateManifest(manifestPath);

  const outcome = await syncSecrets({ cwd: process.cwd(), secretRef: manifest.secretRef });
  if (outcome.exitCode === 0) {
    console.log(`\n  ${green}✓${reset} ${outcome.message}\n`);
    return;
  }
  console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
  if (outcome.exitCode === 64) {
    console.error(`  ${dim}see${reset} ${bold}rt cloud secrets sync${reset} ${dim}docs in the validation-farm plan${reset}\n`);
  }
  process.exit(outcome.exitCode);
}
