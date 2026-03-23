#!/usr/bin/env bun

/**
 * rt cd — Context-aware worktree/repo directory picker.
 *
 * Prints the selected path to stdout so a shell function can cd into it.
 *
 * Behavior:
 *   - In a tracked repo with worktrees → worktree picker + "switch repo" option
 *   - In a tracked repo without worktrees → repo picker (all known repos)
 *   - Not in a tracked repo → repo picker (all known repos with worktrees)
 *
 * Shell setup (add to ~/.zshrc):
 *   rtcd() { local dir; dir="$(rt cd "$@")" && [ -n "$dir" ] && cd "$dir"; }
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { yellow, green, reset } from "../lib/tui.ts";
import { getRepoIdentity, getKnownRepos, type KnownRepo } from "../lib/repo.ts";
import { pickWorktreeWithSwitch, pickFromAllRepos, isSwitchRepo } from "../lib/pickers.ts";

// ─── Shell function setup ────────────────────────────────────────────────────

const SHELL_FUNCTION = [
  `rt() {`,
  `  if [ "$1" = "cd" ]; then`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS command rt cd "\${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  else`,
  `    command rt "$@"`,
  `  fi`,
  `}`,
].join("\n");

async function ensureShellFunction(): Promise<void> {
  const rcFile = join(homedir(), ".zshrc");
  let rcContent = "";
  try {
    rcContent = readFileSync(rcFile, "utf8");
  } catch { /* no .zshrc */ }

  if (rcContent.includes('rt() {') && rcContent.includes('command rt cd')) return;

  // Redirect stdout → stderr before showing prompts
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
  const hasOldFunction = rcContent.includes("rtcd()");

  if (hasOldFunction) {
    console.log(`\n  ${yellow}Upgrading shell function: rtcd → rt cd (native)${reset}`);
  } else {
    console.log(`\n  ${yellow}rt cd needs a shell function to change your directory.${reset}`);
  }

  const install = await inkConfirm({
    message: hasOldFunction
      ? "Replace old rtcd() with native rt cd support in ~/.zshrc?"
      : "Add rt cd support to ~/.zshrc?",
    initialValue: true,
    stderr: true,
  });

  if (!install) {
    console.log(`\n  Add this to your shell config manually:\n`);
    console.log(SHELL_FUNCTION);
    process.stdout.write = origWrite;
    process.exit(0);
  }

  if (hasOldFunction) {
    rcContent = rcContent
      .replace(/\n?# rt — worktree\/repo directory picker\n?/g, "")
      .replace(/\n?rtcd\(\)[^\n]*\n?/g, "\n");
    writeFileSync(rcFile, rcContent);
  }

  const line = `\n# rt — shell wrapper (enables rt cd to change directory)\n${SHELL_FUNCTION}\n`;
  appendFileSync(rcFile, line);
  console.log(`  ${green}✓ Installed rt shell wrapper in ~/.zshrc${reset}`);
  console.log(`  Reloading shell config…`);

  try {
    execSync("source ~/.zshrc", { stdio: "ignore", shell: "/bin/zsh" });
  } catch { /* best-effort */ }

  process.stdout.write = origWrite;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(_args: string[]): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("rt cd must be run interactively");
    process.exit(1);
  }

  await ensureShellFunction();

  // Redirect stdout → stderr so TUI prompts don't contaminate the path output
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  if (!process.stdout.columns && process.stderr.columns) {
    Object.defineProperty(process.stdout, "columns", { value: process.stderr.columns, configurable: true });
  }

  const repos = getKnownRepos();
  const identity = getRepoIdentity();
  const currentRepo = identity
    ? repos.find(r => r.repoName === identity.repoName) ?? null
    : null;

  let selectedPath: string;

  if (currentRepo && currentRepo.worktrees.length > 1) {
    const result = await pickWorktreeWithSwitch(currentRepo, identity?.repoRoot || "", { stderr: true });
    selectedPath = isSwitchRepo(result)
      ? await pickFromAllRepos(repos, { stderr: true })
      : result;
  } else {
    selectedPath = await pickFromAllRepos(repos, { stderr: true });
  }

  // Restore stdout and print just the path
  process.stdout.write = realStdoutWrite;
  realStdoutWrite(selectedPath + "\n");
}
