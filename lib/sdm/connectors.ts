/**
 * Connector discovery. A connector is any executable in ~/.rt/sdm/connectors/;
 * rt runs `<file> discover` with RT_SDM_PROTOCOL=1 and reads one JSON document
 * from stdout. One bad connector never poisons the rest: its failure is
 * collected into CatalogResult.errors and everyone else still contributes.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { validateConnectorOutput, type ConnectorConnection, type ConnectorOutput } from "./protocol.ts";

export interface ConnectorRunError {
  connector: string;
  error: string;
}

export interface DiscoveredConnection extends ConnectorConnection {
  /** Namespaced key: "<connector>:<id>". Stable across runs; used by recents. */
  key: string;
  connector: string;
}

export interface CatalogResult {
  connections: DiscoveredConnection[];
  errors: ConnectorRunError[];
  fromCache: boolean;
}

export const CONNECTOR_TIMEOUT_MS = 30_000;
export const CATALOG_CACHE_MS = 10 * 60_000;

export function connectorsDir(): string {
  return join(homedir(), ".rt", "sdm", "connectors");
}

export function listConnectorFiles(dir = connectorsDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
    } catch {
      continue;
    }
    files.push(p);
  }
  return files;
}

export function runConnector(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; output: ConnectorOutput } | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    const settle = (r: { ok: true; output: ConnectorOutput } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const proc = spawn(filePath, ["discover"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RT_SDM_PROTOCOL: "1" },
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // Process already exited, will settle when close event fires
      }
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", d => (stdout += String(d)));
    proc.stderr?.on("data", d => (stderr += String(d)));
    proc.on("error", err => settle({ ok: false, error: `spawn failed: ${(err as Error).message}` }));
    proc.on("close", code => {
      if (timedOut) return settle({ ok: false, error: `timed out after ${timeoutMs}ms` });
      if (code !== 0) {
        return settle({ ok: false, error: `exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}` });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(stdout);
      } catch {
        return settle({ ok: false, error: `stdout is not valid JSON: ${stdout.trim().slice(0, 120)}` });
      }
      const validated = validateConnectorOutput(raw);
      if (!validated.ok) return settle({ ok: false, error: validated.error });
      settle({ ok: true, output: validated.output });
    });
  });
}

let catalogCache: { at: number; result: CatalogResult } | null = null;

export function invalidateCatalogCache(): void {
  catalogCache = null;
}

export async function discoverConnections(
  opts: { refresh?: boolean; dir?: string; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  if (!opts.refresh && catalogCache && Date.now() - catalogCache.at < CATALOG_CACHE_MS) {
    return { ...catalogCache.result, fromCache: true };
  }
  const connections: DiscoveredConnection[] = [];
  const errors: ConnectorRunError[] = [];
  for (const file of listConnectorFiles(opts.dir)) {
    const connector = basename(file).replace(/\.[^.]+$/, "");
    const r = await runConnector(file, { timeoutMs: opts.timeoutMs });
    if (!r.ok) {
      errors.push({ connector, error: r.error });
      continue;
    }
    for (const c of r.output.connections) {
      connections.push({ ...c, connector, key: `${connector}:${c.id}` });
    }
  }
  const result: CatalogResult = { connections, errors, fromCache: false };
  catalogCache = { at: Date.now(), result };
  return result;
}

export const CONNECTOR_TEMPLATE = `#!/usr/bin/env bun
/**
 * rt sdm connector.
 *
 * rt runs \`<this-file> discover\` and reads ONE JSON document from stdout.
 * Anything on stderr is diagnostics. Replace the static list below with your
 * own discovery: fetch an internal catalog, parse a config file, shell out
 * to \`sdm access catalog\`... anything goes, as long as stdout is the JSON.
 *
 * Validate while developing:  rt sdm connectors test <name>
 */

interface ConnectorConnection {
  id: string;              // stable within this connector
  label: string;           // shown in the picker
  sdmResource: string;     // exact StrongDM resource name
  tier?: string;           // development | qa | staging | production | anything
  production?: boolean;    // true adds a confirm guard before connecting
  reasonSuggestion?: string; // prefill for the access-request reason prompt
  db?: { database?: string; schema?: string; user?: string };
  meta?: Record<string, string>;
}

const connections: ConnectorConnection[] = [
  {
    id: "alpha-staging",
    label: "Alpha Staging",
    sdmResource: "example-alpha-staging",
    tier: "staging",
    reasonSuggestion: "investigating alpha staging data",
  },
  { id: "alpha-qa", label: "Alpha QA", sdmResource: "example-alpha-qa", tier: "qa" },
];

process.stdout.write(JSON.stringify({ version: 1, connections }, null, 2) + "\\n");
`;

/** Write the template as an executable connector. Throws if the file exists. */
export function scaffoldConnector(name: string, dir = connectorsDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  writeFileSync(path, CONNECTOR_TEMPLATE);
  chmodSync(path, 0o755);
  return path;
}
