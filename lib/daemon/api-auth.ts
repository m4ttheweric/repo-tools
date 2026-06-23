/**
 * Local-token auth for the :9401 API server.
 *
 * The server binds to 127.0.0.1, but CORS is `*`, so a malicious web page could
 * still drive *mutating* endpoints via the browser. Requiring a custom header
 * (X-RT-Token) on those routes forces a CORS preflight the page can't satisfy
 * (it can't read the token), blocking cross-site control while leaving reads
 * open for convenience.
 */

const CONTROL_PATH = /^\/api\/processes\/[^/]+\/(start|restart|stop)$/;

/** True when a request mutates state and must present the local token. */
export function needsToken(method: string, pathname: string): boolean {
  if (method === "OPTIONS") return false;
  if (pathname === "/api/shutdown") return true;
  if (method === "POST" && pathname === "/api/processes") return true; // launch a command
  if (method === "POST" && pathname === "/api/terminals") return true; // open a shell session
  if (method === "POST" && CONTROL_PATH.test(pathname)) return true;
  if (method === "POST" && (pathname === "/api/endpoints/map" || pathname === "/api/endpoints/unmap")) return true;
  if (method === "POST" && (pathname === "/api/endpoints/bounce-enable" || pathname === "/api/endpoints/bounce-disable")) return true;
  return false;
}

/** True when the presented token matches the configured one (and one exists). */
export function tokenOk(provided: string | null, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}
