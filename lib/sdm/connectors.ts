/**
 * Connector discovery and resolution. A connector is any executable in
 * ~/.rt/sdm/connectors/; rt runs `<file> discover` (and, per-url, `<file>
 * resolve <url>`) with RT_SDM_PROTOCOL=1 and reads one JSON document from
 * stdout. One bad connector never poisons the rest: its failure is collected
 * into CatalogResult.errors and everyone else still contributes.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { rtDir } from "../rt-paths.ts";
import { sdmEnv } from "./core.ts";
import { validateConnectorOutput, type ConnectorConnection, type ConnectorOutput, type UnresolvedEntry } from "./protocol.ts";

export interface ConnectorRunError {
  connector: string;
  error: string;
}

export interface DiscoveredConnection extends ConnectorConnection {
  /** Namespaced key: "<connector>:<id>". Stable across runs; used by recents. */
  key: string;
  connector: string;
}

/** An unresolved gap reported by a connector, namespaced the same way DiscoveredConnection is. */
export interface UnresolvedGap extends UnresolvedEntry {
  key: string;
  connector: string;
}

export interface CatalogResult {
  connections: DiscoveredConnection[];
  errors: ConnectorRunError[];
  // Optional so existing hand-built CatalogResult literals (daemon deps in
  // tests, the CLI's daemon-passthrough fallback) stay back-compatible;
  // discoverConnections itself always populates it, empty array or not.
  unresolved?: UnresolvedGap[];
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

/**
 * Spawn a connector with an arbitrary command+args (e.g. ["discover"] or
 * ["resolve", url]) and validate its stdout as a ConnectorOutput. Internal;
 * runConnector and runConnectorResolve are the thin public callers.
 */
function runConnectorCommand(
  filePath: string,
  args: string[],
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
    const proc = spawn(filePath, args, {
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

export function runConnector(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; output: ConnectorOutput } | { ok: false; error: string }> {
  return runConnectorCommand(filePath, ["discover"], opts);
}

/** Ask a single connector to resolve one url, e.g. `<file> resolve <url>`. */
export function runConnectorResolve(
  filePath: string,
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: true; output: ConnectorOutput } | { ok: false; error: string }> {
  return runConnectorCommand(filePath, ["resolve", url], opts);
}

// Keyed by resolved directory so discovery in one dir never serves another
// dir's cached results (e.g. two callers passing different `dir` within the
// TTL window).
const catalogCache = new Map<string, { at: number; result: CatalogResult }>();

export function invalidateCatalogCache(): void {
  catalogCache.clear();
}

/** ~/.rt/sdm/catalog-cache.json: the on-disk mirror of the in-memory catalogCache. */
export function catalogCachePath(): string {
  return join(rtDir(), "sdm", "catalog-cache.json");
}

interface PersistedCatalogCache {
  /** The resolved directory this cache was built from; a mismatch is a miss,
   * mirroring the in-memory cache's per-directory scoping. */
  dir: string;
  builtAt: number;
  result: CatalogResult;
}

/**
 * Guarded read of the on-disk catalog cache, same convention as state.ts: a
 * missing file, corrupt JSON, or a shape that doesn't look like a
 * CatalogResult all fall through to running connectors fresh.
 */
function readCatalogCacheFile(path = catalogCachePath()): PersistedCatalogCache | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed?.dir === "string" &&
      typeof parsed?.builtAt === "number" &&
      parsed?.result &&
      Array.isArray(parsed.result.connections) &&
      Array.isArray(parsed.result.errors)
    ) {
      return parsed as PersistedCatalogCache;
    }
  } catch {
    // Missing or corrupt cache file: fall through to running connectors.
  }
  return null;
}

/**
 * Never overwrite the file with an empty/all-error result: a transient sdm
 * outage (connectors all failing) would otherwise blank a previously-good
 * picker for every cold CLI start until the outage clears.
 */
function writeCatalogCacheFile(dir: string, builtAt: number, result: CatalogResult): void {
  if (result.connections.length === 0) return;
  const path = catalogCachePath();
  mkdirSync(dirname(path), { recursive: true });
  const payload: PersistedCatalogCache = { dir, builtAt, result };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
}

export async function discoverConnections(
  opts: { refresh?: boolean; dir?: string; timeoutMs?: number } = {},
): Promise<CatalogResult> {
  const cacheKey = resolve(opts.dir ?? connectorsDir());
  const cached = catalogCache.get(cacheKey);
  if (!opts.refresh && cached && Date.now() - cached.at < CATALOG_CACHE_MS) {
    return { ...cached.result, fromCache: true };
  }
  if (!opts.refresh) {
    const persisted = readCatalogCacheFile();
    if (persisted && persisted.dir === cacheKey && Date.now() - persisted.builtAt < CATALOG_CACHE_MS) {
      catalogCache.set(cacheKey, { at: persisted.builtAt, result: persisted.result });
      return { ...persisted.result, fromCache: true };
    }
  }
  const connections: DiscoveredConnection[] = [];
  const errors: ConnectorRunError[] = [];
  const unresolved: UnresolvedGap[] = [];
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
    for (const u of r.output.unresolved ?? []) {
      unresolved.push({ ...u, connector, key: `${connector}:${u.id}` });
    }
  }
  const result: CatalogResult = { connections, errors, unresolved, fromCache: false };
  const builtAt = Date.now();
  catalogCache.set(cacheKey, { at: builtAt, result });
  writeCatalogCacheFile(cacheKey, builtAt, result);
  return result;
}

export interface ResolveConnectionResult {
  connector: string;
  connection?: DiscoveredConnection;
  unresolved?: UnresolvedGap;
}

/**
 * Ask each connector in turn to resolve a url, returning the first one that
 * has an opinion (a resolved connection or an unresolved gap). A url belongs
 * to exactly one org, so the first connector to answer wins; connectors that
 * error or have no opinion are skipped in favor of the next.
 */
export async function resolveConnection(
  url: string,
  opts: { dir?: string; timeoutMs?: number } = {},
): Promise<ResolveConnectionResult | null> {
  for (const file of listConnectorFiles(opts.dir)) {
    const connector = basename(file).replace(/\.[^.]+$/, "");
    const r = await runConnectorResolve(file, url, { timeoutMs: opts.timeoutMs });
    if (!r.ok) continue;
    const connection = r.output.connections[0];
    if (connection) {
      return { connector, connection: { ...connection, connector, key: `${connector}:${connection.id}` } };
    }
    const gap = r.output.unresolved?.[0];
    if (gap) {
      return { connector, unresolved: { ...gap, connector, key: `${connector}:${gap.id}` } };
    }
  }
  return null;
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
