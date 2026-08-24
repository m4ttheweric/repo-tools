import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { join, relative } from "path";
import { parse as parseYaml } from "yaml";
import { stripJsonc } from "../jsonc.ts";
import type { AttachmentSource, SlotSpec, StepSource, VerbDef } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Single definition lives in lib/jsonc.ts — a line-filter fork here previously missed block comments, trailing commas, and inline `//` after content. */
export { stripJsonc };

export function stripFrontmatter(
  md: string,
): { body: string; frontmatter: Record<string, unknown>; bodyStartLine: number } {
  const match = md.match(FRONTMATTER_RE);
  const fmBlock = match?.[0] ?? "";
  const rest = match ? md.slice(match[0].length) : md;
  const parsed = match ? parseYaml(match[1] ?? "") : undefined;
  const frontmatter = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const body = rest.trim();

  // Measure the head only: `body` is trimmed at both ends, so a
  // length-difference formula would count trailing blank lines as leading
  // ones and silently mis-locate every seam that points into a real file.
  const lead = rest.length - rest.trimStart().length;
  const countLines = (s: string) => (s.match(/\n/g) ?? []).length;
  const bodyStartLine = countLines(fmBlock) + countLines(rest.slice(0, lead)) + 1;

  return { body, frontmatter, bodyStartLine };
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
 * Thin by design: shelling out to `claude plugin list` is slow and
 * environment-dependent, so the subprocess call itself is not unit-tested;
 * buildPluginRoots carries the tested logic and this wrapper is exercised
 * live against real installed plugins in integration coverage instead.
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

/**
 * Vendoring exclusions: development junk that must not ship inside a
 * compiled verb -- dotfiles/dotdirs (.DS_Store, .gitignore), python
 * bytecode, test harnesses, and READMEs. Load-bearing runtime files
 * (scripts/, references/, data files) all pass.
 */
const VENDOR_EXCLUDED_DIRS = new Set(["__pycache__", "tests"]);

function isVendorExcluded(name: string, isDir: boolean): boolean {
  if (name.startsWith(".")) return true;
  if (isDir) return VENDOR_EXCLUDED_DIRS.has(name);
  return name.endsWith(".pyc") || name.endsWith(".test.sh") || name === "README.md";
}

function listFilesUnder(dir: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    const abs = sub ? join(dir, sub) : dir;
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (isVendorExcluded(entry.name, entry.isDirectory())) continue;
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

function tokens(raw: unknown): string[] {
  return typeof raw === "string" ? raw.split(/\s+/).filter((t) => t && t !== "-") : [];
}

function readStageMeta(frontmatter: Record<string, unknown>): StepSource["stageMeta"] {
  const meta = frontmatter.metadata && typeof frontmatter.metadata === "object"
    ? (frontmatter.metadata as Record<string, unknown>)
    : {};
  if (typeof meta.stage !== "string") return null;
  return { stage: meta.stage, consumes: tokens(meta["stage-consumes"]), produces: tokens(meta["stage-produces"]) };
}

export function loadStepSource(engineName: string, roots: PluginRoots): StepSource {
  const mattstack = roots.byName.mattstack;
  if (!mattstack) {
    throw new Error(`loadStepSource: no "mattstack" plugin root registered`);
  }

  const skillsDir = join(mattstack.dir, "skills");
  const attachmentsDir = join(mattstack.dir, "attachments");
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

  // Non-public engines live unregistered under attachments/ once moved out of
  // skills/ (registration under skills/ is what puts an engine in the user's
  // slash autocomplete); fall back there in the same shape loadAttachment
  // searches -- flat, then one group level deep.
  if (!foundDir) {
    const flatCandidate = join(attachmentsDir, engineName, "SKILL.md");
    searched.push(flatCandidate);
    if (existsSync(flatCandidate)) {
      foundDir = join(attachmentsDir, engineName);
    }
  }

  if (!foundDir) {
    for (const group of listDirs(attachmentsDir)) {
      const candidate = join(attachmentsDir, group, engineName, "SKILL.md");
      searched.push(candidate);
      if (existsSync(candidate)) {
        foundDir = join(attachmentsDir, group, engineName);
        break;
      }
    }
  }

  if (!foundDir) {
    throw new Error(
      `loadStepSource: engine "${engineName}" not found under ${skillsDir}/* or ${attachmentsDir}/*; searched:\n${searched.join("\n")}`,
    );
  }

  const skillMdPath = join(foundDir, "SKILL.md");
  const { body, frontmatter, bodyStartLine } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));

  if (frontmatter.type !== "pipeline-step") {
    throw new Error(`loadStepSource: "${skillMdPath}" is not typed "type: pipeline-step"`);
  }

  return {
    name: engineName,
    plugin: "mattstack",
    version: mattstack.version,
    dir: foundDir,
    srcPath: relative(mattstack.dir, skillMdPath),
    bodyStartLine,
    body,
    slots: parseSlots(frontmatter.slots),
    allowedTools: parseAllowedTools(frontmatter["allowed-tools"]),
    stepFiles: listFilesUnder(foundDir, new Set(["SKILL.md"])),
    stageMeta: readStageMeta(frontmatter),
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
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
  const { body, frontmatter, bodyStartLine } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));

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
    srcPath: relative(pluginRoot.dir, skillMdPath),
    bodyStartLine,
    body,
    provides,
    allowedTools: parseAllowedTools(frontmatter["allowed-tools"]),
    extraFiles: listFilesUnder(foundDir, new Set(["SKILL.md"])),
    registered,
  };
}

