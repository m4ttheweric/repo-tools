#!/usr/bin/env bun

/**
 * rt nav: Filesystem navigator.
 *
 * Browse folders and files. Selecting a folder descends into it; selecting a
 * file opens it in its default app and stays open (like a persistent Finder).
 * "cd here" cds to the displayed directory. esc quits.
 * ctrl-o on a folder opens it in your code editor. ctrl-up goes up a directory.
 * ctrl-k opens an action menu on the highlighted item (Open with…, Reveal in
 * Finder, Quick Look, Copy path, Open terminal here).
 *
 * Dotfiles are hidden by default; ctrl-t toggles showing them.
 *
 * The listing refreshes itself: files that appear or disappear while the
 * picker is open show up without leaving and re-entering.
 *
 * ctrl-s picks the sort order: Name (the default), Date Modified, Date Created,
 * Size, or Kind. Choosing the sort that is already active reverses it. Folders
 * always stay above files, sorted within their own group. The sort lasts for
 * the session and resets on the next run.
 *
 * Optional first arg sets the starting directory (defaults to cwd).
 *
 * One picker session spans the whole browse: descending into a folder,
 * toggling hidden files, and re-sorting all re-render the same session in
 * place rather than closing and reopening it. A session only ends when the
 * user actually leaves nav (cd, quit) or an action needs the real terminal
 * (an external editor, Quick Look, a spawned shell). Those close the
 * session, run their side effect, then open a fresh one back where the user
 * left off.
 */

import { join, dirname, resolve } from "path";
import { spawnSync as realSpawnSync } from "child_process";
import { homedir } from "os";
import { openDirectoryInEditor as realOpenDirectoryInEditor } from "./code.ts";
import { runNavPicker, type NavOption } from "../lib/navigate.ts";
import {
  listEntries, startDirWatch as realStartDirWatch,
  DEFAULT_SORT, SORT_OPTIONS, sortLabel, isDefaultSort,
  type SortState, type SortKey,
} from "../lib/nav-fs.ts";
import { runPick, type PickHandle } from "../lib/ui/pick.ts";
import { printAborted } from "../lib/ui/abort.ts";
import type { PickAction, PickEvent, PickRow } from "../lib/ui/protocol.ts";

