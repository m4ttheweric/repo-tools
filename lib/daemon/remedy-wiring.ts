/**
 * Remedy engine wiring — constructs the RemedyEngine with PTY banner + event
 * side effects, and hot-reloads global rules from disk.
 */

import { existsSync, mkdirSync, watch } from "fs";
import type { Logger } from "pino";
import { RemedyEngine } from "./remedy-engine.ts";
import { matchBanner, fireBanner } from "./remedy-banners.ts";
import { loadGlobalRemedies, globalRemedyPath } from "./remedy-config.ts";
import type { RemedyEvent } from "./handlers/types.ts";

export interface RemedyWiringDeps {
  /** Needs emitNotice(id, text); typed loosely because the herdr backend also qualifies. */
  processManager: { emitNotice(id: string, text: string): void };
  stateStore: ConstructorParameters<typeof RemedyEngine>[0]["stateStore"];
  broadcast: (type: string, data: any) => void;
  log: Logger;
}

/**
 * Build the RemedyEngine wired to PTY banners, the bounded remedy-event ring
 * buffer (drained by UI polling), and WebSocket broadcasts.
 */
export function createWiredRemedyEngine({ processManager, stateStore, broadcast, log }: RemedyWiringDeps): {
  remedyEngine: RemedyEngine;
  remedyEvents: RemedyEvent[];
} {
  const remedyEvents: RemedyEvent[] = [];

  const remedyEngine = new RemedyEngine({
    processManager: processManager as any,
    stateStore,
    onMatch: (id, remedy, pattern) => {
      const cmdPreview = remedy.cmds.join(" && ");
      processManager.emitNotice(id, matchBanner(remedy.name, pattern, cmdPreview));
      log.info({ remedy: remedy.name, id, pattern }, "remedy matched");
    },
    onFire: (id, remedy, success) => {
      remedyEvents.push({ id, name: remedy.name, success, firedAt: Date.now() });
      if (remedyEvents.length > 50) remedyEvents.shift(); // bounded
      broadcast("remedy", { id, name: remedy.name, success });
      const willRestart = success && remedy.thenRestart !== false;
      processManager.emitNotice(id, fireBanner(remedy.name, success, willRestart));
      log.info({ remedy: remedy.name, id, success }, "remedy fired");
    },
  });

  return { remedyEngine, remedyEvents };
}

/**
 * Load global remedies at startup, then hot-reload whenever
 * ~/.rt/remedies/_global.json changes. Returns a close function for shutdown.
 *
 * Debounce: fs.watch emits multiple rename+change events per atomic-rename save
 * (common editor pattern). A ~100ms settle window collapses these to one reload.
 * Parse error: retain last-good state — editors briefly produce invalid JSON
 * during saves, and loadGlobalRemedies throws. If we reloaded on every throw
 * we'd wipe rules every save-cycle and only recover on the next valid write.
 */
export function startGlobalRemedyWatcher(
  { remedyEngine, log }: { remedyEngine: RemedyEngine; log: Logger },
): () => void {
  const GLOBAL_REMEDY_DEBOUNCE_MS = 100;

  try {
    remedyEngine.reloadGlobals(loadGlobalRemedies());
    log.info("remedy: global rules loaded");
  } catch (err) {
    log.warn({ err }, "remedy: could not load global rules at startup");
  }

  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gPath = globalRemedyPath();
  const dir   = gPath.replace(/_global\.json$/, "");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    watcher = watch(dir, (_evt, filename) => {
      if (filename !== "_global.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        try {
          const rules = loadGlobalRemedies();
          remedyEngine.reloadGlobals(rules);
          log.info({ count: rules.length }, "remedy: hot-reloaded global rules");
        } catch (err) {
          log.error({ err }, "remedy: parse failed; retaining previous rules");
        }
      }, GLOBAL_REMEDY_DEBOUNCE_MS);
    });
  } catch (err) {
    log.warn({ err }, "remedy: could not watch global dir");
  }

  return () => {
    if (timer) clearTimeout(timer);
    try { watcher?.close(); } catch { /* */ }
  };
}
