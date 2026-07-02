/**
 * Connector discovery. A connector is any executable in ~/.rt/sdm/connectors/;
 * rt runs `<file> discover` with RT_SDM_PROTOCOL=1 and reads one JSON document
 * from stdout. One bad connector never poisons the rest: its failure is
 * collected into CatalogResult.errors and everyone else still contributes.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sdmEnv } from "./core.ts";
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

/**
 * Env for a spawned connector. The daemon runs under launchd, which hands
 * out a minimal PATH with no bun on it, so a `#!/usr/bin/env bun` connector
 * would exit 127 with the raw env. Layer sdmEnv()'s Homebrew/local-bin
 * prepend with bun's own install dir and the directory of the runtime
 * actually executing this code, so discovery works from the daemon, the CLI,
 * and any bun install method.
 */
function connectorEnv(): NodeJS.ProcessEnv {
  const base = sdmEnv();
  const extra = [join(homedir(), ".bun", "bin"), dirname(process.execPath)].join(":");
  return { ...base, PATH: `${extra}:${base.PATH ?? ""}`, RT_SDM_PROTOCOL: "1" };
}

export function runConnector(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; output: ConnectorOutput } | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  return new Promise(promiseResolve => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = (r: { ok: true; output: ConnectorOutput } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      promiseResolve(r);
    };
    const proc = spawn(filePath, ["discover"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: connectorEnv(),
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", d => (stdout += String(d)));
    proc.stderr?.on("data", d => (stderr += String(d)));
    const timer = setTimeout(() => {
      timedOut = true;
      // Killing only the direct child can still hang forever: a grandchild
      // (e.g. a bash fixture's `sleep`) can inherit the stdout/stderr pipes
      // and hold their write end open, so "close" never fires on proc. Destroy
      // the streams and kill the direct child, then force-settle on a guard
      // timer instead of waiting on "close". No process-group/detached kill
      // needed, so a parent Ctrl-C still reaches this child normally.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.kill(9); // SIGKILL
      killTimer = setTimeout(() => settle({ ok: false, error: `timed out after ${timeoutMs}ms` }), 1000);
    }, timeoutMs);
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

// Keyed by resolved directory so discovery in one dir never serves another
// dir's cached results (e.g. two callers passing different `dir` within the
// TTL window).
const catalogCache = new Map<string, { at: number; result: CatalogResult }>();

export function invalidateCatalogCache(): void {
  catalogCache.clear();
}

export async function discoverConnections(
  opts: { refresh?: boolean; dir?: string; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const cacheKey = resolve(opts.dir ?? connectorsDir());
  const cached = catalogCache.get(cacheKey);
  if (!opts.refresh && cached && Date.now() - cached.at < CATALOG_CACHE_MS) {
    return { ...cached.result, fromCache: true };
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
  catalogCache.set(cacheKey, { at: Date.now(), result });
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
