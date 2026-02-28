#!/usr/bin/env bun

/**
 * link-repo-tools.ts
 *
 * Sets up all local symlinks and git config for a repo (or git worktree).
 * Run once per repo folder / worktree.
 *
 * What it does:
 *   - Creates symlinks from the repo into matts-utils/repos/<repo-name>/
 *   - Adds each symlink to .git/info/exclude so git never sees them
 *   - Sets core.hooksPath = .local-hooks so the local git hooks are active
 *   - Also symlinks ~/.warp/workflows so Warp terminal picks up workflows
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { symlink } from "fs/promises";
import { execSync } from "child_process";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const REPOS_DIR = join(SCRIPT_DIR, "repos");
const GITHUB_DIR = resolve(SCRIPT_DIR, "../");

const esc = (code: number): string => `\x1b[${code}m`;
const reset = esc(0);
const bold = esc(1);
const dim = esc(2);
const cyan = esc(36);
const green = esc(32);
const yellow = esc(33);
const red = esc(31);

const POINTER = `${cyan}❯${reset}`;
const BLANK = " ";

// ============================================================================
// Symlink config — one entry per thing to link into the repo
// ============================================================================

interface LinkSpec {
  /** Path relative to the repo root where the symlink is created */
  repoPath: string;
  /** Path relative to matts-utils/repos/<repoName>/ where the target lives */
  sourcePath: string;
  /** Entry to add to .git/info/exclude (defaults to repoPath/) */
  excludeEntry?: string;
  /** If true, ensure the parent directory exists before creating the symlink */
  ensureParent?: boolean;
}

const LINK_SPECS: LinkSpec[] = [
  {
    repoPath: "matts-tools",
    sourcePath: "matts-tools",
    excludeEntry: "matts-tools",
  },
  {
    repoPath: ".local-hooks",
    sourcePath: ".local-hooks",
    excludeEntry: ".local-hooks",
  },
  {
    repoPath: ".cursor/rules/local.mdc",
    sourcePath: ".cursor/rules/local.mdc",
    excludeEntry: ".cursor/rules/local.mdc",
    ensureParent: true,
  },
  {
    repoPath: "Agents.MR_REVIEWS.md",
    sourcePath: "Agents.MR_REVIEWS.md",
    excludeEntry: "Agents.MR_REVIEWS.md",
  },
];

// ============================================================================
// Helpers
// ============================================================================

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function getGitCommonDir(repoPath: string): string {
  // In a worktree, .git is a file and the common dir lives in the main repo.
  // git rev-parse --git-common-dir always returns the shared .git directory.
  // For the main worktree it returns a relative path (e.g. ".git"), for linked
  // worktrees it returns an absolute path. Resolve relative paths against repoPath.
  const result = execSync(`git -C "${repoPath}" rev-parse --git-common-dir`, {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  return result.startsWith("/") ? result : join(repoPath, result);
}

function isInGitExclude(repoPath: string, entry: string): boolean {
  const excludePath = join(getGitCommonDir(repoPath), "info", "exclude");
  try {
    return readFileSync(excludePath, "utf8")
      .split("\n")
      .some((line) => line.trim() === entry);
  } catch {
    return false;
  }
}

function addToGitExclude(repoPath: string, entry: string): void {
  const infoDir = join(getGitCommonDir(repoPath), "info");
  const excludePath = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });

  let content = "";
  try {
    content = readFileSync(excludePath, "utf8");
  } catch {
    // file may not exist yet
  }

  if (!content.endsWith("\n") && content.length > 0) content += "\n";
  writeFileSync(excludePath, content + entry + "\n");
}

function gitConfig(repoPath: string, key: string, value: string): void {
  execSync(`git -C "${repoPath}" config --local "${key}" "${value}"`, {
    stdio: "pipe",
  });
}

