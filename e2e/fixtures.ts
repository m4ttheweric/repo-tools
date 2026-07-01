import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const FIXED_GIT_ENV = {
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
  GIT_AUTHOR_NAME: "rt-test",
  GIT_AUTHOR_EMAIL: "test@rt.test",
  GIT_COMMITTER_NAME: "rt-test",
  GIT_COMMITTER_EMAIL: "test@rt.test",
};

function git(cmd: string, cwd: string, home: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...FIXED_GIT_ENV, HOME: home },
  });
}

export interface FixtureRepoOpts {
  name?: string;
  scripts?: Record<string, string>;
  branches?: string[];
}

export function createFixtureRepo(
  home: string,
  opts?: FixtureRepoOpts,
): { path: string; repoName: string } {
  const name = opts?.name ?? "test-repo";
  const scripts = opts?.scripts ?? { dev: "echo dev", test: "echo test" };
  const path = join(home, name);

  mkdirSync(path, { recursive: true });

  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name, version: "1.0.0", scripts }, null, 2),
  );

  git("init", path, home);
  git("add .", path, home);
  git('commit -m "initial"', path, home);

  for (const branch of opts?.branches ?? []) {
    git(`branch ${branch}`, path, home);
  }

  return { path, repoName: name };
}

export interface MonorepoFixtureOpts extends FixtureRepoOpts {
  packages: Array<{
    name: string;
    path: string;
    scripts: Record<string, string>;
  }>;
}

export function createMonorepoFixture(
  home: string,
  opts: MonorepoFixtureOpts,
): { path: string; repoName: string } {
  const name = opts.name ?? "test-monorepo";
  const path = join(home, name);

  mkdirSync(path, { recursive: true });

  writeFileSync(
    join(path, "package.json"),
    JSON.stringify(
      { name, version: "1.0.0", scripts: opts.scripts ?? {}, private: true },
      null,
      2,
    ),
  );

  const workspacePaths = opts.packages
    .map((p) => `  - '${p.path}'`)
    .join("\n");
  writeFileSync(
    join(path, "pnpm-workspace.yaml"),
    `packages:\n${workspacePaths}\n`,
  );

  for (const pkg of opts.packages) {
    const pkgDir = join(path, pkg.path);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify(
        { name: pkg.name, version: "1.0.0", scripts: pkg.scripts },
        null,
        2,
      ),
    );
  }

  git("init", path, home);
  git("add .", path, home);
  git('commit -m "initial"', path, home);

  for (const branch of opts.branches ?? []) {
    git(`branch ${branch}`, path, home);
  }

  return { path, repoName: name };
}

export function seedRepoIndex(
  home: string,
  repos: Array<{ name: string; path: string }>,
): void {
  const rtDir = join(home, ".rt");
  mkdirSync(rtDir, { recursive: true });

  const index: Record<string, string> = {};
  for (const repo of repos) {
    index[repo.name] = repo.path;
  }

  writeFileSync(join(rtDir, "repos.json"), JSON.stringify(index, null, 2));
}

export function addWorktree(
  repoPath: string,
  branch: string,
  home: string,
): string {
  const worktreePath = `${repoPath}-wt-${branch}`;
  git(`worktree add ${worktreePath} -b ${branch}`, repoPath, home);
  return worktreePath;
}

export function ensureShellWrapper(home: string): void {
  const content = [
    "rt() {",
    '  local rt_bin="$HOME/.local/bin/rt"',
    '  [ -x "$rt_bin" ] || rt_bin="$(whence -p rt 2>/dev/null || type -P rt 2>/dev/null)"',
    '  [ -x "$rt_bin" ] || { echo "rt: binary not found" >&2; return 1; }',
    '  if [ "$1" = "cd" ]; then',
    '    local dir; dir="$("$rt_bin" cd "${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"',
    '  elif [ "$1" = "nav" ]; then',
    '    local dir; dir="$("$rt_bin" nav "${@:2}")" && [ -n "$dir" ] && builtin cd "$dir"',
    "  else",
    '    "$rt_bin" "$@"',
    "  fi",
    "}",
  ].join("\n");
  writeFileSync(join(home, ".zshrc"), content);
}
