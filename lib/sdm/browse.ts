/**
 * Connection builder: joins the scanner's real StrongDM resources
 * (lib/sdm/scan.ts) with the user-maintained enrichment overlay
 * (lib/sdm/enrichment.ts) into the display rows the picker renders. A
 * resource with no enrichment entry still gets a row, just with its raw
 * name as the label and no tier, so browse never hides a real resource
 * behind a missing config mapping.
 */

import type { SdmResource } from "./scan.ts";
import type { EnrichmentEntry } from "./enrichment.ts";

export interface SdmConnection {
  key: string;
  label: string;
  sdmResource: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
}

export function buildSdmConnections(
  resources: SdmResource[],
  enrichment: Record<string, EnrichmentEntry>,
): SdmConnection[] {
  return resources
    .map(r => {
      const e = enrichment[r.name];
      const label = e?.label ?? r.name;
      return {
        key: `sdm:${r.name}`,
        label,
        sdmResource: r.name,
        tier: e?.tier,
        production: e?.production ?? false,
        reasonSuggestion: e?.reasonSuggestion ?? `investigating ${label} data`,
        db: e?.db,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
