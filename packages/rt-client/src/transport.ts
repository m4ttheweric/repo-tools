/**
 * rt daemon transport: HTTP over a unix socket (`~/.mattstack/rt/rt.sock`).
 *
 * POST http://localhost/<cmd> with a JSON payload, response envelope
 * `{ ok, data?, error? }`. Every call degrades to `{ ok: false, error }`
 * instead of throwing, so callers surface daemon-down verbatim.
 *
 * Ported verbatim from mr-board's src/rt-client.ts.
 */
import { homedir } from "os";
import { join } from "path";

export interface RtResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Structured form of `error` on a handler throw (R035): `code` defaults
   *  to "handler-threw" when the thrown error carries none. Additive; older
   *  daemons and the reject path never set this. */
  failure?: { code: string; message: string };
}

export interface RtClientOptions {
  sockPath?: string;
  wsUrl?: string;
  /** Per-call override of rtCommand's own default (15s); chat's pulse wrapper needs an 800ms hook budget. */
  timeoutMs?: number;
  /**
   * Test seam for createRelay (relay.ts): swaps the daemon subscription for
   * a fake without a live WebSocket server. Typed structurally against
   * relay.ts's `subscribe` rather than importing its RelayEventType, which
   * would make this module depend on the one that already depends on it.
   */
  subscribeImpl?: (onEvent: (type: string, data: unknown) => void, opts?: RtClientOptions) => () => void;
}

// Duplicates the ~/.mattstack/rt layout: rt-client has no dependency on rt's
// lib/, so this literal cannot import rtDir(). repo-tools/lib/rt-paths.ts is
// the authority — change there first, mirror here (same convention as
// settings/paths.ts's call-time `home()`).
function defaultSock(): string {
  return join(process.env.HOME ?? homedir(), ".mattstack", "rt", "rt.sock");
}

/**
 * Display-only: a module-load snapshot for callers that just want to show
 * the default path (no consumer imports it today — checked). `rtCommand`
 * itself never reads this constant; it calls `defaultSock()` fresh on every
 * invocation so a test can repoint `process.env.HOME` at any time before
 * calling, not only before this module first loads.
 */
export const DEFAULT_SOCK = defaultSock();

export async function rtCommand<T = unknown>(
  cmd: string,
  payload: Record<string, unknown>,
  opts: { sockPath?: string; timeoutMs?: number } = {},
): Promise<RtResponse<T>> {
  const sockPath = opts.sockPath ?? defaultSock();
  try {
    const res = await fetch(`http://localhost/${cmd}`, {
      unix: sockPath,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RT-Client": `rt-client/${process.pid}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      // Bun's `unix` fetch option isn't in the standard RequestInit type.
    } as RequestInit);
    return (await res.json()) as RtResponse<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `rt daemon unreachable at ${sockPath}: ${msg}` };
  }
}
