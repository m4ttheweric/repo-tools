/**
 * rt skills -- compile pack verbs from step sources + manifest bindings into
 * committed SKILL.md files, check compiled output against its sources, and
 * materialize skill bindings for registered repos.
 *
 *   rt skills compile [--team <name>] [--verb <name> ...] [--manifest <path>] [--dry-run]
 *   rt skills check [--team <name>] [--verb <name> ...] [--manifest <path>]
 *   rt skills materialize [--repo <name>] [--json]
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

import { execFileSync, spawnSync } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { applyEdits, modify } from "jsonc-parser";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute as isAbsolutePath, join, relative as relativePath, resolve as resolvePath, sep } from "path";
import { mattstackHome } from "../lib/rt-paths.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes } from "../lib/setup/probes.ts";
import { materializeSkills } from "../lib/setup/skills-materialize.ts";
import { validateChain } from "../lib/skills/chain.ts";
import { compileSkill, HEADER_COMMENT, isInlined } from "../lib/skills/compile.ts";
import { skillMdDriftCauses, type DriftCause } from "../lib/skills/drift.ts";
import { discoverPacks, surfaceFileFor, type PackInfo } from "../lib/skills/packs.ts";
import { findPlaceholders } from "../lib/skills/placeholders.ts";
import { buildStageEntries, hostDir, outDirFor, otherSideDir, targetOutDirs } from "../lib/skills/layout.ts";
import { computePackSha, maskProvenance, mattstackProvenance, packPluginIdentity } from "../lib/skills/provenance.ts";
import {
  invocableRoster,
  loadAttachment,
  loadInclude,
  loadStepSource,
  parseStageQualifiedName,
  readManifestBindings,
  readManifestPipelines,
  readSurface,
  readVerbRoster,
  resolvePluginRoots,
  stageRoster,
  stripFrontmatter,
  type PluginRoots,
  type SurfaceConfig,
} from "../lib/skills/sources.ts";
import type { AttachmentSource, CompileResult, Side, StageEntry, StepSource, VerbDef } from "../lib/skills/types.ts";

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
  team: string | null;
  verbs: string[] | null;
  manifest: string | null;
  dryRun: boolean;
  preview: boolean;
  packDir: string | null;
  mattstackDir: string | null;
  json: boolean;
};

function parseFlags(args: string[]): Flags {
  const verbs: string[] = [];
  let team: string | null = null;
  let manifest: string | null = null;
  let dryRun = false;
  let preview = false;
  let packDir: string | null = null;
  let mattstackDir: string | null = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--pack":
      case "--team": team = args[++i] ?? team; break;
      case "--verb": { const v = args[++i]; if (v) verbs.push(v); break; }
      case "--manifest": manifest = args[++i] ?? null; break;
      case "--dry-run": dryRun = true; break;
      case "--preview": preview = true; break;
      case "--pack-dir": packDir = args[++i] ?? null; break;
      case "--mattstack-dir": mattstackDir = args[++i] ?? null; break;
      case "--json": json = true; break;
      default:
        throw new SkillsUsageError(`unrecognized argument "${a}"`);
    }
  }

  return { team, verbs: verbs.length ? verbs : null, manifest, dryRun, preview, packDir, mattstackDir, json };
}

function packRootDir(mattstackRoot: string, team: string): string {
  return join(mattstackRoot, "teams", team, "mattstack", "packs", team);
}

type PackTarget = { team: string; packDir: string };

/**
 * Which pack a command acts on. Explicit --pack-dir wins (tests); a named
 * pack resolves through marketplace discovery, falling back to the teams-zone
 * path for packs installed by hand; no name at all follows the rt convention
 * -- offer a picker over what is actually installed, auto-selecting when only
 * one pack exists, and name the choices instead of guessing when there is no tty.
 */
/**
 * A pack directory is named for its pack in every layout that produces one
 * (`packs/<name>/`, `plugins/<name>/`), so the directory answers "which pack"
 * when `--pack` was omitted. Naming a specific team here instead meant a
 * general-purpose tool carried one team's slug as its default.
 */
function packNameFor(packDir: string): string {
  return basename(resolvePath(packDir)) || "pack";
}

async function resolvePack(flags: { team: string | null; packDir: string | null; mattstackDir: string | null }): Promise<PackTarget> {
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  if (flags.packDir) return { team: flags.team ?? packNameFor(flags.packDir), packDir: flags.packDir };

  const packs = flags.mattstackDir ? [] : discoverPacks();
  if (flags.team) {
    const pack = packs.find((p) => p.name === flags.team);
    if (pack) return { team: pack.name, packDir: pack.dir };
    const legacy = packRootDir(mattstackRoot, flags.team);
    if (existsSync(legacy)) return { team: flags.team, packDir: legacy };
    throw new SkillsUsageError(
      `no pack named "${flags.team}" (discovered: ${packs.map((p) => p.name).join(", ") || "none"}; checked ${legacy})`,
    );
  }

  if (packs.length === 1) return { team: packs[0]!.name, packDir: packs[0]!.dir };
  if (packs.length === 0) throw new SkillsUsageError("no packs discovered (no directory marketplace plugin carries a surface.jsonc); pass --pack <name>");

  if (!process.stdin.isTTY) {
    throw new SkillsUsageError(`which pack? pass --pack <name> (discovered: ${packs.map((p) => p.name).join(", ")})`);
  }
  const picked = await pickPack(packs);
  if (!picked) process.exit(0);
  return { team: picked.name, packDir: picked.dir };
}

async function pickPack(packs: PackInfo[]): Promise<PackInfo | null> {
  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
  const value = await filterableSelect({
    message: "which pack?",
    options: packs.map((p) => ({ value: p.name, label: p.name, hint: `${p.layout}  ${p.dir}` })),
    stderr: true,
  });
  return packs.find((p) => p.name === value) ?? null;
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

type SkillEntry = { name: string; group: string | null; dir: string };

/**
 * Skill dirs live either flat (skills/<name>) or one group deep
 * (skills/<group>/<name>, the mattstack plugin's layout); a depth-1 dir
 * without its own SKILL.md is a group, and its leaves are the skills.
 */
function enumerateSkillEntries(root: string, into: Map<string, SkillEntry> = new Map()): Map<string, SkillEntry> {
  // surface.jsonc is keyed by bare skill name, so two groups carrying the same
  // leaf would be indistinguishable to every surface operation -- refuse rather
  // than let one silently shadow the other.
  const add = (entry: SkillEntry) => {
    const clash = into.get(entry.name);
    if (clash && clash.dir !== entry.dir) {
      throw new SkillsUsageError(
        `skill name "${entry.name}" appears twice (${clash.dir} and ${entry.dir}); skill names must be unique within a pack`,
      );
    }
    into.set(entry.name, entry);
  };
  for (const top of listSubdirs(root)) {
    const topDir = join(root, top);
    if (existsSync(join(topDir, "SKILL.md"))) {
      add({ name: top, group: null, dir: topDir });
      continue;
    }
    let sawLeaf = false;
    for (const leaf of listSubdirs(topDir)) {
      const leafDir = join(topDir, leaf);
      if (!existsSync(join(leafDir, "SKILL.md"))) continue;
      sawLeaf = true;
      add({ name: leaf, group: top, dir: leafDir });
    }
    if (!sawLeaf) add({ name: top, group: null, dir: topDir });
  }
  return into;
}

/**
 * A plugin may register more than one skills root (plugin.json `skills`, e.g.
 * ["./skills/review", "./plugin/skills"]); the registered surface is the union
 * of those roots, defaulting to skills/ when the manifest lists none.
 */
function registeredSkillRoots(packDir: string): string[] {
  const manifestPath = join(packDir, ".claude-plugin", "plugin.json");
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills?: unknown };
      if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
        // A root is only honored inside the pack: a manifest value like "../x" or an
        // absolute path would otherwise let the surface verbs enumerate (and move) dirs
        // that belong to some other tree.
        const canonical = (p: string) => {
          try {
            return realpathSync(p);
          } catch {
            return resolvePath(p);
          }
        };
        const packRoot = canonical(packDir);
        const roots = parsed.skills
          .filter((s): s is string => typeof s === "string")
          .map((s) => canonical(resolvePath(packDir, s)))
          .filter((root) => {
            const rel = relativePath(packRoot, root);
            if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolutePath(rel)) return false;
            try {
              return statSync(root).isDirectory();
            } catch {
              return false;
            }
          });
        if (roots.length > 0) return roots;
      }
    } catch {
      // an unreadable manifest falls back to the conventional root below
    }
  }
  return [join(packDir, "skills")];
}

function enumerateRegistered(packDir: string): Map<string, SkillEntry> {
  const entries = new Map<string, SkillEntry>();
  for (const root of registeredSkillRoots(packDir)) enumerateSkillEntries(root, entries);
  return entries;
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(join(dir, entry.name), relPath));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

