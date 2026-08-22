/**
 * The ordered step registry `rt setup apply` runs — one `StepDef` per
 * `STEP_IDS` entry, in the contract's pinned order. Every id is a stub here;
 * Tasks 24-26 replace each `stubStep(...)` call in place with the step's
 * real body, never reordering or adding/removing ids.
 */

import type { StepDef, StepOutcome } from "../apply.ts";
import { STEP_IDS, type StepId, type StepKind } from "../contract.ts";

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

export const STEPS: StepDef[] = [
  stubStep("home.init", "Create your settings home repo", "rt"),
  stubStep("home.restore", "Restore your settings home repo", "rt"),
  stubStep("team.create", "Create your team", "rt"),
  stubStep("team.join", "Join your team", "rt"),
  stubStep("secrets.write", "Write your secrets", "rt"),
  stubStep("path.link", "Link rt onto your PATH", "rt"),
  stubStep("intercepts.install", "Install shell intercepts", "rt"),
  stubStep("settings.seed", "Seed your settings", "rt"),
  stubStep("repos.clone", "Clone your repos", "rt"),
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
