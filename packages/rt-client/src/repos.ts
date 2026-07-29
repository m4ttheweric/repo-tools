/**
 * Repo-name resolution against rt's global index (~/.rt/repos.json), a flat
 * `{ "<repoName>": "<absolute path>" }` map. Lets a client resolve "what
 * directory am I in" to "what does the daemon call this repo" without
 * maintaining its own copy of the mapping.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function defaultReposJsonPath(): string {
  return join(homedir(), ".rt", "repos.json");
}

/**
 * Exact-match lookup: returns the repo name whose recorded path equals
 * `repoPath`, or null if the file is missing, corrupt, or has no match.
 * Never throws -- a resolution failure just means the caller falls back to
 * whatever it had before (an unqualified path, a prompt, etc).
 */
export function repoNameForPath(repoPath: string, reposJsonPath?: string): string | null {
  const path = reposJsonPath ?? defaultReposJsonPath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const index = JSON.parse(raw) as Record<string, unknown>;
    for (const [repoName, value] of Object.entries(index)) {
      if (value === repoPath) return repoName;
    }
    return null;
  } catch {
    return null;
  }
}
