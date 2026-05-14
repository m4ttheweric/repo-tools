/**
 * Global Cloudflare tunnel config.
 *
 * Stored at ~/.rt/tunnels/config.json. Shared across all runner boards —
 * one tunnel + base domain serves every lane that wants publishing.
 *
 * On-disk shape is the user-edited source of truth. The generated cloudflared
 * ingress YAML (runtime-<board>.yml) is derived from this plus the runner's
 * LaneConfig[] — see lib/tunnel-ingress.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface TunnelConfig {
  /** Stable cloudflared tunnel UUID. */
  tunnelId: string;
  /** Human-readable tunnel name (display only). */
  tunnelName: string;
  /** Absolute path to the cloudflared credentials JSON. */
  credentialsFile: string;
  /** Apex domain whose wildcard CNAME points at the tunnel. */
  baseDomain: string;
  /**
   * Prefix on the port label, e.g. "p" → "p4000.m4tthew.dev".
   * Empty string yields a pure-numeric subdomain.
   */
  hostnamePrefix: string;
}

function tunnelsDir(): string {
  return join(process.env.HOME ?? "", ".rt", "tunnels");
}

function configPath(): string {
  return join(tunnelsDir(), "config.json");
}

/**
 * Load global tunnel config. Returns null when not yet set up.
 * Throws on malformed JSON so callers can surface a clear error instead of
 * silently treating the user's broken file as "not set up".
 */
export function loadTunnelConfig(): TunnelConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    tunnelId:        String(raw.tunnelId ?? ""),
    tunnelName:      String(raw.tunnelName ?? ""),
    credentialsFile: String(raw.credentialsFile ?? ""),
    baseDomain:      String(raw.baseDomain ?? ""),
    hostnamePrefix:  String(raw.hostnamePrefix ?? "p"),
  };
}

export function saveTunnelConfig(cfg: TunnelConfig): void {
  mkdirSync(tunnelsDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

/** Compute the public hostname for a given canonical port. */
export function hostnameFor(cfg: TunnelConfig, port: number): string {
  return `${cfg.hostnamePrefix}${port}.${cfg.baseDomain}`;
}

/** Absolute path to the generated ingress YAML for a given runner board. */
export function runtimeYamlPath(boardName: string): string {
  return join(tunnelsDir(), `runtime-${boardName}.yml`);
}
