/**
 * Workspace-sync IPC handlers. Keeps `.code-workspace` (or similar)
 * files consistent across a repo's worktrees by watching one source and
 * writing through to siblings, preserving per-worktree keys like peacock.
 *
 *   workspace:sync:start     — enable sync, seed from an initial source
 *   workspace:sync:stop      — disable sync, unregister watcher
 *   workspace:sync:status    — current watcher status
 *   workspace:sync:trigger   — force a sync round using the latest-mtime file
 */

import { statSync } from "fs";
import { join } from "path";
import type { HandlerContext, HandlerMap } from "./types.ts";
import {
  startWatching, stopWatching, getWatcherStatus, loadSyncConfig, saveSyncConfig,
  ensureGitExclude, removeGitExclude, getWorktreePaths, syncWorkspaceFile,
  type WorkspaceSyncConfig,
} from "../workspace-sync.ts";

export function createWorkspaceHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "workspace:sync:start": async (payload) => {
      const { repo, repoPath, fileName, sourcePath } = payload as {
        repo: string; repoPath: string; fileName: string; sourcePath: string;
      };
      if (!repo || !repoPath || !fileName) {
        return { ok: false, error: "missing repo, repoPath, or fileName" };
      }

      const config: WorkspaceSyncConfig = {
        fileName,
        enabled: true,
        preserveKeys: [
          "peacock.color",
          "peacock.favoriteColors",
          "workbench.colorCustomizations",
        ],
      };

      // Save config
      saveSyncConfig(repo, config);

      // Add to git exclude
      ensureGitExclude(repoPath, fileName);

      // Do initial sync from the specified source
      const worktrees = getWorktreePaths(repoPath);
      const targetPaths = worktrees.map(wt => join(wt, fileName));
      const result = syncWorkspaceFile(
        sourcePath || join(repoPath, fileName),
        targetPaths,
        config.preserveKeys,
        ctx.log,
      );

      config.lastSyncAt = new Date().toISOString();
      config.lastSyncSource = sourcePath;
      saveSyncConfig(repo, config);

      // Start watching
      startWatching(repo, repoPath, config, ctx.log);

      return { ok: true, data: result };
    },

    "workspace:sync:stop": async (payload) => {
      const { repo } = payload as { repo: string };
      if (!repo) return { ok: false, error: "missing repo" };

      stopWatching(repo, ctx.log);

      // Disable config
      const config = loadSyncConfig(repo);
      if (config) {
        config.enabled = false;
        saveSyncConfig(repo, config);
      }

      // Remove from git exclude
      const repos = ctx.repoIndex();
      const repoPath = repos[repo];
      if (repoPath && config) {
        removeGitExclude(repoPath, config.fileName);
      }

      return { ok: true };
    },

    "workspace:sync:status": async (payload) => {
      const { repo } = payload as { repo: string };
      if (!repo) return { ok: false, error: "missing repo" };
      return { ok: true, data: getWatcherStatus(repo) };
    },

    "workspace:sync:trigger": async (payload) => {
      const { repo } = payload as { repo: string };
      if (!repo) return { ok: false, error: "missing repo" };

      const config = loadSyncConfig(repo);
      if (!config) return { ok: false, error: "no sync config for this repo" };

      const repos = ctx.repoIndex();
      const repoPath = repos[repo];
      if (!repoPath) return { ok: false, error: "unknown repo" };

      // Find the most recently modified copy as source
      const worktrees = getWorktreePaths(repoPath);
      let latestPath = "";
      let latestMtime = 0;
      for (const wt of worktrees) {
        const fp = join(wt, config.fileName);
        try {
          const mt = statSync(fp).mtimeMs;
          if (mt > latestMtime) { latestMtime = mt; latestPath = fp; }
        } catch { /* missing */ }
      }

      if (!latestPath) return { ok: false, error: "no workspace files found" };

      const targetPaths = worktrees.map(wt => join(wt, config.fileName));
      const result = syncWorkspaceFile(latestPath, targetPaths, config.preserveKeys, ctx.log);

      config.lastSyncAt = new Date().toISOString();
      config.lastSyncSource = latestPath;
      saveSyncConfig(repo, config);

      return { ok: true, data: result };
    },
  };
}
