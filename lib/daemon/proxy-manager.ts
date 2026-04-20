/**
 * ProxyManager — in-daemon reverse HTTP/WS proxies for managed processes.
 *
 * Each managed process gets a stable "canonical" port that external clients
 * connect to. When the process restarts on a new ephemeral port, the proxy's
 * upstream is hot-swapped without changing the public-facing port.
 *
 * WebSocket upgrades are forwarded transparently. On setUpstream, all active
 * WS bridges are closed (code 1012, Service Restart) so clients like Parcel
 * HMR reconnect and land on the new upstream.
 */

import type { ServerWebSocket } from "bun";
import { diag } from "../diag-log.ts";

interface WSData {
  path: string;
  protocols?: string[];
  upstream?: WebSocket;
  sendUpstream?: (m: string | ArrayBuffer | Uint8Array | Buffer) => void;
}

interface Bridge {
  client: ServerWebSocket<WSData>;
  upstream: WebSocket;
}

interface ProxyEntry {
  /** null while paused — the Bun server is torn down but the entry is kept. */
  server: ReturnType<typeof Bun.serve> | null;
  canonicalPort: number;
  upstreamPort: number;
  bridges: Set<Bridge>;
  setUpstream: (p: number) => void;
  /**
   * Free-form label for whoever started the proxy, e.g. "runner:assured" or
   * "daemon:recovery". Survives pause/resume. Overwritten by start().
   */
  initiator: string;
  paused: boolean;
}

export interface ProxyInfo {
  id: string;
  canonicalPort: number;
  upstreamPort: number;
  running: boolean;
  paused: boolean;
  initiator: string;
}

export class ProxyManager {
  private proxies = new Map<string, ProxyEntry>();

  /** Current set of proxy ids — cheap snapshot used by diag logs. */
  private idsSnapshot(): string[] {
    return Array.from(this.proxies.keys()).sort();
  }

