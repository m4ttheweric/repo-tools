import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { AttachmentSource, SlotSpec, StepSource, VerbDef } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function stripJsonc(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

export function stripFrontmatter(md: string): { body: string; frontmatter: Record<string, unknown> } {
  const match = md.match(FRONTMATTER_RE);
  if (!match) {
    return { body: md.trim(), frontmatter: {} };
  }
  const parsed = parseYaml(match[1] ?? "");
  const frontmatter = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const body = md.slice(match[0].length).trim();
  return { body, frontmatter };
}

export type PluginRoots = { byName: Record<string, { dir: string; version: string }> };

export type PluginListEntry = { id: string; installPath: string };

/**
 * Entry-processing half of resolvePluginRoots, split out so it's testable
 * without shelling out to `claude`. `claude plugin list --json` can list an
 * entry whose installPath was since removed or moved (an uninstalled or
 * relocated plugin the cache index hasn't caught up with yet) -- that must
 * not take down resolution for every other plugin, so a missing installPath
 * is skipped with a warning instead of throwing.
 */
export function buildPluginRoots(list: PluginListEntry[]): PluginRoots {
  const byName: PluginRoots["byName"] = {};

  for (const entry of list) {
    const name = entry.id.split("@")[0];
    if (!name) continue;
    if (!existsSync(entry.installPath)) {
      console.error(`rt: skipping plugin "${name}" -- installPath does not exist: ${entry.installPath}`);
      continue;
    }
    const dir = realpathSync(entry.installPath);
    let version = "unknown";
    try {
      const pluginJson = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      if (typeof pluginJson.version === "string") version = pluginJson.version;
    } catch {
      // best-effort: a plugin without a readable manifest still resolves a root
    }
    byName[name] = { dir, version };
  }

  return { byName };
}

/**
 * Thin by design: the subprocess call itself is not unit-tested (see plan
 * constraint); buildPluginRoots carries the tested logic. Task 5 exercises
 * this live against real installed plugins.
 */
export function resolvePluginRoots(): PluginRoots {
  const raw = execSync("claude plugin list --json", { encoding: "utf8" });
  const list = JSON.parse(raw) as PluginListEntry[];
  return buildPluginRoots(list);
}

function parseSlots(raw: unknown): Record<string, SlotSpec> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, SlotSpec> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const spec = value as Record<string, unknown>;
    if (typeof spec.contract !== "string") continue;
    out[key] = {
      contract: spec.contract,
      ...(typeof spec.required === "boolean" ? { required: spec.required } : {}),
    };
  }
  return out;
}

function parseAllowedTools(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function listFilesUnder(dir: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    const abs = sub ? join(dir, sub) : dir;
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile() && !exclude.has(rel)) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function loadStepSource(engineName: string, roots: PluginRoots): StepSource {
  const mattstack = roots.byName.mattstack;
  if (!mattstack) {
    throw new Error(`loadStepSource: no "mattstack" plugin root registered`);
  }

  const skillsDir = join(mattstack.dir, "skills");
  const searched: string[] = [];
  let foundDir: string | null = null;

  for (const group of listDirs(skillsDir)) {
    const candidate = join(skillsDir, group, engineName, "SKILL.md");
    searched.push(candidate);
    if (existsSync(candidate)) {
      foundDir = join(skillsDir, group, engineName);
      break;
    }
  }

  if (!foundDir) {
    throw new Error(
      `loadStepSource: engine "${engineName}" not found under ${skillsDir}/*; searched:\n${searched.join("\n")}`,
    );
  }

  const skillMdPath = join(foundDir, "SKILL.md");
  const { body, frontmatter } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));

  if (frontmatter.type !== "pipeline-step") {
    throw new Error(`loadStepSource: "${skillMdPath}" is not typed "type: pipeline-step"`);
  }

  return {
    name: engineName,
    plugin: "mattstack",
    version: mattstack.version,
    dir: foundDir,
    body,
    slots: parseSlots(frontmatter.slots),
    allowedTools: parseAllowedTools(frontmatter["allowed-tools"]),
    scriptFiles: listFilesUnder(join(foundDir, "scripts"), new Set()).map((entry) => `scripts/${entry}`),
  };
}