function tildeify(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

type ItemKind = "file" | "folder";

/** Sentinel row value for the empty-directory notice (see buildRows). */
const EMPTY_VALUE = "__empty__";

/** Injectable side effects, so tests never spawn real processes or poll the real filesystem. */
export interface NavDeps {
  spawnSync: typeof realSpawnSync;
  startDirWatch: typeof realStartDirWatch;
  openDirectoryInEditor: (dirPath: string) => Promise<void>;
}

const defaultDeps: NavDeps = {
  spawnSync: realSpawnSync,
  startDirWatch: realStartDirWatch,
  openDirectoryInEditor: realOpenDirectoryInEditor,
};

// ─── Rows / actions ──────────────────────────────────────────────────────────

// Nerd Font nf-fa-folder (U+F07B): terminals with the font render a proper
// folder glyph; others fall back to whatever their own font stack
// substitutes. No emoji, matching the picker's visual language elsewhere.
const FOLDER_GLYPH = "\uf07b";

function folderRow(name: string): PickRow {
  return { value: "d:" + name, left: [{ text: `${FOLDER_GLYPH} `, tone: "cyan" }, { text: name, bold: true }] };
}

function fileRow(name: string): PickRow {
  return { value: "f:" + name, left: [{ text: name }] };
}

function emptyRow(): PickRow {
  return { value: EMPTY_VALUE, left: [{ text: "empty folder", tone: "faint" }] };
}

function buildRows(cwd: string, showHidden: boolean, sort: SortState): { rows: PickRow[]; empty: boolean; folders: number; files: number } {
  const { folders, files } = listEntries(cwd, showHidden, sort);
  if (folders.length === 0 && files.length === 0) {
    return { rows: [emptyRow()], empty: true, folders: 0, files: 0 };
  }
  return { rows: [...folders.map(folderRow), ...files.map(fileRow)], empty: false, folders: folders.length, files: files.length };
}

function headerMessage(cwd: string, sort: SortState): string {
  return tildeify(cwd) + headerSuffix(sort);
}

/** The header's cwd breadcrumb: one bold segment. The faint sort suffix is carried separately (crumbSuffix), not folded into this segment. */
function headerBreadcrumb(cwd: string): string[] {
  return [tildeify(cwd)];
}

/**
 * The faint sort suffix, empty on the default sort. The picker paints it faint
 * (PickRequest.crumbSuffix), separate from the bold cwd breadcrumb, per
 * docs/design/picker/Nav.dc.html.
 */
function headerSuffix(sort: SortState): string {
  return isDefaultSort(sort) ? "" : ` (${sortLabel(sort)})`;
}

/** The header's idle count in the design board's grammar: "N folders · M files". */
function idleCountLabel(folders: number, files: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(folders, "folder")} · ${plural(files, "file")}`;
}

/**
 * The registry for the current cwd. Deliberately rebuilt (not patched) on
 * every rows update: the empty-directory state binds "enter" to a different,
 * terminal action than normal browsing does, so the two action sets can never
 * be allowed to drift out of sync with which row set is on screen.
 */
function buildActions(empty: boolean, opts: { showHidden: boolean; expanded: boolean }): PickAction[] {
  const hiddenLabel = opts.showHidden ? "hide hidden" : "show hidden";

  if (empty) {
    return [
      { id: "cd-here", label: "cd here", key: "enter", scope: "item", primary: true, group: "nav" },
      { id: "up", label: "up", key: "ctrl-up", scope: "global", event: true, group: "nav" },
      { id: "toggle-hidden", label: hiddenLabel, key: "ctrl-t", scope: "global", event: true, group: "view" },
    ];
  }

  return [
    { id: "open", label: "open", key: "enter", scope: "item", primary: true, event: true, group: "nav" },
    { id: "cd-selected", label: "cd selected", key: "ctrl-space", scope: "item", group: "nav" },
    { id: "cd-here", label: "cd here", key: "ctrl-h", scope: "global", group: "nav" },
    { id: "up", label: "up", key: "ctrl-up", scope: "global", event: true, group: "nav" },
    { id: "editor", label: "open in editor", key: "ctrl-o", scope: "item", group: "act" },
    { id: "finder", label: "finder", key: "ctrl-f", scope: "global", event: true, group: "act" },
    // No key: ctrl-k / right-click menu only.
    { id: "open-with", label: "open with…", scope: "item", group: "act" },
    { id: "quicklook", label: "quick look", scope: "item", group: "act" },
    { id: "reveal", label: "reveal in finder", scope: "item", event: true, group: "act" },
    { id: "copy-path", label: "copy path", scope: "item", event: true, group: "act" },
    { id: "terminal", label: "open terminal here", scope: "item", group: "act" },
    { id: "toggle-hidden", label: hiddenLabel, key: "ctrl-t", scope: "global", event: true, group: "view" },
    { id: "sort", label: "sort", key: "ctrl-s", scope: "global", event: true, group: "view" },
    // Ungrouped so it pins to the always-visible right run next to esc, the
    // one place a truncated left cluster can never drop it -- NavMenus.dc.html
    // advertises "ctrl-/ commands" there so the ctrl-k/t/s menus stay findable.
    { id: "expand", label: opts.expanded ? "less" : "commands", key: "ctrl-/", scope: "global", event: true },
  ];
}

// ─── Sort modal ──────────────────────────────────────────────────────────────

function sortModalRows(current: SortState): PickRow[] {
  return SORT_OPTIONS.map((o) => {
    const active = o.key === current.key;
    return {
      value: o.key,
      left: [
        { text: active ? "● " : "  ", ...(active ? { tone: "mint" } : {}) },
        { text: o.label, bold: active, tone: active ? "text" : "textsoft" },
      ],
      right: [{ text: active ? `${current.reverse ? o.reversed : o.forward}  (select to reverse)` : o.forward, tone: "dim" }],
    };
  });
}

/** Choosing the already-active sort reverses it, matching what clicking a Finder column header does. */
async function runSortModal(handle: PickHandle, current: SortState): Promise<SortState> {
  const choice = await handle.modal("Sort by", sortModalRows(current));
  if (!choice) return current;
  const key = choice as SortKey;
  return key === current.key ? { key, reverse: !current.reverse } : { key, reverse: false };
}

// ─── Open with… (ctrl-k, needs the real terminal) ───────────────────────────

async function pickOpenWith(target: string, kind: ItemKind, deps: NavDeps): Promise<boolean> {
  const name = target.split("/").pop() || target;
  const defaultLabel = kind === "folder" ? "Finder" : "Default app";
  const options: NavOption[] = [
    { value: "nvim", label: "nvim", hint: "nvim" },
    { value: "code", label: "VS Code", hint: "code" },
    { value: "cursor", label: "Cursor", hint: "cursor" },
    { value: "open", label: defaultLabel, hint: "open" },
  ];
  const result = await runNavPicker({
    options, message: `Open ${name} with`, header: "esc: cancel", expectKeys: [],
  });
  // ctrl-up is always in the expect set and means "back" everywhere in rt, so
  // treat it as cancel here, not as accepting the highlighted row.
  if (!result || !result.value || result.key === "ctrl-up") return false;
  deps.spawnSync(result.value, [target], { stdio: "inherit" });
  return true;
}

// ─── One browse session (one runPick call) ──────────────────────────────────

type SessionOutcome =
  | { type: "cd"; path: string }
  // `aborted` distinguishes esc/cancel-to-shell (and a terminal/open-with
  // action that fired with nothing under the cursor to act on) from a
  // deliberate quit that actually opened a terminal or launched an app;
  // only the former prints the "aborted" line.
  | { type: "quit"; aborted?: boolean }
  | { type: "resume"; cwd: string; showHidden: boolean; sort: SortState; resumeValue?: string; initialQuery?: string };

interface SessionState {
  cwd: string;
  showHidden: boolean;
  sort: SortState;
  resumeValue?: string;
  initialQuery?: string;
}

/** "d:name" / "f:name" -> the absolute path and its kind. */
function targetOf(cwd: string, value: string): { kind: ItemKind; target: string } {
  return { kind: value[0] === "d" ? "folder" : "file", target: join(cwd, value.slice(2)) };
}

async function runNavSession(state: SessionState, deps: NavDeps): Promise<SessionOutcome> {
  let { cwd, showHidden, sort } = state;
  let expanded = false;
  let empty = false;
  // A ref object, not a bare `let`: the watcher is only ever assigned from
  // inside rearmWatch's closure, and TS won't carry that assignment's
  // narrowing back out to the read at session end otherwise.
  const watcherRef: { current: { stop(): void } | null } = { current: null };

  const pushRows = (handle: PickHandle, opts: { resetQuery?: boolean } = {}) => {
    const built = buildRows(cwd, showHidden, sort);
    empty = built.empty;
    handle.update({
      rows: built.rows,
      message: headerMessage(cwd, sort),
      breadcrumb: headerBreadcrumb(cwd),
      idleCount: idleCountLabel(built.folders, built.files),
      ...(headerSuffix(sort) ? { crumbSuffix: headerSuffix(sort) } : {}),
      actions: buildActions(empty, { showHidden, expanded }),
      ...(opts.resetQuery ? { resetQuery: true } : {}),
    });
  };

  const rearmWatch = (handle: PickHandle) => {
    watcherRef.current?.stop();
    watcherRef.current = deps.startDirWatch({ dir: cwd, onChange: () => pushRows(handle) });
  };

  const initial = buildRows(cwd, showHidden, sort);
  empty = initial.empty;

  const handle = runPick(
    {
      message: headerMessage(cwd, sort),
      breadcrumb: headerBreadcrumb(cwd),
      idleCount: idleCountLabel(initial.folders, initial.files),
      ...(headerSuffix(sort) ? { crumbSuffix: headerSuffix(sort) } : {}),
      rows: initial.rows,
      actions: buildActions(empty, { showHidden, expanded }),
      ...(state.resumeValue ? { resumeValue: state.resumeValue } : {}),
      ...(state.initialQuery ? { initialQuery: state.initialQuery } : {}),
    },
    { onEvent: (evt) => handleEvent(evt) },
  );

  async function handleEvent(evt: PickEvent): Promise<void> {
    switch (evt.action) {
      case "open": {
        if (!evt.value) return;
        const { kind, target } = targetOf(cwd, evt.value);
        if (kind === "folder") {
          cwd = target;
          pushRows(handle, { resetQuery: true });
          rearmWatch(handle);
        } else {
          // Returns immediately; browsing continues.
          deps.spawnSync("open", [target], { stdio: "ignore" });
        }
        return;
      }
      case "up": {
        if (cwd !== "/") {
          cwd = dirname(cwd);
          pushRows(handle, { resetQuery: true });
          rearmWatch(handle);
        }
        return;
      }
      case "toggle-hidden": {
        showHidden = !showHidden;
        pushRows(handle);
        return;
      }
      case "sort": {
        sort = await runSortModal(handle, sort);
        pushRows(handle);
        return;
      }
      case "finder": {
        deps.spawnSync("open", [cwd], { stdio: "ignore" });
        return;
      }
      case "reveal": {
        if (!evt.value || evt.value === EMPTY_VALUE) return;
        const { kind, target } = targetOf(cwd, evt.value);
        deps.spawnSync("open", kind === "file" ? ["-R", target] : [target], { stdio: "ignore" });
        return;
      }
      case "copy-path": {
        if (!evt.value || evt.value === EMPTY_VALUE) return;
        const { target } = targetOf(cwd, evt.value);
        deps.spawnSync("pbcopy", [], { input: target });
        return;
      }
      case "expand": {
        expanded = !expanded;
        handle.update({ actions: buildActions(empty, { showHidden, expanded }) });
        return;
      }
    }
  }

  rearmWatch(handle);

  const result = await handle.result;
  watcherRef.current?.stop();

  switch (result.action) {
    case "cd-here":
      return { type: "cd", path: cwd };

    case "cd-selected": {
      if (!result.value || result.value === EMPTY_VALUE) return { type: "cd", path: cwd };
      const { kind, target } = targetOf(cwd, result.value);
      return { type: "cd", path: kind === "folder" ? target : dirname(target) };
    }

    case "editor": {
      if (result.value) {
        const { kind, target } = targetOf(cwd, result.value);
        if (kind === "folder") {
          await deps.openDirectoryInEditor(target);
        } else {
          // ctrl-o on a file has no editor-specific meaning; opening it with
          // its default app matches what enter would have done.
          deps.spawnSync("open", [target], { stdio: "ignore" });
        }
      }
      return { type: "resume", cwd, showHidden, sort, resumeValue: result.value ?? undefined, initialQuery: result.query || undefined };
    }

    case "quicklook": {
      if (result.value) {
        const { target } = targetOf(cwd, result.value);
        const name = target.split("/").pop() || target;
        // qlmanage blocks until the preview window is dismissed, and the
        // picker has already torn down by the time it runs, so without this
        // line the terminal just sits empty with nothing to explain the wait.
        console.error(`  Quick Look: ${name}  (close the preview to return)`);
        const r = deps.spawnSync("qlmanage", ["-p", target], {
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        if (r.error || (r.status !== null && r.status !== 0)) {
          const detail = r.error?.message ?? (r.stderr || r.stdout || "").trim() ?? "";
          console.error(`  Quick Look failed${detail ? `: ${detail.split("\n")[0]}` : ` (exit ${r.status})`}`);
        }
      } else {
        printAborted();
      }
      return { type: "resume", cwd, showHidden, sort, resumeValue: result.value ?? undefined, initialQuery: result.query || undefined };
    }

    case "terminal": {
      if (result.value) {
        const { kind, target } = targetOf(cwd, result.value);
        const shellCwd = kind === "folder" ? target : dirname(target);
        const shell = process.env.SHELL || "/bin/zsh";
        deps.spawnSync(shell, [], { cwd: shellCwd, stdio: "inherit" });
        return { type: "quit" };
      }
      return { type: "quit", aborted: true };
    }

    case "open-with": {
      if (!result.value) return { type: "quit", aborted: true };
      const { kind, target } = targetOf(cwd, result.value);
      const launched = await pickOpenWith(target, kind, deps);
      if (launched) return { type: "quit" };
      printAborted();
      return { type: "resume", cwd, showHidden, sort, resumeValue: result.value, initialQuery: result.query || undefined };
    }

    default:
      // "cancel" (esc), or anything else Go's own fallback might produce.
      return { type: "quit", aborted: true };
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function navigate(args: string[], depsOverride: Partial<NavDeps> = {}): Promise<void> {
  const deps: NavDeps = { ...defaultDeps, ...depsOverride };

  // Redirect stdout → stderr so the picker's own chrome never contaminates
  // the path output a shell wrapper reads.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const cdAndExit = (path: string) => {
    process.stdout.write = realStdoutWrite;
    realStdoutWrite(path + "\n");
  };

  let state: SessionState = {
    cwd: resolve(args[0] ?? process.cwd()),
    showHidden: false,
    sort: { ...DEFAULT_SORT },
  };

  while (true) {
    const outcome = await runNavSession(state, deps);
    if (outcome.type === "cd") {
      cdAndExit(outcome.path);
      return;
    }
    if (outcome.type === "quit") {
      if (outcome.aborted) printAborted();
      return;
    }
    state = outcome;
  }
}
