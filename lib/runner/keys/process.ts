/**
 * Process-scope keymap (entered with [p]).
 *
 * Bindings: add/remove entry, start/activate, warm-all, edit remedy rules,
 * edit command template, open shell at entry cwd.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import {
  entryWindowName,
  globalRemedyPath, remediesDir,
} from "../../runner-store.ts";
import type { RunResolveResult } from "../../../commands/run.ts";
import type { LaneAction } from "../dispatch.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

/**
 * Build an editor invocation string. Injected via ctx so that the detector
 * (which probes $EDITOR / nvim / vim / nano) lives in runner.tsx alongside
 * every other editor-launching caller.
 */
export interface ProcessKeymapDeps {
  buildEditorCmd: (filePath: string) => { editorCmd: string; hint: string };
}

export function createProcessKeymap(ctx: KeymapContext, deps: ProcessKeymapDeps): KeymapHandlers {
  const { buildEditorCmd } = deps;

  const exitScope = (update: StateUpdater) => {
    update((s) => ({ ...s, mode: { type: "normal" } }));
    ctx.setMode("default");
  };

  return {
    escape: ({ update }) => exitScope(update),

    // [a] add process to selected lane
    a: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const laneRepo = state.knownRepos.find((r) => r.repoName === lane.repoName);
      const laneRepoRoot = laneRepo?.worktrees[0]?.path ?? process.cwd();
      const tmpFile = join(tmpdir(), `rt-resolve-${Date.now()}.json`);
      const cmd = `${ctx.rtShell} run --resolve-only --repo ${lane.repoName} > ${tmpFile}`;
      ctx.openPopup(cmd, { cwd: laneRepoRoot, title: "add process", width: "100", height: "20" });
      const poll = setInterval(() => {
        if (!existsSync(tmpFile)) return;
        const content = readFileSync(tmpFile, "utf8").trim();
        if (!content) return;
        clearInterval(poll);
        try {
          const resolved = JSON.parse(content) as RunResolveResult;
          unlinkSync(tmpFile);
          void ctx.addResolvedEntry(lane.id, resolved);
        } catch { /* ignore parse errors */ }
      }, 300);
    },

    // [s] start / restart / respawn / activate
    s: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      const win = entryWindowName(lane.id, entry.id);
      const st = state.entryStates.get(win) ?? "stopped";
      if (st === "starting" || st === "stopping") return;
      const action: LaneAction =
        st === "stopped" ? { type: "spawn",   laneId: lane.id, entryId: entry.id } :
        st === "crashed" ? { type: "respawn", laneId: lane.id, entryId: entry.id } :
        (st === "running" && lane.activeEntryId === entry.id)
          ? { type: "restart",  laneId: lane.id, entryId: entry.id } :
            { type: "activate", laneId: lane.id, entryId: entry.id };
      ctx.doDispatch(action, state);
    },

    // [w] warm all entries in lane (spawn all, only active runs)
    w: ({ update }) => {
      exitScope(update);
      const s = ctx.getCurrentState();
      if (!s) return;
      const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
      if (lane) ctx.doDispatch({ type: "warm-all", laneId: lane.id }, s);
    },

    // [enter] activate the selected entry (auto-start if stopped)
    enter: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry || lane.activeEntryId === entry.id) return;
      ctx.doDispatch({ type: "activate", laneId: lane.id, entryId: entry.id }, state);
    },

    // [r] remove entry (opens entry picker overlay)
    r: ({ update }) => {
      const state = ctx.getCurrentState();
      if (!state) { exitScope(update); return; }
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane || lane.entries.length === 0) { exitScope(update); return; }
      const safeEi = Math.min(state.entryIdx, lane.entries.length - 1);
      update((s) => ({ ...s, mode: { type: "entry-picker", purpose: "remove", laneId: lane.id, idx: safeEi } }));
      ctx.setMode("entry-picker");
    },

    // [f] open global remedy rules file in $EDITOR
    //     File: ~/.rt/remedies/_global.json
    //     The daemon file-watches this and hot-reloads on save — no restart needed.
    f: ({ update }) => {
      exitScope(update);
      const gPath = globalRemedyPath();
      mkdirSync(remediesDir(), { recursive: true });
      // Seed an example if the file doesn't exist yet
      if (!existsSync(gPath)) {
        writeFileSync(gPath, JSON.stringify([
          {
            name: "Example — clear Prisma cache",
            cwdContains: "apps/backend",
            cmdContains: "start:lite",
            pattern: "PrismaClientInitializationError",
            cmds: ["rm -rf node_modules/.prisma"],
            thenRestart: true,
            cooldownMs: 30000,
          },
        ], null, 2));
      }
      const { editorCmd, hint } = buildEditorCmd(gPath);
      ctx.openPopup(editorCmd, { title: "remedy rules (_global.json)", hint, width: "110", height: "30" });
      ctx.showToast("✓ Remedy rules saved — daemon reloads automatically");
    },

    // [e] edit command template via $EDITOR
    e: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      const tmpFile = `/tmp/rt-edit-${entry.id}.sh`;
      writeFileSync(tmpFile, entry.commandTemplate + "\n");
      const { editorCmd, hint } = buildEditorCmd(tmpFile);
      ctx.openPopup(editorCmd, { title: "edit command", hint, width: "100", height: "12" });
      try {
        const newCmd = readFileSync(tmpFile, "utf8").trim();
        if (newCmd && newCmd !== entry.commandTemplate) {
          update((s) => {
            const next = s.lanes.map((l) =>
              l.id === lane.id
                ? { ...l, entries: l.entries.map((e) => e.id === entry.id ? { ...e, commandTemplate: newCmd } : e) }
                : l
            );
            ctx.saveCurrent(next);
            return { ...s, lanes: next };
          });
          ctx.showToast("command updated — restart entry to apply");
        }
      } catch { /* file gone or unreadable */ }
      try { unlinkSync(tmpFile); } catch { /* already cleaned */ }
    },

    // [t] open shell at entry's working directory
    t: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.openTempPane(process.env.SHELL ?? "zsh", { cwd: entry.targetDir, target: ctx.displayPane(), escToClose: true });
    },
  };
}