export function loadAttachment(binding: string, slot: string, roots: PluginRoots): AttachmentSource {
  const [plugin, skillName] = binding.split(":");
  if (!plugin || !skillName) {
    throw new Error(`loadAttachment: slot "${slot}": binding "${binding}" is not "<plugin>:<skill>"`);
  }

  const pluginRoot = roots.byName[plugin];
  if (!pluginRoot) {
    throw new Error(
      `loadAttachment: slot "${slot}": no plugin root registered for "${plugin}" (binding "${binding}")`,
    );
  }

  const searched: string[] = [];
  let foundDir: string | null = null;
  let registered = false;

  const skillsDir = join(pluginRoot.dir, "skills");
  const oneLevel = join(skillsDir, skillName, "SKILL.md");
  searched.push(oneLevel);
  if (existsSync(oneLevel)) {
    foundDir = join(skillsDir, skillName);
    registered = true;
  }

  if (!foundDir) {
    for (const group of listDirs(skillsDir)) {
      const candidate = join(skillsDir, group, skillName, "SKILL.md");
      searched.push(candidate);
      if (existsSync(candidate)) {
        foundDir = join(skillsDir, group, skillName);
        registered = true;
        break;
      }
    }
  }

  if (!foundDir) {
    const attachmentPath = join(pluginRoot.dir, "attachments", skillName, "SKILL.md");
    searched.push(attachmentPath);
    if (existsSync(attachmentPath)) {
      foundDir = join(pluginRoot.dir, "attachments", skillName);
      registered = false;
    }
  }

  if (!foundDir) {
    throw new Error(
      `loadAttachment: slot "${slot}": binding "${binding}" not found; searched:\n${searched.join("\n")}`,
    );
  }

  const skillMdPath = join(foundDir, "SKILL.md");
  const { body, frontmatter } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));

  const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object"
    ? (frontmatter.metadata as Record<string, unknown>)
    : {};
  const provides = typeof metadata.provides === "string" ? metadata.provides : "";
  if (!provides) {
    throw new Error(`loadAttachment: slot "${slot}": "${skillMdPath}" has no metadata.provides`);
  }

  return {
    binding,
    plugin,
    version: pluginRoot.version,
    dir: foundDir,
    body,
    provides,
    allowedTools: parseAllowedTools(frontmatter["allowed-tools"]),
    extraFiles: listFilesUnder(foundDir, new Set(["SKILL.md"])),
    registered,
  };
}

export function readVerbRoster(packDir: string): VerbDef[] {
  const stubsPath = join(packDir, "pack", "stubs.jsonc");
  const parsed = JSON.parse(stripJsonc(readFileSync(stubsPath, "utf8"))) as {
    verbs?: Record<string, { engine: string; description: string }>;
  };
  const verbs = parsed.verbs ?? {};
  return Object.entries(verbs).map(([name, def]) => ({
    name,
    engine: def.engine,
    description: def.description,
  }));
}

export function readManifestBindings(manifestPath: string): Record<string, Record<string, string>> {
  const parsed = JSON.parse(stripJsonc(readFileSync(manifestPath, "utf8"))) as {
    bindings?: Record<string, Record<string, string>>;
  };
  return parsed.bindings ?? {};
}

export type SurfaceConfig = { public: string[] };

export function readSurface(packDir: string): SurfaceConfig | null {
  const surfacePath = join(packDir, "pack", "surface.jsonc");
  if (!existsSync(surfacePath)) return null;
  const parsed = JSON.parse(stripJsonc(readFileSync(surfacePath, "utf8"))) as { public?: unknown };
  const publicList = Array.isArray(parsed.public)
    ? parsed.public.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { public: publicList };
}

export function invocableRoster(roots: PluginRoots): Set<string> {
  const roster = new Set<string>();

  for (const [pluginName, root] of Object.entries(roots.byName)) {
    const skillsDir = join(root.dir, "skills");

    for (const topName of listDirs(skillsDir)) {
      if (existsSync(join(skillsDir, topName, "SKILL.md"))) {
        roster.add(`${pluginName}:${topName}`);
      }

      const groupDir = join(skillsDir, topName);
      for (const subName of listDirs(groupDir)) {
        if (existsSync(join(groupDir, subName, "SKILL.md"))) {
          roster.add(`${pluginName}:${subName}`);
        }
      }
    }
  }

  return roster;
}
