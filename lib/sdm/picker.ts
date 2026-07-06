/**
 * Builds the fzf option list: Recent group first (top item preselected by
 * position), then tier groups in canonical order. A connection shown in
 * Recent is promoted out of its tier group, so every connection appears
 * exactly once (no confusing duplicate rows when filtering).
 */

import { dim } from "../ansi.ts";
import { navSeparator, type NavOption } from "../navigate.ts";
import type { UnresolvedGap } from "./connectors.ts";
import type { SdmConnection } from "./browse.ts";
import type { RecentEntry } from "./state.ts";

export const TIER_LABELS: Record<string, string> = {
  development: "Development",
  qa: "QA",
  staging: "Staging",
  production: "Production",
};

const TIER_ORDER = ["development", "qa", "staging", "production"];

const TIER_COLOR: Record<string, string> = {
  development: "\x1b[32m",
  qa: "\x1b[35m",
  staging: "\x1b[33m",
  production: "\x1b[31m",
};

const MAX_RECENT_ROWS = 3;

function row(key: string, label: string, sdmResource: string, tier?: string): NavOption {
  return {
    value: key,
    label,
    hint: tier ? `${sdmResource}  ${tier}` : sdmResource,
    color: tier ? TIER_COLOR[tier] : undefined,
  };
}

/** Non-selectable row for a gap the connector couldn't resolve; value: "" is a picker no-op. */
function gapRow(gap: UnresolvedGap): NavOption {
  const hint =
    gap.source === "none"
      ? gap.readOnlyAlt
        ? `only read-only ${gap.readOnlyAlt}`
        : "no StrongDM resource"
      : `candidates: ${gap.candidates.join(", ")}`;
  return { value: "", label: gap.label, hint, color: dim };
}

export function buildPickerOptions(
  connections: SdmConnection[],
  recents: RecentEntry[],
  unresolved?: UnresolvedGap[],
): NavOption[] {
  const options: NavOption[] = [];

  const recentRows = recents.slice(0, MAX_RECENT_ROWS);
  const recentKeys = new Set(recentRows.map(r => r.key));
  if (recentRows.length > 0) {
    options.push(navSeparator("Recent"));
    for (const r of recentRows) options.push(row(r.key, r.label, r.sdmResource, r.tier));
  }

  // Skip connections already shown under Recent so they aren't listed twice.
  const byTier = new Map<string, SdmConnection[]>();
  for (const c of connections) {
    if (recentKeys.has(c.key)) continue;
    const tier = c.tier ?? "";
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push(c);
  }
  const tiers = [...byTier.keys()].sort((a, b) => {
    const ia = TIER_ORDER.indexOf(a);
    const ib = TIER_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? TIER_ORDER.length : ia) - (ib === -1 ? TIER_ORDER.length : ib);
    return a.localeCompare(b);
  });

  for (const tier of tiers) {
    options.push(navSeparator(tier === "" ? "Other" : (TIER_LABELS[tier] ?? tier)));
    const group = byTier.get(tier)!.slice().sort((a, b) => a.label.localeCompare(b.label));
    for (const c of group) options.push(row(c.key, c.label, c.sdmResource, c.tier));
  }

  if (unresolved?.length) {
    options.push(navSeparator("Needs mapping"));
    for (const g of unresolved) options.push(gapRow(g));
  }

  return options;
}
