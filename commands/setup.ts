/**
 * rt setup plan|status — the readiness checklist the mattstack.app installer
 * (and a human running rt directly) reads before Install runs.
 *
 *   rt setup plan [--team <name>] [--json]     pre-install: canInstall reachable
 *   rt setup status [--json]                   post-install health view
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { composePlan, realSecretPresence } from "../lib/setup/plan.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import type { Plan, RowStatus } from "../lib/setup/contract.ts";
import type { SecretPresence } from "../lib/setup/validators/accounts.ts";

export interface SetupDeps {
  probes: Probes;
  secrets: SecretPresence;
  print: (s: string) => void;
}

export function realSetupDeps(): SetupDeps {
  return { probes: createRealProbes(), secrets: realSecretPresence(), print: (s) => console.log(s) };
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

async function runPlan(args: string[], deps: SetupDeps, mode: "plan" | "status", header?: string): Promise<void> {
  const plan = await composePlan({
    p: deps.probes,
    secrets: deps.secrets,
    ci: process.env.CI === "true",
    mode,
    teamOverride: flagValue(args, "--team"),
  });

  if (args.includes("--json")) {
    deps.print(JSON.stringify(plan));
    return;
  }
  if (header) deps.print(header);
  for (const line of renderPlanHuman(plan)) deps.print(line);
}

export async function setupPlan(args: string[], _ctx: CommandContext = {}, deps: SetupDeps = realSetupDeps()): Promise<void> {
  await runPlan(args, deps, "plan");
}

export async function setupStatus(args: string[], _ctx: CommandContext = {}, deps: SetupDeps = realSetupDeps()): Promise<void> {
  await runPlan(args, deps, "status", "rt setup status");
}

// Task 27 replaces this with the real interactive walk; today it's the same
// health view `rt setup status` gives.
export const setupInteractive = setupStatus;