  start(id: string, canonicalPort: number, upstreamPort: number, initiator: string): void {
    const hadPrevious = this.proxies.has(id);
    // Stop existing proxy for this id if any
    this.stop(id, /* fromStart */ true);

    let currentUpstream = upstreamPort;
    const bridges = new Set<Bridge>();
    let entry!: ProxyEntry;

    const setUpstream = (p: number) => {
      currentUpstream = p;
      entry.upstreamPort = p;
      // Force existing WS bridges to reconnect — they're pinned to the old upstream.
      // Clients (HMR, devtools) reconnect to the same canonical port and land on the new upstream.
      for (const b of bridges) {
        // Client close first so the upstream-close handler doesn't race and overwrite 1012.
        try { b.client.close(1012, "upstream changed"); } catch { /* ignore */ }
        try { b.upstream.close(1000, "upstream changed"); } catch { /* ignore */ }
      }
      bridges.clear();
    };

    const server = Bun.serve<WSData, never>({
      port: canonicalPort,
      fetch(req, srv) {
        const url = new URL(req.url);
        const upgradeHeader = req.headers.get("upgrade")?.toLowerCase();
        if (upgradeHeader === "websocket") {
          const protoHeader = req.headers.get("sec-websocket-protocol");
          const protocols = protoHeader
            ? protoHeader.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined;
          const ok = srv.upgrade(req, {
            data: { path: url.pathname + url.search, protocols },
          });
          if (!ok) return new Response("WebSocket upgrade failed", { status: 400 });
          return undefined;
        }
        const target = `http://localhost:${currentUpstream}${url.pathname}${url.search}`;
        return fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        }).catch((err) => new Response(`Proxy error: ${err}`, { status: 502 }));
      },
      websocket: {
        open(ws) {
          const { path, protocols } = ws.data;
          const wsUrl = `ws://localhost:${currentUpstream}${path}`;
          let upstream: WebSocket;
          try {
            upstream = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
          } catch (err) {
            diag("proxy.ws.upstream.fail", id, { err: String(err), upstream: currentUpstream });
            try { ws.close(1011, "upstream connect failed"); } catch { /* ignore */ }
            return;
          }
          upstream.binaryType = "arraybuffer";
          ws.data.upstream = upstream;
          const bridge: Bridge = { client: ws, upstream };
          bridges.add(bridge);

          const pending: (string | ArrayBuffer | Uint8Array | Buffer)[] = [];
          let upstreamOpen = false;

          upstream.addEventListener("open", () => {
            upstreamOpen = true;
            for (const m of pending) {
              try { upstream.send(m as string | ArrayBufferLike); } catch { /* ignore */ }
            }
            pending.length = 0;
          });
          upstream.addEventListener("message", (ev) => {
            try { ws.send(ev.data as string | Uint8Array); } catch { /* ignore */ }
          });
          upstream.addEventListener("close", (ev) => {
            bridges.delete(bridge);
            try { ws.close(ev.code || 1000, ev.reason || ""); } catch { /* ignore */ }
          });
          upstream.addEventListener("error", () => {
            bridges.delete(bridge);
            try { ws.close(1011, "upstream error"); } catch { /* ignore */ }
          });

          ws.data.sendUpstream = (m) => {
            if (upstreamOpen) {
              try { upstream.send(m as string | ArrayBufferLike); } catch { /* ignore */ }
            } else {
              pending.push(m);
            }
          };
        },
        message(ws, message) {
          ws.data.sendUpstream?.(message);
        },
        close(ws) {
          const upstream = ws.data.upstream;
          if (upstream) {
            try { upstream.close(); } catch { /* ignore */ }
          }
          for (const b of bridges) {
            if (b.client === ws) { bridges.delete(b); break; }
          }
        },
      },
    });

    entry = { server, canonicalPort, upstreamPort, bridges, setUpstream, initiator, paused: false };
    this.proxies.set(id, entry);

    diag("proxy.start", id, {
      canonicalPort, upstreamPort, initiator, replacedPrevious: hadPrevious,
      size: this.proxies.size, ids: this.idsSnapshot(),
    });
  }

  /**
   * Stop the upstream server but keep the entry. `resume` rebinds using the
   * remembered canonical + upstream ports. No-op if already paused or missing.
   */
  pause(id: string): void {
    const entry = this.proxies.get(id);
    if (!entry || entry.paused) return;
    for (const b of entry.bridges) {
      try { b.client.close(1001, "proxy paused"); } catch { /* ignore */ }
      try { b.upstream.close(); } catch { /* ignore */ }
    }
    entry.bridges.clear();
    try { entry.server?.stop(true); } catch { /* ignore */ }
    entry.server = null;
    entry.paused = true;
    diag("proxy.pause", id, {
      canonicalPort: entry.canonicalPort, upstreamPort: entry.upstreamPort,
      size: this.proxies.size, ids: this.idsSnapshot(),
    });
  }

  /** Rebind a paused entry. No-op if the entry is missing or not paused. */
  resume(id: string): void {
    const entry = this.proxies.get(id);
    if (!entry || !entry.paused) return;
    const { canonicalPort, upstreamPort, initiator } = entry;
    this.start(id, canonicalPort, upstreamPort, initiator);
    diag("proxy.resume", id, {
      canonicalPort, upstreamPort,
      size: this.proxies.size, ids: this.idsSnapshot(),
    });
  }

  /** Hot-swap the upstream port. Next request will be forwarded to the new port. */
  setUpstream(id: string, port: number): void {
    const entry = this.proxies.get(id);
    if (!entry) {
      diag("proxy.setUpstream.miss", id, {
        port, size: this.proxies.size, ids: this.idsSnapshot(),
      });
      throw new Error(`ProxyManager: no proxy running for "${id}"`);
    }
    const prev = entry.upstreamPort;
    const closed = entry.bridges.size;
    entry.setUpstream(port);
    diag("proxy.setUpstream", id, { from: prev, to: port, bridgesClosed: closed });
  }

  stop(id: string, fromStart = false): void {
    const entry = this.proxies.get(id);
    if (entry) {
      for (const b of entry.bridges) {
        // Client close first so the upstream-close handler doesn't race and overwrite the code.
        try { b.client.close(1001, "proxy stopped"); } catch { /* ignore */ }
        try { b.upstream.close(); } catch { /* ignore */ }
      }
      entry.bridges.clear();
      try { entry.server?.stop(true); } catch { /* ignore */ }
      this.proxies.delete(id);
      diag(fromStart ? "proxy.stop.replace" : "proxy.stop", id, {
        size: this.proxies.size, ids: this.idsSnapshot(),
      });
    } else if (!fromStart) {
      diag("proxy.stop.miss", id, {
        size: this.proxies.size, ids: this.idsSnapshot(),
      });
    }
  }

  getStatus(id: string): ProxyInfo | null {
    const entry = this.proxies.get(id);
    if (!entry) return null;
    return {
      id,
      canonicalPort: entry.canonicalPort,
      upstreamPort:  entry.upstreamPort,
      running:       !entry.paused,
      paused:        entry.paused,
      initiator:     entry.initiator,
    };
  }

  list(): ProxyInfo[] {
    return Array.from(this.proxies.entries()).map(([id, entry]) => ({
      id,
      canonicalPort: entry.canonicalPort,
      upstreamPort:  entry.upstreamPort,
      running:       !entry.paused,
      paused:        entry.paused,
      initiator:     entry.initiator,
    }));
  }

  stopAll(): void {
    diag("proxy.stopAll", "", { size: this.proxies.size, ids: this.idsSnapshot() });
    for (const id of this.proxies.keys()) this.stop(id);
  }
}
