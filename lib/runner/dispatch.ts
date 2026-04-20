/**
 * Pure runner reducer.
 *
 * `dispatch(action, state)` is the side-effectful-but-runner-local-state-free
 * body of a lane action. It issues daemon IPC calls and returns a DispatchPatch
 * describing how the lanes/laneIdx/entryIdx should change. The caller
 * (doDispatch in runner.tsx) applies the patch, handles optimistic UI state,
 * and runs post-mutate side effects (pane refresh, persistence).
 */

import { daemonQuery } from "../daemon-client.ts";
import {
  proxyWindowName, entryWindowName,
  type LaneConfig, type LaneEntry, type LaneMode,
} from "../runner-store.ts";
import type { EntryState } from "./components/shared.ts";

export type LaneAction =
  | { type: "spawn";        laneId: string; entryId: string }
  | { type: "activate";     laneId: string; entryId: string }
  | { type: "warm-all";     laneId: string }
  | { type: "respawn";      laneId: string; entryId: string }
  | { type: "stop";         laneId: string; entryId: string }
  | { type: "pause-lane";   laneId: string }
  | { type: "restart";      laneId: string; entryId: string }
  | { type: "remove-entry"; laneId: string; entryId: string }
  | { type: "remove-lane";  laneId: string }
  | { type: "toggle-mode";  laneId: string }
  | { type: "reset" };

/**
 * `mutate` is applied to the current lanes inside safeUpdate (not to a stale
 * snapshot), so multiple in-flight dispatches — and concurrent edits from
 * paths like addResolvedEntry — compose instead of clobbering each other.
 */
export type LaneMutation = (lanes: LaneConfig[]) => LaneConfig[];
export type DispatchPatch = {
  mutate?:   LaneMutation;
  laneIdx?:  number;
  entryIdx?: number;
};

export interface DispatchState {
  lanes:       LaneConfig[];
  entryStates: Map<string, EntryState>;
  /** Label recorded on any proxy this dispatch cycle creates. */
  initiator:   string;
}

/** Ensure the proxy for a lane is running (creates it if missing). */
export async function ensureProxy(lane: LaneConfig, initiator: string): Promise<void> {
  const proxyId = proxyWindowName(lane.id);
  const status = await daemonQuery("proxy:status", { id: proxyId });
  const data = status?.data as { running?: boolean; paused?: boolean } | null | undefined;
  if (!status?.ok || !data) {
    const activeEntry = lane.entries.find((e) => e.id === lane.activeEntryId);
    await daemonQuery("proxy:start", {
      id: proxyId,
      canonicalPort: lane.canonicalPort,
      upstreamPort: activeEntry?.ephemeralPort ?? 0,
      initiator,
    });
  } else if (data.paused) {
    // Rebind with the remembered upstream — runner doesn't need to care about port.
    await daemonQuery("proxy:resume", { id: proxyId });
  }
}

/**
 * Start an entry's process via the atomic process:start daemon command.
 * Handles port auto-allocation, command substitution, and proxy upstream routing.
 * Returns the actual ephemeral port used.
 */
export async function startEntry(lane: LaneConfig, entry: LaneEntry): Promise<number> {
  // Auto-heal entries saved with ephemeralPort: 0.
  let ephemeralPort = entry.ephemeralPort;
  if (!ephemeralPort) {
    const win = entryWindowName(lane.id, entry.id);
    const portRes = await daemonQuery("port:allocate", { label: win });
    ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
  }

  const port = String(ephemeralPort);
  const canonicalPort = String(lane.canonicalPort);
  const cmd = entry.commandTemplate
    .replace(/\$\{?PORT\}?/g, port)
    .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);

  const processId = entryWindowName(lane.id, entry.id);

  // process:start is an atomic composite: spawn + group:activate + proxy:set-upstream
  // in a single daemon round-trip — no intermediate window where proxy has no upstream.
  await daemonQuery("process:start", {
    id:            processId,
    cmd,
    cwd:           entry.targetDir,
    env:           { PORT: port, CANONICAL_PORT: canonicalPort },
    groupId:       lane.id,
    canonicalPort: lane.canonicalPort,
    mode:          lane.mode ?? "warm",
  });

  if (entry.remedies?.length) {
    await daemonQuery("remedy:set", { id: processId, remedies: entry.remedies, cwd: entry.targetDir });
  }

  return ephemeralPort;
}

/**
 * Restart an entry's process via the atomic process:restart daemon command.
 * Returns the actual ephemeral port used.
 */
export async function restartEntry(lane: LaneConfig, entry: LaneEntry): Promise<number> {
  let ephemeralPort = entry.ephemeralPort;
  if (!ephemeralPort) {
    const win = entryWindowName(lane.id, entry.id);
    const portRes = await daemonQuery("port:allocate", { label: win });
    ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
  }

  const port = String(ephemeralPort);
  const canonicalPort = String(lane.canonicalPort);
  const cmd = entry.commandTemplate
    .replace(/\$\{?PORT\}?/g, port)
    .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);

  const processId = entryWindowName(lane.id, entry.id);

  // process:restart is an atomic composite: kill (awaited) + spawn + group:activate
  // + proxy:set-upstream in a single daemon round-trip — no proxy-offline window.
  await daemonQuery("process:restart", {
    id:            processId,
    cmd,
    cwd:           entry.targetDir,
    env:           { PORT: port, CANONICAL_PORT: canonicalPort },
    groupId:       lane.id,
    canonicalPort: lane.canonicalPort,
    mode:          lane.mode ?? "warm",
  });

  if (entry.remedies?.length) {
    await daemonQuery("remedy:set", { id: processId, remedies: entry.remedies, cwd: entry.targetDir });
  }

  return ephemeralPort;
}

