import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { TiltResource } from "@tilt-launcher/sdk";
import type { ResolvedWorktree } from "../lib";

// ── Types ──────────────────────────────────────────────────

export interface DashboardViewProps {
  resolved: ResolvedWorktree[];
  snapshots: Map<number, TiltResource[]>;
  proxyConfigs: Map<string, { port: number }>;
  tiltBasePort: number;
}

// ── Status helpers ─────────────────────────────────────────

export function getStatusIcon(r: TiltResource): { icon: string; color: string } {
  if (r.runtimeStatus === "error") return { icon: "✗", color: "red" };
  if (r.runtimeStatus === "ok" && r.lastBuildError) return { icon: "⚠", color: "yellow" };
  if (r.runtimeStatus === "ok") return { icon: "✓", color: "green" };
  if (r.isDisabled) return { icon: "○", color: "gray" };
  return { icon: "·", color: "gray" };
}

export function getStatusDetail(r: TiltResource): { text: string; color: string } | null {
  if (r.runtimeStatus === "error") {
    const msg = r.lastBuildError ? truncate(r.lastBuildError, 60) : "error";
    return { text: msg, color: "red" };
  }
  if (r.runtimeStatus === "ok" && r.lastBuildError) {
    return { text: truncate(r.lastBuildError, 60), color: "yellow" };
  }
  if (r.runtimeStatus === "pending" && r.waitingOn?.length) {
    return { text: `waiting: ${r.waitingOn.join(", ")}`, color: "gray" };
  }
  if (r.runtimeStatus === "pending") {
    return { text: "pending", color: "gray" };
  }
  if (r.isDisabled) {
    return { text: "disabled", color: "gray" };
  }
  return null;
}

function truncate(s: string, max: number): string {
  const line = s.split("\n")[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function wtLabel(rw: ResolvedWorktree): string {
  return rw.dir.split("/").pop() ?? rw.dir;
}

// ── Presentational components ──────────────────────────────

export function ResourceRow({ resource }: { resource: TiltResource }) {
  const { icon, color } = getStatusIcon(resource);
  const detail = getStatusDetail(resource);
  const isPending = resource.runtimeStatus === "pending";

  return (
    <Box marginLeft={4} gap={1}>
      {isPending ? (
        <Text color="cyan"><Spinner type="dots" /></Text>
      ) : (
        <Text color={color}>{icon}</Text>
      )}
      <Text>{resource.name}</Text>
      {detail && <Text color={detail.color}>{detail.text}</Text>}
    </Box>
  );
}

export function WorktreePanel({
  worktree,
  resources,
  port,
}: {
  worktree: ResolvedWorktree;
  resources: TiltResource[] | undefined;
  port: number;
}) {
  const label = wtLabel(worktree);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color="green">●</Text>
        <Text bold>{label}</Text>
        <Text dimColor>{worktree.branch}</Text>
        <Text dimColor>tilt</Text>
        <Text color="cyan">{`http://localhost:${port}`}</Text>
      </Box>
      {resources && resources.length > 0 ? (
        resources.map((r) => <ResourceRow key={r.name} resource={r} />)
      ) : (
        <Box marginLeft={4} gap={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text dimColor>connecting to tilt…</Text>
        </Box>
      )}
    </Box>
  );
}

export function StatusFooter({ snapshots, total }: { snapshots: Map<number, TiltResource[]>; total: number }) {
  const allConnected = total > 0 && snapshots.size >= total;
  const allHealthy = allConnected && [...snapshots.values()].every(
    (resources) => resources.every((r) => r.runtimeStatus === "ok" || r.runtimeStatus === "not_applicable" || r.isDisabled),
  );
  const hasErrors = [...snapshots.values()].some(
    (resources) => resources.some((r) => r.runtimeStatus === "error" || (r.runtimeStatus === "ok" && r.lastBuildError)),
  );

  return (
    <Box>
      <Text>  </Text>
      {allHealthy ? (
        <><Text color="green">All services healthy.</Text><Text dimColor> Ctrl+C to stop.</Text></>
      ) : hasErrors ? (
        <><Text color="yellow">Some services have errors.</Text><Text dimColor> Ctrl+C to stop.</Text></>
      ) : (
        <Text dimColor>Ctrl+C to stop.</Text>
      )}
    </Box>
  );
}

/** Pure presentational dashboard — no side effects, no TiltClient. */
export function DashboardView({
  resolved,
  snapshots,
  proxyConfigs,
  tiltBasePort,
}: DashboardViewProps) {
  const hasProxy = proxyConfigs.size > 0;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>  dev-proxy orchestrator</Text>
      </Box>

      {resolved.map((rw, i) => (
        <WorktreePanel
          key={i}
          worktree={rw}
          resources={snapshots.get(i)}
          port={tiltBasePort + i}
        />
      ))}

      {hasProxy && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>  Proxies:</Text>
          {[...proxyConfigs.entries()].map(([name, pc]) => (
            <Box key={name} marginLeft={4} gap={1}>
              <Text>{name.padEnd(10)}</Text>
              <Text color="cyan">{`http://localhost:${pc.port}`}</Text>
            </Box>
          ))}
        </Box>
      )}

      <StatusFooter snapshots={snapshots} total={resolved.length} />
    </Box>
  );
}
