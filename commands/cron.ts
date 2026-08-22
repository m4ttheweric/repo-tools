/**
 * rt cron install — install a daemon cron trigger.
 *
 *   rt cron install <trigger> [--json]   (trigger: board-triage)
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { resolveTool } from "../lib/deps/resolve.ts";
import { installCronTrigger, triageTrigger } from "../lib/setup/cron-install.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes } from "../lib/setup/probes.ts";

const KNOWN_TRIGGERS = ["board-triage"] as const;

export async function cronInstall(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  const name = args.find((a) => !a.startsWith("--"));

  if (!name || !(KNOWN_TRIGGERS as readonly string[]).includes(name)) {
    exitUserError(
      new UserActionableError("usage", `usage: rt cron install <trigger> [--json] (trigger: ${KNOWN_TRIGGERS.join(", ")})`),
      json,
      "cron install",
      console.log,
    );
  }

  const p = createRealProbes();
  const boardBinary = resolveTool(p, "board").chosen;
  if (!boardBinary) {
    exitUserError(
      new UserActionableError("board-missing", "board binary not found — run `rt tools install board` first"),
      json,
      "cron install",
      console.log,
    );
  }

  const trigger = triageTrigger(boardBinary);
  const result = installCronTrigger(trigger);

  if (!result.written) {
    exitUserError(new UserActionableError("cron-not-migrated", result.reason ?? "rt.cron is not migrated"), json, "cron install", console.log);
  }

  if (json) {
    console.log(JSON.stringify(envelope({ installed: trigger })));
    return;
  }
  console.log(`rt cron install: installed "${trigger.name}"`);
  console.log("restart the daemon to apply: rt daemon restart");
}
