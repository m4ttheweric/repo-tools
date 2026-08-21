import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
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

type MarketplaceEntry = { name?: string; source?: string | { source?: string; path?: string } };

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
        const rel = typeof entry.source === "string" ? entry.source : entry.source?.path;
        if (!rel) continue;
        const pluginDir = isAbsolute(rel) ? rel : resolve(marketDir, rel);
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

export function packDirOf(pack: PackInfo): string {
  return pack.dir;
}

export function surfaceConfigDir(pack: PackInfo): string {
  return dirname(pack.surfacePath);
}
