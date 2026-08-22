/**
 * The ordered step registry `rt setup apply` runs — one `StepDef` per
 * `STEP_IDS` entry, in the contract's pinned order. Task 24 replaces the
 * first block of stubs (home through repos.clone) with real bodies; the
 * rest stay stubs for Tasks 25/26 to replace in place, never reordering or
 * adding/removing ids.
 */

import type { StepDef, StepOutcome } from "../apply.ts";
import { STEP_IDS, type StepId, type StepKind } from "../contract.ts";
import { installShims } from "../../endpoint/shim.ts";
import { homeInitStep, homeRestoreStep } from "./home.ts";
import { teamCreateStep, teamJoinStep } from "./team.ts";
import { secretsWriteStep } from "./secrets.ts";
import { pathLinkStep } from "./path.ts";
import { settingsSeedStep } from "./settings.ts";
import { reposCloneStep } from "./repos.ts";

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

async function interceptsInstallRun(): Promise<StepOutcome> {
  const result = await installShims();
  const total = result.installed.length + result.current.length;
  return { state: "done", detail: total === 0 ? "no commands to shim" : `${total} shims` };
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
  stubStep("services.register", "Register background services", "app"),
  stubStep("proxy.install", "Install the local proxy", "privileged"),
  stubStep("deck.managed", "Set up managed deck", "rt"),
  stubStep("skills.materialize", "Materialize skills", "rt"),
  stubStep("board.keys", "Generate board keys", "rt"),
  stubStep("cron.triage", "Install triage cron", "rt"),
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
