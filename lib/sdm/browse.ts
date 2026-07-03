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
      db: { database: "postgres", schema: "acme", user: "postgres" },
    });
  };

  for (const c of catalog.connections) {
    for (const name of c.resolution?.candidates ?? []) {
      const label = name.startsWith(`${c.sdmResource}-`)
        ? `${c.label} (${name.slice(c.sdmResource.length + 1)})`
        : name.replace(/^acme-/, "");
      addVariant(name, label, c.tier, c.connector, c.production ?? false);
    }
  }

  for (const g of catalog.unresolved ?? []) {
    for (const name of g.candidates) {
      addVariant(name, name.replace(/^acme-/, ""), g.tier, g.connector, g.env === "prod");
    }
  }

  return [...byResource.values()];
}
