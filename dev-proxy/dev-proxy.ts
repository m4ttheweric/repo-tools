#!/usr/bin/env bun
/**
 * Multi-worktree dev proxy.
 *
 * Sits on Auth0-approved ports and routes traffic to one of N upstream
 * dev servers based on a `wt` cookie. Visiting a worktree's path sets
 * the cookie automatically and redirects to the app.
 *
 * Config sources (checked in order):
 *   1. DEV_PROXY_RUNTIME_CONFIG env var — inline JSON from orchestrate.ts
 *   2. dev-proxy.config.ts in the same directory
 *
 * Usage:
 *   bun run dev-proxy.ts
 */

import { resolve, dirname, join } from "path";
import { Eta } from "eta";
import {
  type Worktree,
  type ProxyConfig,
  type DevConfig,
  type ResolvedWorktree,
  DEFAULT_PROXY_PORTS,
  detectWorktrees,
  resolveWorktrees,
  deriveProxyConfigs,
  displayName,
  isHtmlResponse,
  pickUpstream,
  shortDirFromPath,
  BADGE_COLORS,
} from "./lib";

export type { Worktree, ProxyConfig };

// ── Template engine ─────────────────────────────────────────

const eta = new Eta({
  views: join(dirname(import.meta.path), "templates"),
  cache: false,
});

// ── Load config ─────────────────────────────────────────────

const proxyConfigs: { label: string; config: ProxyConfig }[] = [];

const runtimeConfigEnv = process.env.DEV_PROXY_RUNTIME_CONFIG;

if (runtimeConfigEnv) {
  const raw = JSON.parse(runtimeConfigEnv);
  const resolved: ResolvedWorktree[] = raw.worktrees;
  const proxyPorts = raw.proxy as { adjuster: number; frontend: number };
  const derived = deriveProxyConfigs(proxyPorts, resolved);
  proxyConfigs.push(
    { label: "adjuster", config: derived.adjuster },
    { label: "frontend", config: derived.frontend },
  );
} else {
  const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");
  const { default: config } = (await import(configPath)) as {
    default: DevConfig;
  };
  const proxyPorts = {
    adjuster: config.proxy?.adjuster ?? DEFAULT_PROXY_PORTS.adjuster,
    frontend: config.proxy?.frontend ?? DEFAULT_PROXY_PORTS.frontend,
  };
  const detected = detectWorktrees(config.repoDir, config.ignore);
  if (detected.length < 2) {
    console.error("Need at least 2 git worktrees.");
    process.exit(1);
  }
  const resolved = resolveWorktrees(detected);
  const derived = deriveProxyConfigs(proxyPorts, resolved);
  proxyConfigs.push(
    { label: "adjuster", config: derived.adjuster },
    { label: "frontend", config: derived.frontend },
  );
}

for (const { config } of proxyConfigs) {
  if (config.worktrees.length < 2) {
    console.error("Config must have at least 2 worktrees.");
    process.exit(1);
  }
}

// ── Git branch resolution ────────────────────────────────────

type ResolvedWorktreeInfo = { branch: string; shortDir: string };
const worktreeInfoMap = new Map<string, ResolvedWorktreeInfo>();

function gitBranch(dir: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
  });
  return new TextDecoder().decode(result.stdout).trim() || "???";
}

const allWorktrees = proxyConfigs[0].config.worktrees;

for (const w of allWorktrees) {
  if (w.dir && !worktreeInfoMap.has(w.dir)) {
    const branch = gitBranch(w.dir);
    const shortDir = shortDirFromPath(w.dir);
    worktreeInfoMap.set(w.dir, { branch, shortDir });
  }
}

function getWorktreeInfo(w: Worktree): ResolvedWorktreeInfo | undefined {
  return w.dir ? worktreeInfoMap.get(w.dir) : undefined;
}

// ── Port conflict check ─────────────────────────────────────

async function checkPort(port: number): Promise<void> {
  const result = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
  const pids = new TextDecoder()
    .decode(result.stdout)
    .trim()
    .split("\n")
    .filter(Boolean);

  if (pids.length === 0) return;

  const nameResult = Bun.spawnSync(["lsof", "-i", `:${port}`, "-P", "-n"]);
  const info = new TextDecoder().decode(nameResult.stdout).trim();
  const processLine = info.split("\n").find((l) => l.includes("LISTEN"));
  const processName = processLine?.split(/\s+/)[0] ?? "unknown";

  console.log(
    `\n  ⚠️  Port ${port} is in use by \x1b[1m${processName}\x1b[0m (pid ${pids.join(
      ", ",
    )})`,
  );

  process.stdout.write("  Kill it? [Y/n] ");

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log(`  ✓ Killed. Waiting for port to free up...`);
      await Bun.sleep(500);
      return;
    }
    console.log("  Aborted.");
    process.exit(0);
  }
}

for (const { config } of proxyConfigs) {
  await checkPort(config.port);
}

// ── Routing types ────────────────────────────────────────────

type WsData = {
  upstream: number;
  path: string;
  target?: WebSocket;
  buffer?: (string | ArrayBuffer | Uint8Array)[];
};

// ── Badge / status helpers ───────────────────────────────────

const badgeColors = BADGE_COLORS;
const statusPath = "/status";

function worktreeVars(w: Worktree) {
  const info = getWorktreeInfo(w);
  return {
    path: w.path,
    name: displayName(w),
    upstream: w.upstream,
    branch: info?.branch ?? "",
    shortDir: info?.shortDir ?? "",
  };
}

function buildBadgeHtml(active: Worktree, worktrees: Worktree[]): string {
  const activeIdx = worktrees.indexOf(active);
  const color = badgeColors[activeIdx % badgeColors.length];

  const items = worktrees
    .map((w) =>
      eta.render("./badge-item", {
        active: w === active,
        ...worktreeVars(w),
      }),
    )
    .join("");

  return eta.render("./badge", {
    color,
    ...worktreeVars(active),
    items,
  });
}

