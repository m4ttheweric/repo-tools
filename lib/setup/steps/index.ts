/**
 * The ordered step registry `rt setup apply` runs — one `StepDef` per
 * `STEP_IDS` entry, in the contract's pinned order. Tasks 24/25 replace the
 * first two blocks of stubs (home through repos.clone, services.register
 * through cron.triage) with real bodies; the rest stay stubs for Task 26 to
 * replace in place, never reordering or adding/removing ids.
 */

import type { ApplyContext, StepDef, StepOutcome } from "../apply.ts";
import { STEP_IDS, type StepId, type StepKind } from "../contract.ts";
import { installShims } from "../../endpoint/shim.ts";
import { homeInitStep, homeRestoreStep } from "./home.ts";
import { teamCreateStep, teamJoinStep } from "./team.ts";
import { secretsWriteStep } from "./secrets.ts";
import { pathLinkStep } from "./path.ts";
import { settingsSeedStep } from "./settings.ts";
import { reposCloneStep } from "./repos.ts";
import { servicesRegisterStep, proxyInstallStep } from "./services.ts";
import { deckManagedStep } from "./deck.ts";
import { skillsMaterializeStep, boardKeysStep, cronTriageStep } from "./skills.ts";
import { toFailedOutcome } from "./step-utils.ts";

function stubStep(id: StepId, title: string, kind: StepKind): StepDef {
  return {
    id,
    title,
    kind,
    applies: () => true,
    async run(): Promise<StepOutcome> {
      return { state: "skipped", detail: "not implemented" };
    },
  };
}

async function interceptsInstallRun(ctx: ApplyContext): Promise<StepOutcome> {
  try {
    const result = await installShims();
    const total = result.installed.length + result.current.length;
    if (result.skipped.length > 0) {
      ctx.log("intercepts.install", `not ours, left alone: ${result.skipped.join(", ")}`);
    }
    const detail =
      total === 0 && result.skipped.length === 0
        ? "no commands to shim"
        : `${total} shims${result.skipped.length > 0 ? ` · skipped (occupied): ${result.skipped.join(", ")}` : ""}`;
    return { state: "done", detail };
  } catch (err) {
    return toFailedOutcome(err);
  }
}

export const interceptsInstallStep: StepDef = {
  id: "intercepts.install",
  title: "Install shell intercepts",
  kind: "rt",
  applies: () => true,
  run: interceptsInstallRun,
};

export const STEPS: StepDef[] = [
  homeInitStep,
  homeRestoreStep,
  teamCreateStep,
  teamJoinStep,
  secretsWriteStep,
  pathLinkStep,
  interceptsInstallStep,
  settingsSeedStep,
  reposCloneStep,
  servicesRegisterStep,
  proxyInstallStep,
  deckManagedStep,
  skillsMaterializeStep,
  boardKeysStep,
  cronTriageStep,
  stubStep("plugins.install", "Install plugins", "rt"),
  stubStep("fastbrowser.setup", "Set up Fast Browser", "rt"),
  stubStep("herdr.integration", "Set up herdr integration", "rt"),
  stubStep("extension.install", "Install the browser extension", "rt"),
  stubStep("services.start", "Start services", "rt"),
  stubStep("snapshot.push", "Push your first snapshot", "rt"),
  stubStep("verify", "Verify your setup", "rt"),
];

if (STEPS.length !== STEP_IDS.length) {
  throw new Error(`STEPS registry (${STEPS.length}) is out of sync with STEP_IDS (${STEP_IDS.length})`);
}
