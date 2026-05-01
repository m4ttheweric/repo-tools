/**
 * Per-repo Doppler template — the source of truth for which app subdir of a
 * worktree maps to which Doppler project + config.
 *
 * Path: ~/.rt/<repo>/doppler-template.yaml. Format is a flat list of objects:
 *   - { path: apps/backend,  project: backend,  config: dev }
 *   - { path: apps/frontend, project: frontend, config: dev }
 *
 * The reconciler reads this and writes corresponding entries to
 * ~/.doppler/.doppler.yaml so Doppler CLI works in any worktree without
 * `make initDoppler`. See docs/superpowers/specs/2026-04-30-doppler-template-sync-design.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse, stringify } from "yaml";

export interface DopplerTemplateEntry {
  /** Path relative to the worktree root (e.g. "apps/backend"). */
  path: string;
  /** Doppler project name. */
  project: string;
  /** Doppler config name (almost always "dev"). */
  config: string;
}

/** Resolve ~/.rt at call time so tests can override HOME before importing. */
function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function templatePath(repoName: string): string {
  return join(rtDir(), repoName, "doppler-template.yaml");
}

/** Load the template. Returns `null` if missing or malformed. */
export function loadTemplate(repoName: string): DopplerTemplateEntry[] | null {
  const path = templatePath(repoName);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries: DopplerTemplateEntry[] = [];
    for (const item of parsed) {
      if (
        item && typeof item === "object" &&
        typeof item.path    === "string" &&
        typeof item.project === "string" &&
        typeof item.config  === "string"
      ) {
        entries.push({ path: item.path, project: item.project, config: item.config });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Persist entries to disk. Creates the parent directory if needed. */
export function saveTemplate(
  repoName: string,
  entries: DopplerTemplateEntry[],
): void {
  const path = templatePath(repoName);
  mkdirSync(join(rtDir(), repoName), { recursive: true });
  const yaml = stringify(entries);
  writeFileSync(path, yaml);
}
