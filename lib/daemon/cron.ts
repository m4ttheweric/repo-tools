/**
 * Cron trigger layer: MECHANISM ONLY (MAT-161 seam ruling, 2026-08-08).
 * A daemon broadcast matching a configured pattern schedules a command on a
 * per-trigger trailing-edge debounce. That is the entire feature: no
 * conditions, no chaining, no retries-with-policy, no output parsing, no
 * workflow. The moment logic needs "if X and Y", it belongs in the invoked
 * program. Ships with rt's installation (tray-app precedent); dormant when
 * ~/.mattstack/rt/cron.jsonc is absent or empty.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { stripJsonc } from "../jsonc.ts";
import { rtDir } from "../rt-paths.ts";

export interface CronTrigger {
  name: string;
  /** Broadcast frame type to match exactly (e.g. "project-mrs"). */
  event: string;
  /** Optional: also require data.repoName to equal this. */
  repoName?: string;
  run: string[];
  debounceMs?: number;
}

export interface CronConfig {
  triggers: CronTrigger[];
}

export interface CronLog {
  info(msg: string): void;
  warn(msg: string): void;
}

const DEFAULT_DEBOUNCE_MS = 5000;

export function parseCronConfig(text: string): CronConfig {
  const raw = JSON.parse(stripJsonc(text)) as { triggers?: unknown };
  if (raw.triggers === undefined) return { triggers: [] };
  if (!Array.isArray(raw.triggers)) throw new Error(`cron.jsonc "triggers" must be an array`);
  const triggers = raw.triggers.map((t, i): CronTrigger => {
    const o = t as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) throw new Error(`cron.jsonc triggers[${i}] needs a "name"`);
    if (typeof o.event !== "string" || !o.event) throw new Error(`cron.jsonc trigger "${o.name}" needs an "event"`);
    if (!Array.isArray(o.run) || o.run.length === 0 || o.run.some((a) => typeof a !== "string")) {
      throw new Error(`cron.jsonc trigger "${o.name}" needs a non-empty string[] "run"`);
    }
    if (o.repoName !== undefined && typeof o.repoName !== "string") {
      throw new Error(`cron.jsonc trigger "${o.name}": "repoName" must be a string`);
    }
    if (o.debounceMs !== undefined && (typeof o.debounceMs !== "number" || o.debounceMs <= 0)) {
      throw new Error(`cron.jsonc trigger "${o.name}": "debounceMs" must be a positive number`);
    }
    return { name: o.name, event: o.event, repoName: o.repoName as string | undefined, run: o.run as string[], debounceMs: o.debounceMs as number | undefined };
  });
  return { triggers };
}

/** Missing file → dormant. Invalid file → warn and dormant: a config typo
    must never take the daemon down. */
export function loadCronConfig(path: string = join(rtDir(), "cron.jsonc"), log?: CronLog): CronConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { triggers: [] };
  }
  try {
    return parseCronConfig(text);
  } catch (err) {
    log?.warn(`cron: ignoring invalid ${path}: ${err instanceof Error ? err.message : err}`);
    return { triggers: [] };
  }
}

function defaultRunCommand(argv: string[], trigger: CronTrigger, log: CronLog): void {
  try {
    // Non-blocking, NOT detached: Bun.spawn offers no process-group detach,
    // so a daemon restart kills an in-flight command. Accepted (spec section
    // 5): invoked programs must be idempotent one-shot passes, and the next
    // matching event simply re-runs them.
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    log.info(`cron ${trigger.name}: spawned "${argv.join(" ")}" (pid ${proc.pid})`);
    void proc.exited.then((code) => log.info(`cron ${trigger.name}: exited ${code}`));
  } catch (err) {
    // A failed spawn is a log line, nothing more; the next matching event
    // tries again. No retry policy here by design.
    log.warn(`cron ${trigger.name}: spawn failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function startCron(
  config: CronConfig,
  opts: { log: CronLog; runCommand?: (argv: string[], trigger: CronTrigger) => void },
): { onBroadcast(type: string, data: unknown): void; dispose(): void } {
  const { log } = opts;
  const runCommand = opts.runCommand ?? ((argv: string[], trigger: CronTrigger) => defaultRunCommand(argv, trigger, log));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  if (config.triggers.length > 0) {
    log.info(`cron: ${config.triggers.length} trigger(s) armed`);
  }

  return {
    onBroadcast(type: string, data: unknown): void {
      if (disposed) return;
      for (const trigger of config.triggers) {
        if (trigger.event !== type) continue;
        if (trigger.repoName !== undefined && (data as { repoName?: unknown } | null)?.repoName !== trigger.repoName) continue;
        const prior = timers.get(trigger.name);
        if (prior) clearTimeout(prior);
        timers.set(
          trigger.name,
          setTimeout(() => {
            timers.delete(trigger.name);
            runCommand(trigger.run, trigger);
          }, trigger.debounceMs ?? DEFAULT_DEBOUNCE_MS),
        );
      }
    },
    dispose(): void {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
