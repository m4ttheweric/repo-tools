import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { stripJsonc } from "./sources.ts";

export type PackLayout = "flat" | "grouped";

export type PackInfo = {
  name: string;
  dir: string;
  layout: PackLayout;
  surfacePath: string;
};

export type DiscoverOpts = {
  settingsPath?: string;
  extraPackDirs?: { name: string; dir: string }[];
};

function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "settings.json");
}

function readJsonc(path: string): unknown {
  return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

export function surfaceFileFor(dir: string): string | null {
  const candidates = [join(dir, "pack", "surface.jsonc"), join(dir, "surface.jsonc")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function hasNestedSkill(root: string): boolean {
  if (!existsSync(root)) return false;
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(root, group.name);
    if (existsSync(join(groupDir, "SKILL.md"))) continue;
    for (const leaf of readdirSync(groupDir, { withFileTypes: true })) {
      if (leaf.isDirectory() && existsSync(join(groupDir, leaf.name, "SKILL.md"))) return true;
    }
  }
  return false;
}

export function detectLayout(dir: string): PackLayout {
  return hasNestedSkill(join(dir, "skills")) || hasNestedSkill(join(dir, "attachments"))
    ? "grouped"
    : "flat";
}

function packFromDir(name: string, dir: string): PackInfo | null {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  const surfacePath = surfaceFileFor(real);
  if (!surfacePath) return null;
  return { name, dir: real, layout: detectLayout(real), surfacePath };
}

type MarketplaceEntry = { name?: string; source?: string | { source?: string; path?: string; url?: string } };

/**
 * A url source with a file:// url is the local dev marketplace's shape: Claude
 * Code refuses symlinked plugin paths, so a checkout is served as a clone of
 * itself, and the checkout (not the cache clone) is the pack to read.
 */
function pluginDirOf(marketDir: string, source: MarketplaceEntry["source"]): string | null {
  const path = typeof source === "string" ? source : source?.path;
  if (path) return isAbsolute(path) ? path : resolve(marketDir, path);
  if (typeof source !== "object" || source?.source !== "url" || typeof source.url !== "string" || !source.url.startsWith("file://")) return null;
  try {
    return fileURLToPath(source.url);
  } catch {
    return null;
  }
}

/**
 * A pack is any plugin served from a directory marketplace that carries a
 * surface.jsonc -- discovery reads what is actually installed instead of a
 * hardcoded pack list, so a new team pack appears the moment its marketplace
 * is registered.
 */
export function discoverPacks(opts: DiscoverOpts = {}): PackInfo[] {
  const found = new Map<string, PackInfo>();
  const settingsPath = opts.settingsPath ?? claudeSettingsPath();

  if (existsSync(settingsPath)) {
    let settings: { extraKnownMarketplaces?: Record<string, { source?: { source?: string; path?: string } }> } = {};
    try {
      settings = readJsonc(settingsPath) as typeof settings;
    } catch {
      settings = {};
    }
    for (const marketplace of Object.values(settings.extraKnownMarketplaces ?? {})) {
      const src = marketplace.source;
      if (!src || src.source !== "directory" || !src.path) continue;
      const marketDir = src.path.startsWith("~") ? join(homedir(), src.path.slice(1)) : src.path;
      const manifest = join(marketDir, ".claude-plugin", "marketplace.json");
      if (!existsSync(manifest)) continue;
      let entries: MarketplaceEntry[] = [];
      try {
        entries = ((readJsonc(manifest) as { plugins?: MarketplaceEntry[] }).plugins) ?? [];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.name) continue;
        const pluginDir = pluginDirOf(marketDir, entry.source);
        if (!pluginDir) continue;
        const pack = packFromDir(entry.name, pluginDir);
        if (pack && !found.has(pack.name)) found.set(pack.name, pack);
      }
    }
  }

  for (const extra of opts.extraPackDirs ?? []) {
    const pack = packFromDir(extra.name, extra.dir);
    if (pack && !found.has(pack.name)) found.set(pack.name, pack);
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The pack whose tree contains startDir, or null. Walks upward on the same
 * surface.jsonc marker discovery uses, so a compile run from inside a
 * worktree acts on that worktree's sources rather than whatever checkout the
 * marketplace registry points at. The name is the directory basename;
 * callers with a better identity source (the pack's own plugin.json) may
 * override it.
 */
export function findEnclosingPack(startDir: string): PackInfo | null {
  let dir: string;
  try {
    dir = realpathSync(startDir);
  } catch {
    return null;
  }
  while (true) {
    const surfacePath = surfaceFileFor(dir);
    // In the grouped layout the surface lives at <root>/pack/surface.jsonc,
    // so standing inside pack/ matches its own bare candidate; the pack root
    // is the parent, which the next iteration finds via its pack/ candidate.
    const insidePackSubdir = basename(dir) === "pack" && surfacePath === join(dir, "surface.jsonc");
    if (surfacePath && !insidePackSubdir) return packFromDir(basename(dir), dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function packDirOf(pack: PackInfo): string {
  return pack.dir;
}

export function surfaceConfigDir(pack: PackInfo): string {
  return dirname(pack.surfacePath);
}
