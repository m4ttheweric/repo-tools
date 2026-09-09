/**
 * Daemon-side edge for the pane ref grammar (rt-client's parsePaneRef):
 * every verb that addresses an EXISTING pane resolves the incoming ref to a
 * bare herdr pane id plus the socket it lives on, right here, once.
 */
import { parsePaneRef } from "../../packages/rt-client/src/pane-ref.ts";
import { bgSocketPath } from "./bg-service.ts";

/** ref -> {paneId, sockPath}; sockPath undefined = visible default. */
export function resolvePaneRef(ref: string): { paneId: string; sockPath: string | undefined } {
  const { server, paneId } = parsePaneRef(ref);
  return { paneId, sockPath: server === "bg" ? bgSocketPath() : undefined };
}
