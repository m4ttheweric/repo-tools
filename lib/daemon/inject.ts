import { herdrRequest, waitTimeout, HERDR_UNAVAILABLE } from "../herdr/client.ts";
import { formatPaneRef } from "../../packages/rt-client/src/index.ts";
import { bgSocketPath } from "./bg-service.ts";

const DEFAULT_WAIT_MS = 5_000;

/** Relocated from handlers/pane.ts (logic unchanged), re-exported there; keeps inject.ts and pane.ts from importing each other. */
export function herdrError(res: { ok: false; code: string; message: string }): { ok: false; error: string } {
  if (res.code === "unreachable" || res.code === "timeout") {
    return { ok: false, error: res.message.startsWith(HERDR_UNAVAILABLE) ? res.message : `${HERDR_UNAVAILABLE}: ${res.message}` };
  }
  return { ok: false, error: `${res.code}: ${res.message}` };
}

export type InjectDelivery = "accepted" | "queued" | "refused";
export interface InjectResult { paneId: string; delivered: InjectDelivery; reason?: string }
export interface InjectOptions { paneId: string; text: string; callerPane?: string; herdr?: typeof herdrRequest; promptWaitMs?: number; sockPath?: string }

/**
 * herdr's injection delivery, shared by chat:invite and pane:send. Returns the
 * CommandResult shape both handlers already return: a refused/accepted/queued
 * outcome is `{ ok: true, data }`; a herdr-unavailable or unexpected herdr error
 * is `{ ok: false, error }` (via herdrError), so a caller returns it directly.
 * agent.get first: not-claude and blocked are refused; working is queued (prompt,
 * no wait); else agent.prompt with a wait until working, and on a stall (the
 * prompt fails with `timeout`/`agent_prompt_stalled`) one `pane.send_keys` Enter
 * nudge then an agent.wait, accepted or queued honestly.
 *
 * `paneId` here is always a bare herdr id: callers (pane:send, chat:invite)
 * resolve the incoming ref to `{ paneId, sockPath }` before calling in.
 */
export async function injectIntoPane(opts: InjectOptions): Promise<{ ok: true; data: InjectResult } | { ok: false; error: string }> {
  const { paneId, text, callerPane, sockPath } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const waitMs = opts.promptWaitMs ?? DEFAULT_WAIT_MS;
  const ok = (delivered: InjectDelivery, reason?: string) =>
    ({ ok: true as const, data: reason ? { paneId, delivered, reason } : { paneId, delivered } });
  // callerPane arrives as a ref (bare or bg:-prefixed, per selfPaneRef); paneId
  // here is always the bare id the caller's ref already resolved against
  // (see the docstring above), so the comparison must re-address paneId into
  // the same ref space -- a bg:w1:p1 caller vs. a bare w1:p1 target would
  // never match even when they are the exact same pane.
  const targetRef = formatPaneRef(paneId, sockPath === bgSocketPath() ? "bg" : "visible");
  if (callerPane && callerPane === targetRef) return ok("refused", "that is this pane");

  const probe = await herdr<{ agent: { agent: string; agent_status: string } }>("agent.get", { target: paneId }, { sockPath });
  if (!probe.ok) {
    if (probe.code === "agent_not_found" || probe.code === "agent_target_ambiguous") return ok("refused", "not a claude pane");
    return herdrError(probe);
  }
  if (probe.result.agent.agent !== "claude") return ok("refused", "not a claude pane");
  if (probe.result.agent.agent_status === "blocked") return ok("refused", "at a prompt");

  if (probe.result.agent.agent_status === "working") {
    const queued = await herdr("agent.prompt", { target: paneId, text }, { sockPath });
    if (!queued.ok) return queued.code === "agent_blocked" ? ok("refused", "at a prompt") : herdrError(queued);
    return ok("queued");
  }

  const prompted = await herdr("agent.prompt", { target: paneId, text, wait: { until: ["working"], timeout_ms: waitMs } }, { timeoutMs: waitTimeout(waitMs), sockPath });
  if (prompted.ok) return ok("accepted");
  if (prompted.code === "agent_blocked") return ok("refused", "at a prompt");
  if (prompted.code !== "timeout" && prompted.code !== "agent_prompt_stalled") return herdrError(prompted);

  // The Claude TUI can absorb the bundled Enter into the composer; one nudge, one more wait.
  const nudge = await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] }, { sockPath });
  if (!nudge.ok) return herdrError(nudge);
  const nudged = await herdr("agent.wait", { target: paneId, until: ["working"], timeout_ms: waitMs }, { timeoutMs: waitTimeout(waitMs), sockPath });
  if (nudged.ok) return ok("accepted");
  if (nudged.code !== "timeout" && nudged.code !== "agent_prompt_stalled") return herdrError(nudged);
  return ok("queued");
}
