/**
 * bg:* daemon handlers: the wire verbs for the daemon-owned background herdr
 * server (see docs/superpowers/specs/2026-09-09-background-server-design.md
 * "The bg service"). lib/daemon/bg-service.ts owns the process lifecycle;
 * lib/daemon/bg-claims-store.ts owns who is holding it up; this module just
 * wires the two together and gates `bg:stop` on live claims.
 */
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { BgService } from "../bg-service.ts";
import type { BgClaimsStore } from "../bg-claims-store.ts";
import type { CommandResult } from "./types.ts";

export function createBgHandlers(deps: {
  service: BgService;
  claims: BgClaimsStore;
  /** herd-lifecycle.ts's watch is idempotent by socket, so an already-watched bg socket is a no-op here. */
  lifecycle: { watch(socket: string): void; sweepClaims(): Promise<void> };
}):
  & { "bg:ensure": (payload: unknown) => Promise<CommandResult<"bg:ensure">> }
  & { "bg:status": (payload: unknown) => Promise<CommandResult<"bg:status">> }
  & { "bg:stop": (payload: unknown) => Promise<CommandResult<"bg:stop">> }
  & { "bg:release": (payload: unknown) => Promise<CommandResult<"bg:release">> } {
  const { service, claims, lifecycle } = deps;

  return {
    "bg:ensure": async (rawPayload: unknown): Promise<CommandResult<"bg:ensure">> => {
      const payload = rawPayload as Commands["bg:ensure"]["payload"];
      const { socket, started } = await service.ensure();
      lifecycle.watch(socket);
      // Reconciles claims against reality on every touch, not just a fresh
      // connect: an already-watched, already-connected bg socket never fires
      // onState(true) again, so a claim orphaned since the last sweep would
      // otherwise sit stale until the next reconnect.
      await lifecycle.sweepClaims();
      if (payload.claim) claims.claim(payload.claim);
      return { ok: true, data: { socket, started, parity: service.lastParity() } };
    },

    "bg:status": async (_payload: unknown): Promise<CommandResult<"bg:status">> => {
      return { ok: true, data: { up: await service.up(), socket: service.socketPath(), claims: claims.list() } };
    },

    "bg:stop": async (_payload: unknown): Promise<CommandResult<"bg:stop">> => {
      const live = claims.list();
      if (live.length > 0) {
        return { ok: false, error: `bg server has live claims: ${live.map((c) => c.owner).join(", ")}` };
      }
      // A claim registered after this check but before stop() lands races the shutdown unchecked; accepted, since the next ensure respawns.
      await service.stop();
      return { ok: true, data: { stopped: true } };
    },

    "bg:release": async (rawPayload: unknown): Promise<CommandResult<"bg:release">> => {
      const payload = rawPayload as Commands["bg:release"]["payload"];
      return { ok: true, data: { released: claims.release(payload.claim) } };
    },
  };
}
