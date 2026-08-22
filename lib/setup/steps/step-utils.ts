/**
 * Shared apply-step safety net: every step body below the engine's own
 * `UserActionableError` catch (lib/setup/apply.ts's `runApplyWith`) still
 * calls into libraries that can throw a plain `Error` — a locked keychain, a
 * missing `sops`, a malformed settings store. None of that may crash the
 * whole apply run; every step maps it to an honest `failed` outcome instead.
 */

import type { StepOutcome } from "../apply.ts";

export function toFailedOutcome(err: unknown): StepOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  return { state: "failed", detail };
}
