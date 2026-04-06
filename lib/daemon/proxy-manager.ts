/**
 * ProxyManager — in-daemon reverse HTTP proxies for managed processes.
 *
 * Each managed process gets a stable "canonical" port that external clients
 * connect to. When the process restarts on a new ephemeral port, the proxy's
 * upstream is hot-swapped without changing the public-facing port.
 */

interface ProxyEntry {
  server: ReturnType<typeof Bun.serve>;
  canonicalPort: number;
  upstreamPort: number;
}

export class ProxyManager {
  private proxies = new Map<string, ProxyEntry>();

  start(id: string, canonicalPort: number, upstreamPort: number): void {
    // Stop existing proxy for this id if any
    this.stop(id);

    let currentUpstream = upstreamPort;

    const server = Bun.serve({
      port: canonicalPort,
      async fetch(req) {
        const url = new URL(req.url);
        const target = `http://localhost:${currentUpstream}${url.pathname}${url.search}`;
        try {
          return await fetch(target, {
            method: req.method,
            headers: req.headers,
            body: req.body,
          });
        } catch (err) {
          return new Response(`Proxy error: ${err}`, { status: 502 });
        }
      },
    });

    const entry: ProxyEntry = { server, canonicalPort, upstreamPort };
    this.proxies.set(id, entry);

    // `currentUpstream` is captured by the fetch closure; expose a setter via the entry
    // by storing a reference that allows hot-swap through Object mutation.
    // We use the entry object itself — see setUpstream below.
    (entry as ProxyEntry & { _setUpstream?: (p: number) => void })._setUpstream = (p: number) => {
      currentUpstream = p;
      entry.upstreamPort = p;
    };
  }

  /** Hot-swap the upstream port. Next request will be forwarded to the new port. */
  setUpstream(id: string, port: number): void {
    const entry = this.proxies.get(id) as (ProxyEntry & { _setUpstream?: (p: number) => void }) | undefined;
    if (!entry) throw new Error(`ProxyManager: no proxy running for "${id}"`);
    entry._setUpstream?.(port);
  }

  stop(id: string): void {
    const entry = this.proxies.get(id);
    if (entry) {
      try { entry.server.stop(true); } catch { /* ignore */ }
      this.proxies.delete(id);
    }
  }

  getStatus(id: string): { id: string; canonicalPort: number; upstreamPort: number; running: boolean } | null {
    const entry = this.proxies.get(id);
    if (!entry) return null;
    return { id, canonicalPort: entry.canonicalPort, upstreamPort: entry.upstreamPort, running: true };
  }

  list(): { id: string; canonicalPort: number; upstreamPort: number; running: boolean }[] {
    return Array.from(this.proxies.entries()).map(([id, entry]) => ({
      id,
      canonicalPort: entry.canonicalPort,
      upstreamPort: entry.upstreamPort,
      running: true,
    }));
  }

  stopAll(): void {
    for (const id of this.proxies.keys()) this.stop(id);
  }
}
