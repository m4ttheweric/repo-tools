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

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { yellow, green, reset } from "../lib/tui.ts";
import { getRepoIdentity, getKnownRepos, getKnownReposCached, findKnownRepo, repoCarriesWorktree, getWorkspacePackages, repoFromOptionValue, missingRepoRefusal, ghostPathRefusal, type KnownRepo } from "../lib/repo.ts";
import { writeRepoCache } from "../lib/repo-cache.ts";
import { isTrashPath } from "../lib/worktree/trash.ts";
import {
  pickWorktreeWithSwitch,
  pickFromAllRepos,
  pickPackageWithEscape,
  resolveWorktreeByBranch,
  pickRepo,
  isSwitchRepo,
} from "../lib/pickers.ts";
import { detectShell, shellRcPath } from "../lib/shell-integration.ts";

// ─── Shell function setup ────────────────────────────────────────────────────

const SHELL_FUNCTION = [
  `rt() {`,
  `  # Resolve rt by absolute path when the dev-mode wrapper exists. This bypasses`,
  `  # zsh's command-hash cache, which otherwise pins rt to whichever binary it`,
  `  # first found and ignores later dev-mode`,
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

  // Latest version marker: whence -p / type -P PATH-only lookup (fixes FUNCNEST
  // recursion), and NO bare `rt worktree` cd-jump — that hijacked the subcommand
  // picker, so a wrapper still carrying it is stale and gets rewritten below.
  if (
    rcContent.includes('rt() {') &&
    rcContent.includes('whence -p rt') &&
    rcContent.includes('"$rt_bin" nav') &&
    !rcContent.includes('"$1" = "worktree"')
  ) return;

  // Redirect stdout → stderr before showing prompts
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  const { confirm } = await import("../lib/rt-render.ts");
  const hasLegacyRtcd = rcContent.includes("rtcd()");
  const hasOldRtWrapper = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes(".last-cwd");
  const hasPreRehashWrapper = rcContent.includes("rt() {") && rcContent.includes(".last-cwd") && !rcContent.includes("hash -r");
  const hasNoNav = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes("command rt nav") && !rcContent.includes('"$rt_bin" nav');
  // Function exists but uses `command rt` everywhere — vulnerable to the stale
  // zsh hash-table issue. Anything pre-absolute-path version qualifies.
  const hasHashCacheBug = rcContent.includes("rt() {") && rcContent.includes("command rt cd") && !rcContent.includes("local rt_bin");
  // Uses command -v which returns the function name in zsh, causing infinite recursion
  const hasFuncnestBug = rcContent.includes("rt() {") && rcContent.includes("command -v rt") && !rcContent.includes("whence -p rt");
  // Function still carries the bare `rt worktree` cd-jump — strip it so
  // `rt worktree` reaches its subcommand picker like every other group.
  const hasWorktreeNav = rcContent.includes("rt() {") && rcContent.includes('"$1" = "worktree"');
  const hasOldFunction = hasLegacyRtcd || hasOldRtWrapper || hasPreRehashWrapper || hasHashCacheBug || hasFuncnestBug || hasWorktreeNav;

  if (hasFuncnestBug) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: fix FUNCNEST recursion in zsh${reset}`);
  } else if (hasPreRehashWrapper) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: auto-rehash after dev-mode toggle${reset}`);
  } else if (hasNoNav) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: adding rt nav cd support${reset}`);
  } else if (hasWorktreeNav) {
    console.error(`\n  ${yellow}Upgrading rt shell wrapper: removing rt worktree cd-jump${reset}`);
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
  const install = await confirm({
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

  if (hasOldRtWrapper || hasPreRehashWrapper || hasNoNav || hasHashCacheBug || hasFuncnestBug || hasWorktreeNav) {
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

// ─── Cache read path ─────────────────────────────────────────────────────────

/**
 * The cd cache can predate the repo you are standing in right now (never yet
 * written back since this repo was created or first registered), so a
 * resolved identity the cached list doesn't carry forces one live
 * `getKnownRepos` scan for this invocation - correctness over speed, and only
 * ever the one extra scan, since a repo that's genuinely absent from the live
 * list won't retrigger it on the next call either.
 */
export function resolveReposForIdentity(
  identity: { identity: string; repoRoot: string } | null,
  cachedRepos: KnownRepo[],
): KnownRepo[] {
  if (!identity) return cachedRepos;
  // The matched row must also CARRY the worktree being stood in: a cache
  // written before this worktree existed matches on identity alone, and serving
  // it hides the new tree from `--worktree <branch>` and from the picker.
  const hit = findKnownRepo(cachedRepos, identity);
  if (hit && repoCarriesWorktree(hit, identity.repoRoot)) return cachedRepos;
  return getKnownRepos({ includeMissing: true });
}

/**
 * The cd-cache rebuilds on a timer, so its rows can carry a worktree disposed
 * (trashed) since the last refresh; served verbatim, that row becomes a picker
 * entry whose selection dead-ends in ghostPathRefusal. Linked rows are
 * re-checked against disk before any picker sees them. The lead row stays even
 * when missing: that is the repo-level lost-path case, which must remain
 * pickable so it gets missingRepoRefusal instead of vanishing.
 */
export function dropGhostWorktrees(
  repos: KnownRepo[],
  exists: (path: string) => boolean = existsSync,
): KnownRepo[] {
  let changed = false;
  const out = repos.map((r) => {
    const kept = r.worktrees.filter((w, i) => i === 0 || (exists(w.path) && !isTrashPath(w.path)));
    if (kept.length === r.worktrees.length) return r;
    changed = true;
    return { ...r, worktrees: kept };
  });
  return changed ? out : repos;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

/**
 * ctrl-r's in-process reload: a live re-scan plus a cache refresh, handed to
 * the repo picker so it can push fresh rows via `handle.update` without
 * closing (this replaced the old fzf `ctrl-r:reload(rt cd --emit-rows)`
 * shell-exec bind).
 */
function reloadRepos(): KnownRepo[] {
  const repos = getKnownRepos({ includeMissing: true });
  writeRepoCache(repos);
  return repos;
}

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
  // updateRepoIndex) as a side effect, so it MUST run before the repo list is
  // read. Otherwise a repo you just entered (especially a local-only repo
  // seen for the first time) is absent from `repos`, currentRepo resolves to
  // null, and rt cd wrongly falls through to the global all-repos picker
  // instead of recognizing where you are.
  //
  // includeMissing: true so a lost repo still renders (dimmed, via repoOption)
  // in every picker built from `repos` — pickFromAllRepos's missing guard is
  // otherwise dead code, since a bare getKnownRepos() never hands it one.
  //
  // `repos` reads the cd cache (fast path). resolveReposForIdentity re-reads
  // live when the cache predates the repo the identity just resolved, so the
  // repo you are standing in is never invisible to its own cd invocation.
  const identity     = getRepoIdentity();
  const cachedRepos  = getKnownReposCached({ includeMissing: true });
  const repos        = dropGhostWorktrees(resolveReposForIdentity(identity, cachedRepos));
  const currentRepo  = identity
    ? findKnownRepo(repos, identity) ?? null
    : null;

  let selectedPath: string;

  // The dispatcher header is suppressed for `rt cd` (command-tree-def.ts
  // `fullscreen: true`) -- every picker below carries this instead, per
  // Cd.dc.html/Enrichment.dc.html.
  const CD_BREADCRUMB = ["rt", "cd"];

  // ── --repo flag: always go to repo picker ────────────────────────────────────
  if (forceRepo) {
    if (wtBranch) {
      // Pick repo first, then jump to the matching worktree (or show picker).
      // A missing row must be pickable here so it gets the clean
      // missingRepoRefusal below instead of resolving via branch name against
      // a dead path.
      const pickedRepoName = repos.length === 1
        ? repos[0]!.repoName
        : await pickRepo(repos, { onReload: reloadRepos, breadcrumb: CD_BREADCRUMB });
      if (!pickedRepoName) process.exit(0); // Esc on repo picker
      const pickedRepo = repoFromOptionValue(repos, pickedRepoName)!;
      if (pickedRepo.missing) {
        console.error(`\n  ${missingRepoRefusal(pickedRepo)}\n`);
        process.exit(1);
      }

      // Try to resolve the worktree in that repo; fall back to picker
      const lower = wtBranch.toLowerCase();
      const hit = pickedRepo.worktrees.filter((wt) => wt.branch.toLowerCase().startsWith(lower));
      if (hit.length === 1) {
        selectedPath = hit[0]!.path;
      } else {
        selectedPath = await resolveWorktreeByBranch(wtBranch, [pickedRepo], { stderr: true, breadcrumb: CD_BREADCRUMB });
      }
    } else {
      selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages, onReload: reloadRepos, breadcrumb: CD_BREADCRUMB });
    }

  // ── --worktree flag only: resolve branch in current repo (then all repos) ──
  } else if (wtBranch) {
    const searchRepos = currentRepo ? [currentRepo] : repos;
    const lower = wtBranch.toLowerCase();
    const inCurrent = currentRepo?.worktrees.filter((wt) => wt.branch.toLowerCase().startsWith(lower)) ?? [];
    // If not found in current repo, broaden to all repos
    const finalRepos = inCurrent.length > 0 ? searchRepos : repos;
    selectedPath = await resolveWorktreeByBranch(wtBranch, finalRepos, { stderr: true, breadcrumb: CD_BREADCRUMB });

  // ── --package in a monorepo: package picker (opt-in) ─────────────────────
  } else if (wantPackages && currentRepo && getWorkspacePackages(identity!.repoRoot).length > 0) {
    selectedPath = await pickPackageWithEscape(currentRepo, identity!.repoRoot, repos, { stderr: true, breadcrumb: CD_BREADCRUMB });

  // ── In a multi-worktree repo: worktree picker ────────────────────────────
  } else if (currentRepo && currentRepo.worktrees.length > 1) {
    // pickWorktreeWithSwitch exits internally on cancel (its abort line rides
    // the shared lib/pickers.ts cancel path), so result is never falsy here.
    const result = await pickWorktreeWithSwitch(currentRepo, identity!.repoRoot, { stderr: true, breadcrumb: CD_BREADCRUMB });
    selectedPath = isSwitchRepo(result)
      ? await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages, onReload: reloadRepos, breadcrumb: CD_BREADCRUMB })
      : result;

  // ── Not in a tracked repo or single-worktree: repo picker ───────────────
  } else {
    selectedPath = await pickFromAllRepos(repos, { stderr: true, includePackages: wantPackages, onReload: reloadRepos, breadcrumb: CD_BREADCRUMB });
  }

  // Restore stdout and print just the path
  process.stdout.write = realStdoutWrite;

  // Ghost guard: the cache (or a picker built from it) can hand back a path
  // that no longer exists on disk. Refuse rather than print a dead path...
  // the shell wrapper `cd`s into whatever stdout prints, no questions asked.
  if (!existsSync(selectedPath)) {
    console.error(`\n  ${ghostPathRefusal(selectedPath)}\n`);
    process.exit(1);
  }

  realStdoutWrite(selectedPath + "\n");
}
