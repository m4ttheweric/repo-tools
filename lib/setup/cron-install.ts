/**
 * Writes/removes a daemon cron trigger in the rt.cron machine setting — used
 * by `rt cron install`/`rt cron remove` and the apply engine's cron.triage
 * step.
 */

import { join } from "path";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import type { KnownRepo } from "../repo-index.ts";
import { repoLabel } from "../repo-label.ts";

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

/** `run` is the already-resolved invocation argv — see `resolveBoardTriage` for how the caller picks it (or refuses). */
export function triageTrigger(run: string[]): TriageTrigger {
  return { name: "board-triage", event: "project-mrs", run, debounceMs: 5000 };
}

export type BoardTriageResolution =
  | { kind: "checkout"; run: string[] }
  /** No registered checkout carries `bin/triage.ts`, but board resolves (bundled or a user copy) — `<exec> triage` runs a one-shot pass (board main ecb43e9+; exit 0 = ran or disabled, non-zero = real failure). */
  | { kind: "bundled"; run: string[] }
  /** Board doesn't resolve at all — nothing to wire. */
  | { kind: "missing" };

/**
 * A registered "board" checkout carrying `bin/triage.ts` wins (source-of-truth
 * for anyone running board from source); otherwise fall back to whatever
 * board resolves to — bundled binary or a PATH copy — appending its `triage`
 * subcommand.
 */
export function resolveBoardTriage(
  p: { exists(path: string): boolean },
  known: Pick<KnownRepo, "repoName" | "worktrees" | "registered">[],
  boardExec: string[] | null,
): BoardTriageResolution {
  // `repoName` is a serialized identity for every row the index wrote
  // post-cutover, so "board" only ever matches its decoded label. Two repos can
  // carry that label, and `find` would then wire cron to whichever sorted
  // first, so an ambiguous label takes the bundled fallback instead of a guess.
  const boards = known.filter((r) => r.registered !== false && repoLabel(r.repoName) === "board");
  const checkout = boards.length === 1 ? boards[0] : undefined;
  if (checkout) {
    const script = join(checkout.worktrees[0]!.path, "bin", "triage.ts");
    if (p.exists(script)) return { kind: "checkout", run: ["bun", "run", script] };
  }
  return boardExec === null ? { kind: "missing" } : { kind: "bundled", run: [...boardExec, "triage"] };
}

export interface InstallCronTriggerDeps {
  getSetting: typeof getSetting;
  setSetting: typeof setSetting;
}

function realInstallCronTriggerDeps(): InstallCronTriggerDeps {
  return { getSetting, setSetting };
}

type CronConfigValue = { triggers?: CronTrigger[] };

// rt.cron's registry def scopes to ["machine"] only, with no repoScoped
// sharding — getSetting("rt.cron") therefore reads exactly the one machine
// store file, the same physical source a raw machine-only read would use.
// Unlike rt.repoTracking (which loadRepoTracking() folds with a SEPARATE
// team-declared key), there is no second source rt.cron could be merging in.
function readTriggers(getter: typeof getSetting): CronTrigger[] {
  return getter<CronConfigValue>("rt.cron").value?.triggers ?? [];
}

/** Replaces any existing trigger of the same name and writes the whole list back to the machine store. */
export function installCronTrigger(
  trigger: CronTrigger,
  deps: InstallCronTriggerDeps = realInstallCronTriggerDeps(),
): { written: true } {
  const triggers = readTriggers(deps.getSetting).filter((t) => t.name !== trigger.name);
  triggers.push(trigger);
  deps.setSetting("rt.cron", { triggers }, "machine");
  return { written: true };
}

/** Drops a trigger by name; a no-op (still `written:true`) when it wasn't installed. */
export function removeCronTrigger(
  name: string,
  deps: InstallCronTriggerDeps = realInstallCronTriggerDeps(),
): { written: true; removed: boolean } {
  const before = readTriggers(deps.getSetting);
  const triggers = before.filter((t) => t.name !== name);
  deps.setSetting("rt.cron", { triggers }, "machine");
  return { written: true, removed: triggers.length !== before.length };
}
