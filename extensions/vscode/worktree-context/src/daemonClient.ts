/**
 * Daemon HTTP client for VS Code extension.
 *
 * Communicates with the rt daemon via HTTP over Unix socket (~/.rt/rt.sock).
 * Uses node:http (not fetch) since VS Code extensions run in Node.js,
 * and node:http supports the `socketPath` option natively.
 *
 * Returns null when daemon is unavailable — callers should fall back
 * to direct API calls or cached data.
 */

import * as http from 'http';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SOCK_PATH = join(homedir(), '.rt', 'rt.sock');
const REQUEST_TIMEOUT_MS = 2000;

export interface DaemonResponse {
  ok: boolean;
  data?: any;
  error?: string;
}

/**
 * Send a command to the rt daemon over the Unix socket.
 * Returns null if daemon is not running or unreachable.
 */
export async function daemonQuery(
  cmd: string,
  payload?: Record<string, any>,
): Promise<DaemonResponse | null> {
  if (!existsSync(SOCK_PATH)) return null;

  const hasBody = payload && Object.keys(payload).length > 0;
  const body = hasBody ? JSON.stringify(payload) : undefined;

  return new Promise<DaemonResponse | null>((resolve) => {
    const req = http.request(
      {
        socketPath: SOCK_PATH,
        path: `/${cmd}`,
        method: hasBody ? 'POST' : 'GET',
        headers: hasBody
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body!) }
          : undefined,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(json as DaemonResponse);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Quick check: is the daemon reachable right now?
 */
export async function isDaemonRunning(): Promise<boolean> {
  const response = await daemonQuery('ping');
  return response?.ok === true;
}
