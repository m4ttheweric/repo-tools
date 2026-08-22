/**
 * The need protocol: how `rt setup apply` asks the running mattstack.app to
 * do something rt itself cannot (register a LaunchAgent, run the privileged
 * proxy install) and waits for the answer over tray.sock.
 *
 * The apply engine emits `{event:"need", id, request}` on stdout, then calls
 * `awaitNeed` to poll `GET /setup/need/<id>` until the app records a
 * terminal outcome. The route always answers 200 with `{state, detail?}` —
 * an unknown or not-yet-started id is "pending", never 404 — but rt
 * tolerates a 404 as pending too, since it costs nothing and covers a stale
 * app build. Works identically whether the app answers instantly or holds
 * the GET open.
 */

import type { TrayClient } from "../daemon-client.ts";
import { bundledToolPath } from "../deps/resolve.ts";
import type { Probes } from "./probes.ts";
import type { StepId } from "./contract.ts";

/** The prod-flavor plist names; dev mode inserts ".dev" before ".plist" (see servicePlists). */
export const SERVICE_PLISTS = ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"] as const;

function devFlavor(name: string, mode: "dev" | "prod"): string {
  return mode === "dev" ? name.replace(/\.plist$/, ".dev.plist") : name;
}

/**
 * Plists to register: the daemon always, the deck helper only when it's
 * actually bundled into the running app (never resolveTool().chosen, which
 * would also say yes for a user's own PATH copy — the app can only register
 * a LaunchAgent for a program that lives inside its own bundle). Omitting
 * an unbundled deck matters because the app reports `ok` only when every
 * *requested* plist registers — asking for one whose BundleProgram doesn't
 * exist would turn a normal daemon-only install into a reported failure.
 */
export function servicePlists(mode: "dev" | "prod", p: Pick<Probes, "exists" | "home">): string[] {
  const plists = [devFlavor(SERVICE_PLISTS[0], mode)];
  if (bundledToolPath(p, "deck") !== null) plists.push(devFlavor(SERVICE_PLISTS[1], mode));
  return plists;
}

export interface NeedReply {
  ok: boolean;
  detail?: string;
}

interface NeedStateBody {
  state: "pending" | "done" | "failed";
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 1_000;
const GET_TIMEOUT_MS = 30_000;
const GONE_THRESHOLD = 3;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitNeed(
  tray: TrayClient,
  id: StepId,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<NeedReply | "timeout" | "app-gone"> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + timeoutMs;
  let consecutiveGone = 0;

  while (true) {
    const res = await tray<NeedStateBody>(`/setup/need/${id}`, { method: "GET", timeoutMs: GET_TIMEOUT_MS });

    if (res.status === 0) {
      consecutiveGone += 1;
      if (consecutiveGone >= GONE_THRESHOLD) return "app-gone";
    } else {
      consecutiveGone = 0;
      if (res.status === 200 && res.json) {
        if (res.json.state === "done") return { ok: true, detail: res.json.detail };
        if (res.json.state === "failed") return { ok: false, detail: res.json.detail };
      }
      // 200 with an unrecognized/missing state, or a 404 (unknown/unstarted id) — tolerated as pending.
    }

    if (now() >= deadline) return "timeout";
    await sleep(pollMs);
  }
}
