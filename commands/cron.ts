/**
 * rt cron install|remove — manage daemon cron triggers.
 *
 *   rt cron install <trigger> [--json]   (trigger: board-triage)
 *   rt cron remove <trigger> [--json]
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { resolveTool } from "../lib/deps/resolve.ts";
import { getKnownRepos } from "../lib/repo-index.ts";
import { installCronTrigger, removeCronTrigger, resolveBoardTriage, triageTrigger } from "../lib/setup/cron-install.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes } from "../lib/setup/probes.ts";

const KNOWN_TRIGGERS = ["board-triage"] as const;
type KnownTrigger = (typeof KNOWN_TRIGGERS)[number];

function requireKnownTrigger(args: string[], json: boolean, verb: string): KnownTrigger {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name || !(KNOWN_TRIGGERS as readonly string[]).includes(name)) {
    exitUserError(
      new UserActionableError("usage", `usage: rt cron ${verb} <trigger> [--json] (trigger: ${KNOWN_TRIGGERS.join(", ")})`),
      json,
      `cron ${verb}`,
      console.log,
    );
  }
  return name as KnownTrigger;
}

export async function cronInstall(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  requireKnownTrigger(args, json, "install");

  const p = createRealProbes();
  const board = resolveTool(p, "board");
  const resolution = resolveBoardTriage(p, getKnownRepos(), board.chosen);

  if (resolution.kind === "missing") {
    exitUserError(
      new UserActionableError(
        "board-missing",
        "board binary not found — resolve it first: `rt deps resolve board` (once bundled, `rt deps link board` exposes it)",
      ),
      json,
      "cron install",
      console.log,
    );
  }
  if (resolution.kind === "unavailable") {
    exitUserError(
      new UserActionableError(
        "triage-unavailable",
        "triage isn't available on this install — the board binary has no triage subcommand yet (tracked separately); register a board checkout instead (`rt repos register <path-to-board>`) and rerun",
      ),
      json,
      "cron install",
      console.log,
    );
  }

  const trigger = triageTrigger(resolution.run);
  installCronTrigger(trigger);

  if (json) {
    console.log(JSON.stringify(envelope({ installed: trigger, restartRequired: true })));
    return;
  }
  console.log(`rt cron install: installed "${trigger.name}"`);
  console.log("restart the daemon to apply: rt daemon restart");
}

export async function cronRemove(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  const name = requireKnownTrigger(args, json, "remove");

  const result = removeCronTrigger(name);

  if (json) {
    console.log(JSON.stringify(envelope({ removed: result.removed, name, restartRequired: result.removed })));
    return;
  }
  console.log(result.removed ? `rt cron remove: removed "${name}"` : `rt cron remove: "${name}" was not installed`);
  if (result.removed) console.log("restart the daemon to apply: rt daemon restart");
}
