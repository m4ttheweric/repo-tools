/**
 * settings:get / settings:list — read-only daemon handlers over the RT-47
 * settings resolver (Task 6).
 *
 * Deliberately `expand: false` and repo-context-free: unlike the CLI (which
 * derives `--repo`'s identity + repoRoot before calling the resolver), the
 * daemon has no filesystem concept of "the caller's repo" to expand
 * `${repoRoot}`/`${worktree}` against — raw values plus provenance are the
 * honest answer here. A caller needing expansion resolves locally instead
 * (lib/settings/resolve.ts is daemon-free and safe to call in-process).
 *
 * Payload arrives over GET as `Object.fromEntries(url.searchParams)` (see
 * lib/daemon/api-server.ts) — every field is a string, so values are
 * trimmed/undefined-coerced the same way handlers/events.ts's `num()` does
 * for its query params.
 *
 * These are daemon-internal handlers, not part of the typed rt-client
 * command surface — no catalog changes, plain HandlerMap like hooks.ts.
 */

import { getSetting, listSettings } from "../../settings/resolve.ts";
import type { HandlerMap } from "./types.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export function createSettingsHandlers(): Record<"settings:get" | "settings:list", (payload: any) => Promise<any>> & HandlerMap {
  return {
    "settings:get": async (payload) => {
      const key = str(payload?.key);
      if (!key) return { ok: false, error: "missing key" };

      try {
        const resolved = getSetting(key, {
          repoIdentity: str(payload?.repoIdentity) ?? null,
          expand: false,
        });
        return { ok: true, data: resolved };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "settings:list": async (payload) => {
      const settings = listSettings({
        repoIdentity: str(payload?.repoIdentity) ?? null,
        expand: false,
      });
      return { ok: true, data: { settings } };
    },
  };
}
