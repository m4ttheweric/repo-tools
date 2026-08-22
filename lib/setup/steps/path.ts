/**
 * `path.link` — exposes rt's default tool set on PATH (T5's tagged links)
 * and wires shell integration + PATH precedence so a fresh shell picks them
 * up without a manual `source`.
 */

import { DEFAULT_EXPOSED, link } from "../../deps/links.ts";
import { installShellIntegration, installZshenvPrecedence } from "../../shell-integration.ts";
import type { ApplyContext } from "../apply.ts";
import type { StepDef, StepOutcome } from "../apply.ts";

async function pathLinkRun(ctx: ApplyContext): Promise<StepOutcome> {
  const linked: string[] = [];
  const skipped: string[] = [];

  for (const tool of DEFAULT_EXPOSED) {
    const outcome = link(ctx.p, tool);
    if (outcome.ok) {
      linked.push(tool);
    } else {
      // dev-mode-owns-rt, user-copy, occupied, no-bundle — none of these
      // fail the step; each is a per-tool skip with an honest log line.
      skipped.push(tool);
      ctx.log("path.link", outcome.detail);
    }
  }

  installShellIntegration();
  installZshenvPrecedence();

  return {
    state: "done",
    detail: `linked: ${linked.length > 0 ? linked.join(", ") : "none"} · skipped: ${skipped.length > 0 ? skipped.join(", ") : "none"}`,
  };
}

export const pathLinkStep: StepDef = {
  id: "path.link",
  title: "Link rt onto your PATH",
  kind: "rt",
  applies: () => true,
  run: pathLinkRun,
};
