/**
 * Local-token auth for the :9401 API server.
 *
 * The server binds to 127.0.0.1, but CORS is `*`, so a malicious web page could
 * still drive *mutating* endpoints via the browser. Requiring a custom header
 * (X-RT-Token) on those routes forces a CORS preflight the page can't satisfy
 * (it can't read the token), blocking cross-site control while leaving reads
 * open for convenience.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { RT_DIR } from "../daemon-config.ts";

/** Where the local API token is persisted (0600) for trusted local clients. */
export const API_TOKEN_PATH = join(RT_DIR, "api-token");

/**
 * Load the local token gating mutating :9401 routes, generating and persisting
 * a fresh one on first run. Trusted local clients (CLI, GUI) read the file;
 * if persisting fails the token is still enforced in-memory for this run.
 */
export function loadOrCreateApiToken(tokenPath: string = API_TOKEN_PATH): string {
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch { /* fall through to regenerate */ }
  const token = randomUUID();
  try {
    mkdirSync(RT_DIR, { recursive: true });
    writeFileSync(tokenPath, token, { mode: 0o600 });
  } catch { /* best-effort; token still enforced in-memory this run */ }
  return token;
}

/** True when a request mutates state and must present the local token. */
export function needsToken(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return false;
  if (pathname === "/api/shutdown") return true;
  if (pathname === "/api/sdm/reconnect") return true;
  if (pathname === "/api/events/emit") return true;
  return false;
}

/** True when the presented token matches the configured one (and one exists). */
export function tokenOk(provided: string | null, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}
