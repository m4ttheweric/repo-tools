/**
 * Pure mapping from the daemon's /api/secrets response to one field.
 *
 * Split out from secrets.ts (which imports vscode transitively via
 * daemonClient.ts) so this logic is unit-testable with bun:test — importing
 * secrets.ts directly pulls in `vscode`, which only resolves inside the
 * extension host.
 */

/** Structural subset of daemonClient.ts's DaemonResponse — avoids importing that module (and vscode with it) here. */
export interface DaemonSecretsResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** The daemon's secrets:read verb's extension scope whitelists exactly these two fields (lib/daemon/handlers/secrets.ts) — keep in lockstep. */
export type DaemonSecretKey = 'linearApiKey' | 'gitlabToken';

/**
 * Distinguishes three failure shapes that collapsing to `undefined` would
 * hide from the caller: `daemon-down` (no response at all — the extension's
 * own `daemonQuery` returns null on any fetch failure), `gate-failed` (the
 * daemon answered but refused — e.g. a missing/stale ~/.mattstack/rt/api-token,
 * secrets:read's own token check), and `unset` (the daemon answered fine,
 * the key just isn't configured — the ONLY case that's not worth warning
 * about). `getSecret` uses this to warn once per distinct cause instead of
 * silently falling through every time.
 */
export type DaemonSecretResult =
  | { status: 'ok'; value: string }
  | { status: 'unset' }
  | { status: 'gate-failed'; error: string }
  | { status: 'daemon-down' };

export function pickDaemonSecret(response: DaemonSecretsResponse | null, key: DaemonSecretKey): DaemonSecretResult {
  if (response === null) return { status: 'daemon-down' };
  if (!response.ok) return { status: 'gate-failed', error: response.error ?? 'unknown' };

  const value = (response.data as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? { status: 'ok', value } : { status: 'unset' };
}