export async function dispatch(action: LaneAction, s: DispatchState): Promise<DispatchPatch> {
  const { lanes, entryStates, initiator } = s;

  function est(win: string): EntryState {
    return entryStates.get(win) ?? "stopped";
  }

  switch (action.type) {
    case "spawn": {
      const lane = lanes.find((l) => l.id === action.laneId);
      const entry = lane?.entries.find((e) => e.id === action.entryId);
      if (!lane || !entry) return {};
      await ensureProxy(lane, initiator);
      const actualPort = await startEntry(lane, entry);
      return {
        mutate: (ls) => ls.map((l) => {
          if (l.id !== action.laneId) return l;
          return {
            ...l,
            activeEntryId: action.entryId,
            entries: l.entries.map((e) => e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e),
          };
        }),
      };
    }

    case "activate": {
      const lane = lanes.find((l) => l.id === action.laneId);
      const entry = lane?.entries.find((e) => e.id === action.entryId);
      if (!lane || !entry) return {};
      const processId = entryWindowName(lane.id, entry.id);
      const entryState = est(processId);
      await ensureProxy(lane, initiator);
      if (entryState === "stopped" || entryState === "crashed") {
        // Not running — do a full start (spawn + group:activate + proxy)
        const actualPort = await startEntry(lane, entry);
        return {
          mutate: (ls) => ls.map((l) => {
            if (l.id !== action.laneId) return l;
            return {
              ...l,
              activeEntryId: action.entryId,
              entries: l.entries.map((e) => e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e),
            };
          }),
        };
      }
      // Already running or warm — just group:activate (resumes + suspends others)
      // and update proxy upstream.
      await daemonQuery("group:activate", { groupId: lane.id, processId, mode: lane.mode ?? "warm" });
      await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: entry.ephemeralPort });
      return {
        mutate: (ls) => ls.map((l) => l.id === action.laneId ? { ...l, activeEntryId: action.entryId } : l),
      };
    }

    case "warm-all": {
      const lane = lanes.find((l) => l.id === action.laneId);
      if (!lane) return {};
      const activeId = lane.activeEntryId ?? lane.entries[0]?.id;
      await ensureProxy(lane, initiator);
      // Start stopped/crashed entries individually.
      // process:start handles group:activate internally so each entry
      // correctly suspends/resumes others as it starts.
      // For warm-all we want everything spawned, so use process:spawn directly
      // for non-active entries to avoid them suspending each other mid-startup,
      // then do a final group:activate for just the active one.
      const portFixes = new Map<string, number>();
      for (const entry of lane.entries) {
        const win = entryWindowName(lane.id, entry.id);
        const st = est(win);
        if (st === "stopped" || st === "crashed") {
          let ephemeralPort = entry.ephemeralPort;
          if (!ephemeralPort) {
            const portRes = await daemonQuery("port:allocate", { label: win });
            ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
          }
          const port = String(ephemeralPort);
          const canonicalPort = String(lane.canonicalPort);
          const cmd = entry.commandTemplate
            .replace(/\$\{?PORT\}?/g, port)
            .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);
          // Use process:spawn (not process:start) to avoid premature group:activate
          // on non-active entries while others are still starting up.
          await daemonQuery("process:spawn", {
            id: win, cmd, cwd: entry.targetDir,
            env: { PORT: port, CANONICAL_PORT: canonicalPort },
          });
          if (ephemeralPort !== entry.ephemeralPort) portFixes.set(entry.id, ephemeralPort);
        }
      }
      // Activate the designated active entry after all are spawned.
      if (activeId) {
        await daemonQuery("group:activate", {
          groupId: lane.id,
          processId: entryWindowName(lane.id, activeId),
          mode: lane.mode ?? "warm",
        });
        const activeEntry = lane.entries.find((e) => e.id === activeId);
        const activePort = portFixes.get(activeId) ?? activeEntry?.ephemeralPort;
        if (activePort) {
          await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: activePort });
        }
        return {
          mutate: (ls) => ls.map((l) => {
            if (l.id !== action.laneId) return l;
            return {
              ...l,
              activeEntryId: activeId,
              entries: l.entries.map((e) => portFixes.has(e.id) ? { ...e, ephemeralPort: portFixes.get(e.id)! } : e),
            };
          }),
        };
      }
      return {};
    }

    case "respawn": {
      // Re-run port allocation and command substitution via process:start.
      // This prevents a stale command stored in the daemon from being replayed.
      const lane = lanes.find((l) => l.id === action.laneId);
      const entry = lane?.entries.find((e) => e.id === action.entryId);
      if (!lane || !entry) return {};
      await ensureProxy(lane, initiator);
      const actualPort = await startEntry(lane, entry);
      return {
        mutate: (ls) => ls.map((l) => {
          if (l.id !== action.laneId) return l;
          return {
            ...l,
            activeEntryId: action.entryId,
            entries: l.entries.map((e) => e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e),
          };
        }),
      };
    }

    case "stop": {
      const win = entryWindowName(action.laneId, action.entryId);
      await daemonQuery("process:kill", { id: win });
      return {};
    }

    case "restart": {
      // Single atomic round-trip: kill (awaited in daemon) → spawn → activate → proxy.
      const lane = lanes.find((l) => l.id === action.laneId);
      const entry = lane?.entries.find((e) => e.id === action.entryId);
      if (!lane || !entry) return {};
      await ensureProxy(lane, initiator);
      const actualPort = await restartEntry(lane, entry);
      return {
        mutate: (ls) => ls.map((l) => {
          if (l.id !== action.laneId) return l;
          return {
            ...l,
            activeEntryId: action.entryId,
            entries: l.entries.map((e) => e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e),
          };
        }),
      };
    }

    case "pause-lane": {
      // Stop the proxy — frees the canonical port.
      // All processes keep running; only the proxy is torn down.
      // [S] (warm-all) will restart the proxy and re-route traffic.
      const lane = lanes.find((l) => l.id === action.laneId);
      if (!lane) return {};
      await daemonQuery("proxy:stop", { id: proxyWindowName(action.laneId) });
      return {};
    }

    case "remove-entry": {
      const lane = lanes.find((l) => l.id === action.laneId);
      if (!lane) return {};
      const win = entryWindowName(action.laneId, action.entryId);
      await daemonQuery("remedy:clear", { id: win }); // unregister before kill (Fix 2)
      await daemonQuery("process:kill", { id: win });
      await daemonQuery("group:remove-member", { groupId: lane.id, processId: win });
      await daemonQuery("port:release", { label: win });
      await daemonQuery("process:remove", { id: win }); // free daemon-side maps

      // Proxy re-point uses the captured lane — accurate at dispatch time
      // even if other entries are added later; the mutator re-derives the
      // activeEntryId against the live lanes list.
      const nextEntries = lane.entries.filter((e) => e.id !== action.entryId);
      const nextActive = lane.activeEntryId === action.entryId ? nextEntries[0]?.id : lane.activeEntryId;
      if (nextActive && nextActive !== lane.activeEntryId) {
        const e = nextEntries.find((e) => e.id === nextActive);
        if (e) await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: e.ephemeralPort });
      }
      return {
        mutate: (ls) => ls.map((l) => {
          if (l.id !== action.laneId) return l;
          const filtered = l.entries.filter((e) => e.id !== action.entryId);
          const newActive = l.activeEntryId === action.entryId ? filtered[0]?.id : l.activeEntryId;
          return { ...l, entries: filtered, activeEntryId: newActive };
        }),
        entryIdx: 0,
      };
    }

    case "remove-lane": {
      const lane = lanes.find((l) => l.id === action.laneId);
      if (!lane) return {};
      // Unregister remedies before killing processes (Fix 2: prevents orphan spawns)
      await Promise.all(lane.entries.map((e) => daemonQuery("remedy:clear", { id: entryWindowName(action.laneId, e.id) })));
      await Promise.all(lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(action.laneId, e.id) })));
      await daemonQuery("proxy:stop", { id: proxyWindowName(action.laneId) });
      await daemonQuery("group:remove", { id: action.laneId });
      for (const e of lane.entries) {
        await daemonQuery("port:release", { label: entryWindowName(action.laneId, e.id) });
        await daemonQuery("process:remove", { id: entryWindowName(action.laneId, e.id) });
      }
      return {
        mutate: (ls) => ls.filter((l) => l.id !== action.laneId),
        entryIdx: 0,
        // laneIdx auto-clamped to new length in doDispatch
      };
    }

    case "toggle-mode": {
      const lane = lanes.find((l) => l.id === action.laneId);
      if (!lane) return {};
      const newMode: LaneMode = (lane.mode ?? "warm") === "warm" ? "single" : "warm";
      return {
        mutate: (ls) => ls.map((l) => l.id === action.laneId ? { ...l, mode: newMode } : l),
      };
    }

    case "reset": {
      await Promise.all(
        lanes.flatMap((lane) => [
          ...lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(lane.id, e.id) })),
          daemonQuery("proxy:stop", { id: proxyWindowName(lane.id) }),
          daemonQuery("group:remove", { id: lane.id }),
        ])
      );
      // After kills complete, free all daemon-side per-process state so
      // spawnConfigs/stateStore/logBuffer don't accumulate across resets.
      await Promise.all(
        lanes.flatMap((lane) => lane.entries.map((e) =>
          daemonQuery("process:remove", { id: entryWindowName(lane.id, e.id) }))),
      );
      return {
        mutate: () => [],
        laneIdx: 0,
        entryIdx: 0,
      };
    }
  }
}
