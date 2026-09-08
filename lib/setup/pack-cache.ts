/**
 * The team-pack half of Claude Code plugin management: what the team clone
 * serves, what is installed, and the per-pack sequence that converges one to
 * the other. Lives apart from `steps/plugins.ts` so the daemon and the status
 * validator can both use it without importing a setup step.
 */

import { join } from "path";
import { stripJsonc } from "../jsonc.ts";
import type { Probes } from "./probes.ts";

export interface ServedPack {
  id: string;
  name: string;
  servedVersion: string | null;
}

/** `error` is non-null only for a marketplace.json that exists and did not parse. */
export interface ServedPacks {
  packs: ServedPack[];
  error: string | null;
}

export interface InstalledPack {
  id: string;
  version: string | null;
  enabled: boolean;
}

interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parse boundary: any element missing a string `id` rejects the whole
 * payload, rather than dropping just that element. A schema violation anywhere
 * means the shape cannot be trusted, so the honest answer is "could not be
 * read", not a silently incomplete list. A missing `enabled` or `version` is
 * not such a violation: both are normalized.
 */
export function parsePluginList(stdout: string): InstalledPack[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: InstalledPack[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item) || typeof item.id !== "string") return null;
    entries.push({
      id: item.id,
      version: typeof item.version === "string" ? item.version : null,
      enabled: item.enabled === true,
    });
  }
  return entries;
}

function teamCloneDir(home: string, slug: string): string {
  return join(home, ".mattstack", "teams", slug);
}

function readVersion(p: Pick<Probes, "readFile">, pluginDir: string): string | null {
  const raw = p.readFile(join(pluginDir, ".claude-plugin", "plugin.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(stripJsonc(raw)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * A null `servedVersion` means rt cannot read a version for that pack (an
 * object-form source, or an unreadable plugin.json). Callers must treat that
 * as "outside the converge", never as a version mismatch.
 */
export function readServedPacks(p: Pick<Probes, "readFile" | "home">, slug: string): ServedPacks {
  const clone = teamCloneDir(p.home, slug);
  const path = join(clone, ".claude-plugin", "marketplace.json");
  const raw = p.readFile(path);
  if (raw === null) return { packs: [], error: null };

  let parsed: { name?: unknown; plugins?: unknown };
  try {
    parsed = JSON.parse(stripJsonc(raw)) as { name?: unknown; plugins?: unknown };
  } catch {
    return { packs: [], error: `${path} did not parse` };
  }

  const marketplace = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : slug;
  const entries = Array.isArray(parsed.plugins) ? (parsed.plugins as MarketplaceEntry[]) : [];
  const packs: ServedPack[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
    const servedVersion = typeof entry.source === "string" ? readVersion(p, join(clone, entry.source)) : null;
    packs.push({ id: `${entry.name}@${marketplace}`, name: entry.name, servedVersion });
  }
  return { packs, error: null };
}
