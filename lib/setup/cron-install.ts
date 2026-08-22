/**
 * Writes/removes a daemon cron trigger in the rt.cron machine setting — used
 * by `rt cron install`/`rt cron remove` and the apply engine's cron.triage
 * step.
 */

import { join } from "path";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import type { KnownRepo } from "../repo-index.ts";

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
  /** Board resolves (bundled or a user copy) but it's compiled-only: no source checkout carries `bin/triage.ts`. The compiled binary parses no subcommands today — firing `[board, "triage", ...]` against it would boot the HTTP server instead of running one pass. */
  | { kind: "unavailable" }
  /** Board doesn't resolve at all — nothing to wire. */
  | { kind: "missing" };

/**
 * board's compiled entry (`Contents/Helpers/board`) parses only `--version`
 * and otherwise boots the HTTP server — there is no `triage` subcommand to
 * invoke there (tracked separately; not this lane's to fix). The one form
 * that actually runs a one-shot triage pass today is `bun run bin/triage.ts`
 * from a board SOURCE checkout (board's own README: "bun run triage ... on a
 * cron"). So the only safe wiring is: a registered "board" checkout carrying
 * that script, invoked directly with `bun` — never the board binary itself.
 */
export function resolveBoardTriage(
  p: { exists(path: string): boolean },
  known: Pick<KnownRepo, "repoName" | "worktrees" | "registered">[],
  boardChosen: string | null,
): BoardTriageResolution {
  const checkout = known.find((r) => r.registered !== false && r.repoName === "board");
  if (checkout) {
    const script = join(checkout.worktrees[0]!.path, "bin", "triage.ts");
    if (p.exists(script)) return { kind: "checkout", run: ["bun", "run", script] };
  }
  return boardChosen === null ? { kind: "missing" } : { kind: "unavailable" };
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
