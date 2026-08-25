/**
 * Mirrors herdr agent statuses onto runs, live. The runs payload carries the
 * attributed agent's status (store.ts `agentMirror`), but nothing would tell
 * a console tab the status FLIPPED — herdr transitions write no run event.
 * This poller probes herdr, diffs each running run's attributed status
 * against the last tick, and emits `run-updated` on change, so blocked→red
 * appears (and clears) at probe cadence instead of at the next slow poll.
 *
 * herdr stays optional: a failed probe (null) skips the tick entirely,
 * holding last-known state — a herdr restart must not flap every run's
 * status to null and back. A successful empty answer diffs normally.
 */
import type { RunSummary } from "../../packages/rt-client/src/commands.ts";
import { livenessFrom, primeLivenessCache, probeAgents, type AgentEntry } from "../runs/liveness.ts";
import type { RunLiveness } from "../runs/attention.ts";
import { listRuns } from "../runs/store.ts";

const POLL_MS = 10_000;

interface Log {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface AgentStatusPollerHandle {
  stop(): void;
  /** Test seam: run one tick now. */
  tick(): Promise<void>;
}

export function startAgentStatusPoller(opts: {
  emitEvent: (topic: string, payload: unknown) => void;
  log: Log;
  intervalMs?: number;
  probe?: () => Promise<AgentEntry[] | null>;
  list?: (liveness: RunLiveness) => RunSummary[];
}): AgentStatusPollerHandle {
  const probe = opts.probe ?? (() => probeAgents());
  const list = opts.list ?? ((liveness: RunLiveness) => listRuns(undefined, liveness));
  const last = new Map<string, string | null>();
  let seeded = false;

  const tick = async (): Promise<void> => {
    const entries = await probe();
    if (entries === null) return;
    primeLivenessCache(entries);
    let runs: RunSummary[];
    try {
      runs = list(livenessFrom(entries));
    } catch (err) {
      opts.log.warn({ err }, "agent-status poller could not list runs");
      return;
    }
    const seen = new Set<string>();
    for (const run of runs) {
      if (run.status !== "running") continue;
      const key = `${run.repo}/${run.id}`;
      seen.add(key);
      const status = run.agent?.status ?? null;
      // The first tick seeds silently: daemon boot is not a status change.
      if (seeded && last.has(key) && last.get(key) !== status) {
        opts.emitEvent("run-updated", { repo: run.repo, runId: run.id, stage: null, kind: "agent-status" });
      }
      last.set(key, status);
    }
    for (const key of last.keys()) if (!seen.has(key)) last.delete(key);
    seeded = true;
  };

  const timer = setInterval(() => void tick().catch(() => {}), opts.intervalMs ?? POLL_MS);
  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
