/**
 * Minimal raw Chrome DevTools Protocol client over a WebSocket. Only the
 * surface browser-login needs: request/response correlation by id, event
 * subscription, and a flat-session send. The dispatcher is split from the
 * transport so message framing is unit-testable without a live browser.
 */

export function createCdpDispatcher(sendRaw: (json: string) => void) {
  let id = 0;
  const pending = new Map<number, (result: any, error?: any) => void>();
  const listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>();

  function handleMessage(json: string): void {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const resolver = pending.get(msg.id);
      if (!resolver) return;
      pending.delete(msg.id);
      resolver(msg.result, msg.error);
      return;
    }
    if (typeof msg.method === "string") {
      for (const cb of listeners.get(msg.method) ?? []) cb(msg.params ?? {}, msg.sessionId);
    }
  }

  function request(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, (result, error) => (error ? reject(new Error(error.message ?? "CDP error")) : resolve(result)));
      sendRaw(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  }

  function on(event: string, cb: (params: any, sessionId?: string) => void): void {
    const arr = listeners.get(event) ?? [];
    arr.push(cb);
    listeners.set(event, arr);
  }

  return { handleMessage, request, on };
}

export interface CdpSocket {
  send(method: string, params?: any, sessionId?: string): Promise<any>;
  on(event: string, cb: (params: any, sessionId?: string) => void): void;
  close(): void;
}

export async function browserWebSocketUrl(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const body = (await res.json()) as { webSocketDebuggerUrl: string };
  return body.webSocketDebuggerUrl;
}

export async function connectCdp(webSocketDebuggerUrl: string): Promise<CdpSocket> {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const dispatcher = createCdpDispatcher(json => ws.send(json));
  ws.addEventListener("message", e => dispatcher.handleMessage(e.data as string));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")));
  });
  return {
    send: (method, params, sessionId) => dispatcher.request(method, params, sessionId),
    on: (event, cb) => dispatcher.on(event, cb),
    close: () => ws.close(),
  };
}
