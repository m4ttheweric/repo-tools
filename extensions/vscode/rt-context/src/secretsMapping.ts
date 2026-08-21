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
}

/** The daemon's secrets:read verb whitelists exactly these two fields (lib/daemon/handlers/secrets.ts) — keep in lockstep. */
export type DaemonSecretKey = 'linearApiKey' | 'gitlabToken';

export function pickDaemonSecret(response: DaemonSecretsResponse | null, key: DaemonSecretKey): string | undefined {
  if (!response?.ok) return undefined;
  const value = (response.data as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
