// ── Dev config (user-facing) ────────────────────────────────

export type DevConfig = {
  repoDir: string;
  ignore?: string[];
  proxy?: {
    adjuster?: number;
    frontend?: number;
  };
};

export const DEFAULT_PROXY_PORTS = {
  adjuster: 4001,
  frontend: 4002,
} as const;

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
const APP_INDICES = { backend: 0, adjuster: 1, frontend: 2 } as const;
export type AppName = keyof typeof APP_INDICES;

export type ResolvedPorts = Record<AppName, number>;

export function assignPorts(
  worktreeIndex: number,
  totalWorktrees: number,
  overrides?: Partial<ResolvedPorts>,
): ResolvedPorts {
  const ports: ResolvedPorts = {
    backend: PORT_BASE + APP_INDICES.backend * totalWorktrees + worktreeIndex,
    adjuster: PORT_BASE + APP_INDICES.adjuster * totalWorktrees + worktreeIndex,
    frontend: PORT_BASE + APP_INDICES.frontend * totalWorktrees + worktreeIndex,
  };
  if (overrides) Object.assign(ports, overrides);
  return ports;
}

// ── Resolved worktree (internal, includes computed ports) ───

export type ResolvedWorktree = {
  path: string;
  dir: string;
  branch: string;
  ports: ResolvedPorts;
};

export function resolveWorktrees(
  selected: DetectedWorktree[],
): ResolvedWorktree[] {
  const N = selected.length;
  return selected.map((wt, i) => ({
    path: pathFromDir(wt.dir),
    dir: wt.dir,
    branch: wt.branch,
    ports: assignPorts(i, N),
  }));
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

export function deriveProxyConfigs(
  proxyPorts: { adjuster: number; frontend: number },
  resolved: ResolvedWorktree[],
): { adjuster: ProxyConfig; frontend: ProxyConfig } {
  return {
    adjuster: {
      port: proxyPorts.adjuster,
      worktrees: resolved.map((rw) => ({
        path: rw.path,
        upstream: rw.ports.adjuster,
        dir: rw.dir,
      })),
    },
    frontend: {
      port: proxyPorts.frontend,
      worktrees: resolved.map((rw) => ({
        path: rw.path,
        upstream: rw.ports.frontend,
        dir: rw.dir,
      })),
    },
  };
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
