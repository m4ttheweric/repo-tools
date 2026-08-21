/**
 * Shared secrets reader for the VS Code extension.
 *
 * Reads go through the rt daemon's `secrets:read` verb (RT-32) — the daemon
 * owns the encrypted store and, during the migration, its own plaintext
 * fallback (lib/linear.ts's loadSecrets), so this module no longer opens
 * ~/.mattstack/rt/secrets.json directly. VS Code's secret store is the
 * fallback when the daemon is unreachable or the key was never set.
 *
 * Writes still update ~/.mattstack/rt/secrets.json AND VS Code's secret
 * store: the daemon's plaintext fallback (transition-only) picks up a file
 * write with no extra plumbing, and there is no secrets:write verb yet.
 */

import * as vscode from 'vscode';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { daemonQuery } from './daemonClient';
import { pickDaemonSecret, type DaemonSecretKey } from './secretsMapping';

export type { DaemonSecretKey };

const SECRETS_PATH = join(homedir(), '.mattstack', 'rt', 'secrets.json');
const API_TOKEN_PATH = join(homedir(), '.mattstack', 'rt', 'api-token');

interface RtSecrets {
  linearApiKey?: string;
  gitlabToken?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
}

function readRtSecrets(): RtSecrets {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeRtSecrets(secrets: RtSecrets): void {
  const dir = join(homedir(), '.mattstack', 'rt');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}

/** /api/secrets is token-gated (api-auth.ts); '' on a fresh machine just fails the gate, same as a wrong token. */
function apiToken(): string {
  try {
    return readFileSync(API_TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Get a secret, preferring the daemon's encrypted store over VS Code's
 * secret store.
 */
export async function getSecret(
  context: vscode.ExtensionContext,
  key: DaemonSecretKey,
): Promise<string | undefined> {
  // 1. Try the daemon first.
  const response = await daemonQuery('/api/secrets', { headers: { 'X-RT-Token': apiToken() } });
  const fromDaemon = pickDaemonSecret(response, key);
  if (fromDaemon) return fromDaemon;

  // 2. Fall back to VS Code secret store (daemon unreachable, or key unset).
  const vscodeKey = key === 'linearApiKey'
    ? 'rtContext.linearApiKey'
    : 'rtContext.gitlabToken';
  return context.secrets.get(vscodeKey);
}

/**
 * Store a secret in both ~/.mattstack/rt/secrets.json AND VS Code's secret store.
 * This keeps both locations in sync during the transition period.
 */
export async function setSecret(
  context: vscode.ExtensionContext,
  key: DaemonSecretKey,
  value: string,
): Promise<void> {
  // 1. Write to shared file
  const rtSecrets = readRtSecrets();
  rtSecrets[key] = value;
  writeRtSecrets(rtSecrets);

  // 2. Also write to VS Code secrets (backward compatibility)
  const vscodeKey = key === 'linearApiKey'
    ? 'rtContext.linearApiKey'
    : 'rtContext.gitlabToken';
  await context.secrets.store(vscodeKey, value);
}
