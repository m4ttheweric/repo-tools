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
 * Optional first arg sets the starting directory (defaults to cwd).
 */

import { readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { openDirectoryInEditor } from "./code.ts";
import { runNavPicker, type NavOption } from "../lib/navigate.ts";


function tildeify(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

function listEntries(dir: string): { folders: string[]; files: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { folders: [], files: [] };
  }
  const folders: string[] = [];
  const files: string[] = [];
  for (const name of entries) {
    let isDir: boolean;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) folders.push(name);
    else files.push(name);
  }
  const cmp = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base" });
  folders.sort(cmp);
  files.sort(cmp);
  return { folders, files };
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

  let cwd = resolve(args[0] ?? process.cwd());
  // Preserved across ctrl-k action-menu round trips so the user's filter and
  // cursor position survive. Reset on any cwd-changing navigation.
  let resumeQuery = "";
  let resumeValue = "";

  while (true) {
    const { folders, files } = listEntries(cwd);
    const atRoot = cwd === "/";

    const options: NavOption[] = [
      ...folders.map((name) => ({
        value: "d:" + name,
        label: "📁 " + name,
        hint: "",
      })),
      ...files.map((name) => ({
        value: "f:" + name,
        label: name,
        hint: "",
      })),
    ];

    // Empty directory: nothing to descend into. Instead of dead-ending (which
    // would print no path and leave the shell wrapper with nowhere to cd),
    // surface a notice so the user can land here or back out.
    if (options.length === 0) {
      const result = await runNavPicker({
        options: [{ value: "__cd_here__", label: "📭 empty folder", hint: "" }],
        message: tildeify(cwd),
        header: "enter: cd here  ctrl-up: up  esc: cancel",
        expectKeys: [],
      });
      if (!result) return; // esc
      const { value: choice, key } = result;
      if (key === "ctrl-up") {
        if (!atRoot) cwd = dirname(cwd);
        continue;
      }
      if (choice === null) return; // esc — cancel without cd
      // enter on the notice → cd into this (empty) directory
      process.stdout.write = realStdoutWrite;
      realStdoutWrite(cwd + "\n");
      return;
    }

    const result = await runNavPicker({
      options,
      message: tildeify(cwd),
      header: "enter: open  ctrl-k: actions  ctrl-o: editor  ctrl-up: up  ctrl-space: cd selected  ctrl-h: cd here  ctrl-f: finder  esc: quit",
      expectKeys: ["ctrl-k", "ctrl-o", "ctrl-space", "ctrl-h", "ctrl-f"],
      initialQuery: resumeQuery,
      resumeValue: resumeValue || undefined,
    });
    if (!result) return;
    const { value: choice, key, query } = result;

    // Clear resume state by default; ctrl-k branches re-set it below.
    resumeQuery = "";
    resumeValue = "";

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

    // ctrl-up: go up regardless of what's selected
    if (key === "ctrl-up") {
      if (!atRoot) cwd = dirname(cwd);
      continue;
    }

    // ctrl-h: cd to the currently displayed directory
    if (key === "ctrl-h") {
      process.stdout.write = realStdoutWrite;
      realStdoutWrite(cwd + "\n");
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
        process.stdout.write = realStdoutWrite;
        realStdoutWrite(target + "\n");
        return;
      }
      if (key === "ctrl-o") {
        await openDirectoryInEditor(target);
        return;
      }
      cwd = target;
      continue;
    }

    // File: ctrl-space cds to its containing directory
    if (key === "ctrl-space") {
      process.stdout.write = realStdoutWrite;
      realStdoutWrite(cwd + "\n");
      return;
    }

    spawnSync("open", [target], { stdio: "inherit" });
    continue;
  }
}
