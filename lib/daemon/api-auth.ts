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
import { lazyChildLogger } from "../daemon-logger.ts";

const log = lazyChildLogger("api-auth");

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
  } catch (err) {
    log.warn({ err, tokenPath }, "could not persist api-token; enforced in-memory only this run, so a client reading the file will disagree until the daemon restarts");
  }
  return token;
}

/**
 * `getApiToken`/`reloadApiToken` share ONE in-memory value between
 * api-server.ts and the secrets handler (S054): before this, api-server
 * captured a token once at boot while the secrets handler called
 * `loadOrCreateApiToken()` fresh on every request, so an external rotation
 * (deleting api-token to force a new one) left the two permanently
 * disagreeing about which token is current -- and if the token dir was
 * unwritable, the secrets handler regenerated a brand new random token on
 * every single call, never matching anything a client could read from disk.
 * Both consumers now read the SAME cached value; a rotation only takes
 * effect for both after `reloadApiToken()` runs or the daemon restarts,
 * either of which was already the closest thing to a happy path before.
 */
let cachedApiToken: string | null = null;

export function getApiToken(tokenPath: string = API_TOKEN_PATH): string {
  if (cachedApiToken === null) cachedApiToken = loadOrCreateApiToken(tokenPath);
  return cachedApiToken;
}

export function reloadApiToken(tokenPath: string = API_TOKEN_PATH): string {
  cachedApiToken = loadOrCreateApiToken(tokenPath);
  return cachedApiToken;
}

/** True when a request mutates state, or (secrets) returns raw credential values, and must present the local token. */
export function needsToken(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return false;
  if (pathname === "/api/shutdown") return true;
  if (pathname === "/api/sdm/reconnect") return true;
  if (pathname === "/api/events/emit") return true;
  // Gated despite being a GET: every other read-only route returns metadata
  // (branch names, MR titles, ports) safe under the open-CORS "reads are
  // free" policy above; this one's response body IS the credential.
  if (pathname === "/api/secrets") return true;
  return false;
}

/** True when the presented token matches the configured one (and one exists). */
export function tokenOk(provided: string | null, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}
