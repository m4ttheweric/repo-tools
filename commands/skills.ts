/**
 * rt skills -- compile pack verbs from step sources + manifest bindings into
 * committed SKILL.md files, and check compiled output against its sources.
 *
 *   rt skills compile [--team <name>] [--verb <name> ...] [--manifest <path>] [--dry-run]
 *   rt skills check [--team <name>] [--verb <name> ...] [--manifest <path>]
 *
 * --pack-dir / --mattstack-dir are test-only escape hatches (hidden from the
 * command tree): they let tests point the whole resolution chain at a
 * mkdtemp fixture instead of the real ~/.mattstack, without a PATH-shimmed
 * `claude` binary -- execSync inside this process ignores runtime PATH
 * mutations (resolved at Bun's own startup), so a fake `claude` on PATH is
 * not a reliable test seam. --mattstack-dir stands in for both the
 * ~/.mattstack root (pack-dir and manifest defaults) and the Claude plugin
 * cache (mirrored under <dir>/plugins/<name>/) that resolvePluginRoots()
 * queries for real via `claude plugin list --json`.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mattstackHome } from "../lib/rt-paths.ts";
import { compileSkill } from "../lib/skills/compile.ts";
import {
  invocableRoster,
  loadAttachment,
  loadStepSource,
  readManifestBindings,
  readVerbRoster,
  resolvePluginRoots,
  type PluginRoots,
} from "../lib/skills/sources.ts";
import type { AttachmentSource, CompileResult, VerbDef } from "../lib/skills/types.ts";

/**
 * Marks an error as an expected, user-facing condition (bad flags, absent
 * binding, unknown verb) rather than a bug in this command -- withCleanErrors
 * prints these as a one-line "rt skills: <message>" and exits 1 with no
 * stack trace; anything else propagates to the top-level crash handler.
 */
class SkillsUsageError extends Error {}

