#!/usr/bin/env bun

/**
 * rt nav — Filesystem navigator using fzf.
 *
 * Browse folders and files. Selecting a folder descends into it; selecting a
 * file opens it in its default app. "→ cd here" cds to the displayed directory.
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

interface FzfOption {
  value: string;
  label: string;
  hint: string;
}

function findResumePosition(
  options: FzfOption[],
  query: string,
  value: string,
): number | null {
  if (!value) return null;
  if (!query) {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx + 1 : null;
  }
  const input = options.map((o) => o.value).join("\n");
  const result = spawnSync("fzf", ["--filter", query], {
    input,
    encoding: "utf8",
  });
  if (!result.stdout) return null;
  const lines = result.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line === value);
  return idx >= 0 ? idx + 1 : null;
}

async function runFzf(
  options: FzfOption[],
  message: string,
  header = "enter: open  ctrl-k: actions  ctrl-o: editor  ctrl-up: up  ctrl-space: cd selected  ctrl-h: cd here",
  expectKeys = "ctrl-k,ctrl-o,ctrl-up,ctrl-space,ctrl-h",
  initialQuery = "",
  resumeValue = "",
  initialPos: number | null = null,
): Promise<{ value: string | null; key: string | null; query: string }> {
  const { spawnSync: sp } = await import("child_process");
  const labelWidth = Math.max(...options.map((o) => o.label.length));
  const input = options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      return `${o.value}\t\x1b[1m${o.label}\x1b[22m${pad}\t  ${o.hint ? `\x1b[2m${o.hint}\x1b[22m` : ""}`;
    })
    .join("\n");

  const resumePos = resumeValue
    ? findResumePosition(options, initialQuery, resumeValue)
    : null;
  const cursorPos = resumePos ?? initialPos;

  const args = [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    "--height=~100%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${message} `,
    "--prompt=filter: ",
    `--header=${header}`,
    "--no-mouse",
    "--print-query",
    ...(initialQuery ? [`--query=${initialQuery}`] : []),
    ...(cursorPos !== null ? [`--bind=load:pos(${cursorPos})`] : []),
    ...(expectKeys ? [`--expect=${expectKeys}`] : []),
  ];

  const result = sp("fzf", args, {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  // --print-query always prints the query as the first line, even on cancel.
  const stdout = result.stdout ?? "";
  const lines = stdout.replace(/\n$/, "").split("\n");
  const query = lines[0] ?? "";

  if (result.status !== 0) {
    return { value: null, key: null, query };
  }

  let key: string | null = null;
  let raw: string;
  if (expectKeys) {
    key = lines[1]?.trim() || null;
    raw = lines[2]?.trim() ?? "";
  } else {
    raw = lines[1]?.trim() ?? "";
  }
  const value = raw.split("\t")[0] ?? null;
  return { value: value || null, key, query };
}

type ItemKind = "file" | "folder";

async function pickOpenWith(target: string, kind: ItemKind): Promise<boolean> {
  const name = target.split("/").pop() || target;
  const defaultLabel = kind === "folder" ? "Finder" : "Default app";
  const options: FzfOption[] = [
    { value: "nvim", label: "nvim", hint: "nvim" },
    { value: "code", label: "VS Code", hint: "code" },
    { value: "cursor", label: "Cursor", hint: "cursor" },
    { value: "open", label: defaultLabel, hint: "open" },
  ];
  const { value: app } = await runFzf(options, `Open ${name} with`, "esc: cancel", "");
  if (!app) return false;

  spawnSync(app, [target], { stdio: "inherit" });
  return true;
}

async function runActionMenu(target: string, kind: ItemKind): Promise<{ exit: boolean }> {
  const name = target.split("/").pop() || target;
  const options: FzfOption[] = [
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

  const { value: action } = await runFzf(options, `Actions for ${name}`, "esc: cancel", "");
  if (!action) return { exit: false };

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

    const options: FzfOption[] = [
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

    if (options.length === 0) {
      console.error(`  ${tildeify(cwd)} is empty`);
      return;
    }

    const { value: choice, key, query } = await runFzf(
      options,
      tildeify(cwd),
      undefined,
      undefined,
      resumeQuery,
      resumeValue,
    );

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
    return;
  }
}
