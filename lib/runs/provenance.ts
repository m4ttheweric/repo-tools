import { basename } from "path";

export type PackProvenance = { dirty: 0 | 1; commits: string[] };

function gitOut(dir: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", env: process.env });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

// A directory that is not a git checkout records nothing: unknown provenance
// must read as absent, never as a guess. `status --porcelain` covers
// unstaged, staged, and untracked in one call; `diff --quiet` alone would
// miss the last two.
export function packProvenance(dirs: string[]): PackProvenance {
  let dirty: 0 | 1 = 0;
  const commits: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const sha = gitOut(dir, ["rev-parse", "--short", "HEAD"]);
    if (sha === null) continue;
    commits.push(`${basename(dir)}=${sha}`);
    const status = gitOut(dir, ["status", "--porcelain"]);
    if (status !== null && status !== "") dirty = 1;
  }
  return { dirty, commits };
}

export function composePackCommits(p: PackProvenance, mattstackSha?: string, packSha?: string): string | null {
  const parts = [...p.commits];
  if (mattstackSha) parts.push(`mattstack=${mattstackSha}`);
  if (packSha) parts.push(packSha);
  return parts.length > 0 ? parts.join(",") : null;
}
