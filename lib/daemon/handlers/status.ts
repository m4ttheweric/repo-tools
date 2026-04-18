/**
 * Daemon-status + introspection IPC handlers.
 *
 *   ping                  — liveness + uptime + pid
 *   status                — basic counters (cache, ports, watched repos)
 *   tray:status           — richer payload for the menu-bar app
 *   tcc:check             — probe read access to every registered repo
 *   repos                 — repo index + worktrees + watched-config paths
 *   ports                 — cached port-scan data, optionally filtered by repo
 *   notifications         — drain the notification queue
 *   notifications:peek    — peek at the notification queue (diagnostics)
 */

import { existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import type { HandlerContext, HandlerMap } from "./types.ts";
import type { PortEntry } from "../../port-scanner.ts";
import { drainNotifications, peekNotifications } from "../../notifier.ts";

export function createStatusHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "ping": async () => {
      return { ok: true, uptime: Date.now() - ctx.startedAt, pid: process.pid };
    },

    "status": async () => {
      return {
        ok: true,
        data: {
          pid: process.pid,
          uptime: Date.now() - ctx.startedAt,
          watchedRepos: ctx.watchedConfigs.size,
          cacheEntries: Object.keys(ctx.cache.entries).length,
          portsCached: ctx.portCacheRef.ports.length,
          portCacheAge: ctx.portCacheRef.updatedAt ? Date.now() - ctx.portCacheRef.updatedAt : null,
        },
      };
    },

    "tray:status": async () => {
      // Richer status payload designed for the menu bar tray app
      const portsByRepo: Record<string, number> = {};
      for (const p of ctx.portCacheRef.ports) {
        const repo = p.repo || "unknown";
        portsByRepo[repo] = (portsByRepo[repo] || 0) + 1;
      }

      return {
        ok: true,
        data: {
          pid: process.pid,
          uptime: Date.now() - ctx.startedAt,
          memoryUsage: process.memoryUsage().rss,
          watchedRepos: ctx.watchedConfigs.size,
          cacheEntries: Object.keys(ctx.cache.entries).length,
          portsCached: ctx.portCacheRef.ports.length,
          portCacheAge: ctx.portCacheRef.updatedAt ? Date.now() - ctx.portCacheRef.updatedAt : null,
          lastRefresh: ctx.refreshStatusRef.lastRefreshAt || null,
          portsByRepo,
          pendingNotifications: peekNotifications().length,
        },
      };
    },

    "tcc:check": async () => {
      // Self-test: can the daemon actually read each registered repo path?
      // EPERM here means macOS TCC has not granted the daemon binary access
      // to the parent directory (typically ~/Documents/...). The CLI shell
      // running rt verify has its own TCC grants (via Terminal.app), so it
      // can't detect this on its own — only the daemon can.
      const repos = ctx.repoIndex();
      const blocked: Array<{ name: string; path: string; error: string }> = [];
      const accessible: string[] = [];
      for (const [name, path] of Object.entries(repos)) {
        try {
          readdirSync(path);
          accessible.push(name);
        } catch (err: any) {
          if (err?.code === "EPERM" || err?.code === "EACCES") {
            blocked.push({ name, path, error: err.code });
          }
          // ENOENT etc — repo moved/deleted, not a TCC issue, ignore
        }
      }
      return {
        ok: true,
        data: {
          blocked,
          accessible,
          totalRepos: Object.keys(repos).length,
          daemonPid: process.pid,
        },
      };
    },

    "repos": async () => {
      const repos = ctx.repoIndex();
      const watched = [...ctx.watchedConfigs.keys()];
      const detailed: Record<string, { path: string; worktrees: Array<{ path: string; branch: string }> }> = {};

      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;

        const worktrees: Array<{ path: string; branch: string }> = [];
        try {
          const output = execSync("git worktree list --porcelain", {
            cwd: repoPath, encoding: "utf8", stdio: "pipe",
          });
          let currentPath = "";
          let currentBranch = "";
          for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
              if (currentPath && currentBranch) {
                worktrees.push({ path: currentPath, branch: currentBranch });
              }
              currentPath = line.replace("worktree ", "").trim();
              currentBranch = "";
            } else if (line.startsWith("branch ")) {
              currentBranch = line.replace("branch refs/heads/", "").trim();
            }
          }
          if (currentPath && currentBranch) {
            worktrees.push({ path: currentPath, branch: currentBranch });
          }
        } catch { /* git command failed */ }

        detailed[repoName] = { path: repoPath, worktrees };
      }

      return { ok: true, data: { repos: detailed, watched } };
    },

    "ports": async (payload) => {
      // Return cached port data, optionally filtered by repo
      const repoFilter = payload?.repo as string | undefined;
      let ports = ctx.portCacheRef.ports;
      if (repoFilter) {
        ports = ports.filter(p => p.repo === repoFilter);
      }

      // Group by repo → worktree for structured display
      const grouped: Record<string, Record<string, PortEntry[]>> = {};
      for (const entry of ports) {
        const repoKey = entry.repo || "unknown";
        const wtKey = entry.worktree || "unknown";
        if (!grouped[repoKey]) grouped[repoKey] = {};
        if (!grouped[repoKey]![wtKey]) grouped[repoKey]![wtKey] = [];
        grouped[repoKey]![wtKey]!.push(entry);
      }

      return {
        ok: true,
        data: {
          ports,
          grouped,
          updatedAt: ctx.portCacheRef.updatedAt,
          age: ctx.portCacheRef.updatedAt ? Date.now() - ctx.portCacheRef.updatedAt : null,
        },
      };
    },

    "notifications": async () => {
      // Drain the notification queue — tray app calls this on startup
      // to pick up any events that accumulated while it was offline
      return { ok: true, data: drainNotifications() };
    },

    "notifications:peek": async () => {
      // Peek without draining — for diagnostics
      return { ok: true, data: peekNotifications() };
    },
  };
}
