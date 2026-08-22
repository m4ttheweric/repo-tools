/**
 * Writes a daemon cron trigger into the rt.cron machine setting — used by
 * `rt cron install` and the apply engine's cron.triage step.
 */

import { getDef, isMigrated } from "../settings/registry.ts";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";

export interface CronTrigger {
  name: string;
  event: string;
  run: string[];
  repoName?: string;
  debounceMs?: number;
}

export interface TriageTrigger extends CronTrigger {
  name: "board-triage";
  event: "project-mrs";
  debounceMs: 5000;
}

export function triageTrigger(boardBinary: string): TriageTrigger {
  return { name: "board-triage", event: "project-mrs", run: [boardBinary, "triage", "--once"], debounceMs: 5000 };
}

export interface InstallCronTriggerDeps {
  getDef: typeof getDef;
  isMigrated: typeof isMigrated;
  getSetting: typeof getSetting;
  setSetting: typeof setSetting;
}

function realInstallCronTriggerDeps(): InstallCronTriggerDeps {
  return { getDef, isMigrated, getSetting, setSetting };
}

/**
 * Replaces any existing trigger of the same name and writes the whole list
 * back to the machine store. rt.cron predates the settings lane's own
 * migration wave, so this stays honest about it rather than writing a value
 * the resolver can't yet read back.
 */
export function installCronTrigger(
  trigger: CronTrigger,
  deps: InstallCronTriggerDeps = realInstallCronTriggerDeps(),
): { written: boolean; reason?: string } {
  const def = deps.getDef("rt.cron");
  if (!def || !deps.isMigrated(def)) {
    return { written: false, reason: "rt.cron is not migrated to the settings stores yet (settings lane in flight)" };
  }

  const current = deps.getSetting<{ triggers?: CronTrigger[] }>("rt.cron").value ?? { triggers: [] };
  const triggers = (current.triggers ?? []).filter((t) => t.name !== trigger.name);
  triggers.push(trigger);

  deps.setSetting("rt.cron", { triggers }, "machine");
  return { written: true };
}
