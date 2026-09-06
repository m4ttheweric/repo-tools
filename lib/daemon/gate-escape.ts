import { herdrRequest } from "../herdr/client.ts";

export type EscapeInjector = (paneId: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Drives herdr's existing pane.send_keys verb; deliberately NOT
    injectIntoPane, which refuses blocked panes, and a pane holding a
    pending form is exactly that state. Escape-only by construction: this
    is the sole key the gate delivery layer is allowed to send. */
export function createEscapeInjector(herdr: typeof herdrRequest = herdrRequest): EscapeInjector {
  return async (paneId) => {
    const res = await herdr("pane.send_keys", { pane_id: paneId, keys: ["escape"] });
    return res.ok ? { ok: true as const } : { ok: false as const, error: `${res.code}: ${res.message}` };
  };
}
