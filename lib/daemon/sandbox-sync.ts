/**
 * Daemon wiring for the sandbox reconcile loop — constructs the real deps
 * for lib/sandbox-allocator.ts's createSandboxSync (whose logic carries the
 * tests) and runs it on an interval.
 *
 * The ~5s cadence is the design's accepted event-latency floor; each pass
 * starts with a cheap controller probe, so a cluster that is down costs one
 * failed localhost fetch per tick and nothing else. Forward children are
 * reaped on daemon shutdown via the returned stop().
 */

import type { Logger } from "pino";
import { controllerUrl } from "../validate-farm.ts";
import { createSandboxClient } from "../sandbox.ts";
import { createForwardSet, createSandboxSync } from "../sandbox-allocator.ts";
import { notifyEnabled } from "../notifier.ts";
import { getEvidenceLedger } from "./evidence-ledger.ts";
import { syncEvidence } from "./evidence-sync.ts";
import { loadEvidenceConfig } from "../evidence-config.ts";

const SANDBOX_SYNC_INTERVAL_MS = 5 * 1000;

// Module-scoped stop handle so shutdown.ts can reap the forward children
// without threading state through daemon.ts (same shape as
// stopDiscussionsPoller).
let running: { stop: () => void } | null = null;

export function stopSandboxSync(): void {
  running?.stop();
  running = null;
}

export function startSandboxSync(log: Logger): { stop: () => void } {
  const forwards = createForwardSet();
  const client = createSandboxClient();
  const evidenceLedger = getEvidenceLedger();
  const notify = (title: string, message: string, category: string) => notifyEnabled(category, title, message);
  const sync = createSandboxSync({
    probe: async () => {
      try {
        const res = await fetch(`${controllerUrl()}/healthz`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
      } catch {
        return false;
      }
    },
    client,
    forwards,
    notify,
    evidence: {
      ledger: evidenceLedger,
      sync: (requestId) => syncEvidence(
        { client, ledger: evidenceLedger, config: (repoId) => loadEvidenceConfig(repoId), notify },
        requestId,
      ),
    },
  });

  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sync.syncOnce();
    } catch (err) {
      log.warn({ err }, "sandbox sync pass failed");
    } finally {
      inFlight = false;
    }
  }, SANDBOX_SYNC_INTERVAL_MS);

  running = {
    stop: () => {
      clearInterval(timer);
      forwards.stopAll();
    },
  };
  return running;
}
