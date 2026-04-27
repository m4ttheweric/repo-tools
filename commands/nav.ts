#!/usr/bin/env bun

/**
 * rt nav — Filesystem navigator using fzf.
 *
 * Browse folders and files. Selecting a folder descends into it; selecting a
 * file opens it in its default app. "→ cd here" cds to the displayed directory.
 * ctrl-o on a folder opens it in your code editor. ctrl-up goes up a directory.
 *
 * Optional first arg sets the starting directory (defaults to cwd).
 */

import { readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { openDirectoryInEditor } from "./code.ts";

const UP = "__rt_nav_up__";

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

async function runFzf(
  options: FzfOption[],
  message: string,
): Promise<{ value: string | null; key: string | null }> {
  const { spawnSync: sp } = await import("child_process");
  const labelWidth = Math.max(...options.map((o) => o.label.length));
  const input = options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      return `${o.value}\t\x1b[1m${o.label}\x1b[22m${pad}\t  ${o.hint ? `\x1b[2m${o.hint}\x1b[22m` : ""}`;
    })
    .join("\n");

  const result = sp(
    "fzf",
    [
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
      "--header=enter: open  ctrl-o: open in editor  ctrl-up: go up  ctrl-space: cd selected  ctrl-h: cd here",
      "--no-mouse",
      "--expect=ctrl-o,ctrl-up,ctrl-space,ctrl-h",
    ],
    { input, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
  );

  if (result.status !== 0 || !result.stdout?.trim()) {
    return { value: null, key: null };
  }

  const lines = result.stdout.trimEnd().split("\n");
  const key = lines[0]?.trim() || null;
  const raw = lines[1]?.trim() ?? "";
  const value = raw.split("\t")[0] ?? null;
  return { value: value || null, key };
}

export async function navigate(args: string[]): Promise<void> {
  // Redirect stdout → stderr so TUI output doesn't contaminate the path output
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  let cwd = resolve(args[0] ?? process.cwd());

  while (true) {
    const { folders, files } = listEntries(cwd);
    const atRoot = cwd === "/";

    const options: FzfOption[] = [
      ...(!atRoot
        ? [{ value: UP, label: "↰ ..", hint: tildeify(dirname(cwd)) }]
        : []),

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

    const { value: choice, key } = await runFzf(options, tildeify(cwd));

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

    if (choice === UP) {
      if (key === "ctrl-space") {
        process.stdout.write = realStdoutWrite;
        realStdoutWrite(dirname(cwd) + "\n");
        return;
      }
      cwd = dirname(cwd);
      continue;
    }

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