function statusPage(current: Worktree, worktrees: Worktree[]): Response {
  const buttons = worktrees
    .map(
      (w) =>
        `<a class="${w === current ? "active" : ""}" href="${w.path}"` +
        ` style="background:${
          w === current ? "#2563eb" : "#64748b"
        }">${displayName(w)}</a>`,
    )
    .join("\n    ");

  const rows = worktrees
    .map(
      (w) =>
        `<tr><td><code>${displayName(w)}</code></td><td>→ localhost:${
          w.upstream
        }</td><td><code>${w.path}</code></td></tr>`,
    )
    .join("");

  const html = eta.render("./status", {
    currentName: displayName(current),
    currentUpstream: current.upstream,
    buttons,
    rows,
  });

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function maybeInjectBadge(
  proxyRes: Response,
  wt: Worktree,
  worktrees: Worktree[],
): Promise<Response> {
  if (!isHtmlResponse(proxyRes.headers)) return proxyRes;

  const text = await proxyRes.text();
  const badge = buildBadgeHtml(wt, worktrees);

  const injected = text.includes("</body>")
    ? text.replace("</body>", badge + "\n</body>")
    : text + badge;

  const headers = new Headers(proxyRes.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("cache-control", "no-cache, no-store, must-revalidate");

  return new Response(injected, {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers,
  });
}

// ── Server factory ──────────────────────────────────────────

function startProxyServer(label: string, pc: ProxyConfig) {
  const { port, worktrees } = pc;
  const defaultWorktree = worktrees[0];
  const worktreeByPath = new Map(worktrees.map((w) => [w.path, w]));

  Bun.serve<WsData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url);

      const matched = worktreeByPath.get(url.pathname);
      if (matched) {
        const next = url.searchParams.get("next") ?? "/";
        return new Response(
          `<!DOCTYPE html><html><head>` +
            `<script>document.cookie="wt=${matched.path};path=/;samesite=lax";` +
            `location.replace("${next}");</script>` +
            `</head></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      if (url.pathname === statusPath) {
        return statusPage(
          pickUpstream(req, worktreeByPath, defaultWorktree),
          worktrees,
        );
      }

      const wt = pickUpstream(req, worktreeByPath, defaultWorktree);

      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const ok = server.upgrade(req, {
          data: { upstream: wt.upstream, path: url.pathname + url.search },
        });
        return ok
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 500 });
      }

      const target = `http://localhost:${wt.upstream}${url.pathname}${url.search}`;
      try {
        const headers = new Headers(req.headers);
        headers.set("host", `localhost:${wt.upstream}`);

        const proxyRes = await fetch(target, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual",
        });

        return maybeInjectBadge(proxyRes, wt, worktrees);
      } catch {
        return new Response(
          `502 — ${displayName(wt)} (localhost:${wt.upstream}) is not reachable.\n`,
          { status: 502, headers: { "Content-Type": "text/plain" } },
        );
      }
    },

    websocket: {
      open(ws) {
        const data = ws.data;
        const target = new WebSocket(
          `ws://localhost:${data.upstream}${data.path}`,
        );

        target.addEventListener("open", () => {
          data.target = target;
          if (data.buffer) {
            for (const msg of data.buffer) target.send(msg);
            data.buffer = undefined;
          }
        });

        target.addEventListener("message", (e) => {
          try {
            ws.send(e.data as string);
          } catch {
            /* client gone */
          }
        });

        target.addEventListener("close", () => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        });

        target.addEventListener("error", () => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        });
      },

      message(ws, message) {
        const { target } = ws.data;
        if (target?.readyState === WebSocket.OPEN) {
          target.send(message);
        } else {
          (ws.data.buffer ??= []).push(message);
        }
      },

      close(ws) {
        try {
          ws.data.target?.close();
        } catch {
          /* already closed */
        }
      },
    },
  });

  return { port, label, worktrees };
}

// ── Start all proxy servers ─────────────────────────────────

const servers = proxyConfigs.map(({ label, config }) =>
  startProxyServer(label, config),
);

// ── Console output ──────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

const colors = [green, cyan, magenta, (s: string) => `\x1b[33m${s}\x1b[0m`];

for (const srv of servers) {
  const { port, label, worktrees } = srv;

  const nameCol =
    Math.max("Status".length, ...worktrees.map((w) => displayName(w).length)) +
    2;
  const upstreamCol = Math.max(
    ...worktrees.map((w) => `localhost:${w.upstream}`.length),
  );

  const rows = worktrees
    .map((w, i) => {
      const color = colors[i % colors.length];
      const name = displayName(w).padEnd(nameCol);
      const upstream = `localhost:${w.upstream}`.padEnd(upstreamCol);
      const url = `http://localhost:${port}${w.path}`;
      return `  ${color("●")} ${bold(name)} ${dim(upstream)}  ${cyan(url)}`;
    })
    .join("\n");

  const statusUrl = `http://localhost:${port}${statusPath}`;
  const statusRow = `  📋 ${bold("Status".padEnd(nameCol))} ${dim(
    "·".repeat(upstreamCol),
  )}  ${cyan(statusUrl)}`;

  const lineLen = nameCol + upstreamCol + statusUrl.length + 10;

  console.log(`
  ⚡ ${bold("dev-proxy")} ${dim(label)} ${dim("v2.0")}
  ${dim("─".repeat(lineLen))}

${rows}

${statusRow}
  ${dim("─".repeat(lineLen))}
  ${dim("Click a URL above to switch. HMR supported.")}

  ${green("Ready")} on ${bold(`http://localhost:${port}`)}
`);
}
