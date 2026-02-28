// ── Resource types (section-specific) ───────────────────────

/** Base fields shared by all resource types */
type ResourceBase = {
  /** Name shown in the Tilt dashboard */
  name: string;
  /** The shell command. Use {repo} for worktree root, {port_<name>} for cross-refs */
  cmd: string;
  /** Resources that must be ready first (can reference any section) */
  deps?: string[];
};

/** A one-shot setup resource (e.g. install, migrations) */
export type SetupResource = ResourceBase;

/** A long-running app resource */
export type AppResource = ResourceBase & {
  /** If set, a reverse proxy is created for this app on the given port */
  proxy?: { port: number };
  /** Link URLs shown in the Tilt dashboard. Use {port} for own port */
  links?: string[];
};

/** A manually-triggered tool resource */
export type ToolResource = ResourceBase;

// ── Tilt resource (internal, used by tiltfile-template) ─────

export type TiltResource = {
  name: string;
  cmd: string;
  cmdType?: "run" | "serve";
  labels: string[];
  autoInit?: boolean;
  deps?: string[];
  links?: string[];
};

// ── Dev config (user-facing) ────────────────────────────────

export type DevConfig = {
  repoDir: string;
  ignore?: string[];
  /** One-shot setup resources (label: "setup", cmdType: "run", autoInit: true) */
  setup?: SetupResource[];
  /** Long-running app resources (label: "apps", cmdType: "serve", autoInit: true) */
  apps: AppResource[];
  /** Manual-trigger tool resources (label: "tools", cmdType: "run", autoInit: false) */
  tools?: ToolResource[];
};

// ── Config errors ───────────────────────────────────────────

export class ConfigError extends Error {
  constructor(
    public headline: string,
    public hint?: string,
  ) {
    super(headline);
    this.name = "ConfigError";
  }
}

// ── Config validation ───────────────────────────────────────

const APP_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const PORT_SELF_RE = /\{port\}/;
const PORT_REF_RE = /\{port_([a-zA-Z0-9_]+)\}/g;

export function validateConfig(config: DevConfig): void {
  // V1: repoDir must be non-empty
  if (!config.repoDir.trim()) {
    throw new ConfigError(
      "repoDir is empty",
      "Set repoDir to your git repository path",
    );
  }

  // B3: repoDir must exist
  const { existsSync } = require("fs");
  if (!existsSync(config.repoDir)) {
    throw new ConfigError(
      `repoDir does not exist: ${config.repoDir}`,
      "Check the path in dev-proxy.config.ts",
    );
  }

  // B4: repoDir must be a git repo
  const gitCheck = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
    cwd: config.repoDir,
  });
  if (gitCheck.exitCode !== 0) {
    throw new ConfigError(
      `repoDir is not a git repository: ${config.repoDir}`,
      "Make sure the path points to a git repository",
    );
  }

  const allResources = flattenResources(config);

  if (allResources.length === 0) {
    throw new ConfigError("Config must define at least one resource");
  }

  const names = new Set<string>();

  for (const r of allResources) {
    if (!r.name.trim()) {
      throw new ConfigError("Resource has an empty name");
    }
    if (!r.cmd.trim()) {
      throw new ConfigError(`Resource '${r.name}' has an empty cmd`);
    }
    if (names.has(r.name)) {
      throw new ConfigError(`Duplicate resource name: '${r.name}'`);
    }
    names.add(r.name);
  }

  // V3: app names must be valid env var identifiers
  for (const app of config.apps) {
    if (!APP_NAME_RE.test(app.name)) {
      throw new ConfigError(
        `Invalid app name: '${app.name}'`,
        "App names must be alphanumeric with underscores (used for PORT_<NAME> env vars)",
      );
    }
  }

  // V5: self-deps
  for (const r of allResources) {
    if (r.deps?.includes(r.name)) {
      throw new ConfigError(`Resource '${r.name}' depends on itself`);
    }
  }

  // Validate deps reference known resources
  for (const r of allResources) {
    for (const dep of r.deps ?? []) {
      if (!names.has(dep)) {
        throw new ConfigError(
          `Resource '${r.name}' depends on unknown resource '${dep}'`,
        );
      }
    }
  }

  // V4: {port} is only valid in apps section
  const appNameSet = new Set(config.apps.map((a) => a.name));

  for (const r of config.setup ?? []) {
    if (PORT_SELF_RE.test(r.cmd)) {
      throw new ConfigError(
        `{port} placeholder in setup resource '${r.name}'`,
        "Use {port_<appName>} to reference a specific app's port",
      );
    }
  }
  for (const r of config.tools ?? []) {
    if (PORT_SELF_RE.test(r.cmd)) {
      throw new ConfigError(
        `{port} placeholder in tools resource '${r.name}'`,
        "Use {port_<appName>} to reference a specific app's port",
      );
    }
  }

  // V6: all {port_<name>} references must point to known apps
  for (const r of allResources) {
    let match: RegExpExecArray | null;
    const re = new RegExp(PORT_REF_RE.source, "g");
    while ((match = re.exec(r.cmd)) !== null) {
      const ref = match[1];
      if (!appNameSet.has(ref)) {
        throw new ConfigError(
          `Unknown port reference {port_${ref}} in resource '${r.name}'`,
          `Valid app names: ${[...appNameSet].join(", ")}`,
        );
      }
    }
  }

  // V2: duplicate proxy ports
  const proxyPorts = new Map<number, string>();
  for (const app of config.apps) {
    if (!app.proxy) continue;
    const port = app.proxy.port;

    // V7: proxy port range
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `Invalid proxy port ${port} on app '${app.name}'`,
        "Must be an integer between 1 and 65535",
      );
    }

    const existing = proxyPorts.get(port);
    if (existing) {
      throw new ConfigError(
        `Duplicate proxy port: ${port}`,
        `Apps '${existing}' and '${app.name}' both use proxy port ${port}`,
      );
    }
    proxyPorts.set(port, app.name);
  }
}

