/**
 * `verify` — the apply run's own final check, over the SAME validators
 * `rt verify`/`composePlan` already run (post-install, `mode: "status"`).
 * Never a second verification path: this step's job is only to turn
 * `rowsToChecks`' output into one `StepOutcome`.
 */

import { composePlan, realSecretPresence } from "../plan.ts";
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

async function verifyRun(ctx: ApplyContext): Promise<StepOutcome> {
  const plan = await composePlan({
    p: ctx.p,
    secrets: realSecretPresence(),
    ci: ctx.ci,
    mode: "status",
    teams: ctx.team.slug ? [ctx.team.slug] : [],
  });

  return outcomeFromChecks(rowsToChecks(plan, { ci: ctx.ci }));
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
