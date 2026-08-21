/**
 * Shared secrets reader for the VS Code extension.
 *
 * Reads go through the rt daemon's `secrets:read` verb — the daemon owns
 * the encrypted sops/age store (lib/linear.ts's loadSecrets), the only
 * source. VS Code's secret store is the fallback when the daemon is
 * unreachable or the key was never set.
 *
 * Writes: there is no secrets:write daemon verb, and this module never
 * writes to disk itself — the encrypted store is written only via
 * `rt secrets set`. `showCantSaveSecretMessage` tells the user what to run
 * instead of pretending to save.
 */

import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { daemonQuery } from './daemonClient';
import { pickDaemonSecret, type DaemonSecretKey } from './secretsMapping';

export type { DaemonSecretKey };

const API_TOKEN_PATH = join(homedir(), '.mattstack', 'rt', 'api-token');

/** /api/secrets is token-gated (api-auth.ts + the secrets:read handler); '' on a fresh machine just fails the gate, same as a wrong token. */
function apiToken(): string {
  try {
    return readFileSync(API_TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

// Warn once per distinct cause per extension-host lifetime, not once per
// getSecret call (called on every status-bar refresh) — a modal or console
// line per call would be spam, but silently collapsing daemon-down and
// gate-failed into "undefined" hid a real, actionable problem from the user.
const warnedOnce = new Set<string>();
function warnOnce(dedupeKey: string, message: string): void {
  if (warnedOnce.has(dedupeKey)) return;
  warnedOnce.add(dedupeKey);
  console.warn(`[rt-context] ${message}`);
}

/**
 * Get a secret, preferring the daemon's encrypted store over VS Code's
 * secret store.
 */
export async function getSecret(
  context: vscode.ExtensionContext,
  key: DaemonSecretKey,
): Promise<string | undefined> {
  const response = await daemonQuery('/api/secrets', { headers: { 'X-RT-Token': apiToken() } });
  const result = pickDaemonSecret(response, key);

  switch (result.status) {
    case 'ok':
      return result.value;
    case 'unset':
      break; // normal — key was never set anywhere; no warning
    case 'daemon-down':
      warnOnce('daemon-down', 'rt daemon unreachable at :9401 — falling back to VS Code\'s local secret store');
      break;
    case 'gate-failed':
      warnOnce(
        `gate-failed:${result.error}`,
        `rt daemon refused the secrets request (${result.error}) — check ~/.mattstack/rt/api-token; falling back to VS Code's local secret store`,
      );
      break;
  }

  // Fall back to VS Code's own secret store (daemon down, gated, or key unset).
  const vscodeKey = key === 'linearApiKey'
    ? 'rtContext.linearApiKey'
    : 'rtContext.gitlabToken';
  return context.secrets.get(vscodeKey);
}

/**
 * This module never writes a secret itself — the encrypted store is
 * written only via `rt secrets set`. There is nothing left to collect from
 * the user here, so the command shows this directed message immediately
 * rather than prompting for a token it can't save.
 */
export function showCantSaveSecretMessage(key: DaemonSecretKey): void {
  vscode.window.showErrorMessage(
    `RT Context: can't save secrets from the extension anymore. Set tokens with \`rt secrets set rt ${key}\` — this command no longer writes.`,
  );
}