function isUnder(parent: string, child: string): boolean {
  const rel = relativePath(canonicalPath(parent), canonicalPath(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolutePath(rel);
}

/**
 * A team-zone pack is compiled against its repo's merged manifest, never its
 * own pack/skills.jsonc: that file is one fragment merge-manifests.sh folds in
 * with the other packs' and the user's overrides, so compiling from it alone
 * would commit an artifact that check flags as drift on every registered
 * machine. A standalone pack (the mattstack plugin) has no repo and no merge;
 * its pack/skills.jsonc IS its manifest.
 */
function findDefaultManifest(mattstackRoot: string, team: string, packDir: string): string {
  const reposRoot = join(mattstackRoot, "repos");
  const candidates: { path: string; mtimeMs: number }[] = [];

  for (const repoName of listSubdirs(reposRoot)) {
    const manifestPath = join(reposRoot, repoName, "skills.jsonc");
    if (!existsSync(manifestPath)) continue;
    const header = leadingCommentBlock(readFileSync(manifestPath, "utf8"));
    // Each provenance line reads `<engine-plugin>:<engine> <slot> <- <pack>@<marketplace>`.
    // Only the source half names the pack; the key half names the engine's plugin,
    // which is "mattstack" in every team's manifest.
    if (!header.includes(`<- ${team}@`)) continue;
    candidates.push({ path: manifestPath, mtimeMs: statSync(manifestPath).mtimeMs });
  }

  if (candidates.length === 0) {
    const ownManifest = join(packDir, "pack", "skills.jsonc");
    const standalone = !isUnder(join(mattstackRoot, "teams"), packDir);
    if (standalone && existsSync(ownManifest)) return ownManifest;
    throw new SkillsUsageError(
      `no skills.jsonc under ${reposRoot}/*/ names team "${team}" in its provenance header (<- ${team}@...)` +
        (standalone ? ` and ${ownManifest} is absent` : "") +
        `; pass --manifest explicitly`,
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

/**
 * The real plugin cache holds symlinks to working trees, and a Dirent for one
 * is not a directory -- stat, so a linked plugin dir is a root here too.
 */
function listPluginDirs(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir)
    .filter((name) => {
      try {
        return statSync(join(pluginsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Test-mode-only: scans <dir>/plugins/<name>/.claude-plugin/plugin.json, bypassing the real `claude plugin list --json`. */
function resolvePluginRootsFromDir(dir: string): PluginRoots {
  const pluginsDir = join(dir, "plugins");
  const byName: PluginRoots["byName"] = {};

  for (const name of listPluginDirs(pluginsDir)) {
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

type Resolved = {
  packDir: string;
  team: string;
  // Unfiltered by --verb: the roster/stage universe is scoped by --verb once
  // inside compileTargets (across both name spaces together), not here --
  // composition (which must never truncate its binding universe on a stray
  // --verb) also reads this directly, unfiltered.
  fullRoster: VerbDef[];
  bindings: Record<string, Record<string, string>>;
  pluginRoots: PluginRoots;
  invocable: Set<string>;
  surface: SurfaceConfig | null;
  internalRoster: Set<string>;
  manifestPath: string | null;
  pipelines: Record<string, string[]>;
  stages: VerbDef[];
  stageEntries: Record<string, StageEntry[]>;
  repoKey: string;
  mattstackSha: string;
  mattstackDirty: 0 | 1;
  packSha: string;
};

/**
 * Internal roster tokens mirror invocableRoster's "<team>:<name>" shape so
 * they line up with body-prose tokens and fill bindings. A dir under
 * <packDir>/skills/ not (yet) named in surface.jsonc's public list is
 * internal by default -- this is what lets a fill inline through the
 * transition window before it physically moves. Non-public stub verbs seed
 * the roster too: a retired verb's dir is deleted, so the dir scan alone
 * would let dangling references to it slip through. attachments/ dirs seed
 * it as well: `surface apply` moves a skill there once it goes internal, so
 * without this a name that migrated from skills/ to attachments/ falls out
 * of the roster and a body token naming it downgrades from a compile error
 * to a mere "not invocable" warning.
 */
function computeInternalRoster(
  team: string,
  packDir: string,
  surface: SurfaceConfig | null,
  fullRoster: VerbDef[],
): Set<string> {
  const internal = new Set<string>();
  if (!surface) return internal;
  const publicSet = new Set(surface.public);
  for (const name of enumerateRegistered(packDir).keys()) {
    if (!publicSet.has(name)) internal.add(`${team}:${name}`);
  }
  for (const name of enumerateSkillEntries(join(packDir, "attachments")).keys()) {
    if (!publicSet.has(name)) internal.add(`${team}:${name}`);
  }
  for (const verb of fullRoster) {
    if (!publicSet.has(verb.name)) internal.add(`${team}:${verb.name}`);
  }
  return internal;
}

async function resolve(flags: Flags): Promise<Resolved> {
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  const { team, packDir } = await resolvePack(flags);

  const fullRoster = readVerbRoster(packDir);
  // A pack with no verb roster needs no manifest: bindings only feed compile targets.
  const manifestPath = fullRoster.length === 0 ? null : (flags.manifest ?? findDefaultManifest(mattstackRoot, team, packDir));
  const bindings = manifestPath ? readManifestBindings(manifestPath) : {};
  // No compile targets means nothing needs plugin roots or the invocable roster;
  // skipping the `claude plugin list` subprocess keeps rosterless packs usable
  // even where the Claude CLI is absent.
  const pluginRoots: PluginRoots = fullRoster.length === 0
    ? { byName: {} }
    : flags.mattstackDir
      ? resolvePluginRootsFromDir(mattstackRoot)
      : resolvePluginRoots();
  // The pack being compiled is the plugin its own fills are bound as. The installed
  // cache is the previous release of it, so reading fills from there inlines stale
  // bodies and pins their version token one release behind -- every `check` after a
  // release would report stale until the next bump.
  const self = packPluginIdentity(packDir);
  if (self && fullRoster.length > 0) pluginRoots.byName[self.name] = { dir: packDir, version: self.version };
  const invocable = fullRoster.length === 0 ? new Set<string>() : invocableRoster(pluginRoots);
  const surface = readSurface(packDir);
  const internalRoster = computeInternalRoster(team, packDir, surface, fullRoster);

  const pipelines = manifestPath ? readManifestPipelines(manifestPath) : {};
  let stages: VerbDef[];
  try {
    stages = stageRoster(pipelines);
  } catch (err) {
    throw new SkillsUsageError((err as Error).message);
  }
  // The manifest's parent directory name is the registry repo key `run-start
  // --repo` expects -- the same key `~/.mattstack/runs/<repo>/` is named by.
  const repoKey = manifestPath ? basename(dirname(manifestPath)) : "";
  const { sha: mattstackSha, dirty: mattstackDirty } = mattstackProvenance(pipelines, pluginRoots.byName.mattstack);
  const packSha = computePackSha(pipelines, self, packDir);
  let stageEntries: Record<string, StageEntry[]>;
  try {
    stageEntries = buildStageEntries({ pipelines, pluginRoots, publicSet: surface ? new Set(surface.public) : null });
  } catch (err) {
    throw new SkillsUsageError((err as Error).message);
  }

  return {
    packDir, team, fullRoster, bindings, pluginRoots, invocable, surface, internalRoster, manifestPath,
    pipelines, stages, stageEntries, repoKey, mattstackSha, mattstackDirty, packSha,
  };
}

function loadFillsFor(step: StepSource, resolved: Resolved, where: string): Record<string, AttachmentSource | null> {
  const slotBindings = resolved.bindings[`${step.plugin}:${step.name}`] ?? {};
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
      throw new SkillsUsageError(`${where}: ${(err as Error).message}`);
    }
  }
  return fills;
}

/** Composition and compile share this scan so their include lists cannot drift. */
function includeNames(bodies: string[]): string[] {
  const names: string[] = [];
  for (const body of bodies) {
    for (const p of findPlaceholders(body)) {
      if (p.kind === "include" && p.arg && !names.includes(p.arg)) names.push(p.arg);
    }
  }
  return names;
}

/**
 * Scans the step body plus every INLINED bound fill's body, so a fill's own
 * `{{include}}` lines resolve too -- a reference-mode fill's body never
 * reaches the compiled output, so an `{{include}}` line inside one names
 * nothing a compile emits.
 */
function loadIncludesFor(
  step: StepSource,
  fills: Record<string, AttachmentSource | null>,
  resolved: Resolved,
  where: string,
): Record<string, AttachmentSource> {
  const out: Record<string, AttachmentSource> = {};
  const fillBodies = Object.values(fills)
    .filter((f): f is AttachmentSource => f !== null && isInlined(f, resolved.internalRoster))
    .map((f) => f.body);
  for (const name of includeNames([step.body, ...fillBodies])) {
    try {
      out[name] = loadInclude(name, resolved.pluginRoots);
    } catch (err) {
      throw new SkillsUsageError(`${where}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Every stage's own rules plus its bound fills' rules; unioned into the orchestrator because a stage read as a file loads no frontmatter of its own. */
function stageAllowedToolsFor(resolved: Resolved, entries: Record<string, StageEntry[]>): string[] {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const list of Object.values(entries)) {
    for (const entry of list) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const step = loadStepSource(entry.name, resolved.pluginRoots);
      rules.push(...step.allowedTools);
      for (const fill of Object.values(loadFillsFor(step, resolved, `stage "${entry.name}"`))) {
        if (fill) rules.push(...fill.allowedTools);
      }
    }
  }
  return rules;
}

function compileVerb(target: CompileTarget, resolved: Resolved, emittedTargetDirs: string[], verbSides: Record<string, Side>): CompileResult {
  const { isPublic, isStage } = target;
  let verb = target.verb;
  const where = `${isStage ? "stage" : "verb"} "${verb.name}"`;
  let step: StepSource;
  try {
    step = loadStepSource(verb.engine, resolved.pluginRoots);
  } catch (err) {
    throw new SkillsUsageError(`${where}: ${(err as Error).message}`);
  }
  if (isStage) verb = { ...verb, description: step.description };

  const entries = resolved.stageEntries;
  const allStageDirs = Object.values(entries).flat().map((e) => e.dir);
  const stageNames = new Set(resolved.stages.map((s) => s.name));
  // Only a public roster verb is ever invoked by name, so only its ${CLAUDE_SKILL_DIR}
  // is its own directory; every other target is read as a file from a public skill.
  const stageDir = isStage
    ? allStageDirs.find((d) => d.endsWith(`/${verb.name}`)) ?? null
    : isPublic ? null : hostDir(verb.name, "attachments");
  const internalVerbDirs = Object.entries(verbSides)
    .filter(([name, side]) => side === "attachments" && !stageNames.has(name))
    .map(([name]) => hostDir(name, "attachments"));
  const isOrchestrator = findPlaceholders(step.body).some((p) => p.kind === "pipeline.stages");

  try {
    const fills = loadFillsFor(step, resolved, where);
    return compileSkill(verb, step, fills, resolved.invocable, {
      internalRoster: resolved.internalRoster,
      includes: loadIncludesFor(step, fills, resolved, where),
      pipelines: entries,
      repoKey: resolved.repoKey,
      mattstackSha: resolved.mattstackSha,
      mattstackDirty: resolved.mattstackDirty,
      packSha: resolved.packSha,
      stageDir,
      stageAllowedTools: isOrchestrator ? stageAllowedToolsFor(resolved, entries) : [],
      emittedSiblingDirs: [...allStageDirs, ...internalVerbDirs],
      packRoot: resolved.packDir,
      compiledDir: outDirFor(resolved.packDir, verb.name, isPublic),
      emittedTargetDirs,
      where,
      verbSides,
      side: isPublic ? "skills" : "attachments",
    });
  } catch (err) {
    const message = (err as Error).message;
    // loadFillsFor/loadIncludesFor's SkillsUsageError already carries this same
    // `where` prefix; a bare Error from compileSkill (e.g. a fill's own
    // {{slot}} misuse) never does, and would otherwise surface with no verb
    // or stage named at all.
    const isPrefixed = err instanceof SkillsUsageError || message.startsWith(`${where}: `);
    throw new SkillsUsageError(isPrefixed ? message : `${where}: ${message}`);
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

type CompileVerbStatus = "compiled" | "errored";
type CompileVerbRow = {
  name: string;
  status: CompileVerbStatus;
  files: { path: string }[];
  warnings: string[];
  errors: string[];
  side: Side;
};

type CompileOutcome = { ok: true; result: CompileResult } | { ok: false; message: string };

/**
 * compileVerb fails two ways: it throws (loadStepSource/loadAttachment/
 * compileSkill's lints and resolveBoundSlots), or it returns a result whose
 * errors[] is non-empty (lintInternalRoster only). Every skillsCompile mode
 * needs both outcomes as data rather than a thrown SkillsUsageError -- --json
 * and --preview to report them, the writing mode to collect every target's
 * verdict before touching disk -- so this is the one place that catches both.
 * skillsCheck is the lone caller left that lets compileVerb throw.
 */
function tryCompileVerb(target: CompileTarget, resolved: Resolved, emittedTargetDirs: string[], verbSides: Record<string, Side>): CompileOutcome {
  const { verb, isStage } = target;
  try {
    const result = compileVerb(target, resolved, emittedTargetDirs, verbSides);
    if (result.errors.length > 0) {
      return { ok: false, message: `${isStage ? "stage" : "verb"} "${verb.name}": ${result.errors.join("; ")}` };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** What `run-start` puts in the run record before the first stage runs; every other field has to be produced by a stage. */
const PIPELINE_SEED = ["work-type", "ticket", "repo", "mode"];

function pipelineChainErrors(resolved: Resolved): string[] {
  return Object.entries(resolved.stageEntries).flatMap(([type, list]) =>
    validateChain(type, list, PIPELINE_SEED),
  );
}

type CompileTarget = { verb: VerbDef; isPublic: boolean; isStage: boolean };

type CompilePlan = { targets: CompileTarget[]; verbSides: Record<string, Side> };

/**
 * A roster verb keeps today's default-public rule; a stage is internal
 * unless surface.jsonc names it explicitly. `verbFilter` (--verb) scopes
 * both name spaces together, in the order named: `--verb stage-plan`
 * targets exactly that stage, `--verb work` targets exactly that roster
 * verb -- neither pulls in every stage a pipeline declares, which is what
 * `resolved.stages` being unfiltered would otherwise do to --preview's
 * one-body contract and to a scoped compile/check. `verbSides` is built
 * before the filter applies: a scoped compile still exempts the host dirs
 * of, and renders {{verb.path}} to, targets it is not emitting.
 */
function compileTargets(resolved: Resolved, publicSet: Set<string> | null, verbFilter: string[] | null): CompilePlan {
  const rosterNames = new Set(resolved.fullRoster.map((v) => v.name));
  for (const stage of resolved.stages) {
    if (rosterNames.has(stage.name)) {
      throw new SkillsUsageError(`"${stage.name}" is both a roster verb and a pipeline stage; a name may be one or the other`);
    }
  }

  const all: CompileTarget[] = [
    ...resolved.fullRoster.map((verb) => ({ verb, isPublic: !publicSet || publicSet.has(verb.name), isStage: false })),
    ...resolved.stages.map((verb) => ({ verb, isPublic: publicSet?.has(verb.name) ?? false, isStage: true })),
  ];
  const verbSides: Record<string, Side> = {};
  for (const t of all) verbSides[t.verb.name] = t.isPublic ? "skills" : "attachments";
  if (!verbFilter) return { targets: all, verbSides };

  const byName = new Map(all.map((t) => [t.verb.name, t]));
  const targets = verbFilter.map((name) => {
    const target = byName.get(name);
    if (!target) throw new SkillsUsageError(`verb "${name}" not found in roster or pipeline stages`);
    return target;
  });
  return { targets, verbSides };
}

export async function skillsCompile(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    const flags = parseFlags(args);
    const resolved = await resolve(flags);
    const publicSet = resolved.surface ? new Set(resolved.surface.public) : null;

    if (flags.preview && (flags.verbs?.length ?? 0) !== 1) {
      throw new SkillsUsageError("--preview needs a single --verb");
    }

    const chainErrors = pipelineChainErrors(resolved);
    if (chainErrors.length > 0) throw new SkillsUsageError(chainErrors.join("\n"));

    const { targets, verbSides } = compileTargets(resolved, publicSet, flags.verbs);
    const emittedTargetDirs = targetOutDirs(resolved, targets);

    if (flags.json) {
      const rows: CompileVerbRow[] = [];
      for (const target of targets) {
        const { verb, isPublic } = target;
        const side: Side = isPublic ? "skills" : "attachments";
        const outcome = tryCompileVerb(target, resolved, emittedTargetDirs, verbSides);
        if (!outcome.ok) {
          rows.push({ name: verb.name, status: "errored", files: [], warnings: [], errors: [outcome.message], side });
        } else {
          rows.push({
            name: verb.name,
            status: "compiled",
            files: outcome.result.files.map((f) => ({ path: f.path })),
            warnings: outcome.result.warnings,
            errors: [],
            side,
          });
        }
      }
      // An errored verb is a failed compile: exit non-zero so a caller reading
      // the code (not just the payload) sees it, matching the non-JSON path's
      // throw and check --json's stale exit.
      if (rows.some((row) => row.status === "errored")) process.exitCode = 1;
      console.log(JSON.stringify({ pack: resolved.team, packDir: resolved.packDir, verbs: rows }));
      return;
    }

    if (flags.preview) {
      for (const target of targets) {
        const { verb } = target;
        const outcome = tryCompileVerb(target, resolved, emittedTargetDirs, verbSides);
        if (!outcome.ok) {
          // A lint-erroring verb has no previewable body -- say so on stderr
          // and leave stdout empty rather than silently producing nothing.
          console.error(`rt skills: ${outcome.message}`);
          process.exitCode = 1;
          return;
        }
        // The body is the product here: no summary lines and no warnings
        // interleaved, so the output pipes straight into a file or a preview pane.
        const main = outcome.result.files.find((f) => "content" in f && f.path.endsWith("SKILL.md"));
        if (!main || !("content" in main)) throw new SkillsUsageError(`verb "${verb.name}": produced no SKILL.md`);
        console.log(main.content);
      }
      // The post-loop misplaced scan below walks the whole pack rather than the
      // requested verb, so letting --preview reach it would put a misplaced
      // skill anywhere on stdout, where the caller reads the compiled body.
      return;
    }

    // Every target is compiled before any is written: a run that aborts midway
    // leaves already-emitted verbs referencing stage dirs that never landed.
    const planned: { target: CompileTarget; result: CompileResult }[] = [];
    const failures: string[] = [];
    for (const target of targets) {
      const outcome = tryCompileVerb(target, resolved, emittedTargetDirs, verbSides);
      if (outcome.ok) planned.push({ target, result: outcome.result });
      else failures.push(outcome.message);
    }
    if (failures.length > 0) {
      for (const message of failures) console.error(`rt skills: ${message}`);
      process.exit(1);
    }

    for (const { target, result } of planned) {
      const { verb, isPublic } = target;
      const side: Side = isPublic ? "skills" : "attachments";

      if (flags.dryRun) {
        console.log(`would write ${result.files.length} files for ${verb.name}`);
        for (const warning of result.warnings) console.log(`  ${warning}`);
        continue;
      }

      // A pack's own engine source may live at attachments/<verb>/SKILL.md while
      // its door compiles into skills/<verb>/: the other side is only stale when
      // it carries the compiler header, never when it is the hand-written source.
      const stale = otherSideDir(resolved.packDir, verb.name, isPublic);
      if (existsSync(stale) && !isHandWrittenDir(stale)) rmSync(stale, { recursive: true, force: true });
      writeCompiledVerb(outDirFor(resolved.packDir, verb.name, isPublic), result);
      console.log(`compiled ${verb.name} -> ${side} (${result.files.length} files, ${result.warnings.length} warnings)`);
      for (const warning of result.warnings) console.log(`  ${warning}`);
    }

    if (publicSet) {
      for (const name of enumerateRegistered(resolved.packDir).keys()) {
        if (!publicSet.has(name)) {
          console.log(`misplaced: ${name} (run rt skills surface apply, or move it)`);
          process.exitCode = 1;
        }
      }
    }
  });
}

type CheckVerbStatus = "in-sync" | "stale" | "never-compiled";
type CheckVerbRow = {
  name: string;
  status: CheckVerbStatus;
  staleFiles: string[];
  orphanFiles: string[];
  side: Side;
  staleBecause?: DriftCause[];
};

export async function skillsCheck(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    const flags = parseFlags(args);
    const resolved = await resolve(flags);
    // No surface.jsonc means the pack has no public/internal split yet -- every roster verb is public.
    const publicSet = resolved.surface ? new Set(resolved.surface.public) : null;

    let anyStale = false;
    const rows: CheckVerbRow[] = [];

    // Pack-level staleness: the stage list a compiled orchestrator carries no
    // longer folds, so recompiling would refuse. No row can express that, so
    // --json carries it alongside them instead of leaving the exit code alone
    // to say a payload of current rows is a failure.
    const chainErrors = pipelineChainErrors(resolved);
    if (chainErrors.length > 0) anyStale = true;
    if (!flags.json) for (const chainError of chainErrors) console.log(chainError);

    const { targets, verbSides } = compileTargets(resolved, publicSet, flags.verbs);
    const emittedTargetDirs = targetOutDirs(resolved, targets);

    for (const target of targets) {
      const { verb, isPublic } = target;
      const outDir = outDirFor(resolved.packDir, verb.name, isPublic);
      const side: Side = isPublic ? "skills" : "attachments";

      if (!existsSync(outDir)) {
        anyStale = true;
        rows.push({ name: verb.name, status: "never-compiled", staleFiles: [], orphanFiles: [], side });
        if (!flags.json) console.log(`${verb.name}: stale (never compiled -- outDir missing; run rt skills compile)`);
        continue;
      }

      const result = compileVerb(target, resolved, emittedTargetDirs, verbSides);
      const staleFiles: string[] = [];
      const orphanFiles: string[] = [];
      const expectedPaths = new Set(result.files.map((f) => f.path));
      const causes: DriftCause[] = [];
      const addCause = (cause: DriftCause) => {
        if (!causes.includes(cause)) causes.push(cause);
      };

      for (const file of result.files) {
        const dest = join(outDir, file.path);
        const expected = "content" in file ? Buffer.from(file.content) : readFileSync(file.copyFrom);
        // SKILL.md carries the compiler's own version/sha stamps -- a version bump or
        // a fresh checkout sha with no inlined body change is not drift worth flagging.
        if (file.path.endsWith("SKILL.md")) {
          const maskedExpected = maskProvenance(expected.toString("utf8"));
          const maskedOnDisk = existsSync(dest) ? maskProvenance(readFileSync(dest, "utf8")) : null;
          if (maskedOnDisk === null || maskedOnDisk !== maskedExpected) {
            staleFiles.push(file.path);
            if (maskedOnDisk === null) addCause("structure");
            else for (const cause of skillMdDriftCauses(maskedOnDisk, maskedExpected)) addCause(cause);
          }
        } else {
          const stale = !existsSync(dest) || !readFileSync(dest).equals(expected);
          if (stale) {
            staleFiles.push(file.path);
            addCause("vendored");
          }
        }
      }

      // A file left behind by an earlier compile: writeCompiledVerb would delete it on
      // the next real compile, so "current" here would be a false clean bill of health.
      const onDiskFiles = listFilesRecursive(outDir);
      const outRel = relativePath(resolved.packDir, outDir);
      const ignored = gitIgnoredFiles(resolved.packDir, onDiskFiles.map((f) => join(outRel, f)));
      for (const onDisk of onDiskFiles) {
        if (expectedPaths.has(onDisk) || ignored.has(join(outRel, onDisk))) continue;
        orphanFiles.push(onDisk);
      }

      if (staleFiles.length > 0 || orphanFiles.length > 0) {
        anyStale = true;
        rows.push({ name: verb.name, status: "stale", staleFiles, orphanFiles, side, staleBecause: causes });
        if (!flags.json) {
          const humanFiles = [...staleFiles, ...orphanFiles.map((f) => `${f} (orphan)`)];
          const movedPrefix = causes.length > 0 ? `${causes.join(", ")} moved; ` : "";
          console.log(`${verb.name}: stale (${movedPrefix}recompile or investigate drift with git diff) -- ${humanFiles.join(", ")}`);
        }
      } else {
        rows.push({ name: verb.name, status: "in-sync", staleFiles, orphanFiles, side });
        if (!flags.json) console.log(`${verb.name}: current`);
      }
    }

    if (anyStale) process.exitCode = 1;

    if (flags.json) {
      console.log(JSON.stringify({ pack: resolved.team, packDir: resolved.packDir, verbs: rows, chainErrors }));
    }
  });
}

function skillsFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function skillsPacks(args: string[]): Promise<void> {
  const json = args.includes("--json");
  // --settings-path is a test-only escape hatch (hidden from the command
  // tree), mirroring --pack-dir/--mattstack-dir: it lets tests point
  // discoverPacks at a fixture claude settings.json instead of the real
  // ~/.claude/settings.json.
  const settingsPath = skillsFlagValue(args, "--settings-path");
  const packs = discoverPacks(settingsPath ? { settingsPath } : {});
  const rows = packs.map((p) => ({ name: p.name, dir: p.dir, layout: p.layout }));

  if (json) {
    console.log(JSON.stringify({ packs: rows }));
    return;
  }

  if (rows.length === 0) {
    console.log("no packs discovered (no directory marketplace plugin carries a surface.jsonc)");
    return;
  }
  for (const row of rows) console.log(`${row.name}  ${row.layout}  ${row.dir}`);
}

// ─── rt skills composition ─────────────────────────────────────────────────

type CompositionSlot = {
  name: string;
  contract: string;
  required: boolean;
  boundTo: string | null;
  // Fill fields (registered/inlined/fillVersion/fillSourcePath) are the
  // PLUGIN's version, not the fill's own -- AttachmentSource.version is
  // assigned pluginRoot.version, so every fill from one plugin reports an
  // identical value that moves only when the plugin bumps, never when the
  // fill itself is edited. A version timeline keyed on this number shows
  // one step for an entire plugin, not per part.
  fillSourcePath: string | null;
  fillVersion: string | null;
  registered: boolean | null;
  inlined: boolean | null;
  resolveError?: string;
};

type CompositionVerb = {
  name: string;
  engine: string;
  engineRef: string | null;
  plugin: string | null;
  description: string;
  public: boolean;
  sourcePath: string | null;
  artifactPath: string;
  slots: CompositionSlot[];
  includes: string[];
  engineError?: string;
};

type CompositionBinderKind = "verb" | "stage" | "skill" | "external";
type CompositionBinder = {
  ref: string;
  verb: string | null;
  kind: CompositionBinderKind;
  slots: { name: string; boundTo: string }[];
};

type CompositionFill = { binding: string; provides: string; sourcePath: string; registered: boolean };

type CompositionPayload = {
  pack: string;
  packDir: string;
  /**
   * The manifest that supplies these bindings, absolute -- the file to edit to
   * rebind a slot. For a team pack it lives in a registered repo under
   * `~/.mattstack/repos/<repoName>/`, whose dir name is the repo, not the
   * pack, so it cannot be reconstructed from `pack`; a standalone pack's is
   * its own `<packDir>/pack/skills.jsonc`. Null when the pack has no roster
   * (nothing to bind).
   */
  manifestPath: string | null;
  verbs: CompositionVerb[];
  fills: CompositionFill[];
  binders: CompositionBinder[];
  /**
   * Work type -> its ordered stage refs, straight from the manifest. This is
   * the payload's only record of order: binders[].kind says a ref IS a stage
   * but not where it runs, and a stage ref is otherwise indistinguishable
   * from any other mattstack: binder. A consumer wanting execution order has
   * nowhere else to get it.
   */
  pipelines: Record<string, string[]>;
};

/**
 * Per-verb degradation: loadStepSource throws above the slot loop (no
 * mattstack root, engine not found, or frontmatter.type !== "pipeline-step")
 * -- any one of those would otherwise blank the whole composition payload
 * before a single verb is emitted. engineRef/plugin/sourcePath are derived
 * from the loaded step, so a failed load genuinely has no bindings key: null
 * is the honest value, and the verb still appears rather than vanishing.
 */
function buildCompositionVerb(verb: VerbDef, resolved: Resolved, publicSet: Set<string> | null): CompositionVerb {
  const isPublic = !publicSet || publicSet.has(verb.name);
  const artifactPath = outDirFor(resolved.packDir, verb.name, isPublic);

  let step;
  try {
    step = loadStepSource(verb.engine, resolved.pluginRoots);
  } catch (err) {
    return {
      name: verb.name,
      engine: verb.engine,
      engineRef: null,
      plugin: null,
      description: verb.description,
      public: isPublic,
      sourcePath: null,
      artifactPath,
      slots: [],
      includes: [],
      engineError: (err as Error).message,
    };
  }

  const engineRef = `${step.plugin}:${verb.engine}`;
  const slotBindings = resolved.bindings[engineRef] ?? {};
  const stepPluginDir = resolved.pluginRoots.byName[step.plugin]?.dir ?? null;
  const sourcePath = stepPluginDir ? join(stepPluginDir, step.srcPath) : null;

  const fillBodies: string[] = [];
  const slots: CompositionSlot[] = Object.entries(step.slots).map(([slotName, spec]) => {
    const boundTo = slotBindings[slotName] ?? null;
    // required is optional on SlotSpec; default it explicitly so JSON carries
    // "not required" rather than silently dropping the key.
    const base = { name: slotName, contract: spec.contract, required: spec.required ?? false, boundTo };

    if (!boundTo) {
      return { ...base, fillSourcePath: null, fillVersion: null, registered: null, inlined: null };
    }

    // Per-slot degradation: loadAttachment throws on an unresolvable binding
    // and on a fill missing metadata.provides -- one dangling binding must
    // not take down every other slot's data, let alone the whole payload.
    try {
      const fill = loadAttachment(boundTo, slotName, resolved.pluginRoots);
      const inlined = isInlined(fill, resolved.internalRoster);
      // A reference-mode fill's body never reaches the compiled output, so its
      // own {{include}} lines resolve nothing a compile emits either.
      if (inlined) fillBodies.push(fill.body);
      const fillPluginDir = resolved.pluginRoots.byName[fill.plugin]?.dir ?? null;
      return {
        ...base,
        fillSourcePath: fillPluginDir ? join(fillPluginDir, fill.srcPath) : null,
        fillVersion: fill.version,
        registered: fill.registered,
        inlined,
      };
    } catch (err) {
      return {
        ...base,
        fillSourcePath: null,
        fillVersion: null,
        registered: null,
        inlined: null,
        resolveError: (err as Error).message,
      };
    }
  });

  return {
    name: verb.name,
    engine: verb.engine,
    engineRef,
    plugin: step.plugin,
    description: verb.description,
    public: isPublic,
    sourcePath,
    artifactPath,
    slots,
    includes: includeNames([step.body, ...fillBodies]),
  };
}

/**
 * verbs[] is roster-shaped and therefore an incomplete binding universe:
 * measured against a live pack, stubs.jsonc's verbs and the manifest's
 * binding keys intersect on a minority -- the rest are pipeline stages,
 * cross-plugin keys (e.g. board:review), and mattstack skills that bind
 * fills without being a roster verb or a pipeline stage. binders[] inverts
 * every key in Resolved.bindings instead, so an inverse index built from it
 * (rather than from verbs[]) doesn't render genuinely-bound fills as
 * orphaned.
 *
 * `verb` is set by matching a roster entry's `mattstack:<engine>` against
 * the ref -- loadStepSource hardcodes plugin: "mattstack" as a literal, so
 * this is a cheap string match needing no plugin resolution and no
 * successful step load. Kind is derived from ref membership in the
 * manifest's own pipelines block (never from string heuristics like
 * includes("stage-"), which breaks the day a stage is renamed): a match
 * there is "stage"; a roster match is "verb"; a remaining mattstack: ref is
 * "skill" (a plugin skill binding fills without being either); anything
 * else is cross-plugin, "external".
 */
function buildBinders(resolved: Resolved, pipelines: Record<string, string[]>): CompositionBinder[] {
  const stageRefs = new Set(Object.values(pipelines).flat());
  const verbByEngineRef = new Map<string, string>();
  for (const verb of resolved.fullRoster) verbByEngineRef.set(`mattstack:${verb.engine}`, verb.name);

  return Object.entries(resolved.bindings).map(([ref, slotBindings]) => {
    const verbName = verbByEngineRef.get(ref) ?? null;
    const kind: CompositionBinderKind = verbName
      ? "verb"
      : stageRefs.has(ref)
        ? "stage"
        : ref.startsWith("mattstack:")
          ? "skill"
          : "external";
    return {
      ref,
      verb: verbName,
      kind,
      slots: Object.entries(slotBindings).map(([name, boundTo]) => ({ name, boundTo })),
    };
  });
}

/**
 * Nothing else in rt enumerates the universe of fills.
 * invocableRoster walks only skills/ (never attachments/, where fills
 * live); enumerateSkillEntries covers one pack's attachments/ only, with
 * bare names and no provides. This walks every plugin root's skills/ AND
 * attachments/ and keeps only entries carrying frontmatter metadata.provides
 * -- that field is what makes an entry a fill rather than a roster/verb
 * skill (a pipeline-step SKILL.md has slots, not provides).
 */
function enumerateFills(pluginRoots: PluginRoots): CompositionFill[] {
  const fills: CompositionFill[] = [];

  for (const [pluginName, root] of Object.entries(pluginRoots.byName)) {
    for (const registered of [true, false] as const) {
      const rootDir = join(root.dir, registered ? "skills" : "attachments");
      for (const entry of enumerateSkillEntries(rootDir).values()) {
        const skillMdPath = join(entry.dir, "SKILL.md");
        let provides = "";
        try {
          const { frontmatter } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));
          const metadata = frontmatter.metadata && typeof frontmatter.metadata === "object"
            ? (frontmatter.metadata as Record<string, unknown>)
            : {};
          provides = typeof metadata.provides === "string" ? metadata.provides : "";
        } catch {
          continue; // unreadable SKILL.md: not a usable fill
        }
        if (!provides) continue; // no metadata.provides: a roster/verb skill, not a fill
        fills.push({ binding: `${pluginName}:${entry.name}`, provides, sourcePath: skillMdPath, registered });
      }
    }
  }

  return fills.sort((a, b) => a.binding.localeCompare(b.binding));
}

export async function skillsComposition(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    // composition never takes --verb: resolved.roster is selectVerbs-filtered,
    // and binders[]/fills[] are always complete, so a filtered verbs[] would
    // contradict them inside the same payload. Use fullRoster unconditionally.
    const flags = parseFlags(args);
    const resolved = await resolve(flags);
    const publicSet = resolved.surface ? new Set(resolved.surface.public) : null;
    // A rosterless pack (e.g. the mattstack plugin itself) short-circuits
    // resolve(): bindings is {} and pluginRoots is empty, so verbs/binders/fills
    // all come back empty here too -- that is correct, not a failure.
    const pipelines = resolved.manifestPath ? readManifestPipelines(resolved.manifestPath) : {};

    const verbs = resolved.fullRoster.map((verb) => buildCompositionVerb(verb, resolved, publicSet));
    const fills = enumerateFills(resolved.pluginRoots);
    const binders = buildBinders(resolved, pipelines);

    const payload: CompositionPayload = {
      pack: resolved.team,
      packDir: resolved.packDir,
      manifestPath: resolved.manifestPath,
      verbs,
      fills,
      binders,
      pipelines,
    };

    if (flags.json) {
      console.log(JSON.stringify(payload));
      return;
    }

    console.log(`rt skills composition -- pack ${payload.pack}`);
    for (const verb of payload.verbs) {
      if (verb.engineError) {
        console.log(`  ${verb.name}: ENGINE ERROR -- ${verb.engineError}`);
        continue;
      }
      console.log(`  ${verb.name} (${verb.engineRef}) ${verb.public ? "public" : "internal"}`);
      for (const slot of verb.slots) {
        const status = slot.resolveError
          ? `ERROR -- ${slot.resolveError}`
          : slot.boundTo ?? "(unbound)";
        console.log(`    ${slot.name}: ${status}`);
      }
    }
    console.log(`  ${payload.fills.length} fills, ${payload.binders.length} binders`);
  });
}

export async function skillsMaterialize(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const repo = skillsFlagValue(args, "--repo");

  try {
    const result = await materializeSkills(createRealProbes(), { repo });
    if (json) {
      console.log(JSON.stringify(envelope(result)));
      return;
    }
    // A top-level skip (merge-manifests.sh not installed yet) is the normal
    // fresh-machine outcome, not a failure -- exit 0, never exit 2.
    if (result.skipped) {
      console.log(`skipped: ${result.reason}`);
      return;
    }
    for (const r of result.repos) {
      console.log(`${r.ok ? "materialized" : "failed"} ${r.name}: ${r.detail}`);
    }
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "skills materialize", console.log);
    throw err;
  }
}

// ─── rt skills surface -- list / set / apply / palette ────────────────

type SurfaceFlags = {
  team: string | null;
  dryRun: boolean;
  packDir: string | null;
  mattstackDir: string | null;
  manifest: string | null;
  json: boolean;
};

type SurfaceRow = { name: string; kind: "compiled" | "hand-authored" | "missing"; status: "public" | "internal" };

function kindLabel(kind: SurfaceRow["kind"]): string {
  return kind === "missing" ? "(no files on disk)" : kind;
}

function parseSurfaceFlags(args: string[]): { flags: SurfaceFlags; rest: string[] } {
  let team: string | null = null;
  let dryRun = false;
  let packDir: string | null = null;
  let mattstackDir: string | null = null;
  let manifest: string | null = null;
  let json = false;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--pack":
      case "--team": team = args[++i] ?? team; break;
      case "--dry-run": dryRun = true; break;
      case "--pack-dir": packDir = args[++i] ?? null; break;
      case "--mattstack-dir": mattstackDir = args[++i] ?? null; break;
      case "--manifest": manifest = args[++i] ?? null; break;
      case "--json": json = true; break;
      default: rest.push(a);
    }
  }

  return { flags: { team, dryRun, packDir, mattstackDir, manifest, json }, rest };
}

/** Pins the pack on the flags so the compile delegation and the printed header name the same pack the user picked. */
async function resolveSurfacePaths(flags: SurfaceFlags): Promise<{ packDir: string }> {
  const target = await resolvePack(flags);
  flags.team = target.team;
  flags.packDir = target.packDir;
  return { packDir: target.packDir };
}

function isHandWrittenDir(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md")) && !isCompiledDir(dir);
}

function isCompiledDir(dir: string): boolean {
  const skillMdPath = join(dir, "SKILL.md");
  if (!existsSync(skillMdPath)) return false;
  const { body } = stripFrontmatter(readFileSync(skillMdPath, "utf8"));
  return body.startsWith(HEADER_COMMENT);
}

/** Stub verb names are always compile targets; a materialized dir carrying the compiler header is one too, even if its verb was since retired from stubs.jsonc. */
function classify(name: string, dir: string | null, verbNames: Set<string>): "compiled" | "hand-authored" {
  if (verbNames.has(name)) return "compiled";
  if (dir && isCompiledDir(dir)) return "compiled";
  return "hand-authored";
}

function collectRegistry(packDir: string, verbNames: Set<string>) {
  const skillEntries = enumerateRegistered(packDir);
  const attachmentEntries = enumerateSkillEntries(join(packDir, "attachments"));
  const skillsNames = new Set(skillEntries.keys());
  const attachmentNames = new Set(attachmentEntries.keys());
  const allNames = new Set<string>([...skillsNames, ...attachmentNames, ...verbNames]);
  return { skillsNames, attachmentNames, allNames, skillEntries, attachmentEntries };
}

/** The set `set`'s first use bootstraps surface.jsonc from -- so the first edit is a delta from reality, not a cliff. */
function defaultPublicSet(skillsNames: Set<string>, verbNames: Set<string>): Set<string> {
  return new Set<string>([...skillsNames, ...verbNames]);
}

/**
 * No stages, not an error, when: the pack is rosterless (no verbs to pipeline),
 * or it has a roster but no manifest was discoverable (--manifest absent and
 * `findDefaultManifest` can't find one) -- the surface verbs must keep working
 * in both cases. A manifest that *is* found but fails to parse still throws.
 */
function stageNamesFor(flags: SurfaceFlags, packDir: string): Set<string> {
  if (readVerbRoster(packDir).length === 0) return new Set();
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  const team = flags.team ?? packNameFor(packDir);
  let manifest: string;
  if (flags.manifest) {
    manifest = flags.manifest;
  } else {
    try {
      manifest = findDefaultManifest(mattstackRoot, team, packDir);
    } catch (err) {
      if (err instanceof SkillsUsageError) return new Set();
      throw err;
    }
  }
  try {
    return new Set(stageRoster(readManifestPipelines(manifest)).map((v) => v.name));
  } catch (err) {
    throw new SkillsUsageError((err as Error).message);
  }
}

export function computeRows(
  packDir: string,
  verbNames: Set<string>,
  surface: SurfaceConfig | null,
  stageNames: Set<string>,
): { source: string; rows: SurfaceRow[] } {
  const { skillsNames, attachmentNames, allNames, skillEntries, attachmentEntries } = collectRegistry(packDir, verbNames);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);
  const surfacePath = surfaceFileFor(packDir);
  const source = surface && surfacePath
    ? surfacePath.slice(packDir.length + 1)
    : "(no surface.jsonc yet -- inferred from current skills/ + stubs.jsonc placement)";

  const names = new Set<string>([...allNames, ...publicSet, ...stageNames]);
  const rows = [...names].sort().map((name) => {
    const dir = skillEntries.get(name)?.dir ?? attachmentEntries.get(name)?.dir ?? null;
    const isStage = stageNames.has(name);
    return {
      name,
      kind: isStage ? ("compiled" as const) : allNames.has(name) ? classify(name, dir, verbNames) : ("missing" as const),
      status: (publicSet.has(name) ? "public" : "internal") as "public" | "internal",
    };
  });

  return { source, rows };
}

function writeSurfaceConfig(packDir: string, publicList: string[]): void {
  // Write back wherever the pack already keeps its surface (pack/ for team packs,
  // the plugin root for packs without a pack/ dir); new packs get pack/.
  const path = surfaceFileFor(packDir) ?? join(packDir, "pack", "surface.jsonc");
  mkdirSync(dirname(path), { recursive: true });
  // The leading comment block is the pack's own record (ratification notes,
  // what lives where); a rewrite carries it forward.
  const existing = existsSync(path) ? leadingCommentBlock(readFileSync(path, "utf8")) : "";
  const header = existing || "// surface.jsonc -- names this pack's public skills/ directories.";
  const json = JSON.stringify({ public: publicList }, null, 2);
  writeFileSync(path, `${header}\n${json}\n`);
}

function compileArgs(flags: SurfaceFlags, packDir: string): string[] {
  const args = ["--pack", flags.team ?? packNameFor(packDir), "--pack-dir", packDir];
  if (flags.mattstackDir) args.push("--mattstack-dir", flags.mattstackDir);
  if (flags.manifest) args.push("--manifest", flags.manifest);
  if (flags.dryRun) args.push("--dry-run");
  return args;
}

function isInsideGitWorkTree(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Files git ignores inside a compiled dir (a __pycache__ from running the
 * verb's scripts in place, editor droppings) were never written by a compile
 * and are not drift. Outside a git checkout there are no ignore rules, so
 * every stray file counts. Paths are pack-relative, as git check-ignore
 * reports them.
 */
function gitIgnoredFiles(packDir: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0 || !isInsideGitWorkTree(packDir)) return new Set();
  const res = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: packDir,
    input: relPaths.join("\0") + "\0",
    encoding: "utf8",
  });
  // exit 1 means nothing matched; any other non-zero status is a git error
  if (res.status !== 0) return new Set();
  return new Set(res.stdout.split("\0").filter(Boolean));
}

type PlannedMove = { fromRel: string; toRel: string };

/**
 * The source is the entry's real dir: a registered skill may live under any
 * plugin.json root (plugin/skills/<name>), not only skills/. A grouped skill
 * keeps its group on the other side.
 */
function planMove(packDir: string, entry: SkillEntry, to: "skills" | "attachments"): PlannedMove {
  return {
    fromRel: relativePath(canonicalPath(packDir), canonicalPath(entry.dir)),
    toRel: entry.group ? join(to, entry.group, entry.name) : join(to, entry.name),
  };
}

/** git mv keeps rename history for the common case; fixtures (and any non-git pack dir) fall back to a plain rename. */
function moveHandAuthoredDir(packDir: string, move: PlannedMove): string | null {
  const { fromRel, toRel } = move;
  mkdirSync(dirname(join(packDir, toRel)), { recursive: true });

  if (isInsideGitWorkTree(packDir)) {
    execFileSync("git", ["mv", fromRel, toRel], { cwd: packDir, stdio: "pipe" });
    return null;
  }

  renameSync(join(packDir, fromRel), join(packDir, toRel));
  return "plain rename -- pack dir is not a git repo";
}

function printSurfaceRows(flags: SurfaceFlags, source: string, rows: SurfaceRow[]): void {
  console.log(`rt skills surface -- pack ${flags.team}`);
  console.log(`source: ${source}`);
  for (const row of rows) {
    console.log(`  ${row.status.padEnd(9)}${kindLabel(row.kind).padEnd(15)}${row.name}`);
  }
}

async function runList(flags: SurfaceFlags): Promise<void> {
  const { packDir } = await resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const stageNames = stageNamesFor(flags, packDir);
  const { source, rows } = computeRows(packDir, verbNames, surface, stageNames);

  if (flags.json) {
    console.log(JSON.stringify({ pack: flags.team, packDir, rows }));
    return;
  }

  printSurfaceRows(flags, source, rows);
  if (rows.length === 0) console.log("(no skills registered in this pack)");
}

async function runApply(flags: SurfaceFlags): Promise<void> {
  const { packDir } = await resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const stageNames = stageNamesFor(flags, packDir);
  const { skillsNames, attachmentNames, skillEntries, attachmentEntries } = collectRegistry(packDir, verbNames);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);

  const candidates = [...new Set<string>([...skillsNames, ...attachmentNames])].sort();
  let moved = 0;

  for (const name of candidates) {
    const currentlyUnderSkills = skillsNames.has(name);
    const entry = (currentlyUnderSkills ? skillEntries : attachmentEntries).get(name)!;
    const dir = entry.dir;
    // Stages and compiled entries are regenerated by the compile step, never git-mv'd
    if (stageNames.has(name)) continue;
    if (classify(name, dir, verbNames) === "compiled") continue;

    const wantPublic = publicSet.has(name);
    if (currentlyUnderSkills === wantPublic) continue;

    const move = planMove(packDir, entry, currentlyUnderSkills ? "attachments" : "skills");
    const route = `${dirname(move.fromRel)}/ -> ${dirname(move.toRel)}/`;
    moved++;

    if (flags.dryRun) {
      console.log(`would move ${name}: ${route}`);
      continue;
    }

    const note = moveHandAuthoredDir(packDir, move);
    console.log(`moved ${name}: ${route}${note ? ` (${note})` : ""}`);
  }

  // surface.jsonc only ever names the public side -- internal is the absence
  // of an entry, indistinguishable from never-touched, so there is nothing to
  // reconcile or announce for a stage the surface doesn't list. A listed
  // stage with neither side on disk has nothing to git-mv either; the
  // trailing compile below is what actually places it.
  let recorded = 0;
  for (const name of [...stageNames].sort()) {
    if (!publicSet.has(name)) continue;
    if (existsSync(outDirFor(packDir, name, true)) || existsSync(otherSideDir(packDir, name, true))) continue;
    recorded++;
    console.log(flags.dryRun
      ? `${name}: would record; emitted to skills/ on the next compile`
      : `${name}: recorded; emitted to skills/ on the next compile`);
  }

  if (moved === 0 && recorded === 0) console.log("no moves needed");

  await skillsCompile(compileArgs(flags, packDir));
}

/**
 * Every name lands in ONE surface.jsonc write and ONE apply. Each apply
 * git-mv's directories and recompiles the whole pack, so calling this per name
 * would leave a partially-moved pack behind any failure after the first --
 * and would pay for the pack's full compile once per name.
 */
async function runSet(names: string[], want: "public" | "internal", flags: SurfaceFlags): Promise<void> {
  const { packDir } = await resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const { skillsNames, allNames } = collectRegistry(packDir, verbNames);
  const stageNames = stageNamesFor(flags, packDir);

  // Validated before anything is written: an unknown name in a list of ten
  // must not leave the other nine applied. A declared-but-never-compiled
  // stage passes here even with no directory on either side.
  for (const name of names) {
    if (!allNames.has(name) && !stageNames.has(name)) {
      throw new SkillsUsageError(
        `"${name}" is not a known skill or verb in this pack (checked skills/, attachments/, stubs.jsonc)`,
      );
    }
  }

  const surface = readSurface(packDir);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);

  for (const name of names) {
    if (want === "public") publicSet.add(name);
    else publicSet.delete(name);
  }

  writeSurfaceConfig(packDir, [...publicSet].sort());
  for (const name of names) console.log(`${name}: ${want}`);

  await runApply(flags);
}

export type SurfaceDelta = { toPublic: string[]; toInternal: string[] };

export type PaletteAction =
  | { kind: "no-changes" }
  | { kind: "write"; delta: SurfaceDelta }
  | { kind: "declined"; delta: SurfaceDelta };

/**
 * Pure decision seam for the palette's accept path. The picker's checked set
 * round-trips honestly, so confirming with nothing marked yields an empty
 * selection -- read as "every currently-public name goes internal", not as a
 * leftover row. Called once (confirmed=false) to compute the delta for the
 * pre-write preview, and again with the real answer once the user has seen it.
 */
export function decidePaletteAction(
  previousPublic: Set<string>,
  resultRows: { name: string; status: "public" | "internal" }[],
  confirmed: boolean,
): PaletteAction {
  const toPublic: string[] = [];
  const toInternal: string[] = [];

  for (const row of resultRows) {
    const was = previousPublic.has(row.name);
    const now = row.status === "public";
    if (was === now) continue;
    if (now) toPublic.push(row.name);
    else toInternal.push(row.name);
  }
  toPublic.sort();
  toInternal.sort();

  if (toPublic.length === 0 && toInternal.length === 0) return { kind: "no-changes" };
  const delta = { toPublic, toInternal };
  return confirmed ? { kind: "write", delta } : { kind: "declined", delta };
}

function printDelta(delta: SurfaceDelta): void {
  console.log("changes:");
  for (const name of delta.toPublic) console.log(`  + public   ${name}`);
  for (const name of delta.toInternal) console.log(`  - public   ${name}`);
}

function confirmYesNo(promptText: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function runPalette(flags: SurfaceFlags): Promise<void> {
  const { packDir } = await resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const stageNames = stageNamesFor(flags, packDir);
  const { skillsNames } = collectRegistry(packDir, verbNames);
  const previousPublic = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);
  const { source, rows } = computeRows(packDir, verbNames, surface, stageNames);

  if (rows.length === 0) {
    console.log("(no skills registered in this pack)");
    return;
  }

  if (!process.stdin.isTTY) {
    printSurfaceRows(flags, source, rows);
    console.log("");
    console.log("no tty -- edit one at a time: rt skills surface set <name> --public|--internal");
    return;
  }

  const { filterableMultiselect } = await import("../lib/pick-wrappers.ts");
  const options = rows.map((row) => ({
    value: row.name,
    label: row.name,
    hint: `${row.status.padEnd(9)}${kindLabel(row.kind)}`,
  }));
  const initialValues = rows.filter((row) => row.status === "public").map((row) => row.name);

  const selected = await filterableMultiselect({
    message: "rt skills surface",
    breadcrumb: ["rt", "skills", "surface"],
    options,
    initialValues,
  });

  if (selected === null) return;

  const selectedSet = new Set(selected);

  const resultRows = rows.map((row) => ({
    name: row.name,
    status: (selectedSet.has(row.name) ? "public" : "internal") as "public" | "internal",
  }));

  const preview = decidePaletteAction(previousPublic, resultRows, false);
  if (preview.kind === "no-changes") {
    console.log("no changes -- surface.jsonc left as is");
    return;
  }

  printDelta(preview.delta);
  const confirmed = await confirmYesNo("  apply these changes? [y/N] ");
  const decision = decidePaletteAction(previousPublic, resultRows, confirmed);

  if (decision.kind !== "write") {
    console.log("declined -- no changes made");
    return;
  }

  writeSurfaceConfig(packDir, [...selectedSet].sort());
  console.log(`surface.jsonc updated: ${selectedSet.size} public`);

  await runApply(flags);
}

export async function skillsSurface(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    const mode = args[0];

    if (mode === "list") {
      const { flags, rest } = parseSurfaceFlags(args.slice(1));
      if (rest.length) throw new SkillsUsageError(`unrecognized argument "${rest[0]}"`);
      await runList(flags);
      return;
    }

    if (mode === "apply") {
      const { flags, rest } = parseSurfaceFlags(args.slice(1));
      if (rest.length) throw new SkillsUsageError(`unrecognized argument "${rest[0]}"`);
      await runApply(flags);
      return;
    }

    if (mode === "set") {
      // Names run up to the first flag, so one invocation carries a whole
      // one-direction change.
      const names: string[] = [];
      for (const a of args.slice(1)) {
        if (a.startsWith("--")) break;
        names.push(a);
      }
      if (names.length === 0) {
        throw new SkillsUsageError("set requires a skill name: rt skills surface set <name...> --public|--internal");
      }
      const duplicate = names.find((n, i) => names.indexOf(n) !== i);
      if (duplicate) throw new SkillsUsageError(`"${duplicate}" named more than once`);
      const { flags, rest } = parseSurfaceFlags(args.slice(1 + names.length));
      let want: "public" | "internal" | null = null;
      for (const a of rest) {
        if (a === "--public") want = "public";
        else if (a === "--internal") want = "internal";
        else throw new SkillsUsageError(`unrecognized argument "${a}"`);
      }
      if (!want) throw new SkillsUsageError("set requires --public or --internal");
      await runSet(names, want, flags);
      return;
    }

    if (mode !== undefined && !mode.startsWith("--")) {
      throw new SkillsUsageError(`unrecognized subcommand "${mode}" (expected list, set, or apply)`);
    }

    const { flags, rest } = parseSurfaceFlags(args);
    if (rest.length) throw new SkillsUsageError(`unrecognized argument "${rest[0]}"`);
    await runPalette(flags);
  });
}

// ─── rt skills bind -- write bindings.<engineRef>.<slot> = <fill>, preserving manifest comments ──

type BindFlags = {
  team: string | null;
  manifest: string | null;
  dryRun: boolean;
  packDir: string | null;
  mattstackDir: string | null;
};

function parseBindFlags(args: string[]): BindFlags {
  let team: string | null = null;
  let manifest: string | null = null;
  let dryRun = false;
  let packDir: string | null = null;
  let mattstackDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--pack":
      case "--team": team = args[++i] ?? team; break;
      case "--manifest": manifest = args[++i] ?? null; break;
      case "--dry-run": dryRun = true; break;
      case "--pack-dir": packDir = args[++i] ?? null; break;
      case "--mattstack-dir": mattstackDir = args[++i] ?? null; break;
      default:
        throw new SkillsUsageError(`unrecognized argument "${a}"`);
    }
  }

  return { team, manifest, dryRun, packDir, mattstackDir };
}

type PickedBind = { verbName: string; slotName: string; fill: string; flagArgs: string[] };

/**
 * TTY-only chained pickers for an omitted <verb>/<slot>/<fill>, resolved left to
 * right from the pack's roster + manifest. Returns null when nothing needs
 * picking (all three positionals present) or a step's candidate set is empty, so
 * skillsBind falls through to its existing error -- the non-TTY / --json paths
 * never call this and stay byte-for-byte unchanged.
 */
/** Split `skills bind` args into positionals and flag args (bind's flags: --dry-run boolean, plus the value-taking --pack/--team/--manifest/--pack-dir/--mattstack-dir). Keeps the &lt;verb&gt; &lt;slot&gt; &lt;fill&gt; count right even when flags are interleaved. */
function separateBindArgs(args: string[]): { positionals: string[]; flagArgs: string[] } {
  const valued = new Set(["--pack", "--team", "--manifest", "--pack-dir", "--mattstack-dir"]);
  const positionals: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") {
      flagArgs.push(a);
    } else if (valued.has(a)) {
      flagArgs.push(a);
      if (i + 1 < args.length) flagArgs.push(args[++i]!);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flagArgs };
}

async function pickBindArgs(args: string[]): Promise<PickedBind | null> {
  const { positionals, flagArgs } = separateBindArgs(args);
  if (positionals.length >= 3) return null;

  const bindFlags = parseBindFlags(flagArgs);
  const resolved = await resolve({
    team: bindFlags.team,
    verbs: null,
    manifest: bindFlags.manifest,
    dryRun: bindFlags.dryRun,
    preview: false,
    packDir: bindFlags.packDir,
    mattstackDir: bindFlags.mattstackDir,
    json: false,
  });

  const { filterableSelect } = await import("../lib/pick-wrappers.ts");

  let verbName = positionals[0];
  if (!verbName) {
    const seen = new Set<string>();
    const options = [];
    for (const v of resolved.fullRoster) {
      seen.add(v.name);
      options.push({ value: v.name, label: v.name, hint: `verb  -> ${v.engine}` });
    }
    for (const s of resolved.stages) {
      if (seen.has(s.name)) continue;
      options.push({ value: s.name, label: s.name, hint: `stage  -> ${s.engine}` });
    }
    if (options.length === 0) return null;
    const picked = await filterableSelect({ message: "which verb?", options, stderr: true });
    if (picked === null) process.exit(0);
    verbName = picked;
  }

  const verb = resolved.fullRoster.find((v) => v.name === verbName) ?? resolved.stages.find((v) => v.name === verbName);
  if (!verb) return null;

  let step;
  try {
    step = loadStepSource(verb.engine, resolved.pluginRoots);
  } catch {
    return null;
  }

  let slotName = positionals[1];
  if (!slotName) {
    const options = Object.entries(step.slots).map(([name, spec]) => ({
      value: name,
      label: name,
      hint: `${spec.contract}${spec.required ? "  required" : ""}`,
    }));
    if (options.length === 0) return null;
    const picked = await filterableSelect({ message: `which slot on "${verbName}"?`, options, stderr: true });
    if (picked === null) process.exit(0);
    slotName = picked;
  }

  const slotSpec = step.slots[slotName];
  if (!slotSpec) return null;

  let fill = positionals[2];
  if (!fill) {
    const options = enumerateFills(resolved.pluginRoots)
      .filter((f) => f.provides === slotSpec.contract)
      .map((f) => ({ value: f.binding, label: f.binding, hint: `${f.provides}  ${f.registered ? "registered" : "attachment"}` }));
    if (options.length === 0) return null;
    const picked = await filterableSelect({ message: `which fill for "${slotName}" (${slotSpec.contract})?`, options, stderr: true });
    if (picked === null) process.exit(0);
    fill = picked;
  }

  return { verbName, slotName, fill, flagArgs };
}

export async function skillsBind(args: string[]): Promise<void> {
  await withCleanErrors(async () => {
    // Positionals, not raw args, so an interleaved flag (bind verb --pack x slot
    // fill) doesn't read as a filled <slot>/<fill> and skip the picker.
    const { positionals, flagArgs } = separateBindArgs(args);
    let [verbName, slotName, fill] = positionals;
    let rest = flagArgs;
    if ((!verbName || !slotName || !fill) && process.stdin.isTTY && !args.includes("--json") && !process.env.RT_BATCH) {
      const picked = await pickBindArgs(args);
      if (picked) {
        verbName = picked.verbName;
        slotName = picked.slotName;
        fill = picked.fill;
        rest = picked.flagArgs;
      }
    }
    if (!verbName || !slotName || !fill) {
      throw new SkillsUsageError("bind requires: rt skills bind <verb> <slot> <fill>");
    }

    const bindFlags = parseBindFlags(rest);
    const resolved = await resolve({
      team: bindFlags.team,
      verbs: null,
      manifest: bindFlags.manifest,
      dryRun: bindFlags.dryRun,
      preview: false,
      packDir: bindFlags.packDir,
      mattstackDir: bindFlags.mattstackDir,
      json: false,
    });

    // Roster verb wins on a name collision -- resolve() lets compileTargets reject
    // that collision pack-wide, so bind's own tie-break only ever matters for --dry-run.
    const rosterVerb = resolved.fullRoster.find((v) => v.name === verbName);
    const verb = rosterVerb ?? resolved.stages.find((v) => v.name === verbName);
    if (!verb) {
      const knownVerbs = resolved.fullRoster.map((v) => v.name).sort();
      const knownStages = resolved.stages.map((v) => v.name).sort();
      throw new SkillsUsageError(
        `"${verbName}" is neither a roster verb nor a pipeline stage (verbs: ${knownVerbs.join(", ") || "none"}; stages: ${knownStages.join(", ") || "none"})`,
      );
    }

    let step;
    try {
      step = loadStepSource(verb.engine, resolved.pluginRoots);
    } catch (err) {
      throw new SkillsUsageError(`verb "${verbName}": ${(err as Error).message}`);
    }

    const slotSpec = step.slots[slotName];
    if (!slotSpec) {
      const known = Object.keys(step.slots).sort();
      throw new SkillsUsageError(
        `slot "${slotName}" not declared on verb "${verbName}"'s step (known slots: ${known.join(", ") || "none"})`,
      );
    }

    // loadAttachment throws a plain Error on an unresolvable binding or a fill
    // missing metadata.provides -- wrap it so it exits clean like every other
    // validation failure here, instead of surfacing as an uncaught crash.
    let attachment;
    try {
      attachment = loadAttachment(fill, slotName, resolved.pluginRoots);
    } catch (err) {
      throw new SkillsUsageError((err as Error).message);
    }

    if (attachment.provides !== slotSpec.contract) {
      throw new SkillsUsageError(
        `fill "${fill}" provides "${attachment.provides}", but slot "${slotName}" demands "${slotSpec.contract}"`,
      );
    }

    if (!resolved.manifestPath) {
      throw new SkillsUsageError(`pack "${resolved.team}" has no manifest to bind into`);
    }

    const engineRef = `${step.plugin}:${verb.engine}`;
    const oldValue = resolved.bindings[engineRef]?.[slotName] ?? "(unbound)";
    const summary = `${verbName}.${slotName}: ${oldValue} -> ${fill}`;

    if (bindFlags.dryRun) {
      console.log(summary);
      return;
    }

    const text = readFileSync(resolved.manifestPath, "utf8");
    const edits = modify(text, ["bindings", engineRef, slotName], fill, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    writeFileSync(resolved.manifestPath, applyEdits(text, edits));

    console.log(summary);

    const surfaceFlags: SurfaceFlags = {
      team: resolved.team,
      dryRun: false,
      packDir: resolved.packDir,
      mattstackDir: bindFlags.mattstackDir,
      manifest: resolved.manifestPath,
      json: false,
    };
    // A stage's bound fills feed every orchestrator's compiled allowed-tools union
    // (stageAllowedToolsFor) -- scoping to `--verb <stage>` would leave every
    // orchestrator's SKILL.md stale, so a stage bind recompiles the whole pack.
    const recompileArgs = rosterVerb ? [...compileArgs(surfaceFlags, resolved.packDir), "--verb", verbName] : compileArgs(surfaceFlags, resolved.packDir);
    await skillsCompile(recompileArgs);
  });
}
