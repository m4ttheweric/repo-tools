/**
 * Daemon HTTP + WebSocket client for VS Code extension.
 *
 * Communicates with the rt daemon via:
 *  1. HTTP REST API at http://localhost:9401 (for queries)
 *  2. WebSocket at ws://localhost:9401/ws (for live updates)
 *
 * Falls back gracefully when daemon is unavailable.
 */

import * as vscode from 'vscode';

const API_BASE = 'http://localhost:9401';
const WS_URL = 'ws://localhost:9401/ws';
const REQUEST_TIMEOUT_MS = 2000;
const WS_RECONNECT_DELAY_MS = 10_000;

// ── Types ──

export interface DaemonResponse {
  ok: boolean;
  data?: any;
  error?: string;
}

export interface DaemonEvent {
  type: 'status' | 'ports' | 'notification';
  data: any;
  timestamp: number;
}

// ── HTTP Client ──

/**
 * Query the daemon's REST API. Returns null if daemon is unavailable.
 */
export async function daemonQuery(
  path: string,
  options?: { method?: string; body?: any },
): Promise<DaemonResponse | null> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const method = options?.method ?? 'GET';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const fetchOptions: RequestInit = {
      method,
      signal: controller.signal,
      headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    };

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeout);

    return await response.json() as DaemonResponse;
  } catch {
    return null;
  }
}

/**
 * Quick check: is the daemon reachable right now?
 */
export async function isDaemonRunning(): Promise<boolean> {
  const response = await daemonQuery('/api/status');
  return response?.ok === true;
}

/**
 * Fetch a single branch's cached data from the daemon.
 */
export async function fetchBranchFromDaemon(
  branch: string,
): Promise<DaemonResponse | null> {
  return daemonQuery(`/api/cache/${encodeURIComponent(branch)}`);
}

// ── WebSocket Client ──

type EventHandler = (event: DaemonEvent) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let eventHandlers: EventHandler[] = [];
let isConnecting = false;

/**
 * Register a handler for daemon events (status, ports, notification).
 * Returns a Disposable that removes the handler.
 */
export function onDaemonEvent(handler: EventHandler): vscode.Disposable {
  eventHandlers.push(handler);
  return new vscode.Disposable(() => {
    eventHandlers = eventHandlers.filter(h => h !== handler);
  });
}

/**
 * Start the WebSocket connection to the daemon.
 * Automatically reconnects on disconnect.
 */
export function connectWebSocket(): void {
  if (ws || isConnecting) return;
  isConnecting = true;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      isConnecting = false;
      console.log('[rt-context] WebSocket connected to daemon');

      // Clear any pending reconnect
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as DaemonEvent;
        for (const handler of eventHandlers) {
          try { handler(parsed); } catch { /* handler error */ }
        }
      } catch {
        // Invalid JSON — ignore
      }
    };

    ws.onclose = () => {
      ws = null;
      isConnecting = false;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this — reconnect handled there
      ws?.close();
    };
  } catch {
    ws = null;
    isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWebSocket();
  }, WS_RECONNECT_DELAY_MS);
}

/**
 * Close the WebSocket connection and stop reconnecting.
 */
export function disconnectWebSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (ws) {
    ws.onclose = null; // Prevent auto-reconnect on intentional close
    ws.close();
    ws = null;
  }
  isConnecting = false;
  eventHandlers = [];
}
