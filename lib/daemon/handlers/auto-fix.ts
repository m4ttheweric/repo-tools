/**
 * Auto-fix IPC handlers — read-only inspection + config get/set.
 *
 *   auto-fix:log:read        — return last N attempts for a repo (default 25)
 *   auto-fix:notes:read      — return notes file content for a branch+sha
 *   auto-fix:status          — { enabled, recentAttempts, lockHolder }
 *   auto-fix:config:get      — current AutoFixConfig
 *   auto-fix:config:set      — partial update (merged with current)
 */

import { loadAutoFixConfig, saveAutoFixConfig, type AutoFixConfig } from "../../auto-fix-config.ts";
import { readLog, readNotes } from "../../auto-fix-log.ts";
import { isLockHeld, autoFixLockPath } from "../../auto-fix-lock.ts";
import { existsSync, readFileSync } from "fs";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createAutoFixHandlers(_ctx: HandlerContext): HandlerMap {
  return {
    "auto-fix:log:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const branch   = payload?.branch   as string | undefined;
      const limit    = (payload?.limit as number) ?? 25;
      if (!repoName) return { ok: false, error: "missing repoName" };
      let log = readLog(repoName);
      if (branch) log = log.filter(e => e.branch === branch);
      log = log.slice(Math.max(0, log.length - limit));
      return { ok: true, data: { entries: log } };
    },

    "auto-fix:notes:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const branch   = payload?.branch   as string | undefined;
      const sha      = payload?.sha      as string | undefined;
      if (!repoName || !branch || !sha) return { ok: false, error: "missing repoName/branch/sha" };
      const body = readNotes(repoName, branch, sha);
      if (body === null) return { ok: false, error: "notes not found" };
      return { ok: true, data: { body } };
    },

    "auto-fix:status": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      if (!repoName) return { ok: false, error: "missing repoName" };
      const cfg = loadAutoFixConfig(repoName);
      const log = readLog(repoName);
      const recent = log.slice(Math.max(0, log.length - 5));
      let lockHolder: any = null;
      if (existsSync(autoFixLockPath(repoName))) {
        try {
          lockHolder = JSON.parse(readFileSync(autoFixLockPath(repoName), "utf8"));
        } catch { /* */ }
      }
      return {
        ok: true,
        data: {
          enabled:        cfg.enabled,
          fileCap:        cfg.fileCap,
          lineCap:        cfg.lineCap,
          recentAttempts: recent,
          lockHeld:       isLockHeld(repoName),
          lockHolder,
        },
      };
    },

    "auto-fix:config:get": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      if (!repoName) return { ok: false, error: "missing repoName" };
      return { ok: true, data: loadAutoFixConfig(repoName) };
    },

    "auto-fix:config:set": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const patch    = payload?.patch    as Partial<AutoFixConfig> | undefined;
      if (!repoName || !patch) return { ok: false, error: "missing repoName/patch" };
      const current = loadAutoFixConfig(repoName);
      const next: AutoFixConfig = { ...current, ...patch };
      saveAutoFixConfig(repoName, next);
      return { ok: true, data: next };
    },
  };
}
