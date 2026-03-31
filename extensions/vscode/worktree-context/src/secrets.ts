/**
 * Shared secrets reader for the VS Code extension.
 *
 * Reads from ~/.rt/secrets.json (shared with the rt CLI),
 * falling back to VS Code's secret store for backward compatibility.
 *
 * Write operations update BOTH stores so the CLI and extension stay in sync.
 */

import * as vscode from 'vscode';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SECRETS_PATH = join(homedir(), '.rt', 'secrets.json');

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
  const dir = join(homedir(), '.rt');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}

/**
 * Get a secret, preferring ~/.rt/secrets.json over VS Code's secret store.
 */
export async function getSecret(
  context: vscode.ExtensionContext,
  key: 'linearApiKey' | 'gitlabToken',
): Promise<string | undefined> {
  // 1. Try shared file first
  const rtSecrets = readRtSecrets();
  const fileValue = rtSecrets[key];
  if (fileValue) return fileValue;

  // 2. Fall back to VS Code secret store (legacy)
  const vscodeKey = key === 'linearApiKey'
    ? 'worktreeContext.linearApiKey'
    : 'worktreeContext.gitlabToken';
  return context.secrets.get(vscodeKey);
}

/**
 * Store a secret in both ~/.rt/secrets.json AND VS Code's secret store.
 * This keeps both locations in sync during the transition period.
 */
export async function setSecret(
  context: vscode.ExtensionContext,
  key: 'linearApiKey' | 'gitlabToken',
  value: string,
): Promise<void> {
  // 1. Write to shared file
  const rtSecrets = readRtSecrets();
  rtSecrets[key] = value;
  writeRtSecrets(rtSecrets);

  // 2. Also write to VS Code secrets (backward compatibility)
  const vscodeKey = key === 'linearApiKey'
    ? 'worktreeContext.linearApiKey'
    : 'worktreeContext.gitlabToken';
  await context.secrets.store(vscodeKey, value);
}