async function withCleanErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SkillsUsageError) {
      console.error(`rt skills: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

type Flags = {
  team: string;
  verbs: string[] | null;
  manifest: string | null;
  dryRun: boolean;
  packDir: string | null;
  mattstackDir: string | null;
};

function parseFlags(args: string[]): Flags {
  const verbs: string[] = [];
  let team = "acme";
  let manifest: string | null = null;
  let dryRun = false;
  let packDir: string | null = null;
  let mattstackDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--team": team = args[++i] ?? team; break;
      case "--verb": { const v = args[++i]; if (v) verbs.push(v); break; }
      case "--manifest": manifest = args[++i] ?? null; break;
      case "--dry-run": dryRun = true; break;
      case "--pack-dir": packDir = args[++i] ?? null; break;
      case "--mattstack-dir": mattstackDir = args[++i] ?? null; break;
      default:
        throw new SkillsUsageError(`unrecognized argument "${a}"`);
    }
  }

  return { team, verbs: verbs.length ? verbs : null, manifest, dryRun, packDir, mattstackDir };
}

function packRootDir(mattstackRoot: string, team: string): string {
  return join(mattstackRoot, "teams", team, "mattstack", "packs", team);
}

function leadingCommentBlock(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().startsWith("//")) {
      lines.push(line);
      continue;
    }
    break;
  }
  return lines.join("\n");
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function findDefaultManifest(mattstackRoot: string, team: string): string {
  const reposRoot = join(mattstackRoot, "repos");
  const candidates: { path: string; mtimeMs: number }[] = [];

  for (const repoName of listSubdirs(reposRoot)) {
    const manifestPath = join(reposRoot, repoName, "skills.jsonc");
    if (!existsSync(manifestPath)) continue;
    const header = leadingCommentBlock(readFileSync(manifestPath, "utf8"));
    if (!header.includes(team)) continue;
    candidates.push({ path: manifestPath, mtimeMs: statSync(manifestPath).mtimeMs });
  }

  if (candidates.length === 0) {
    throw new SkillsUsageError(
      `no skills.jsonc under ${reposRoot}/*/ names team "${team}" in its provenance header; pass --manifest explicitly`,
    );
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0]!;
  const tied = candidates.filter((c) => c.mtimeMs === newest.mtimeMs);
  if (tied.length > 1) {
    throw new SkillsUsageError(
      `ambiguous manifest for team "${team}" -- candidates tie for newest:\n${tied.map((c) => c.path).join("\n")}\npass --manifest explicitly`,
    );
  }

  return newest.path;
}

/** Test-mode-only: scans <dir>/plugins/<name>/.claude-plugin/plugin.json, bypassing the real `claude plugin list --json`. */
function resolvePluginRootsFromDir(dir: string): PluginRoots {
  const pluginsDir = join(dir, "plugins");
  const byName: PluginRoots["byName"] = {};

  for (const name of listSubdirs(pluginsDir)) {
    const pluginDir = join(pluginsDir, name);
    let version = "unknown";
    try {
      const parsed = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
      if (typeof parsed.version === "string") version = parsed.version;
    } catch {
      // best-effort: a fixture plugin without a readable manifest still resolves a root
    }
    byName[name] = { dir: pluginDir, version };
  }

  return { byName };
}

function selectVerbs(roster: VerbDef[], names: string[] | null): VerbDef[] {
  if (!names) return roster;
  const byName = new Map(roster.map((v) => [v.name, v]));
  return names.map((name) => {
    const verb = byName.get(name);
    if (!verb) throw new SkillsUsageError(`verb "${name}" not found in roster`);
    return verb;
  });
}

type Resolved = {
  packDir: string;
  roster: VerbDef[];
  bindings: Record<string, Record<string, string>>;
  pluginRoots: PluginRoots;
  invocable: Set<string>;
};

function resolve(flags: Flags): Resolved {
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  const packDir = flags.packDir ?? packRootDir(mattstackRoot, flags.team);
  const manifestPath = flags.manifest ?? findDefaultManifest(mattstackRoot, flags.team);

  const roster = selectVerbs(readVerbRoster(packDir), flags.verbs);
  const bindings = readManifestBindings(manifestPath);
  const pluginRoots = flags.mattstackDir ? resolvePluginRootsFromDir(mattstackRoot) : resolvePluginRoots();
  const invocable = invocableRoster(pluginRoots);

  return { packDir, roster, bindings, pluginRoots, invocable };
}

function compileVerb(verb: VerbDef, resolved: Resolved): CompileResult {
  let step;
  try {
    step = loadStepSource(verb.engine, resolved.pluginRoots);
  } catch (err) {
    throw new SkillsUsageError(`verb "${verb.name}": ${(err as Error).message}`);
  }

  const slotBindings = resolved.bindings[`${step.plugin}:${verb.engine}`] ?? {};
  const fills: Record<string, AttachmentSource | null> = {};
  for (const slotName of Object.keys(step.slots)) {
    const bindingName = slotBindings[slotName];
    if (!bindingName) {
      fills[slotName] = null;
      continue;
    }
    try {
      fills[slotName] = loadAttachment(bindingName, slotName, resolved.pluginRoots);
    } catch (err) {
      throw new SkillsUsageError(`verb "${verb.name}": ${(err as Error).message}`);
    }
  }

  try {
    return compileSkill(verb, step, fills, resolved.invocable);
  } catch (err) {
    // compileSkill's own message already names verb + slot -- pass it through unchanged.
    throw new SkillsUsageError((err as Error).message);
  }
}

function writeCompiledVerb(outDir: string, result: CompileResult): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const file of result.files) {
    const dest = join(outDir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    if ("content" in file) {
      writeFileSync(dest, file.content);
    } else {
      copyFileSync(file.copyFrom, dest);
      chmodSync(dest, statSync(file.copyFrom).mode);
    }
  }
}

export async function skillsCompile(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    const flags = parseFlags(args);
    const resolved = resolve(flags);

    for (const verb of resolved.roster) {
      const result = compileVerb(verb, resolved);
      const outDir = join(resolved.packDir, "skills", verb.name);

      if (flags.dryRun) {
        console.log(`would write ${result.files.length} files for ${verb.name}`);
        for (const warning of result.warnings) console.log(`  ${warning}`);
        continue;
      }

      writeCompiledVerb(outDir, result);
      console.log(`compiled ${verb.name} (${result.files.length} files, ${result.warnings.length} warnings)`);
      for (const warning of result.warnings) console.log(`  ${warning}`);
    }
  });
}

export async function skillsCheck(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    const flags = parseFlags(args);
    const resolved = resolve(flags);

    let anyStale = false;

    for (const verb of resolved.roster) {
      const outDir = join(resolved.packDir, "skills", verb.name);
      if (!existsSync(outDir)) continue;

      const result = compileVerb(verb, resolved);
      const staleFiles: string[] = [];

      for (const file of result.files) {
        const dest = join(outDir, file.path);
        const expected = "content" in file ? Buffer.from(file.content) : readFileSync(file.copyFrom);
        if (!existsSync(dest) || !readFileSync(dest).equals(expected)) {
          staleFiles.push(file.path);
        }
      }

      if (staleFiles.length > 0) {
        anyStale = true;
        console.log(`${verb.name}: stale (recompile or investigate drift with git diff) -- ${staleFiles.join(", ")}`);
      } else {
        console.log(`${verb.name}: current`);
      }
    }

    if (anyStale) process.exitCode = 1;
  });
}
