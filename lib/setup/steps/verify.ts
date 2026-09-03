/**
 * `verify` — the apply run's own final check, over the SAME validators
 * `rt verify`/`composePlan` already run (post-install, `mode: "status"`).
 * Never a second verification path: this step's job is only to turn
 * `rowsToChecks`' output into one `StepOutcome`.
 */

import { composePlan } from "../plan.ts";
import { rowsToChecks } from "../../../commands/verify.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";
import { toFailedOutcome } from "./step-utils.ts";

type CheckResult = ReturnType<typeof rowsToChecks>[number];

export function outcomeFromChecks(checks: CheckResult[]): StepOutcome {
  const failures = checks.filter((c) => c.status === "fail" && c.severity === "critical");
  if (failures.length > 0) {
    return {
      state: "failed",
      detail: `${failures.length} check${failures.length === 1 ? "" : "s"} failed: ${failures.map((f) => f.name).join(", ")}`,
      remedy: "Run `rt verify` for details",
    };
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  return { state: "done", detail: `${passed} check${passed === 1 ? "" : "s"} passed` };
}

/** Rows whose failure right after Install means "still booting", not "broken": services.start kickstarted the daemon seconds ago and its launchctl/worktrees sub-probes lag the ping, and a joiner's team.sync engine hasn't taken its first pull yet. */
const SETTLING_ROWS = new Set(["tool.daemon", "team.sync"]);
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 3000;

/**
 * Re-reads the checks while the only critical failures are settling rows;
 * any other failure is judged on the first read. team.sync is `required:
 * false`, so it never shows up as a critical failure — its "never pulled"
 * state instead reads as a `warn` whose detail names it, and that gets the
 * same re-read budget so a fresh join isn't judged before the engine boots.
 */
export async function settleChecks(
  read: () => Promise<CheckResult[]>,
  opts: { attempts: number; intervalMs: number; sleep: (ms: number) => Promise<void> },
): Promise<CheckResult[]> {
  let checks = await read();
  for (let attempt = 1; attempt < opts.attempts; attempt++) {
    const critical = checks.filter((c) => c.status === "fail" && c.severity === "critical");
    const criticalSettling = critical.length > 0 && critical.every((c) => SETTLING_ROWS.has(c.name));
    const teamSync = checks.find((c) => c.name === "team.sync");
    const teamSyncNeverPulled = teamSync?.status === "warn" && teamSync.detail.includes("never");
    if (!criticalSettling && !teamSyncNeverPulled) break;
    await opts.sleep(opts.intervalMs);
    checks = await read();
  }
  return checks;
}

async function verifyRun(ctx: ApplyContext): Promise<StepOutcome> {
  const read = async () => {
    const plan = await composePlan({
      p: ctx.p,
      secrets: ctx.secretPresence,
      ci: ctx.ci,
      mode: "status",
      teams: ctx.team.slug ? [ctx.team.slug] : [],
    });
    return rowsToChecks(plan, { ci: ctx.ci });
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return outcomeFromChecks(await settleChecks(read, { attempts: SETTLE_ATTEMPTS, intervalMs: SETTLE_INTERVAL_MS, sleep }));
}

async function verifyRunSafe(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    return await verifyRun(ctx);
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const verifyStep: StepDef = {
  id: "verify",
  title: "Verify your setup",
  kind: "rt",
  applies: () => true,
  run: verifyRunSafe,
};
