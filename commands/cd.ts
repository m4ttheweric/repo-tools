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
 * Shell setup (add to your shell rc file):
 *   rtcd() { local dir; dir="$(rt cd "$@")" && [ -n "$dir" ] && cd "$dir"; }
 */

import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { yellow, green, reset } from "../lib/tui.ts";
import { getRepoIdentity, getKnownRepos, getWorkspacePackages, type KnownRepo } from "../lib/repo.ts";
import {
  pickWorktreeWithSwitch,
  pickFromAllRepos,
  pickPackageWithEscape,
  resolveWorktreeByBranch,
  isSwitchRepo,
} from "../lib/pickers.ts";
import { detectShell, shellRcPath } from "../lib/shell-integration.ts";

// ─── Shell function setup ────────────────────────────────────────────────────

const SHELL_FUNCTION = [
  `rt() {`,
  `  if [ "$1" = "cd" ]; then`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS command rt cd "\${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  elif [ "$1" = "nav" ]; then`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS command rt nav "\${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  elif [ "$1" = "x" ]; then`,
  `    command rt "$@"`,
  `    local rt_cwd`,
  `    rt_cwd="$(cat "$HOME/.rt/.last-cwd" 2>/dev/null)"`,
  `    if [ -n "$rt_cwd" ] && [ "$rt_cwd" != "$PWD" ]; then`,
  `      builtin cd "$rt_cwd"`,
  `    fi`,
  `  elif [ "$1" = "settings" ] && [ "$2" = "dev-mode" ]; then`,
  `    command rt "$@"`,
  `    # dev-mode swaps ~/.local/bin/rt in or out — rehash so the next invocation`,
  `    # resolves to the new wrapper/binary without a terminal restart.`,
  `    hash -r 2>/dev/null`,
  `  else`,
  `    command rt "$@"`,
  `  fi`,
  `}`,
].join("\n");

async function ensureShellFunction(): Promise<void> {
  const shell = detectShell();
  const rcFile = shellRcPath(shell) ?? join(homedir(), ".zshrc");
  let rcContent = "";
  try {
    rcContent = readFileSync(rcFile, "utf8");
  } catch { /* no rc file yet */ }

  // Latest version marker: includes rt nav cd support.
  if (rcContent.includes('rt() {') && rcContent.includes('command rt cd') && rcContent.includes('.last-cwd') && rcContent.includes('hash -r') && rcContent.includes('command rt nav')) return;

  // Redirect stdout → stderr before showing prompts
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
  const hasLegacyRtcd = rcContent.includes("rtcd()");
  const hasOldRtWrapper = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes(".last-cwd");
  const hasPreRehashWrapper = rcContent.includes("rt() {") && rcContent.includes(".last-cwd") && !rcContent.includes("hash -r");
  const hasOldFunction = hasLegacyRtcd || hasOldRtWrapper || hasPreRehashWrapper;

  const hasNoNav = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes("command rt nav");

  if (hasPreRehashWrapper) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: auto-rehash after dev-mode toggle${reset}`);
  } else if (hasNoNav) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt nav cd support${reset}`);
  } else if (hasOldRtWrapper) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt x auto-cd support${reset}`);
  } else if (hasLegacyRtcd) {
    console.error(`\n  ${yellow}Upgrading shell function: rtcd → rt cd (native)${reset}`);
  } else {
    console.error(`\n  ${yellow}rt cd needs a shell function to change your directory.${reset}`);
  }

  const hasOldFunction2 = hasOldFunction || hasNoNav;

  const rcLabel = rcFile.replace(homedir(), "~");
  const install = await inkConfirm({
    message: hasOldFunction2
      ? `Upgrade rt shell wrapper in ${rcLabel}?`
      : `Add rt cd support to ${rcLabel}?`,
    initialValue: true,
    stderr: true,
  });

  if (!install) {
    console.error(`\n  Add this to your shell config manually:\n`);
    console.error(SHELL_FUNCTION);
    process.stdout.write = origWrite;
    process.exit(0);
  }

  if (hasOldRtWrapper || hasPreRehashWrapper || hasNoNav) {
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
  console.error(`  ${green}✓ Installed rt shell wrapper in ${rcLabel}${reset}`);
  console.error(`  Restart your terminal or run: source ${rcLabel}`);

  process.stdout.write = origWrite;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function worktreePicker(args: string[]): Promise<void> {

  await ensureShellFunction();

  // Redirect stdout → stderr so TUI prompts don’t contaminate the path output
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  if (!process.stdout.columns && process.stderr.columns) {
    Object.defineProperty(process.stdout, "columns", { value: process.stderr.columns, configurable: true });
  }

  // After any picker exits (ESC or selection), cursor is just below the 2-line
  // header. Erase it so the terminal is clean.
  process.once("exit", () => process.stderr.write("\x1b[2A\x1b[0J"));

  // ── Parse flags ─────────────────────────────────────────────────────────────────────
  const forceRepo    = args.includes("--repo");
  const wtIdx        = args.indexOf("--worktree");
  const wtBranch     = wtIdx !== -1 ? args[wtIdx + 1] : undefined;

  const repos        = getKnownRepos();
  const identity     = getRepoIdentity();
  const currentRepo  = identity
    ? repos.find((r) => r.repoName === identity.repoName) ?? null
    : null;

  let selectedPath: string;

  // ── --repo flag: always go to repo picker ────────────────────────────────────
  if (forceRepo) {
    if (wtBranch) {
      // Pick repo first, then jump to the matching worktree (or show picker)
      const { filterableSelect } = await import("../lib/rt-render.tsx");
      const repoOptions = repos.map((r) => ({
        value: r.repoName,
        label: r.repoName,
        hint: r.worktrees.length > 1
          ? `${r.worktrees.length} worktrees`
          : r.worktrees[0]?.path.replace(homedir(), "~") ?? "",
      }));
      const pickedRepoName = repos.length === 1
        ? repos[0]!.repoName
        : await filterableSelect({ message: "Pick a repo", options: repoOptions, stderr: true });
      const pickedRepo = repos.find((r) => r.repoName === pickedRepoName)!;

      // Try to resolve the worktree in that repo; fall back to picker
      const lower = wtBranch.toLowerCase();
      const hit = pickedRepo.worktrees.filter((wt) => wt.branch.toLowerCase().startsWith(lower));
      if (hit.length === 1) {
        selectedPath = hit[0]!.path;
      } else {
        selectedPath = await resolveWorktreeByBranch(wtBranch, [pickedRepo], { stderr: true });
      }
    } else {
      selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: true });
    }

  // ── --worktree flag only: resolve branch in current repo (then all repos) ──
  } else if (wtBranch) {
    const searchRepos = currentRepo ? [currentRepo] : repos;
    const lower = wtBranch.toLowerCase();
    const inCurrent = currentRepo?.worktrees.filter((wt) => wt.branch.toLowerCase().startsWith(lower)) ?? [];
    // If not found in current repo, broaden to all repos
    const finalRepos = inCurrent.length > 0 ? searchRepos : repos;
    selectedPath = await resolveWorktreeByBranch(wtBranch, finalRepos, { stderr: true });

  // ── In a monorepo: package picker ────────────────────────────────────────
  } else if (currentRepo && getWorkspacePackages(identity!.repoRoot).length > 0) {
    selectedPath = await pickPackageWithEscape(currentRepo, identity!.repoRoot, repos, { stderr: true });

  // ── In a plain multi-worktree repo: worktree picker [unchanged] ──────────
  } else if (currentRepo && currentRepo.worktrees.length > 1) {
    const result = await pickWorktreeWithSwitch(currentRepo, identity!.repoRoot, { stderr: true });
    if (!result) process.exit(0);
    selectedPath = isSwitchRepo(result)
      ? await pickFromAllRepos(repos, { stderr: true, includePackages: true })
      : result;

  // ── Not in a tracked repo or single-worktree: repo picker [unchanged] ───
  } else {
    selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: true });
  }

  // Restore stdout and print just the path
  process.stdout.write = realStdoutWrite;
  realStdoutWrite(selectedPath + "\n");
}
