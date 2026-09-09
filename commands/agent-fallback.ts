/**
 * Daemon-down execution for `rt agent`. Reuses the exact
 * daemon handlers in-process for the surfaces a short-lived CLI can serve:
 * herdr launch/resume and the read verbs. Headless is refused BEFORE any
 * handler is constructed, because the CLI exits immediately and cannot reap
 * the async `claude -p` child (it would spawn and orphan it).
 */
import type { Database } from "bun:sqlite";
import { createAgentHandlers, type HeadlessChild } from "../lib/daemon/handlers/agent.ts";
import { openStateDbGuarded, getAgent, stateDbPath } from "../lib/state/index.ts";
import type { HerdrRunner } from "../lib/agent-herdr.ts";
import type { AgentSurface, RtResponse } from "../packages/rt-client/src/index.ts";

export const HEADLESS_NEEDS_DAEMON =
  "headless needs the rt daemon to reap completion; start it (rt daemon start) or use --surface herdr";

export const BG_NEEDS_DAEMON =
  "--bg needs the rt daemon (it owns the background herdr server); start it (rt daemon start)";

type FallbackCommand = "agent:start" | "agent:resume" | "agent:get" | "agent:list";

export async function runAgentFallback<T>(
  command: FallbackCommand,
  payload: Record<string, unknown>,
  deps: { db?: Database; herdrRunner?: HerdrRunner; spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild } = {},
): Promise<RtResponse<T>> {
  const db = deps.db ?? openStateDbGuarded(stateDbPath());

  // Headless and bg pre-gates, before any handler runs: neither surface has
  // anything this in-process fallback can drive (headless needs a reaper,
  // bg needs the daemon-owned background server).
  if (command === "agent:start" && ((payload.surface as AgentSurface | undefined) ?? "herdr") === "headless") {
    return { ok: false, error: HEADLESS_NEEDS_DAEMON };
  }
  if (command === "agent:start" && payload.bg === true) {
    return { ok: false, error: BG_NEEDS_DAEMON };
  }
  if (command === "agent:resume") {
    const rec = getAgent(payload.id as string, db);
    const effective: AgentSurface = (payload.surface as AgentSurface | undefined) ?? rec?.surface ?? "herdr";
    if (effective === "headless") return { ok: false, error: HEADLESS_NEEDS_DAEMON };
  }

  const handlers = createAgentHandlers({
    db,
    emitEvent: () => 0,
    ...(deps.herdrRunner !== undefined && { herdrRunner: deps.herdrRunner }),
    ...(deps.spawnHeadless !== undefined && { spawnHeadless: deps.spawnHeadless }),
  });
  const res = await (handlers[command] as (p: unknown) => Promise<RtResponse<T>>)(payload);
  return res;
}
