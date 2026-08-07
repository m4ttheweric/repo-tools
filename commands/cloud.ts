#!/usr/bin/env bun

/**
 * rt cloud — mattcloud cluster operations.
 *
 * Usage:
 *   rt cloud secrets sync    doppler env snapshot → k8s Secret upsert
 *                            (exit 0 ok / 1 tooling failure / 64 refused)
 *   rt cloud sync-config     overlay gates.jsonc + bake.jsonc → ConfigMaps
 *                            repo-gates / repo-bake-config in mc-system
 *                            (exit 0 ok / 1 tooling failure / 64 no gates.jsonc)
 *
 * The env snapshot never touches disk: doppler → memory → kubectl stdin
 * (lib/cloud-secrets.ts). Refuses when `doppler` on PATH is the mattcloud
 * in-pod shim rather than the real CLI.
 *
 * sync-config ships the overlay files as raw bytes through the same
 * kubectl-stdin pattern (lib/cloud-config.ts). A missing bake.jsonc is fine
 * (gates sync alone, and the output says so); a missing gates.jsonc is a
 * refusal (64). bake.jsonc schema (minimal — the controller owns validation):
 *
 *   { "dockerfile": "<repo-relative path>", "installCmd": "<string, optional>" }
 *
 * CLUSTER-VERIFY PENDING: the kubectl leg is unit-tested with injected
 * exec fakes only; it needs a pass against the live cluster (plan Task 9
 * step 5) before being trusted end-to-end.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset } from "../lib/tui.ts";
import { repoDataDir } from "../lib/rt-paths.ts";
import { syncConfig } from "../lib/cloud-config.ts";
import { syncSecrets } from "../lib/cloud-secrets.ts";
import { loadGateManifest, resolveRepoId } from "../lib/validate-farm.ts";

/** Resolve the farm repoId from the worktree's origin, or exit 64. */
function requireRepoId(ctx: CommandContext): string {
  const repoId = resolveRepoId(ctx.identity!.remoteUrl);
  if (!repoId) {
    console.error(`\n  ${red}no farm overlay claims this repo's origin${reset}`);
    console.error(`  ${dim}create ~/.rt/repos/<repoId>/repo.jsonc with { "origin": "${ctx.identity!.remoteUrl}" }${reset}\n`);
    process.exit(64);
  }
  return repoId;
}

export async function secretsSyncCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoId = requireRepoId(ctx);

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

export async function syncConfigCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoId = requireRepoId(ctx);

  const gatesPath = join(repoDataDir(repoId), "gates.jsonc");
  if (!existsSync(gatesPath)) {
    console.error(`\n  ${red}no gate manifest at ${gatesPath}${reset}\n`);
    process.exit(64);
  }
  const bakePath = join(repoDataDir(repoId), "bake.jsonc");

  const outcome = await syncConfig({
    gates: readFileSync(gatesPath, "utf8"),
    bake: existsSync(bakePath) ? readFileSync(bakePath, "utf8") : null,
  });
  if (outcome.exitCode === 0) {
    console.log(`\n  ${green}✓${reset} ${outcome.message}\n`);
    return;
  }
  console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
  process.exit(outcome.exitCode);
}
