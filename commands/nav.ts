#!/usr/bin/env bun

/**
 * rt nav — Filesystem navigator using fzf.
 *
 * Browse folders and files. Selecting a folder descends into it; selecting a
 * file opens it in its default app and stays open (like a persistent Finder).
 * "→ cd here" cds to the displayed directory. esc quits.
 * ctrl-o on a folder opens it in your code editor. ctrl-up goes up a directory.
 * ctrl-k opens an action menu on the highlighted item (Open with…, Reveal in
 * Finder, Quick Look, Copy path, Open terminal here).
 *
 * Dotfiles are hidden by default; ctrl-t toggles showing them. ctrl-r toggles
 * deep-jump mode, recursively listing everything under the current directory
 * so you can filter across nested paths. ctrl-p toggles a preview pane
 * showing the highlighted folder's contents or file's text.
 *
 * Optional first arg sets the starting directory (defaults to cwd).
 */

import { join, dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { openDirectoryInEditor } from "./code.ts";
import { runNavPicker, type NavOption } from "../lib/navigate.ts";
import { listEntries, deepList, buildPreviewCommand } from "../lib/nav-fs.ts";

function tildeify(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

type ItemKind = "file" | "folder";

async function pickOpenWith(target: string, kind: ItemKind): Promise<boolean> {
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
  // ctrl-up is always in fzf's --expect (it means "back" everywhere in rt) —
  // treat it as cancel here, not as accepting the highlighted row.
  if (!result || !result.value || result.key === "ctrl-up") return false;
  const app = result.value;

  spawnSync(app, [target], { stdio: "inherit" });
  return true;
}

async function runActionMenu(target: string, kind: ItemKind): Promise<{ exit: boolean }> {
  const name = target.split("/").pop() || target;
  const options: NavOption[] = [
    { value: "open-with", label: "Open with…", hint: "" },
    { value: "reveal", label: "Reveal in Finder", hint: kind === "file" ? "open -R" : "open" },
    ...(kind === "file"
      ? [{ value: "quicklook", label: "Quick Look", hint: "qlmanage -p" }]
      : []),
    { value: "copy-path", label: "Copy path", hint: "pbcopy" },
    ...(kind === "folder"
      ? [{ value: "terminal", label: "Open terminal here", hint: "$SHELL" }]
      : []),
  ];

  const result = await runNavPicker({
    options, message: `Actions for ${name}`, header: "esc: cancel", expectKeys: [],
  });
  // ctrl-up means "back", not "run the highlighted action" (see pickOpenWith).
  if (!result || result.key === "ctrl-up") return { exit: false };
  const { value: action } = result;

  switch (action) {
    case "open-with":
      return { exit: await pickOpenWith(target, kind) };

    case "reveal":
      spawnSync("open", kind === "file" ? ["-R", target] : [target], { stdio: "inherit" });
      return { exit: false };

    case "quicklook":
      spawnSync("qlmanage", ["-p", target], { stdio: ["ignore", "ignore", "ignore"] });
      return { exit: false };

    case "copy-path":
      spawnSync("pbcopy", [], { input: target });
      console.error(`  copied: ${target}`);
      return { exit: false };

    case "terminal": {
      const shell = process.env.SHELL || "/bin/zsh";
      spawnSync(shell, [], { cwd: target, stdio: "inherit" });
      return { exit: true };
    }
  }
  return { exit: false };
}

export async function navigate(args: string[]): Promise<void> {
  // Redirect stdout → stderr so TUI output doesn't contaminate the path output
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const cdAndExit = (path: string) => {
    process.stdout.write = realStdoutWrite;
    realStdoutWrite(path + "\n");
  };

  let cwd = resolve(args[0] ?? process.cwd());
  let showHidden = false;
  let deepMode = false;
  // Preserved across ctrl-k/ctrl-t/ctrl-f round trips so the user's filter and
  // cursor position survive. Reset on any cwd-changing navigation.
  let resumeQuery = "";
  let resumeValue = "";

  while (true) {
    const atRoot = cwd === "/";
    const { folders, files } = deepMode
      ? deepList(cwd, { showHidden })
      : listEntries(cwd, showHidden);

    const options: NavOption[] = [
      ...folders.map((name) => ({ value: "d:" + name, label: "📁 " + name, hint: "" })),
      ...files.map((name) => ({ value: "f:" + name, label: name, hint: "" })),
    ];

    const hiddenHint = showHidden ? "ctrl-t: hide hidden" : "ctrl-t: show hidden";

    if (options.length === 0) {
      // Deep mode with zero results (everything ignored/hidden): fall back to
      // browse mode rather than rendering an empty picker.
      if (deepMode) {
        deepMode = false;
        continue;
      }
      // Empty directory: nothing to descend into. Instead of dead-ending
      // (which would print no path and leave the shell wrapper with nowhere
      // to cd), surface a notice so the user can land here or back out.
      const result = await runNavPicker({
        options: [{ value: "__cd_here__", label: "📭 empty folder", hint: "" }],
        message: tildeify(cwd),
        header: `enter: cd here  ctrl-up: up  ${hiddenHint}  esc: cancel`,
        expectKeys: ["ctrl-t"],
      });
      if (!result) return; // esc
      const { value: choice, key } = result;
      if (key === "ctrl-up") {
        if (!atRoot) cwd = dirname(cwd);
        continue;
      }
      if (key === "ctrl-t") {
        showHidden = !showHidden;
        continue;
      }
      if (choice === null) return; // esc — cancel without cd
      cdAndExit(cwd); // enter on the notice → cd into this (empty) directory
      return;
    }

    const modeHint = deepMode ? "ctrl-r: browse" : "ctrl-r: deep jump";
    const upHint = deepMode ? "ctrl-up: browse" : "ctrl-up: up";
    // Revealed by ctrl-/. Two columns spread across the list area — the
    // preview pane takes the right half of the terminal, and fzf truncates
    // (not wraps) header lines that overflow.
    const helpPairs: Array<[string, string]> = [
      ["enter: open", "ctrl-k: actions"],
      ["ctrl-space: cd selected", "ctrl-o: editor"],
      ["ctrl-h: cd here", "ctrl-f: finder"],
      [upHint, modeHint],
      ["esc: quit", hiddenHint],
      ["", "ctrl-p: preview"],
    ];
    const termCols = process.stderr.columns || 80;
    const listWidth = Math.floor(termCols / 2) - 4; // preview + borders
    const rightWidth = Math.max(...helpPairs.map(([, right]) => right.length));
    const leftPad = Math.max(25, listWidth - rightWidth);
    const helpHeader = helpPairs
      .map(([left, right]) => (left.padEnd(leftPad) + right).trimEnd())
      .join("\n");
    const result = await runNavPicker({
      options,
      message: tildeify(cwd) + (deepMode ? " (deep)" : ""),
      helpHeader,
      expectKeys: ["ctrl-k", "ctrl-o", "ctrl-space", "ctrl-h", "ctrl-f", "ctrl-r", "ctrl-t"],
      initialQuery: resumeQuery,
      resumeValue: resumeValue || undefined,
      preview: buildPreviewCommand(cwd),
    });
    if (!result) return;
    const { value: choice, key, query } = result;

    // Clear resume state by default; round-trip branches re-set it below.
    resumeQuery = "";
    resumeValue = "";

    // ctrl-t: toggle hidden files, preserving filter (cursor value may vanish
    // from the new list — findResumePosition returns null and that's fine)
    if (key === "ctrl-t") {
      showHidden = !showHidden;
      resumeQuery = query;
      resumeValue = choice ?? "";
      continue;
    }

    // ctrl-r: toggle deep-jump mode. Keep the typed filter (likely still
    // relevant) but not the cursor value (row set changes entirely).
    if (key === "ctrl-r") {
      deepMode = !deepMode;
      resumeQuery = query;
      continue;
    }

    // ctrl-k: open action menu on highlighted item (skip on empty rows)
    if (key === "ctrl-k") {
      if (choice === null) {
        resumeQuery = query;
        resumeValue = "";
        continue;
      }
      const kind: ItemKind = choice[0] === "d" ? "folder" : "file";
      const target = join(cwd, choice.slice(2));
      const { exit } = await runActionMenu(target, kind);
      if (exit) return;
      resumeQuery = query;
      resumeValue = choice;
      continue;
    }

    // ctrl-up: in deep mode, back to browse; otherwise go up a directory
    if (key === "ctrl-up") {
      if (deepMode) {
        deepMode = false;
      } else if (!atRoot) {
        cwd = dirname(cwd);
      }
      continue;
    }

    // ctrl-h: cd to the currently displayed directory
    if (key === "ctrl-h") {
      cdAndExit(cwd);
      return;
    }

    // ctrl-f: open current directory in Finder
    if (key === "ctrl-f") {
      spawnSync("open", [cwd], { stdio: "inherit" });
      resumeQuery = query;
      resumeValue = choice ?? "";
      continue;
    }

    if (choice === null) return;

    const kind = choice[0];
    const name = choice.slice(2);
    const target = join(cwd, name);

    if (kind === "d") {
      if (key === "ctrl-space") {
        cdAndExit(target);
        return;
      }
      if (key === "ctrl-o") {
        await openDirectoryInEditor(target);
        return;
      }
      // Descending always lands in browse mode: deep jump is a travel
      // accelerator, not a permanent view.
      cwd = target;
      deepMode = false;
      continue;
    }

    // File: ctrl-space cds to its containing directory (== cwd in browse
    // mode; the parent of a nested match in deep mode)
    if (key === "ctrl-space") {
      cdAndExit(dirname(target));
      return;
    }

    spawnSync("open", [target], { stdio: "inherit" });
    continue;
  }
}