/**
 * Verb names flow unsanitized into join(packDir, "skills", name) at two
 * destructive call sites (writeCompiledVerb's rmSync + the internal-verb
 * skip's rmSync in commands/skills.ts) -- reject path-breakout characters
 * here, at the one place every verb name is read from disk.
 */
function assertSafeVerbName(name: string, stubsPath: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(
      `readVerbRoster: verb key "${name}" in ${stubsPath} is not a safe directory name (must not contain "/", "\\", or "..")`,
    );
  }
}

export function readVerbRoster(packDir: string): VerbDef[] {
  const stubsPath = join(packDir, "pack", "stubs.jsonc");
  // A pack with no verb roster (the mattstack plugin) has no compile targets;
  // its surface is still manageable, so absence is an empty roster, not an error.
  if (!existsSync(stubsPath)) return [];
  const parsed = JSON.parse(stripJsonc(readFileSync(stubsPath, "utf8"))) as {
    verbs?: Record<string, { engine: string; description: string }>;
  };
  const verbs = parsed.verbs ?? {};
  return Object.entries(verbs).map(([name, def]) => {
    assertSafeVerbName(name, stubsPath);
    return { name, engine: def.engine, description: def.description };
  });
}

export function readManifestBindings(manifestPath: string): Record<string, Record<string, string>> {
  const parsed = JSON.parse(stripJsonc(readFileSync(manifestPath, "utf8"))) as {
    bindings?: Record<string, Record<string, string>>;
  };
  return parsed.bindings ?? {};
}

/**
 * Separate reader rather than widening readManifestBindings: that function's
 * flat-Record return is depended on by every existing compile/check call
 * site, and pipelines is only ever needed alongside it, never instead of it.
 */
export function readManifestPipelines(manifestPath: string): Record<string, string[]> {
  const parsed = JSON.parse(stripJsonc(readFileSync(manifestPath, "utf8"))) as {
    pipelines?: Record<string, string[]>;
  };
  return parsed.pipelines ?? {};
}

export type SurfaceConfig = { public: string[] };

export function readSurface(packDir: string): SurfaceConfig | null {
  // Packs without a pack/ config dir (the mattstack plugin repo) declare their
  // surface at the plugin root beside .claude-plugin; pack/surface.jsonc wins.
  const surfacePath = [join(packDir, "pack", "surface.jsonc"), join(packDir, "surface.jsonc")]
    .find((candidate) => existsSync(candidate));
  if (!surfacePath) return null;
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
