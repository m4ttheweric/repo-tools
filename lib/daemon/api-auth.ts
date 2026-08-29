/**
 * Local-token auth for the :9401 API server.
 *
 * The server binds to 127.0.0.1, and CORS is default-deny (only a trusted
 * Origin gets its response readable), but CORS alone does not stop a
 * malicious web page from firing a mutating request in the first place -- it
 * only stops the page from reading the reply. Requiring a custom header
 * (X-RT-Token) on those routes forces a CORS preflight the page can't satisfy
 * (it can't read the token), blocking cross-site control while leaving reads
 * open for convenience.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { RT_DIR } from "../daemon-config.ts";
import { lazyChildLogger } from "../daemon-logger.ts";
import { getSetting } from "../settings/resolve.ts";

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
 * api-server.ts and the secrets handler: before this, api-server
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

/**
 * True when a request mutates state, or (secrets/notifications) returns or
 * drains something a GET should not silently consume, and must present the
 * local token. A CORS preflight (OPTIONS) can never present the custom
 * X-RT-Token header, so it is never gated, on any path. Otherwise
 * default-gated for every method except GET/HEAD (an allowlist-by-path
 * approach guarantees the next mutating route would ship unguarded), plus two
 * explicit GET exceptions whose verb lies about being a read.
 */
export function needsToken(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return false;
  if (method === "GET" || method === "HEAD") {
    // Gated despite being a GET: /api/secrets's response body IS a
    // credential; /api/notifications DRAINS the queue, so its
    // verb lies about being a read the way every other GET here is not.
    if (pathname === "/api/secrets") return true;
    if (pathname === "/api/notifications") return true;
    return false;
  }
  return true;
}

/** True when the presented token matches the configured one (and one exists). */
export function tokenOk(provided: string | null, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}

/**
 * `rt.trustedBrowserOrigins` -- see registry-defs.ts. Read fresh on every
 * call (the settings resolver is deliberately unmemoized), wrapped in a
 * try/catch since a request-path settings read must never 500 the daemon
 * over a malformed store file.
 */
export function getTrustedBrowserOrigins(): readonly string[] {
  try {
    const resolved = getSetting<string[]>("rt.trustedBrowserOrigins");
    return Array.isArray(resolved.value) ? resolved.value : [];
  } catch {
    return [];
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(origin);
}

/**
 * The 127.0.0.1 trust boundary: the daemon binds loopback-only,
 * but any web page the user visits also runs on 127.0.0.1 and can send a
 * request. A request with NO Origin header at all is not a browser fetch --
 * it is the CLI, the Swift tray, rt-client from a Bun/Node process, or the
 * VS Code extension, none of which send one -- so it is trusted unchanged.
 * A request that DOES carry an Origin header is trusted only if it presents
 * the local api-token or its Origin is on the explicit allowlist.
 */
export function isBrowserRequestTrusted(
  origin: string | null,
  token: string | null,
  apiToken: string,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (tokenOk(token, apiToken)) return true;
  return isOriginAllowed(origin, allowedOrigins);
}

/**
 * Same trust decision as isBrowserRequestTrusted, but resolves the allowlist
 * lazily: getAllowedOrigins() only runs when an Origin header is present.
 * getTrustedBrowserOrigins does synchronous disk I/O on the settings store,
 * and the vast majority of :9401 traffic (the CLI, the tray, rt-client from a
 * Bun/Node process) carries no Origin at all, so it must never pay that cost.
 */
export function resolveOriginTrust(
  origin: string | null,
  presentedToken: string | null,
  apiToken: string,
  getAllowedOrigins: () => readonly string[] = getTrustedBrowserOrigins,
): boolean {
  if (!origin) return true;
  return isBrowserRequestTrusted(origin, presentedToken, apiToken, getAllowedOrigins());
}

/**
 * A browser CORS preflight (OPTIONS) cannot carry the X-RT-Token value
 * itself -- only Access-Control-Request-Headers names it as a header the
 * follow-up request will use -- so an off-allowlist Origin that intends to
 * authenticate with the token must be granted the preflight on trust alone.
 * tokenOk() still gates the actual request; this only lets the browser send it.
 */
export function isTokenPreflight(method: string, requestHeaders: string | null): boolean {
  if (method !== "OPTIONS" || !requestHeaders) return false;
  return requestHeaders
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .includes("x-rt-token");
}
