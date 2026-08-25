import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const MARKER_VERSION_RE = /(<!-- part: [^>]*?\bversion=)[^\s>]+/g;
const COMPILED_RE = /^(\s*compiled: )"[^"\n]*"$/m;
const BAKED_FLAG_RE = /(--(?:mattstack|pack)-sha )\S+/g;

/** check compares artifacts with the versions and shas the compiler stamps masked out: a bump that changed no inlined body is not drift. */
export function maskProvenance(text: string): string {
  return text
    .replace(MARKER_VERSION_RE, "$1*")
    .replace(COMPILED_RE, "$1*")
    .replace(BAKED_FLAG_RE, "$1*");
}

/** The pack's own plugin identity, when it is one (a pack without a manifest is not a plugin root). */
export function packPluginIdentity(packDir: string): { name: string; version: string } | null {
  const manifestPath = join(packDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name) return null;
    return { name: parsed.name, version: typeof parsed.version === "string" ? parsed.version : "" };
  } catch {
    return null;
  }
}

export type GitFacts = { sha: string; dirty: 0 | 1 };

/** Feeds run-start.flags' --mattstack-sha/--mattstack-dirty; a non-git or unreadable mattstack dir degrades to empty/clean rather than failing resolution. */
export function gitFacts(dir: string): GitFacts {
  try {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { stdio: "pipe" }).toString().trim();
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { stdio: "pipe" }).toString();
    return { sha, dirty: status.trim() ? 1 : 0 };
  } catch {
    return { sha: "", dirty: 0 };
  }
}

/**
 * Only {{run-start.flags}} carries these facts, and only a pipeline body places
 * it, so a pack with no declared pipelines pays nothing for the two git
 * subprocesses. An installed plugin cache is a plain copy with no .git; its
 * version is the only provenance it carries, and it is what the run DB records
 * in that case.
 */
export function mattstackProvenance(
  pipelines: Record<string, string[]>,
  plugin: { dir: string; version: string } | undefined,
  facts: (dir: string) => GitFacts = gitFacts,
): GitFacts {
  if (!plugin) return { sha: "", dirty: 0 };
  if (Object.keys(pipelines).length === 0) return { sha: plugin.version, dirty: 0 };
  const { sha, dirty } = facts(plugin.dir);
  return { sha: sha || plugin.version, dirty };
}

/** The pack's own provenance token: its short sha when --pack-dir is a checkout, else the version its plugin.json declares. */
export function packProvenance(packDir: string): string {
  const { sha } = gitFacts(packDir);
  if (sha) return sha;
  return packPluginIdentity(packDir)?.version ?? "";
}