// ── Flatten config into TiltResource[] ──────────────────────

/**
 * Convert the grouped DevConfig into a flat TiltResource array
 * suitable for the Tiltfile generator. Applies section-level defaults:
 *   setup → labels: ["setup"], cmdType: "run", autoInit: true
 *   apps  → labels: ["apps"],  cmdType: "serve", autoInit: true
 *   tools → labels: ["tools"], cmdType: "run", autoInit: false
 *
 * For apps, {port} placeholders in cmd and links are replaced with
 * {port_<appName>} so the Tiltfile generator can resolve them uniformly.
 */
export function flattenResources(config: DevConfig): TiltResource[] {
  const resources: TiltResource[] = [];

  for (const r of config.setup ?? []) {
    resources.push({
      name: r.name,
      cmd: r.cmd,
      labels: ["setup"],
      deps: r.deps,
    });
  }

  for (const app of config.apps) {
    // Replace {port} with {port_<name>} for uniform placeholder resolution
    const portVar = `port_${app.name}`;
    const cmd = app.cmd.replace(/\{port\}/g, `{${portVar}}`);
    const links = app.links?.map((l) =>
      l.replace(/\{port\}/g, `{${portVar}}`),
    );

    resources.push({
      name: app.name,
      cmd,
      cmdType: "serve",
      labels: ["apps"],
      deps: app.deps,
      links,
    });
  }

  for (const r of config.tools ?? []) {
    resources.push({
      name: r.name,
      cmd: r.cmd,
      labels: ["tools"],
      autoInit: false,
      deps: r.deps,
    });
  }

  return resources;
}

// ── Git worktree detection ──────────────────────────────────

export type DetectedWorktree = {
  dir: string;
  branch: string;
};

export function detectWorktrees(
  repoDir: string,
  ignore?: string[],
): DetectedWorktree[] {
  const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
    cwd: repoDir,
  });
  const output = new TextDecoder().decode(result.stdout);
  const worktrees: DetectedWorktree[] = [];

  let dir = "";
  let branch = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      dir = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    } else if (line.startsWith("HEAD ") || line === "detached") {
      if (!branch) branch = "detached";
    } else if (line === "" && dir) {
      worktrees.push({ dir, branch: branch || "detached" });
      dir = "";
      branch = "";
    }
  }

  if (dir) {
    worktrees.push({ dir, branch: branch || "detached" });
  }

  if (!ignore?.length) return worktrees;

  const globs = ignore.map((pattern) => new Bun.Glob(pattern));
  return worktrees.filter(
    (wt) => !globs.some((g) => g.match(wt.dir)),
  );
}

