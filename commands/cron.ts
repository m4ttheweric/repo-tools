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

function usageForTrigger(json: boolean, verb: string): never {
  exitUserError(
    new UserActionableError("usage", `usage: rt cron ${verb} <trigger> [--json] (trigger: ${KNOWN_TRIGGERS.join(", ")})`),
    json,
    `cron ${verb}`,
    console.log,
  );
}

async function requireKnownTrigger(args: string[], json: boolean, verb: string): Promise<KnownTrigger> {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    // No trigger given: an interactive terminal gets a picker; agents and
    // --json callers keep the usage error and its exit code.
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      const { filterableSelect } = await import("../lib/rt-render.ts");
      const picked = await filterableSelect({
        message: `rt cron ${verb}`,
        options: KNOWN_TRIGGERS.map((t) => ({ value: t, label: t, hint: "" })),
      });
      if (!picked) process.exit(0);
      return picked as KnownTrigger;
    }
    usageForTrigger(json, verb);
  }
  // A present-but-unknown trigger is a typo, not an omission: still an error.
  if (!(KNOWN_TRIGGERS as readonly string[]).includes(name)) usageForTrigger(json, verb);
  return name as KnownTrigger;
}

export async function cronInstall(args: string[], _ctx: CommandContext = {}): Promise<void> {
  const json = args.includes("--json");
  await requireKnownTrigger(args, json, "install");

  const p = createRealProbes();
  const board = resolveTool(p, "board");
  const resolution = resolveBoardTriage(p, getKnownRepos(), board.exec);

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
  const name = await requireKnownTrigger(args, json, "remove");

  const result = removeCronTrigger(name);

  if (json) {
    console.log(JSON.stringify(envelope({ removed: result.removed, name, restartRequired: result.removed })));
    return;
  }
  console.log(result.removed ? `rt cron remove: removed "${name}"` : `rt cron remove: "${name}" was not installed`);
  if (result.removed) console.log("restart the daemon to apply: rt daemon restart");
}
