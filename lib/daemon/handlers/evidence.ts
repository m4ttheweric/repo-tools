/**
 * Evidence daemon handlers: the state-machine surface for `rt evidence` --
 * request, list, pull, approve/reject, fulfill (local-chrome filing), redraw,
 * and mark-attached. Every state change also broadcasts "evidence:updated"
 * so cron-triggered frames (MAT-161) and other subscribers see it live.
 *
 * Daemon-internal commands: no rt-client catalog entry, loose HandlerMap.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandlerContext, HandlerMap } from "./types.ts";
import {
  getEvidenceLedger,
  type EvidenceLedger,
  type EvidenceLedgerEntry,
  type LedgerState,
} from "../evidence-ledger.ts";
import { createSandboxClient, type SandboxClient, type EvidenceSlot } from "../../sandbox.ts";
import {
  loadEvidenceConfig,
  expandEvidenceRoot,
  validateRequestArgs,
  type EvidenceConfig,
} from "../../evidence-config.ts";
import { syncEvidence, branchSlug, treeFileNames } from "../evidence-sync.ts";
import { notifyEnabled } from "../../notifier.ts";

export interface EvidenceHandlerOverrides {
  ledger?: EvidenceLedger;
  client?: SandboxClient;
  config?: (repoId: string) => EvidenceConfig | null;
  sync?: (requestId: string) => Promise<void>;
}

interface RequestPayload {
  repoId: string;
  branch: string;
  sandboxId?: string;
  caseId: string;
  view: string;
  recipe: string;
  args?: Record<string, string>;
  slot: EvidenceSlot;
  executor?: "sidecar" | "local-chrome";
  forceBefore?: boolean;
}

export function createEvidenceHandlers(
  ctx: HandlerContext,
  broadcast: (type: string, data: unknown) => void,
  overrides: EvidenceHandlerOverrides = {},
): HandlerMap {
  const ledger = overrides.ledger ?? getEvidenceLedger();
  const client = overrides.client ?? createSandboxClient();
  const config = overrides.config ?? ((repoId: string) => loadEvidenceConfig(repoId));
  const sync = overrides.sync
    ?? ((requestId: string) =>
      syncEvidence(
        {
          client,
          ledger,
          config,
          notify: (title, message, category) => notifyEnabled(category, title, message),
        },
        requestId,
      ));

  function emitUpdated(requestId: string, state: string): void {
    broadcast("evidence:updated", { requestId, state });
  }

  /** Resolves the same tree-slot directory evidence-sync.ts writes into. */
  function treeSlotDir(cfg: EvidenceConfig, entry: EvidenceLedgerEntry): string {
    return join(expandEvidenceRoot(cfg.evidenceRoot), branchSlug(entry.branch), entry.caseId);
  }

  return {
    "evidence:request": async (payload: RequestPayload) => {
      const cfg = config(payload.repoId);
      if (!cfg) return { ok: false, error: `no evidence config for repo "${payload.repoId}"` };

      const args = payload.args ?? {};
      const validationError = validateRequestArgs(cfg, payload.view, payload.recipe, args);
      if (validationError) return { ok: false, error: validationError };

      const viewConfig = cfg.views[payload.view];
      const executor = payload.executor ?? (viewConfig?.identityGated ? "local-chrome" : "sidecar");
      const requestedAt = new Date().toISOString();

      if (executor === "sidecar") {
        if (!payload.sandboxId) return { ok: false, error: "sandboxId required for sidecar executor" };
        const { requestId } = await client.requestEvidence(payload.sandboxId, {
          caseId: payload.caseId,
          view: payload.view,
          recipe: payload.recipe,
          args,
          slot: payload.slot,
          forceBefore: payload.forceBefore,
        });
        ledger.upsert({
          requestId,
          executor: "sidecar",
          sandboxId: payload.sandboxId,
          repoId: payload.repoId,
          branch: payload.branch,
          caseId: payload.caseId,
          view: payload.view,
          recipe: payload.recipe,
          slot: payload.slot,
          state: "requested",
          requestedAt,
        });
        emitUpdated(requestId, "requested");
        return { ok: true, data: { requestId, executor } };
      }

      const requestId = "local-" + crypto.randomUUID();
      ledger.upsert({
        requestId,
        executor: "local-chrome",
        sandboxId: null,
        repoId: payload.repoId,
        branch: payload.branch,
        caseId: payload.caseId,
        view: payload.view,
        recipe: payload.recipe,
        slot: payload.slot,
        state: "requested",
        requestedAt,
      });
      emitUpdated(requestId, "requested");
      return { ok: true, data: { requestId, executor } };
    },

    "evidence:list": async (
      payload: { branch?: string; sandboxId?: string; states?: LedgerState[] } = {},
    ) => {
      return { ok: true, data: ledger.list(payload) };
    },

    "evidence:pull": async (payload: { requestId?: string } = {}) => {
      if (payload.requestId && !ledger.read(payload.requestId)) {
        return { ok: false, error: `unknown requestId: ${payload.requestId}` };
      }
      const ids = payload.requestId
        ? [payload.requestId]
        : ledger.list({ states: ["captured"] }).map((e) => e.requestId);

      const synced: string[] = [];
      for (const id of ids) {
        try {
          await sync(id);
        } catch (err) {
          ctx.log.warn({ err, requestId: id }, "evidence pull failed");
          continue;
        }
        const entry = ledger.read(id);
        if (entry?.state === "synced") {
          synced.push(id);
          emitUpdated(id, "synced");
        }
      }
      return { ok: true, data: { synced } };
    },

    "evidence:approve": async (payload: { requestId: string }) => {
      const entry = ledger.read(payload.requestId);
      if (!entry) return { ok: false, error: `unknown requestId "${payload.requestId}"` };
      if (entry.state !== "synced") {
        return { ok: false, error: `cannot approve from state "${entry.state}" (must be synced)` };
      }
      ledger.setState(payload.requestId, "approved");
      emitUpdated(payload.requestId, "approved");
      return { ok: true, data: {} };
    },

    "evidence:reject": async (payload: { requestId: string; reason?: string }) => {
      const entry = ledger.read(payload.requestId);
      if (!entry) return { ok: false, error: `unknown requestId "${payload.requestId}"` };
      if (entry.state !== "synced") {
        return { ok: false, error: `cannot reject from state "${entry.state}" (must be synced)` };
      }
      const reason = payload.reason?.trim();
      if (!reason) return { ok: false, error: "reject requires a non-empty reason" };
      ledger.setState(payload.requestId, "rejected", { reason });
      emitUpdated(payload.requestId, "rejected");
      return { ok: true, data: {} };
    },

    "evidence:fulfill": async (payload: { requestId: string; basePath: string; annotatedPath?: string }) => {
      const entry = ledger.read(payload.requestId);
      if (!entry) return { ok: false, error: `unknown requestId "${payload.requestId}"` };
      if (entry.executor !== "local-chrome" || entry.state !== "requested") {
        return { ok: false, error: `cannot fulfill from state "${entry.state}" (must be local-chrome in requested)` };
      }
      const cfg = config(entry.repoId);
      if (!cfg) return { ok: false, error: `no evidence config for repo "${entry.repoId}"` };

      const dir = treeSlotDir(cfg, entry);
      mkdirSync(dir, { recursive: true });
      const names = treeFileNames({ slot: entry.slot, recipe: entry.recipe, requestId: entry.requestId });

      const basePath = join(dir, names.base);
      copyFileSync(payload.basePath, basePath);

      const files: { base: string; annotated?: string; manifest: string } = {
        base: basePath,
        manifest: join(dir, names.manifest),
      };
      if (payload.annotatedPath) {
        const annotatedPath = join(dir, names.annotated);
        copyFileSync(payload.annotatedPath, annotatedPath);
        files.annotated = annotatedPath;
      }

      const manifest = {
        requestId: entry.requestId,
        executor: "local-chrome" as const,
        filedAt: new Date().toISOString(),
        source: { basePath: payload.basePath, annotatedPath: payload.annotatedPath },
      };
      writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));

      ledger.setState(payload.requestId, "synced", { files });
      emitUpdated(payload.requestId, "synced");
      return { ok: true, data: { files } };
    },

    "evidence:redraw": async (payload: { requestId: string; annotatedPath: string }) => {
      const entry = ledger.read(payload.requestId);
      if (!entry) return { ok: false, error: `unknown requestId "${payload.requestId}"` };
      if (entry.state !== "synced" && entry.state !== "approved") {
        return { ok: false, error: `cannot redraw from state "${entry.state}" (must be synced or approved)` };
      }
      const cfg = config(entry.repoId);
      if (!cfg) return { ok: false, error: `no evidence config for repo "${entry.repoId}"` };

      const dir = treeSlotDir(cfg, entry);
      mkdirSync(dir, { recursive: true });
      const names = treeFileNames({ slot: entry.slot, recipe: entry.recipe, requestId: entry.requestId });
      const annotatedPath = join(dir, names.annotated);
      copyFileSync(payload.annotatedPath, annotatedPath);

      // State itself does not change on a redraw -- only the tree's
      // annotated file and the ledger's file pointer -- so this patches via
      // upsert rather than setState, which would otherwise re-stamp the
      // decidedAt/syncedAt timestamp tied to entry.state.
      const files = { ...(entry.files ?? { base: "", manifest: "" }), annotated: annotatedPath };
      ledger.upsert({ ...entry, files });
      ledger.recordRedraw(payload.requestId, new Date().toISOString());
      emitUpdated(payload.requestId, entry.state);
      return { ok: true, data: { annotated: annotatedPath } };
    },

    "evidence:mark-attached": async (payload: { requestId: string }) => {
      const entry = ledger.read(payload.requestId);
      if (!entry) return { ok: false, error: `unknown requestId "${payload.requestId}"` };
      if (entry.state !== "approved") {
        return { ok: false, error: `cannot mark attached from state "${entry.state}" (must be approved)` };
      }
      ledger.setState(payload.requestId, "attached");
      emitUpdated(payload.requestId, "attached");
      return { ok: true, data: {} };
    },
  };
}
