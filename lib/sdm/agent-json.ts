/**
 * JSON envelopes for the agent-facing sdm verbs (connections/connect/status
 * with --json). Pure builders: commands print them verbatim to stdout and set
 * the returned exit code, so shapes are locked by unit tests, not by eyeball.
 * The rt-sdm-connect skill is the consumer; field renames break it.
 */

import type { SdmConnection } from "./browse.ts";
import { SDM_DEFAULT_DURATION, SDM_DURATIONS, type SdmHealth, type SdmResourceState, type SdmSnapshot } from "./core.ts";
import type { GuidedResult, GuidedTarget } from "./flow.ts";
import { buildPostgresUrl } from "./verify.ts";

export function buildConnectionsJson(
  connections: SdmConnection[],
  resources: Map<string, SdmResourceState>,
): unknown {
  return {
    ok: true,
    durations: [...SDM_DURATIONS],
    defaultDuration: SDM_DEFAULT_DURATION,
    connections: connections.map(c => {
      const state = resources.get(c.sdmResource);
      return {
        key: c.key,
        label: c.label,
        sdmResource: c.sdmResource,
        tier: c.tier ?? null,
        production: c.production ?? false,
        standingAccess: c.standingAccess ?? false,
        connected: state?.connected ?? false,
        address: state?.address ?? null,
        defaultReason: c.reasonSuggestion ?? `investigating ${c.label} data`,
        db: c.db ?? null,
      };
    }),
  };
}

export function buildConnectionsRefusal(health: SdmHealth, error?: string): unknown {
  return { ok: false, health: health.status, error: error ?? health.message ?? "unknown" };
}

export function buildConnectJson(target: GuidedTarget, result: GuidedResult): { json: unknown; exitCode: number } {
  if (result.outcome === "connected") {
    return {
      exitCode: 0,
      json: {
        ok: true,
        address: result.address,
        url: buildPostgresUrl(result.address, target.db),
        database: target.db?.database ?? "postgres",
        schema: target.db?.schema ?? "public",
        verified: !result.unverified,
        latencyMs: result.verify.latencyMs,
        attempts: result.verify.attempts,
      },
    };
  }
  if (result.outcome === "aborted") {
    return { exitCode: 1, json: { ok: false, stage: "aborted", error: result.reason, hint: null } };
  }
  return { exitCode: 1, json: { ok: false, stage: result.stage, error: result.error, hint: result.hint ?? null } };
}

/** CLI-layer production gate: refuse a non-interactive connect to a
 * production target unless --confirm-production relayed a human yes.
 * The daemon's tray reconnect never calls this; a tray click is a human. */
export function shouldRefuseProduction(
  target: Pick<GuidedTarget, "production">,
  opts: { interactive: boolean; confirmProduction?: boolean },
): boolean {
  return Boolean(target.production) && !opts.interactive && !opts.confirmProduction;
}

export function buildProductionRefusal(target: GuidedTarget): unknown {
  return {
    ok: false,
    stage: "confirm",
    error: `${target.label} is a production resource; a human must approve. Re-run with --confirm-production.`,
    hint: null,
  };
}

export function buildStatusJson(snapshot: SdmSnapshot, appRunning: boolean): { json: unknown; exitCode: number } {
  const ok = snapshot.health.status === "ok";
  const tunnels = ok
    ? [...snapshot.resources.entries()]
        .filter(([, s]) => s.connected)
        .map(([resource, s]) => ({ resource, address: s.address, expiry: s.expiry }))
    : [];
  return {
    exitCode: ok ? 0 : 1,
    json: { ok, health: snapshot.health.status, message: snapshot.health.message, appRunning, tunnels },
  };
}
