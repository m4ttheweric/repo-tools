/**
 * Pure transform: (global tunnel config, lanes) → cloudflared ingress YAML.
 *
 * The output is hand-written YAML (no library) because the schema is tiny and
 * fully under our control. Lanes are emitted in lane.id ascending order so
 * `cloudflared` always sees a deterministic ingress — useful for diffing the
 * generated file when debugging.
 */

import type { LaneConfig } from "./runner-store.ts";
import type { TunnelConfig } from "./tunnel-config.ts";
import { hostnameFor } from "./tunnel-config.ts";

export function generateIngressYaml(cfg: TunnelConfig, lanes: LaneConfig[]): string {
  const enabled = lanes
    .filter((l) => l.tunnel?.enabled === true && l.canonicalPort > 0)
    .sort((a, b) => {
      const na = Number(a.id), nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.id.localeCompare(b.id);
    });

  const lines: string[] = [
    `tunnel: ${cfg.tunnelId}`,
    `credentials-file: ${cfg.credentialsFile}`,
    `ingress:`,
  ];
  for (const lane of enabled) {
    lines.push(`  - hostname: ${hostnameFor(cfg, lane.canonicalPort)}`);
    lines.push(`    service: http://localhost:${lane.canonicalPort}`);
  }
  lines.push(`  - service: http_status:404`);
  return lines.join("\n") + "\n";
}
