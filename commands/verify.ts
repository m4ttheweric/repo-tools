#!/usr/bin/env bun

/**
 * rt verify — Installation verification.
 *
 * A read-only render of the setup plan (lib/setup/plan.ts, mode "status"):
 * every row composePlan already computed becomes one flat check. There is no
 * separate check logic here — the plan's validators are the single source
 * of truth for what "installed correctly" means, for both `rt setup` and
 * `rt verify`.
 *
 * Designed to run in CI or as a post-install check:
 *   rt verify           # full check with human output
 *   rt verify --json    # machine-readable JSON output
 *   rt verify --ci      # minimal output, strict exit codes
 */

import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { listTeams } from "../lib/settings/stores.ts";
import { composePlan, realSecretPresence } from "../lib/setup/plan.ts";
import { createRealProbes } from "../lib/setup/probes.ts";
import type { Action, Plan, Row } from "../lib/setup/contract.ts";
import { checkRtContextExtension } from "../lib/setup/validators/rt-health.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";
type Status = "pass" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  severity: Severity;
}

// commands/__tests__/verify.test.ts (untouched by this task) imports
// checkRtContextExtension directly from this module — the local binding
// must stay a real import + export, not `export … from`, so that test keeps
// resolving against this file.
export { checkRtContextExtension };

// ─── Row → check mapping ────────────────────────────────────────────────────

function actionHint(action: Action | null): string {
  return action ? ` — ${action.label}` : "";
}

/**
 * perm.* rows read the tray over its unix socket, which CI's headless daemon
 * cannot answer — a required perm gap there is the expected CI shape, not a
 * broken install, so it never blocks the exit code. tool.daemon's needs-you
 * carries the same CI-expected shape (a fresh daemon needs Login Items
 * approval no CI runner can grant); its other non-ready statuses still fail.
 */
function ciNeverCritical(r: Row, ci: boolean): boolean {
  if (!ci) return false;
  if (r.id.startsWith("perm.")) return true;
  return r.id === "tool.daemon" && r.status === "needs-you";
}

function rowToCheck(r: Row, opts: { ci: boolean }): CheckResult {
  const detail = `${r.detail}${actionHint(r.action)}`;

  if (r.status === "ready") return { name: r.id, status: "pass", detail, severity: "critical" };
  if (r.status === "skipped" || r.status === "checking") return { name: r.id, status: "skip", detail, severity: "info" };

  // missing | invalid | error | needs-you
  if (r.required && !ciNeverCritical(r, opts.ci)) return { name: r.id, status: "fail", detail, severity: "critical" };
  return { name: r.id, status: "warn", detail, severity: "warning" };
}

export function rowsToChecks(plan: Plan, opts: { ci: boolean }): CheckResult[] {
  return plan.groups.flatMap((g) => g.rows.map((r) => rowToCheck(r, opts)));
}

// ─── Output formatters ────────────────────────────────────────────────────────

/**
 * Shared human-readable format — used for both terminal and CI.
 * When noColor=true, ANSI codes are stripped so CI logs stay readable.
 */
function printHuman(results: CheckResult[], noColor = false): void {
  const c = (code: string) => (noColor ? "" : code);

  const icons: Record<Status, string> = {
    pass: `${c(green)}✓${c(reset)}`,
    fail: `${c(red)}✗${c(reset)}`,
    warn: `${c(yellow)}⚠${c(reset)}`,
    skip: `${c(dim)}–${c(reset)}`,
  };

  console.log("");
  console.log(`  ${c(bold)}${c(cyan)}rt verify${c(reset)}`);
  console.log("");

  for (const r of results) {
    console.log(`  ${icons[r.status]} ${r.name}  ${c(dim)}${r.detail}${c(reset)}`);
  }

  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");
  const warnings = results.filter((r) => r.status === "warn" || (r.status === "fail" && r.severity === "warning"));
  const passes = results.filter((r) => r.status === "pass");

  console.log("");
  if (failures.length === 0) {
    console.log(`  ${c(green)}${c(bold)}✓ all critical checks passed${c(reset)}  ${c(dim)}${passes.length} passed, ${warnings.length} warnings${c(reset)}`);
  } else {
    console.log(`  ${c(red)}${c(bold)}✗ ${failures.length} critical check${failures.length !== 1 ? "s" : ""} failed${c(reset)}  ${c(dim)}${passes.length} passed, ${warnings.length} warnings${c(reset)}`);
  }
  console.log("");
}

function printJSON(results: CheckResult[], plan: Plan): void {
  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");
  console.log(JSON.stringify({
    passed: failures.length === 0,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      warn: results.filter((r) => r.status === "warn").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    checks: results,
    plan,
  }, null, 2));
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runVerify(args: string[]): Promise<void> {
  const isCI = args.includes("--ci") || process.env.CI === "true";
  const isJSON = args.includes("--json");
  const ci = process.env.CI === "true";

  const plan = await composePlan({
    p: createRealProbes(),
    secrets: realSecretPresence(),
    ci,
    mode: "status",
    teams: listTeams(),
  });

  const results = rowsToChecks(plan, { ci });
  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");

  if (isJSON) {
    printJSON(results, plan);
  } else if (isCI) {
    printHuman(results, /* noColor */ true);
  } else {
    printHuman(results);
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}