function findGitRepos(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, ".git")))
      .map((d) => join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

function findRepoConfigs(): string[] {
  try {
    return readdirSync(REPOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ============================================================================
// Interactive selector
// ============================================================================

async function selectRepo(repos: string[]): Promise<string> {
  const repoConfigs = findRepoConfigs();
  // Pre-resolve config names (handles worktrees mapping to primary repo name)
  const resolvedNames = repos.map((r) => {
    try {
      return resolveRepoName(r);
    } catch {
      return r.split("/").pop()!;
    }
  });
  let cursor = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?25l");

  let lastLineCount = 0;

  function draw(): void {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      process.stdout.write("\x1b[0J");
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(
      `  ${bold}${cyan}link repo tools${reset}  ${dim}(↑↓ navigate, enter select, q quit)${reset}`,
    );
    lines.push(`  ${dim}source: ${REPOS_DIR}${reset}`);
    lines.push("");

    for (let i = 0; i < repos.length; i++) {
      const isActive = i === cursor;
      const folderName = repos[i].split("/").pop()!;
      const configName = resolvedNames[i];
      const hasConfig = repoConfigs.includes(configName);
      const symlinkPath = join(repos[i], "matts-tools");
      const alreadyLinked = isSymlink(symlinkPath);
      const isWorktree = configName !== folderName;

      const pointer = isActive ? POINTER : BLANK;
      const worktreeTag = isWorktree ? `  ${dim}↳ ${configName}${reset}` : "";
      const status = alreadyLinked
        ? `  ${dim}${green}linked${reset}`
        : hasConfig
          ? `  ${dim}${yellow}not linked${reset}`
          : `  ${dim}no config${reset}`;
      const label = isActive ? `${bold}${folderName}${reset}` : folderName;
      lines.push(`  ${pointer} ${label}${worktreeTag}${status}`);
    }

    lines.push("");
    lastLineCount = lines.length;
    process.stdout.write(lines.join("\n") + "\n");
  }

  function cleanup(): void {
    process.stdout.write("\x1b[?25h");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  draw();

  return new Promise<string>((resolve) => {
    process.stdin.on("data", (key: string) => {
      if (key === "\x03" || key === "q") {
        cleanup();
        console.log(`\n  ${dim}cancelled${reset}\n`);
        process.exit(0);
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(repos[cursor]);
        return;
      }
      if (key === "\x1b[A" || key === "k") {
        cursor = Math.max(0, cursor - 1);
        draw();
        return;
      }
      if (key === "\x1b[B" || key === "j") {
        cursor = Math.min(repos.length - 1, cursor + 1);
        draw();
        return;
      }
    });
  });
}

// ============================================================================
// Setup
// ============================================================================

function resolveRepoName(repoPath: string): string {
  // For git worktrees, the common git dir points back to the primary repo.
  // Use that to derive the config name, so worktrees like assured-dev-two
  // correctly resolve to the assured-dev config.
  try {
    const commonDir = getGitCommonDir(repoPath);
    // commonDir is an absolute path like /path/to/assured-dev/.git
    return resolve(commonDir, "..").split("/").pop()!;
  } catch {
    return repoPath.split("/").pop()!;
  }
}

async function setup(selectedRepo: string): Promise<void> {
  const repoName = resolveRepoName(selectedRepo);
  const folderName = selectedRepo.split("/").pop()!;
  const sourceDir = join(REPOS_DIR, repoName);
  console.log("");

  if (repoName !== folderName) {
    console.log(
      `  ${dim}worktree of ${bold}${repoName}${reset}${dim} — using that config${reset}`,
    );
  }

  if (!existsSync(sourceDir)) {
    console.log(
      `  ${red}no config found for ${bold}${repoName}${reset}${red} in ${REPOS_DIR}${reset}`,
    );
    console.log(`  ${dim}create a folder at: ${sourceDir}${reset}`);
    console.log("");
    process.exit(1);
  }

  let anyChange = false;

  for (const spec of LINK_SPECS) {
    const symlinkPath = join(selectedRepo, spec.repoPath);
    const targetPath = join(sourceDir, spec.sourcePath);
    const excludeEntry = spec.excludeEntry ?? spec.repoPath + "/";

    if (!existsSync(targetPath)) {
      console.log(
        `  ${dim}skip ${spec.repoPath} — source not found in config${reset}`,
      );
      continue;
    }

    if (spec.ensureParent) {
      mkdirSync(dirname(symlinkPath), { recursive: true });
    }

    if (isSymlink(symlinkPath)) {
      console.log(`  ${dim}✓ ${spec.repoPath} already linked${reset}`);
    } else if (existsSync(symlinkPath)) {
      console.log(
        `  ${red}✗ ${spec.repoPath} exists but is not a symlink — remove it manually${reset}`,
      );
      continue;
    } else {
      await symlink(targetPath, symlinkPath);
      console.log(
        `  ${green}✓${reset} linked ${bold}${spec.repoPath}${reset} → ${dim}${targetPath}${reset}`,
      );
      anyChange = true;
    }

    if (!isInGitExclude(selectedRepo, excludeEntry)) {
      addToGitExclude(selectedRepo, excludeEntry);
      console.log(
        `  ${green}✓${reset} added ${bold}${excludeEntry}${reset} to .git/info/exclude`,
      );
      anyChange = true;
    }
  }

  // Wire up git hooks
  const hooksPath = ".local-hooks";
  const localHooksExists = existsSync(join(selectedRepo, hooksPath));
  if (localHooksExists) {
    try {
      const current = execSync(
        `git -C "${selectedRepo}" config --local core.hooksPath`,
        { encoding: "utf8", stdio: "pipe" },
      ).trim();
      if (current === hooksPath) {
        console.log(
          `  ${dim}✓ core.hooksPath already set to ${hooksPath}${reset}`,
        );
      } else {
        gitConfig(selectedRepo, "core.hooksPath", hooksPath);
        console.log(
          `  ${green}✓${reset} set ${bold}core.hooksPath${reset} = ${hooksPath}`,
        );
        anyChange = true;
      }
    } catch {
      gitConfig(selectedRepo, "core.hooksPath", hooksPath);
      console.log(
        `  ${green}✓${reset} set ${bold}core.hooksPath${reset} = ${hooksPath}`,
      );
      anyChange = true;
    }
  }

  console.log("");
  if (!anyChange) {
    console.log(`  ${dim}everything already up to date${reset}\n`);
  } else {
    console.log(`  ${green}${bold}done.${reset}\n`);
  }
}

// ============================================================================
// Entry
// ============================================================================

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(`${red}must be run in an interactive terminal${reset}`);
    process.exit(1);
  }

  const repos = findGitRepos(GITHUB_DIR);

  if (repos.length === 0) {
    console.log(`${yellow}no git repos found in ${GITHUB_DIR}${reset}`);
    process.exit(1);
  }

  const selectedRepo = await selectRepo(repos);
  await setup(selectedRepo);
}

await main();
