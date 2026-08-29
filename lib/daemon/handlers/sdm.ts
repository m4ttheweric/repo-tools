/**
 * SDM daemon handlers: catalog/snapshot caches for the CLI and tray, plus the
 * promptless reconnect the tray menu calls. Nothing here ever submits an
 * access request (org-visible); reconnect refuses with needs-access-request
 * and the tray routes the human through the reason/duration panel instead.
 */

import type { HandlerContext, HandlerMap } from "./types.ts";
import {
  connectResource,
  fetchAccessCatalog,
  getSdmSnapshot,
  resourceNeedsAccessRequest,
  type SdmFailureCode,
  type SdmSnapshot,
} from "../../sdm/core.ts";
import { scanSdmResources, type SdmResource } from "../../sdm/scan.ts";
import { probeQuery, probeTunnel, verifyWithRetries, VERIFY_ATTEMPT_TIMEOUT_MS, type ProbeResult, type VerifyOutcome } from "../../sdm/verify.ts";
import { loadSdmState, recordRecent, type RecentEntry, type SdmState } from "../../sdm/state.ts";
import { runGuidedConnect } from "../../sdm/flow.ts";

export interface SdmHandlerDeps {
  scan: (opts?: { refresh?: boolean }) => Promise<{ resources: SdmResource[]; fromCache: boolean; error?: string }>;
  getSnapshot: (force?: boolean) => Promise<SdmSnapshot>;
  loadState: () => SdmState;
  needsAccessRequest: (resource: string) => Promise<boolean>;
  connect: (resource: string, onLine: (l: string) => void) => Promise<{ ok: boolean; error?: string; code?: SdmFailureCode }>;
  verify: (url: string) => Promise<VerifyOutcome>;
  probeTunnel: (address: string) => Promise<ProbeResult>;
  recordRecent: (entry: Omit<RecentEntry, "lastConnectedAt">) => SdmState;
}

const realDeps: SdmHandlerDeps = {
  scan: opts => scanSdmResources(opts),
  getSnapshot: force => getSdmSnapshot(force),
  loadState: () => loadSdmState(),
  needsAccessRequest: async resource => {
    const catalog = await fetchAccessCatalog();
    return catalog.ok ? resourceNeedsAccessRequest(catalog.output, resource) : false;
  },
  connect: connectResource,
  verify: url => verifyWithRetries(() => probeQuery(url, VERIFY_ATTEMPT_TIMEOUT_MS)),
  probeTunnel: address => {
    const i = address.lastIndexOf(":");
    return probeTunnel(address.slice(0, i), Number(address.slice(i + 1)));
  },
  recordRecent: entry => recordRecent(entry),
};

function serializeSnapshot(snapshot: SdmSnapshot) {
  return { health: snapshot.health, resources: Object.fromEntries(snapshot.resources) };
}

export function createSdmHandlers(ctx: HandlerContext, deps: SdmHandlerDeps = realDeps): HandlerMap {
  return {
    "sdm:catalog": async (payload) => {
      const p = (payload as { refresh?: boolean } | undefined) ?? {};
      const result = await deps.scan({ refresh: p.refresh });
      if (result.error) ctx.log.warn({ err: result.error }, "sdm scan failed");
      return { ok: true, resources: result.resources, fromCache: result.fromCache, error: result.error };
    },

    "sdm:snapshot": async (payload) => {
      const p = (payload as { force?: boolean } | undefined) ?? {};
      const snapshot = await deps.getSnapshot(p.force);
      return { ok: true, ...serializeSnapshot(snapshot) };
    },

    "sdm:recents": async () => {
      const state = deps.loadState();
      const snapshot = await deps.getSnapshot();
      const recents = state.recents.map(r => ({
        ...r,
        connected: snapshot.resources.get(r.sdmResource)?.connected ?? false,
        address: snapshot.resources.get(r.sdmResource)?.address ?? null,
      }));
      return { ok: true, health: snapshot.health, recents };
    },

    "sdm:reconnect": async (payload) => {
      const p = (payload as { key?: string } | undefined) ?? {};
      const key = p.key ?? "";
      const entry = deps.loadState().recents.find(r => r.key === key);
      if (!entry) return { ok: false, error: `unknown recents key: ${key}` };
      if (await deps.needsAccessRequest(entry.sdmResource)) {
        return { ok: false, outcome: "needs-access-request", resource: entry.sdmResource };
      }
      const never = async (): Promise<never> => {
        throw new Error("prompt reached in promptless reconnect");
      };
      const result = await runGuidedConnect(
        {
          key: entry.key, label: entry.label, sdmResource: entry.sdmResource,
          tier: entry.tier, production: entry.production, reasonSuggestion: entry.reasonSuggestion, db: entry.db,
        },
        { interactive: false },
        {
          getSnapshot: deps.getSnapshot,
          needsAccessRequest: deps.needsAccessRequest,
          requestAccess: never,
          connect: deps.connect,
          verify: deps.verify,
          probeTunnel: deps.probeTunnel,
          login: never,
          promptDuration: never,
          promptReason: never,
          confirmProduction: never,
          confirmLogin: never,
          onLine: () => {},
          recordRecent: t =>
            void deps.recordRecent({
              key: t.key, label: t.label, sdmResource: t.sdmResource,
              tier: t.tier, production: t.production, reasonSuggestion: t.reasonSuggestion, db: t.db,
            }),
        },
      );
      if (result.outcome !== "connected") {
        const error = result.outcome === "failed" ? result.error : result.reason;
        return { ok: false, outcome: result.outcome, error };
      }
      ctx.log.info(
        { resource: entry.sdmResource, attempts: result.verify.attempts, latencyMs: result.verify.latencyMs },
        "sdm reconnect verified",
      );
      return { ok: true, address: result.address, verifyAttempts: result.verify.attempts };
    },
  };
}
