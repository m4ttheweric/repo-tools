import { herdrRequest } from "../herdr/client.ts";
import { resolvePaneRef } from "./pane-ref-socket.ts";

export type EscapeInjector = (ref: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Drives herdr's existing pane.send_keys verb; deliberately NOT
    injectIntoPane, which refuses blocked panes, and a pane holding a
    pending form is exactly that state. Escape-only by construction: this
    is the sole key the gate delivery layer is allowed to send. The
    argument is a pane REF (`bg:w1:p2` or bare): resolved here so a gate
    row's origin.paneId round-trips to whichever server actually holds it. */
export function createEscapeInjector(herdr: typeof herdrRequest = herdrRequest): EscapeInjector {
  return async (ref) => {
    const { paneId, sockPath } = resolvePaneRef(ref);
    const res = await herdr("pane.send_keys", { pane_id: paneId, keys: ["escape"] }, { sockPath });
    return res.ok ? { ok: true as const } : { ok: false as const, error: `${res.code}: ${res.message}` };
  };
}
