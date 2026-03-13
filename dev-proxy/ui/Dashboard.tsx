/**
 * Dashboard connector — wires TiltClient lifecycle to the presentational DashboardView.
 *
 * This is the only file with side effects (TiltClient, useEffect).
 * All rendering is delegated to DashboardView.tsx.
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { TiltClient, type TiltResource } from "@tilt-launcher/sdk";
import type { ResolvedWorktree } from "../lib";
import { DashboardView } from "./DashboardView.tsx";

// ── Types ──────────────────────────────────────────────────

export interface DashboardProps {
  resolved: ResolvedWorktree[];
  proxyConfigs: Map<string, { port: number }>;
  tiltBasePort: number;
  configResourceNames: Set<string>;
  onShutdownReady?: (cleanup: () => void) => void;
}

// ── Custom hook: TiltClient lifecycle ──────────────────────

function useTiltWatcher(
  resolved: ResolvedWorktree[],
  tiltBasePort: number,
  configResourceNames: Set<string>,
  onShutdownReady?: (cleanup: () => void) => void,
) {
  const [snapshots, setSnapshots] = useState<Map<number, TiltResource[]>>(new Map());
  const clientsRef = useRef<TiltClient[]>([]);
  const cleanupRef = useRef<Array<() => void>>([]);

  const filterResources = useCallback(
    (resources: TiltResource[]) => resources.filter((r) => configResourceNames.has(r.name)),
    [configResourceNames],
  );

  const mergeSnapshot = useCallback(
    (index: number, incoming: TiltResource[]) => {
      const filtered = filterResources(incoming);
      if (filtered.length === 0) return;

      setSnapshots((prev) => {
        const next = new Map(prev);
        const existing = next.get(index) ?? [];
        const merged = new Map(existing.map((r) => [r.name, r]));
        for (const r of filtered) merged.set(r.name, r);
        next.set(index, [...merged.values()]);
        return next;
      });
    },
    [filterResources],
  );

  useEffect(() => {
    let stopped = false;

    async function connect(index: number) {
      const port = tiltBasePort + index;
      const client = new TiltClient(port);
      clientsRef.current.push(client);

      // Wait for reachability
      let attempts = 0;
      while (attempts < 60 && !stopped) {
        if (await client.isReachable()) break;
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
      }
      if (stopped) return;

      // Initial fetch
      try {
        const resources = await client.getResources();
        mergeSnapshot(index, resources);
      } catch { /* tilt may have crashed */ }
      if (stopped) return;

      // Watch for live updates, fall back to polling
      try {
        const stop = await client.watch((event) => {
          if (event.resources.length > 0 && !stopped) {
            mergeSnapshot(index, event.resources);
          }
        });
        cleanupRef.current.push(stop);
      } catch {
        const poll = setInterval(async () => {
          if (stopped) { clearInterval(poll); return; }
          try {
            const resources = await client.getResources();
            mergeSnapshot(index, resources);
          } catch { /* tilt may be restarting */ }
        }, 5000);
        cleanupRef.current.push(() => clearInterval(poll));
      }
    }

    for (let i = 0; i < resolved.length; i++) {
      connect(i);
    }

    const cleanup = () => {
      stopped = true;
      for (const fn of cleanupRef.current) {
        try { fn(); } catch { /* already closed */ }
      }
      for (const client of clientsRef.current) {
        try { client.close(); } catch { /* already closed */ }
      }
    };
    onShutdownReady?.(cleanup);

    return cleanup;
  }, [resolved, tiltBasePort, mergeSnapshot, onShutdownReady]);

  return snapshots;
}

// ── Connector component ────────────────────────────────────

export function Dashboard({
  resolved,
  proxyConfigs,
  tiltBasePort,
  configResourceNames,
  onShutdownReady,
}: DashboardProps) {
  const snapshots = useTiltWatcher(resolved, tiltBasePort, configResourceNames, onShutdownReady);

  return (
    <DashboardView
      resolved={resolved}
      snapshots={snapshots}
      proxyConfigs={proxyConfigs}
      tiltBasePort={tiltBasePort}
    />
  );
}
