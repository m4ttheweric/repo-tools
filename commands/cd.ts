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
  `  elif [ "$1" = "x" ]; then`,
  `    command rt "$@"`,
  `    local rt_cwd`,
  `    rt_cwd="$(cat "$HOME/.rt/.last-cwd" 2>/dev/null)"`,
  `    if [ -n "$rt_cwd" ] && [ "$rt_cwd" != "$PWD" ]; then`,
  `      builtin cd "$rt_cwd"`,
  `    fi`,
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

  if (rcContent.includes('rt() {') && rcContent.includes('command rt cd') && rcContent.includes('.last-cwd')) return;

  // Redirect stdout → stderr before showing prompts
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
  const hasLegacyRtcd = rcContent.includes("rtcd()");
  const hasOldRtWrapper = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes(".last-cwd");
  const hasOldFunction = hasLegacyRtcd || hasOldRtWrapper;

  if (hasOldRtWrapper) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt x auto-cd support${reset}`);
  } else if (hasLegacyRtcd) {
    console.error(`\n  ${yellow}Upgrading shell function: rtcd → rt cd (native)${reset}`);
  } else {
    console.error(`\n  ${yellow}rt cd needs a shell function to change your directory.${reset}`);
  }

  const install = await inkConfirm({
    message: hasOldFunction
      ? "Upgrade rt shell wrapper in ~/.zshrc?"
      : "Add rt cd support to ~/.zshrc?",
    initialValue: true,
    stderr: true,
  });

  if (!install) {
    console.error(`\n  Add this to your shell config manually:\n`);
    console.error(SHELL_FUNCTION);
    process.stdout.write = origWrite;
    process.exit(0);
  }

  if (hasOldRtWrapper) {
    // Remove the old rt() wrapper block
    rcContent = rcContent
      .replace(/\n?# rt — shell wrapper \(enables rt cd to change directory\)\n?/g, "")
      .replace(/\n?rt\(\) \{[\s\S]*?\n\}\n?/g, "\n");
    writeFileSync(rcFile, rcContent);
  } else if (hasLegacyRtcd) {
    rcContent = rcContent
      .replace(/\n?# rt — worktree\/repo directory picker\n?/g, "")
      .replace(/\n?rtcd\(\)[^\n]*\n?/g, "\n");
    writeFileSync(rcFile, rcContent);
  }

  const line = `\n# rt — shell wrapper (enables rt cd to change directory)\n${SHELL_FUNCTION}\n`;
  appendFileSync(rcFile, line);
  console.error(`  ${green}✓ Installed rt shell wrapper in ~/.zshrc${reset}`);
  console.error(`  Reloading shell config…`);

  try {
    execSync("source ~/.zshrc", { stdio: "ignore", shell: "/bin/zsh" });
  } catch { /* best-effort */ }

  process.stdout.write = origWrite;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function worktreePicker(_args: string[]): Promise<void> {

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
