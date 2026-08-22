/**
 * The need protocol: how `rt setup apply`/`rt uninstall` ask the running
 * mattstack.app to do something rt itself cannot (register a LaunchAgent,
 * run the privileged proxy install/remove) and wait for the answer over
 * tray.sock.
 *
 * The engine emits `{event:"need", id, request}` on stdout, then calls
 * `awaitNeed` to poll `GET /setup/need/<id>` until the app records a
 * terminal outcome. The route always answers 200 with `{state, detail?}` —
 * an unknown or not-yet-started id is "pending", never 404 — but rt
 * tolerates a 404 as pending too, since it costs nothing and covers a stale
 * app build. Each poll's own GET times out at 30s and comes back status 0,
 * indistinguishable from a genuinely gone app — a request the app held open
 * past that would misread as "app-gone" after three polls. That never
 * happens against the merged app: NeedBroker's outcome read is a
 * non-blocking actor read that answers immediately either way.
 */

import type { TrayClient } from "../daemon-client.ts";
import { bundledToolPath } from "../deps/resolve.ts";
import type { StepOutcome } from "./apply.ts";
import type { EventId } from "./contract.ts";
import type { Probes } from "./probes.ts";

/** The prod-flavor plist names; dev mode inserts ".dev" before ".plist" (see servicePlists). */
export const SERVICE_PLISTS = ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"] as const;

function devFlavor(name: string, mode: "dev" | "prod"): string {
  return mode === "dev" ? name.replace(/\.plist$/, ".dev.plist") : name;
}

export interface ServicePlists {
  plists: string[];
  /** True when the deck plist was left out because deck isn't bundled — a caller decides whether that's worth telling the user about. */
  deckOmitted: boolean;
}

/**
 * Plists to register: the daemon always, the deck helper only when it's
 * actually bundled into the running app (never resolveTool().chosen, which
 * would also say yes for a user's own PATH copy — the app can only register
 * a LaunchAgent for a program that lives inside its own bundle). Omitting
 * an unbundled deck matters because the app reports `ok` only when every
 * *requested* plist registers — asking for one whose BundleProgram doesn't
 * exist would turn a normal daemon-only install into a reported failure.
 * The bundle check runs once here — every caller reads `deckOmitted` off
 * the result instead of re-running its own `bundledToolPath` check.
 */
export function servicePlists(mode: "dev" | "prod", p: Pick<Probes, "exists" | "home">): ServicePlists {
  const deckBundled = bundledToolPath(p, "deck") !== null;
  const plists = [devFlavor(SERVICE_PLISTS[0], mode)];
  if (deckBundled) plists.push(devFlavor(SERVICE_PLISTS[1], mode));
  return { plists, deckOmitted: !deckBundled };
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
  id: EventId,
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

/**
 * The one place `ctx.need`'s four-way reply becomes a `StepOutcome`, so no
 * step body hand-rolls this mapping and risks turning a stalled or absent
 * app into a false success. `no-app` is the only non-fatal case — a
 * nonInteractive run legitimately has nobody to satisfy the need; a real
 * timeout or a vanished app is always a failure, never a skip. Lives here
 * (not apply.ts, which re-exports it) so a step file can import it without
 * a runtime cycle back through steps/index.ts.
 */
export function outcomeFromNeed(reply: NeedReply | "timeout" | "app-gone" | "no-app"): StepOutcome {
  if (reply === "no-app") return { state: "skipped", detail: "no mattstack.app running to complete this step" };
  if (reply === "timeout") return { state: "failed", detail: "timed out waiting for mattstack.app" };
  if (reply === "app-gone") return { state: "failed", detail: "mattstack.app stopped responding" };
  return reply.ok ? { state: "done", detail: reply.detail } : { state: "failed", detail: reply.detail ?? "mattstack.app reported failure" };
}
