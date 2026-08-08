#!/usr/bin/env bun

/**
 * rt cloud — mattcloud cluster operations.
 *
 * Usage:
 *   rt cloud secrets sync    doppler env snapshot → k8s Secret upsert
 *                            (exit 0 ok / 1 tooling failure / 64 refused)
 *   rt cloud sync-config     overlay config files → ConfigMaps in mc-system:
 *                            gates.jsonc → repo-gates (required),
 *                            bake.jsonc → repo-bake-config,
 *                            sandbox-bake.jsonc → sandbox-bake-config,
 *                            sandbox.jsonc → repo-sandbox-config
 *                            (key <repoId>.json, comments stripped),
 *                            evidence.jsonc → repo-evidence-config,
 *                            browser-flows/* → repo-browser-flows
 *                            (exit 0 ok / 1 tooling failure / 64 no gates.jsonc)
 *   rt cloud secrets sync-browser   overlay sandbox.browserSecretsFile →
 *                                   Secret repo-browser-secrets (mc-sandboxes)
 *   rt cloud secrets sync-agent     overlay sandbox.agentCredentialFiles →
 *                                   Secret agent-credentials (mc-sandboxes);
 *                                   keys are overlay-named, producing the
 *                                   files is adapter business
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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../lib/command-tree.ts";
import { bold, dim, green, red, reset } from "../lib/tui.ts";
import { repoDataDir } from "../lib/rt-paths.ts";
import { syncConfig } from "../lib/cloud-config.ts";
import { syncAgentCredentials, syncBrowserSecrets, syncSecrets } from "../lib/cloud-secrets.ts";
import { loadGateManifest, resolveRepoId } from "../lib/validate-farm.ts";
import { stripJsonc } from "../lib/jsonc.ts";
import { readSandboxConfig } from "../lib/sandbox.ts";

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
  const sandboxBakePath = join(repoDataDir(repoId), "sandbox-bake.jsonc");
  const sandboxPath = join(repoDataDir(repoId), "sandbox.jsonc");
  const evidencePath = join(repoDataDir(repoId), "evidence.jsonc");
  // The controller JSON.parses the mounted <repoId>.json, so comments must
  // come out here; the schema itself stays overlay-owned (no validation).
  let sandbox: { repoId: string; json: string } | null = null;
  if (existsSync(sandboxPath)) {
    try {
      sandbox = { repoId, json: JSON.stringify(JSON.parse(stripJsonc(readFileSync(sandboxPath, "utf8"))), null, 2) };
    } catch {
      console.error(`\n  ${red}${sandboxPath} is not valid JSONC${reset}\n`);
      process.exit(64);
    }
  }
  const flowsDir = join(repoDataDir(repoId), "browser-flows");
  const browserFlows = existsSync(flowsDir)
    ? readdirSync(flowsDir)
        .filter(name => statSync(join(flowsDir, name)).isFile())
        .map(name => ({ name, content: readFileSync(join(flowsDir, name), "utf8") }))
    : null;

  const outcome = await syncConfig({
    gates: readFileSync(gatesPath, "utf8"),
    bake: existsSync(bakePath) ? readFileSync(bakePath, "utf8") : null,
    sandboxBake: existsSync(sandboxBakePath) ? readFileSync(sandboxBakePath, "utf8") : null,
    sandbox,
    evidence: existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : null,
    browserFlows,
  });
  if (outcome.exitCode === 0) {
    console.log(`\n  ${green}✓${reset} ${outcome.message}\n`);
    return;
  }
  console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
  process.exit(outcome.exitCode);
}

// ─── Sandbox secrets (slice 2) ───────────────────────────────────────────────
// Both are local-export upserts: the overlay names the source files, the
// bytes flow memory → kubectl stdin, and nothing here inspects the values.

export async function browserSecretsSyncCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoId = requireRepoId(ctx);
  const config = readSandboxConfig(repoId);
  if (!config?.browserSecretsFile) {
    console.error(`\n  ${red}overlay ~/.rt/repos/${repoId}/config.json names no sandbox.browserSecretsFile${reset}\n`);
    process.exit(64);
  }
  if (!existsSync(config.browserSecretsFile)) {
    console.error(`\n  ${red}no such file: ${config.browserSecretsFile}${reset}\n`);
    process.exit(64);
  }
  const outcome = await syncBrowserSecrets({ content: readFileSync(config.browserSecretsFile, "utf8") });
  if (outcome.exitCode === 0) {
    console.log(`\n  ${green}✓${reset} ${outcome.message}\n`);
    return;
  }
  console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
  process.exit(outcome.exitCode);
}

export async function agentCredentialsSyncCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoId = requireRepoId(ctx);
  const config = readSandboxConfig(repoId);
  const sources = config?.agentCredentialFiles ?? {};
  if (Object.keys(sources).length === 0) {
    console.error(`\n  ${red}overlay ~/.rt/repos/${repoId}/config.json names no sandbox.agentCredentialFiles${reset}\n`);
    process.exit(64);
  }
  const files: Record<string, Uint8Array> = {};
  for (const [key, path] of Object.entries(sources)) {
    if (!existsSync(path)) {
      console.error(`\n  ${red}agent credential source missing: ${path} (key ${key})${reset}\n`);
      process.exit(64);
    }
    files[key] = new Uint8Array(readFileSync(path));
  }
  const outcome = await syncAgentCredentials({ files });
  if (outcome.exitCode === 0) {
    console.log(`\n  ${green}✓${reset} ${outcome.message}\n`);
    return;
  }
  console.error(`\n  ${red}✗ ${outcome.message}${reset}\n`);
  process.exit(outcome.exitCode);
}
