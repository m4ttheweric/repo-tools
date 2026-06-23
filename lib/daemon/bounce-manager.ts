/**
 * Hosts bounce endpoints: one Bun.serve per canonical port that 302s OAuth
 * callbacks back to the app's real origin. Logic lives in resolveBounce; this
 * class owns the socket lifecycle (parallel to ProxyManager).
 */
import { resolveBounce } from "./bounce.ts";

interface Entry { server: ReturnType<typeof Bun.serve>; port: number }

export class BounceManager {
  private entries = new Map<string, Entry>();

  start(id: string, port: number, deps: { returnParam: string; allowedOrigins: () => Set<string> }): void {
    this.stop(id);
    const server = Bun.serve({
      port,
      fetch(req) {
        const r = resolveBounce(req.url, deps.returnParam, deps.allowedOrigins());
        if (r.status === 302 && r.location) return new Response(null, { status: 302, headers: { location: r.location } });
        return new Response(r.body ?? "bad request", { status: r.status });
      },
    });
    this.entries.set(id, { server, port });
  }

  stop(id: string): void {
    const e = this.entries.get(id);
    if (e) { try { e.server.stop(true); } catch { /* ignore */ } this.entries.delete(id); }
  }

  stopAll(): void { for (const id of [...this.entries.keys()]) this.stop(id); }

  list(): { id: string; port: number }[] {
    return [...this.entries.entries()].map(([id, e]) => ({ id, port: e.port }));
  }
}
