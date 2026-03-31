/**
 * rt status — Instant branch dashboard from daemon cache.
 *
 * Usage:
 *   rt status           show dashboard once
 *   rt status --watch   live-update every 15s
 *
 * Displays MR state, pipeline status, review progress, blockers,
 * Linear ticket info, and running ports for each branch.
 */

import { bold, cyan, dim, green, yellow, red, reset, blue } from "../lib/tui.ts";
import type { MRDashboardProps } from "../lib/enrich.ts";
import type { PortEntry } from "../lib/port-scanner.ts";

// ─── Icons ──────────────────────────────────────────────────────────────────

const PIPELINE_ICONS: Record<string, string> = {
  SUCCESS: `${green}✓${reset}`,
  FAILED: `${red}✗${reset}`,
  RUNNING: `${cyan}⟳${reset}`,
  PENDING: `${dim}◌${reset}`,
  CANCELED: `${dim}⊘${reset}`,
  SKIPPED: `${dim}⊘${reset}`,
  CREATED: `${dim}◌${reset}`,
  MANUAL: `${yellow}▶${reset}`,
  WAITING_FOR_RESOURCE: `${dim}◌${reset}`,
};

const STATE_ICONS: Record<string, string> = {
  opened: `${green}◉${reset}`,
  merged: `${blue}◆${reset}`,
  closed: `${dim}◯${reset}`,
};

// ─── Data fetching ──────────────────────────────────────────────────────────

interface CacheEntry {
  ticket: { identifier: string; title: string; stateName?: string; stateColor?: string } | null;
  linearId: string;
  mr: MRDashboardProps | null;
  fetchedAt: number;
}

interface StatusData {
  branches: Record<string, CacheEntry>;
  ports: PortEntry[];
  source: "daemon" | "cache-file";
}

async function fetchStatusData(): Promise<StatusData> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");

  // Fetch branch cache and ports in parallel
  const [cacheResult, portResult] = await Promise.all([
    daemonQuery("cache:read"),
    daemonQuery("ports"),
  ]);

  let branches: Record<string, CacheEntry> = {};
  let ports: PortEntry[] = [];
  let source: "daemon" | "cache-file" = "daemon";

  if (cacheResult?.ok && cacheResult.data) {
    branches = cacheResult.data;
  } else {
    // Fallback: read cache file directly
    source = "cache-file";
    try {
      const { readFileSync } = await import("fs");
      const { homedir } = await import("os");
      const { join } = await import("path");
      const raw = JSON.parse(readFileSync(join(homedir(), ".rt", "branch-cache.json"), "utf8"));
      branches = raw.entries || {};
    } catch { /* no cache */ }
  }

  if (portResult?.ok && portResult.data?.ports) {
    ports = portResult.data.ports;
  }

  return { branches, ports, source };
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

function hexToAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatUptime(etime: string): string {
  const trimmed = etime.trim();
  if (!trimmed || trimmed === "unknown") return "?";
  const parts = trimmed.split(/[-:]/);
  if (parts.length === 2) {
    const mins = parseInt(parts[0]!, 10);
    if (mins === 0) return `${parts[1]}s`;
    return `${mins}m`;
  }
  if (parts.length === 3) {
    if (trimmed.includes("-")) return `${parts[0]}d`;
    const hours = parseInt(parts[0]!, 10);
    const mins = parseInt(parts[1]!, 10);
    if (hours === 0) return `${mins}m`;
    return `${hours}h${mins > 0 ? `${mins}m` : ""}`;
  }
  return trimmed;
}

function renderPipeline(mr: MRDashboardProps): string {
  if (!mr.pipeline) return "";
  const icon = PIPELINE_ICONS[mr.pipeline.status] || "";
  const status = mr.pipeline.status.toLowerCase();

  if (mr.pipeline.status === "RUNNING") {
    const progress = mr.pipeline.total > 0
      ? ` ${dim}(${mr.pipeline.passing}/${mr.pipeline.total})${reset}`
      : "";
    return `${icon} ${dim}pipeline${reset}${progress}`;
  }
  if (mr.pipeline.status === "FAILED") {
    const failing = mr.pipeline.failing > 0 ? ` ${dim}(${mr.pipeline.failing} failing)${reset}` : "";
    return `${icon} ${red}pipeline${reset}${failing}`;
  }
  return `${icon} ${dim}${status}${reset}`;
}

function renderReviews(mr: MRDashboardProps): string {
  if (!mr.reviews) return "";
  const { given, required, isApproved, reviewers } = mr.reviews;

  if (isApproved) {
    return `${green}✓${reset} ${dim}approved${reset}`;
  }

  if (required > 0) {
    const remaining = required - given;
    if (remaining > 0) {
      return `${yellow}${given}/${required}${reset} ${dim}reviews${reset}`;
    }
    return `${green}${given}/${required}${reset} ${dim}reviews${reset}`;
  }

  // No required count — show what we have
  if (reviewers && reviewers.length > 0) {
    const acted = reviewers.filter((r: any) =>
      r.reviewState === "APPROVED" || r.reviewState === "REVIEWED",
    ).length;
    return `${dim}${acted}/${reviewers.length} reviewed${reset}`;
  }

  return "";
}

function renderBlockers(mr: MRDashboardProps): string {
  if (!mr.blockers?.any) return "";
  const parts: string[] = [];
  if (mr.blockers.hasConflicts) parts.push(`${red}conflicts${reset}`);
  if (mr.blockers.needsRebase) parts.push(`${yellow}rebase${reset}`);
  if (mr.blockers.hasMergeError) parts.push(`${red}merge error${reset}`);
  if (mr.blockers.isDraft) parts.push(`${dim}draft${reset}`);
  if (mr.blockers.hasUnresolvedDiscussions) parts.push(`${yellow}discussions${reset}`);
  if (parts.length === 0) return "";
  return parts.join(`${dim}, ${reset}`);
}

