#!/usr/bin/env bun

/**
 * rt cd — Context-aware worktree/repo directory picker.
 *
 * Prints the selected path to stdout so a shell function can cd into it.
 *
 * rt cd is for changing worktree or repo; moving around inside a repo is what
 * rt nav is for. So the default never drills below the worktree root.
 *
 * Behavior:
 *   - In a tracked repo with worktrees → worktree picker + "switch repo" option
 *   - In a tracked repo without worktrees → repo picker (all known repos)
 *   - Not in a tracked repo → repo picker (all known repos with worktrees)
 *   - --package → opt back into the monorepo package picker (one level deeper)
 *
 * Shell setup (add to your shell rc file):
 *   rtcd() { local dir; dir="$(rt cd "$@")" && [ -n "$dir" ] && cd "$dir"; }
 */

import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { yellow, green, reset } from "../lib/tui.ts";
import { getRepoIdentity, getKnownRepos, getWorkspacePackages, repoOption, type KnownRepo } from "../lib/repo.ts";
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
  `  # Resolve rt by absolute path when the dev-mode wrapper exists. This bypasses`,
  `  # zsh's command-hash cache, which otherwise pins rt to whichever binary it`,
  `  # first found (often Homebrew's compiled rt) and ignores later dev-mode`,
  `  # swaps until the shell calls 'hash -r' — leading to surprising "I'm in dev`,
  `  # mode but my changes don't show up" behaviour across shells.`,
  `  local rt_bin="$HOME/.local/bin/rt"`,
  `  # whence -p (zsh) / type -P (bash): PATH-only lookup, skips this function`,
  `  [ -x "$rt_bin" ] || rt_bin="$(whence -p rt 2>/dev/null || type -P rt 2>/dev/null)"`,
  `  [ -x "$rt_bin" ] || { echo "rt: binary not found in PATH" >&2; return 1; }`,
  ``,
  `  if [ "$1" = "cd" ]; then`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS "$rt_bin" cd "\${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  elif [ "$1" = "nav" ]; then`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS "$rt_bin" nav "\${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  elif [ "$1" = "worktree" ] && [ -z "$2" ]; then`,
  `    # Bare 'rt worktree' is the nav picker (same contract as cd/nav) — jump`,
  `    # into the selected tree. 'rt worktree <subcommand>' passes straight`,
  `    # through below.`,
  `    local dir`,
  `    dir="$(COLUMNS=$COLUMNS "$rt_bin" worktree)" && [ -n "$dir" ] && builtin cd "$dir"`,
  `  elif [ "$1" = "x" ]; then`,
  `    "$rt_bin" "$@"`,
  `    local rt_cwd`,
  `    rt_cwd="$(cat "$HOME/.mattstack/rt/.last-cwd" 2>/dev/null)"`,
  `    if [ -n "$rt_cwd" ] && [ "$rt_cwd" != "$PWD" ]; then`,
  `      builtin cd "$rt_cwd"`,
  `    fi`,
  `  elif [ "$1" = "settings" ] && [ "$2" = "dev-mode" ]; then`,
  `    "$rt_bin" "$@"`,
  `    # dev-mode swaps ~/.local/bin/rt in or out — rehash so any other shell`,
  `    # (which doesn't go through this function) sees the swap on next 'rt'.`,
  `    hash -r 2>/dev/null`,
  `  else`,
  `    "$rt_bin" "$@"`,
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

  // Latest version marker: whence -p / type -P PATH-only lookup (fixes FUNCNEST recursion)
  // + bare 'rt worktree' cd-jump support.
  if (
    rcContent.includes('rt() {') &&
    rcContent.includes('whence -p rt') &&
    rcContent.includes('"$rt_bin" nav') &&
    rcContent.includes('"$1" = "worktree"')
  ) return;

  // Redirect stdout → stderr before showing prompts
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
  const hasLegacyRtcd = rcContent.includes("rtcd()");
  const hasOldRtWrapper = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes(".last-cwd");
  const hasPreRehashWrapper = rcContent.includes("rt() {") && rcContent.includes(".last-cwd") && !rcContent.includes("hash -r");
  const hasNoNav = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes("command rt nav") && !rcContent.includes('"$rt_bin" nav');
  // Function exists but uses `command rt` everywhere — vulnerable to the stale
  // zsh hash-table issue. Anything pre-absolute-path version qualifies.
  const hasHashCacheBug = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes("local rt_bin");
  // Uses command -v which returns the function name in zsh, causing infinite recursion
  const hasFuncnestBug = rcContent.includes("rt() {") && rcContent.includes("command -v rt") && !rcContent.includes("whence -p rt");
  // Function exists and is otherwise current, but predates bare 'rt worktree' cd-jump support.
  const hasNoWorktreeNav = rcContent.includes("rt() {") && rcContent.includes('"$rt_bin" nav') && !rcContent.includes('"$1" = "worktree"');
  const hasOldFunction = hasLegacyRtcd || hasOldRtWrapper || hasPreRehashWrapper || hasHashCacheBug || hasFuncnestBug || hasNoWorktreeNav;

  if (hasFuncnestBug) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: fix FUNCNEST recursion in zsh${reset}`);
  } else if (hasPreRehashWrapper) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: auto-rehash after dev-mode toggle${reset}`);
  } else if (hasNoNav) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt nav cd support${reset}`);
  } else if (hasNoWorktreeNav) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt worktree cd support${reset}`);
  } else if (hasHashCacheBug) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: resolve dev-mode binary by absolute path${reset}`);
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

  if (hasOldRtWrapper || hasPreRehashWrapper || hasNoNav || hasHashCacheBug || hasFuncnestBug || hasNoWorktreeNav) {
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
  // header. Erase it so the terminal is clean — but only on success: error
  // paths exit(1) after printing a message ("no worktree found matching …"),
  // and the erase would wipe exactly those two lines.
  process.once("exit", (code) => {
    if (code === 0) process.stderr.write("\x1b[2A\x1b[0J");
  });

  // ── Parse flags ─────────────────────────────────────────────────────────────────────
  const forceRepo    = args.includes("--repo");
  const wantPackages = args.includes("--package") || args.includes("--packages");
  const wtIdx        = args.indexOf("--worktree");
  const wtBranch     = wtIdx !== -1 ? args[wtIdx + 1] : undefined;

  // getRepoIdentity() registers the current repo in the index (via
  // updateRepoIndex) as a side effect, so it MUST run before getKnownRepos().
  // Otherwise a repo you just entered — especially a local-only repo seen for
  // the first time — is absent from `repos`, currentRepo resolves to null, and
  // rt cd wrongly falls through to the global all-repos picker instead of
  // recognizing where you are.
  const identity     = getRepoIdentity();
  const repos        = getKnownRepos();
  const currentRepo  = identity
    ? repos.find((r) => r.repoName === identity.repoName) ?? null
    : null;

  let selectedPath: string;

  // ── --repo flag: always go to repo picker ────────────────────────────────────
  if (forceRepo) {
    if (wtBranch) {
      // Pick repo first, then jump to the matching worktree (or show picker)
      const { filterableSelect } = await import("../lib/rt-render.tsx");
      const repoOptions = repos.map(repoOption);
      const pickedRepoName = repos.length === 1
        ? repos[0]!.repoName
        : await filterableSelect({ message: "Pick a repo", options: repoOptions, stderr: true });
      if (!pickedRepoName) process.exit(0); // Esc on repo picker
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
      selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages });
    }

  // ── --worktree flag only: resolve branch in current repo (then all repos) ──
  } else if (wtBranch) {
    const searchRepos = currentRepo ? [currentRepo] : repos;
    const lower = wtBranch.toLowerCase();
    const inCurrent = currentRepo?.worktrees.filter((wt) => wt.branch.toLowerCase().startsWith(lower)) ?? [];
    // If not found in current repo, broaden to all repos
    const finalRepos = inCurrent.length > 0 ? searchRepos : repos;
    selectedPath = await resolveWorktreeByBranch(wtBranch, finalRepos, { stderr: true });

  // ── --package in a monorepo: package picker (opt-in) ─────────────────────
  } else if (wantPackages && currentRepo && getWorkspacePackages(identity!.repoRoot).length > 0) {
    selectedPath = await pickPackageWithEscape(currentRepo, identity!.repoRoot, repos, { stderr: true });

  // ── In a multi-worktree repo: worktree picker ────────────────────────────
  } else if (currentRepo && currentRepo.worktrees.length > 1) {
    const result = await pickWorktreeWithSwitch(currentRepo, identity!.repoRoot, { stderr: true });
    if (!result) process.exit(0);
    selectedPath = isSwitchRepo(result)
      ? await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages })
      : result;

  // ── Not in a tracked repo or single-worktree: repo picker ───────────────
  } else {
    selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages });
  }

  // Restore stdout and print just the path
  process.stdout.write = realStdoutWrite;
  realStdoutWrite(selectedPath + "\n");
}