export function pathFromDir(dir: string): string {
  const name = dir.replace(/\/$/, "").split("/").pop() ?? dir;
  return `/${name}`;
}

// ── Port assignment ─────────────────────────────────────────

const PORT_BASE = 52000;

/**
 * Dynamically assign ports for a set of apps.
 * Each app gets a unique port: PORT_BASE + (appIndex * totalWorktrees) + worktreeIndex
 */
export function assignPorts(
  appNames: string[],
  worktreeIndex: number,
  totalWorktrees: number,
): Record<string, number> {
  const ports: Record<string, number> = {};
  for (let i = 0; i < appNames.length; i++) {
    const port = PORT_BASE + i * totalWorktrees + worktreeIndex;
    if (port > 65535) {
      throw new ConfigError(
        `Port overflow: ${appNames[i]} would get port ${port}`,
        `${appNames.length} apps × ${totalWorktrees} worktrees exceeds available port range from base ${PORT_BASE}`,
      );
    }
    ports[appNames[i]] = port;
  }
  return ports;
}

// ── Resolved worktree (internal, includes computed ports) ───

export type ResolvedWorktree = {
  path: string;
  dir: string;
  branch: string;
  ports: Record<string, number>;
};

export function resolveWorktrees(
  selected: DetectedWorktree[],
  appNames: string[],
): ResolvedWorktree[] {
  const N = selected.length;
  const resolved = selected.map((wt, i) => ({
    path: pathFromDir(wt.dir),
    dir: wt.dir,
    branch: wt.branch,
    ports: assignPorts(appNames, i, N),
  }));

  // B1: detect duplicate paths (same dir basename in different locations)
  const pathCounts = new Map<string, string[]>();
  for (const rw of resolved) {
    const dirs = pathCounts.get(rw.path) ?? [];
    dirs.push(rw.dir);
    pathCounts.set(rw.path, dirs);
  }
  for (const [path, dirs] of pathCounts) {
    if (dirs.length > 1) {
      throw new ConfigError(
        `Worktree path collision: '${path}'`,
        `Multiple worktrees map to the same path: ${dirs.join(", ")}. Use ignore patterns to exclude one.`,
      );
    }
  }

  return resolved;
}

// ── Proxy-level types (used by dev-proxy.ts) ────────────────

export type Worktree = {
  path: string;
  upstream: number;
  dir?: string;
};

export type ProxyConfig = {
  port: number;
  worktrees: Worktree[];
};

/**
 * Derive proxy configs from apps that have `proxy` set.
 * Returns a map of app name → ProxyConfig.
 */
export function deriveProxyConfigs(
  apps: AppResource[],
  resolved: ResolvedWorktree[],
): Map<string, ProxyConfig> {
  const configs = new Map<string, ProxyConfig>();

  for (const app of apps) {
    if (!app.proxy) continue;
    configs.set(app.name, {
      port: app.proxy.port,
      worktrees: resolved.map((rw) => ({
        path: rw.path,
        upstream: rw.ports[app.name],
        dir: rw.dir,
      })),
    });
  }

  return configs;
}

export function displayName(w: Worktree): string {
  return w.path.split("/").filter(Boolean).pop() ?? w.path;
}

export function isHtmlResponse(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").includes("text/html");
}

export function parseWorktreeCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(/wt=([^;]+)/);
  return match?.[1] ?? null;
}

export function pickUpstream(
  req: Request,
  worktreeByPath: Map<string, Worktree>,
  defaultWorktree: Worktree,
): Worktree {
  const cookie = req.headers.get("cookie") ?? "";
  const wtPath = parseWorktreeCookie(cookie);
  if (wtPath) {
    const found = worktreeByPath.get(wtPath);
    if (found) return found;
  }
  return defaultWorktree;
}

export function shortDirFromPath(dir: string): string {
  const parts = dir.replace(/\/$/, "").split("/");
  return parts.slice(-2).join("/");
}

export const BADGE_COLORS = [
  "#2563eb",
  "#059669",
  "#7c3aed",
  "#d97706",
  "#dc2626",
];