// ─── Main renderer ──────────────────────────────────────────────────────────

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev"]);

function renderDashboard(data: StatusData): string {
  const lines: string[] = [];
  const { branches, ports } = data;

  // Group ports by branch for easy lookup
  const portsByBranch = new Map<string, PortEntry[]>();
  for (const p of ports) {
    if (!p.branch) continue;
    if (!portsByBranch.has(p.branch)) portsByBranch.set(p.branch, []);
    portsByBranch.get(p.branch)!.push(p);
  }

  // Separate branches by type
  const activeBranches: [string, CacheEntry][] = [];
  const defaultBranches: [string, CacheEntry][] = [];
  const localBranches: [string, CacheEntry][] = [];

  for (const [branch, entry] of Object.entries(branches)) {
    if (entry.mr) {
      activeBranches.push([branch, entry]);
    } else if (DEFAULT_BRANCHES.has(branch)) {
      defaultBranches.push([branch, entry]);
    } else {
      localBranches.push([branch, entry]);
    }
  }

  // Sort: most recently fetched first
  activeBranches.sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0));

  // Header
  lines.push(`  ${bold}${cyan}rt status${reset}  ${dim}${data.source === "daemon" ? "⚡ daemon" : "📁 cache file"} · ${timeAgo(Date.now())}${reset}`);
  lines.push("");

  // Active MRs
  if (activeBranches.length > 0) {
    for (const [branch, entry] of activeBranches) {
      const mr = entry.mr!;
      const stateIcon = STATE_ICONS[mr.state] || "";
      const branchDisplay = branch.length > 50 ? branch.slice(0, 49) + "…" : branch;

      // Line 1: branch + MR state
      const segments: string[] = [];
      segments.push(`  ${stateIcon} ${bold}${branchDisplay}${reset}`);

      // MR state label
      if (mr.state === "merged") {
        segments.push(`${blue}merged${reset}`);
      } else if (mr.isDraft) {
        segments.push(`${dim}draft${reset}`);
      } else if (mr.isReady) {
        segments.push(`${green}ready${reset}`);
      }

      lines.push(segments.join("  "));

      // Line 2: pipeline, reviews, blockers
      const details: string[] = [];
      const pipelineStr = renderPipeline(mr);
      if (pipelineStr) details.push(pipelineStr);
      const reviewStr = renderReviews(mr);
      if (reviewStr) details.push(reviewStr);
      const blockerStr = renderBlockers(mr);
      if (blockerStr) details.push(blockerStr);

      // Ticket
      if (entry.ticket) {
        let ticketStr = `${dim}${entry.ticket.identifier}${reset}`;
        if (entry.ticket.stateName) {
          const color = entry.ticket.stateColor ? hexToAnsi(entry.ticket.stateColor) : dim;
          ticketStr += ` ${color}[${entry.ticket.stateName}]${reset}`;
        }
        details.push(ticketStr);
      }

      if (details.length > 0) {
        lines.push(`    ${details.join(`  ${dim}·${reset}  `)}`);
      }

      // Line 3: ports (if any)
      const branchPorts = portsByBranch.get(branch);
      if (branchPorts && branchPorts.length > 0) {
        const portStrs = branchPorts.map((p) =>
          `${yellow}:${p.port}${reset} ${dim}${p.relativeDir} ${p.command} (${formatUptime(p.uptime)})${reset}`,
        );
        lines.push(`    ${portStrs.join("  ")}`);
      }

      lines.push("");
    }
  } else {
    lines.push(`  ${dim}no active MRs${reset}`);
    lines.push("");
  }

  // Default branches (compact)
  if (defaultBranches.length > 0) {
    const dbNames = defaultBranches.map(([b]) => `${dim}${b}${reset}`).join("  ");
    lines.push(`  ${dim}●${reset} ${dbNames}`);
  }

  // Local-only count (compact)
  const localCount = localBranches.length;
  if (localCount > 0) {
    lines.push(`  ${dim}${localCount} local-only branch${localCount !== 1 ? "es" : ""}${reset}`);
  }

  // Unmatched ports (not tied to a branch)
  const unmatchedPorts = ports.filter((p) => !p.branch || !branches[p.branch]);
  if (unmatchedPorts.length > 0) {
    lines.push("");
    lines.push(`  ${dim}other ports:${reset}`);
    for (const p of unmatchedPorts) {
      lines.push(`    ${yellow}:${p.port}${reset} ${dim}${p.repo || "?"} · ${p.relativeDir} · ${p.command} (${formatUptime(p.uptime)})${reset}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function showStatus(args: string[]): Promise<void> {
  const watchMode = args.includes("--watch") || args.includes("-w");
  const intervalSec = 15;

  if (!watchMode) {
    const data = await fetchStatusData();
    process.stdout.write(renderDashboard(data));
    return;
  }

  // Watch mode: re-render in place
  console.log(`  ${dim}watching (${intervalSec}s refresh) — Ctrl+C to exit${reset}\n`);

  let lastLineCount = 0;

  const render = async () => {
    const data = await fetchStatusData();
    const output = renderDashboard(data);

    // Clear previous output
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
    }

    process.stdout.write(output);
    lastLineCount = output.split("\n").length;
  };

  await render();
  setInterval(render, intervalSec * 1000);

  // Keep alive
  await new Promise(() => {});
}
