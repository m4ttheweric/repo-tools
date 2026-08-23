/**
 * The ordered step registry `rt setup apply` runs — one `StepDef` per
 * `STEP_IDS` entry, in the contract's pinned order.
 */

import type { ApplyContext, StepDef, StepOutcome } from "../apply.ts";
import { STEP_IDS } from "../contract.ts";
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
import { pluginsInstallStep } from "./plugins.ts";
import { fastbrowserSetupStep, herdrIntegrationStep, extensionInstallStep, servicesStartStep, snapshotPushStep } from "./tools.ts";
import { verifyStep } from "./verify.ts";
import { toFailedOutcome } from "./step-utils.ts";

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
  pluginsInstallStep,
  fastbrowserSetupStep,
  herdrIntegrationStep,
  extensionInstallStep,
  servicesStartStep,
  snapshotPushStep,
  verifyStep,
];

if (STEPS.length !== STEP_IDS.length) {
  throw new Error(`STEPS registry (${STEPS.length}) is out of sync with STEP_IDS (${STEP_IDS.length})`);
}
