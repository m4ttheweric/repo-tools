/**
 * Process REST surface for the :9401 API server — pure mapping of (method,
 * pathname) to a daemon command + payload. Kept separate from daemon.ts so the
 * routing table is unit-testable without starting a server.
 *
 *   GET  /api/processes              -> process:describe  (enriched list)
 *   POST /api/processes/:id/start    -> process:respawn   (start via stored config)
 *   POST /api/processes/:id/restart  -> process:respawn
 *   POST /api/processes/:id/stop     -> process:stop      (kill)
 */

export interface ApiRouteMatch {
  cmd: string;
  payload: any;
}

const CONTROL_ACTIONS: Record<string, string> = {
  start: "process:respawn",
  restart: "process:respawn",
  stop: "process:stop",
};

export function matchProcessApiRoute(method: string, pathname: string): ApiRouteMatch | null {
  if (pathname === "/api/processes") {
    return method === "GET" ? { cmd: "process:describe", payload: {} } : null;
  }

  const m = pathname.match(/^\/api\/processes\/([^/]+)\/([^/]+)$/);
  if (m) {
    if (method !== "POST") return null;
    const id = decodeURIComponent(m[1]!);
    const cmd = CONTROL_ACTIONS[m[2]!];
    return cmd ? { cmd, payload: { id } } : null;
  }

  return null;
}
