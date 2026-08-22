/**
 * Shared apply-step safety net: every step body below the engine's own
 * `UserActionableError` catch (lib/setup/apply.ts's `runApplyWith`) still
 * calls into libraries that can throw a plain `Error` — a locked keychain, a
 * missing `sops`, a malformed settings store. None of that may crash the
 * whole apply run; every step maps it to an honest `failed` outcome instead.
 */

import type { ApplyContext, StepOutcome } from "../apply.ts";
import { outcomeFromNeed, type NeedReply } from "../need.ts";

export function toFailedOutcome(err: unknown): StepOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  return { state: "failed", detail };
}

/**
 * Every `ctx.need`-driven step (services.register, proxy.install) shapes the
 * same four-way reply the same way: `no-app` is a skip when nobody could
 * have answered (nonInteractive) but a `failed`-with-remedy when a person
 * was expected to (interactive, and just hasn't opened the app yet); a real
 * `timeout`/`app-gone` always gets a "the app was there, then wasn't" remedy.
 * This wraps `outcomeFromNeed` (the one ok/failed/skipped decision) rather
 * than re-deriving it — only the remedy/detail text is step-specific.
 */
export function needOutcome(
  reply: NeedReply | "timeout" | "app-gone" | "no-app",
  ctx: Pick<ApplyContext, "nonInteractive">,
  copy: { noAppDetail: string; noAppRemedy: string; timeoutRemedy: string },
): StepOutcome {
  if (reply === "no-app") {
    return ctx.nonInteractive
      ? { state: "skipped", detail: copy.noAppDetail }
      : { state: "failed", detail: copy.noAppDetail, remedy: copy.noAppRemedy };
  }
  const base = outcomeFromNeed(reply);
  if ((reply === "timeout" || reply === "app-gone") && base.state === "failed") {
    return { ...base, remedy: copy.timeoutRemedy };
  }
  return base;
}
