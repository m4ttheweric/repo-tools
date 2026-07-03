/**
 * SDM-first browse list: expands the config-first catalog (friendly labels
 * for known connections) into one row per REAL StrongDM resource, so `rt sdm
 * connect`'s picker never shows a "needs mapping" gap when the resource
 * itself is perfectly connectable. Every resolved connection's own
 * resolution.candidates and every gap's candidates name real resources that
 * config just hasn't given a friendly primary label to yet; this turns each
 * of those into its own selectable row.
 */

import type { CatalogResult, DiscoveredConnection } from "./connectors.ts";

// Same tier vocabulary the picker groups on (lib/sdm/picker.ts TIER_LABELS).
// Checked in this order, so a name carrying two tokens (unlikely) resolves to
// the first one listed rather than the last.
const ENV_TOKEN_TIERS: [token: string, tier: string][] = [
  ["dev", "development"],
  ["qa", "qa"],
  ["labs", "qa"],
  ["staging", "staging"],
  ["prod", "production"],
];

/** Best-effort tier guess for an orphan resource name with no connector-supplied tier. */
function guessTier(name: string): string | undefined {
  for (const [token, tier] of ENV_TOKEN_TIERS) {
    if (new RegExp(`(^|-)${token}($|-)`, "i").test(name)) return tier;
  }
  return undefined;
}

export function buildBrowseConnections(catalog: CatalogResult): DiscoveredConnection[] {
  const byResource = new Map<string, DiscoveredConnection>();

  // Primary rows win dedup: kept verbatim, added before any candidate-derived
  // variant can claim the same sdmResource.
  for (const c of catalog.connections) {
    if (!byResource.has(c.sdmResource)) byResource.set(c.sdmResource, c);
  }

  const addVariant = (
    name: string,
    label: string,
    tier: string | undefined,
    connector: string,
    production: boolean,
  ) => {
    if (byResource.has(name)) return;
    byResource.set(name, {
      id: name,
      key: `${connector}:${name}`,
      connector,
      label,
      sdmResource: name,
      tier,
      production,
      reasonSuggestion: `investigating ${label} data`,
      db: { database: "postgres", schema: "assured", user: "postgres" },
    });
  };

  for (const c of catalog.connections) {
    for (const name of c.resolution?.candidates ?? []) {
      const label = name.startsWith(`${c.sdmResource}-`)
        ? `${c.label} (${name.slice(c.sdmResource.length + 1)})`
        : name.replace(/^assured-/, "");
      addVariant(name, label, c.tier, c.connector, c.production ?? false);
    }
  }

  for (const g of catalog.unresolved ?? []) {
    for (const name of g.candidates) {
      addVariant(name, name.replace(/^assured-/, ""), g.tier, g.connector, g.env === "prod");
    }
  }

  // Orphans: real resources sdm reports that no config entry (primary or
  // candidate) ever named, e.g. assured-staging-read-write. Honest browse
  // means these still show up rather than being invisible to the picker.
  for (const { name, connector } of catalog.allResources ?? []) {
    if (byResource.has(name)) continue;
    const label = name.replace(/^assured-/, "");
    byResource.set(name, {
      id: name,
      key: `${connector}:${name}`,
      connector,
      label,
      sdmResource: name,
      tier: guessTier(name),
      production: /(^|-)prod($|-)/i.test(name),
      reasonSuggestion: `investigating ${label} data`,
      db: { database: "postgres", schema: "assured", user: "postgres" },
    });
  }

  return [...byResource.values()];
}
