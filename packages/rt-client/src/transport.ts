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
}

export interface RtClientOptions {
  sockPath?: string;
  wsUrl?: string;
}

// Duplicates the ~/.mattstack/rt layout: rt-client has no dependency on rt's
// lib/, so this literal cannot import rtDir(). repo-tools/lib/rt-paths.ts is
// the authority — change there first, mirror here.
export const DEFAULT_SOCK = join(homedir(), ".mattstack", "rt", "rt.sock");

export async function rtCommand<T = unknown>(
  cmd: string,
  payload: Record<string, unknown>,
  opts: { sockPath?: string; timeoutMs?: number } = {},
): Promise<RtResponse<T>> {
  const sockPath = opts.sockPath ?? DEFAULT_SOCK;
  try {
    const res = await fetch(`http://localhost/${cmd}`, {
      unix: sockPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
