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

import { execFileSync, spawnSync } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { createInterface } from "node:readline";
import { dirname, join } from "path";
import { resolveFzf } from "../lib/fzf.ts";
import { mattstackHome } from "../lib/rt-paths.ts";
import { compileSkill, HEADER_COMMENT } from "../lib/skills/compile.ts";
import {
  invocableRoster,
  loadAttachment,
  loadStepSource,
  readManifestBindings,
  readSurface,
  readVerbRoster,
  resolvePluginRoots,
  stripFrontmatter,
  type PluginRoots,
  type SurfaceConfig,
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
  let team = "claimview";
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
  surface: SurfaceConfig | null;
  internalRoster: Set<string>;
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
  for (const name of listSubdirs(join(packDir, "skills"))) {
    if (!publicSet.has(name)) internal.add(`${team}:${name}`);
  }
  for (const name of listSubdirs(join(packDir, "attachments"))) {
    if (!publicSet.has(name)) internal.add(`${team}:${name}`);
  }
  for (const verb of fullRoster) {
    if (!publicSet.has(verb.name)) internal.add(`${team}:${verb.name}`);
  }
  return internal;
}

function resolve(flags: Flags): Resolved {
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  const packDir = flags.packDir ?? packRootDir(mattstackRoot, flags.team);
  const manifestPath = flags.manifest ?? findDefaultManifest(mattstackRoot, flags.team);

  const fullRoster = readVerbRoster(packDir);
  const roster = selectVerbs(fullRoster, flags.verbs);
  const bindings = readManifestBindings(manifestPath);
  const pluginRoots = flags.mattstackDir ? resolvePluginRootsFromDir(mattstackRoot) : resolvePluginRoots();
  const invocable = invocableRoster(pluginRoots);
  const surface = readSurface(packDir);
  const internalRoster = computeInternalRoster(flags.team, packDir, surface, fullRoster);

  return { packDir, roster, bindings, pluginRoots, invocable, surface, internalRoster };
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
    return compileSkill(verb, step, fills, resolved.invocable, { internalRoster: resolved.internalRoster });
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
    const publicSet = resolved.surface ? new Set(resolved.surface.public) : null;

    for (const verb of resolved.roster) {
      const outDir = join(resolved.packDir, "skills", verb.name);

      if (publicSet && !publicSet.has(verb.name)) {
        console.log(`internal: ${verb.name} (not compiled; roster entry retired)`);
        if (!flags.dryRun && existsSync(outDir)) {
          rmSync(outDir, { recursive: true, force: true });
        }
        continue;
      }

      const result = compileVerb(verb, resolved);
      if (result.errors.length > 0) {
        throw new SkillsUsageError(`verb "${verb.name}": ${result.errors.join("; ")}`);
      }

      if (flags.dryRun) {
        console.log(`would write ${result.files.length} files for ${verb.name}`);
        for (const warning of result.warnings) console.log(`  ${warning}`);
        continue;
      }

      writeCompiledVerb(outDir, result);
      console.log(`compiled ${verb.name} (${result.files.length} files, ${result.warnings.length} warnings)`);
      for (const warning of result.warnings) console.log(`  ${warning}`);
    }

    if (publicSet) {
      for (const name of listSubdirs(join(resolved.packDir, "skills"))) {
        if (!publicSet.has(name)) {
          console.log(`misplaced: ${name} (run rt skills surface apply, or move it)`);
          process.exitCode = 1;
        }
      }
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

// ─── rt skills surface -- list / set / apply / fzf palette ────────────────

type SurfaceFlags = {
  team: string;
  dryRun: boolean;
  packDir: string | null;
  mattstackDir: string | null;
  manifest: string | null;
};

type SurfaceRow = { name: string; kind: "compiled" | "hand-authored"; status: "public" | "internal" };

function parseSurfaceFlags(args: string[]): { flags: SurfaceFlags; rest: string[] } {
  let team = "claimview";
  let dryRun = false;
  let packDir: string | null = null;
  let mattstackDir: string | null = null;
  let manifest: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--team": team = args[++i] ?? team; break;
      case "--dry-run": dryRun = true; break;
      case "--pack-dir": packDir = args[++i] ?? null; break;
      case "--mattstack-dir": mattstackDir = args[++i] ?? null; break;
      case "--manifest": manifest = args[++i] ?? null; break;
      default: rest.push(a);
    }
  }

  return { flags: { team, dryRun, packDir, mattstackDir, manifest }, rest };
}

function resolveSurfacePaths(flags: SurfaceFlags): { packDir: string } {
  const mattstackRoot = flags.mattstackDir ?? mattstackHome();
  const packDir = flags.packDir ?? packRootDir(mattstackRoot, flags.team);
  return { packDir };
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
  const skillsNames = new Set(listSubdirs(join(packDir, "skills")));
  const attachmentNames = new Set(listSubdirs(join(packDir, "attachments")));
  const allNames = new Set<string>([...skillsNames, ...attachmentNames, ...verbNames]);
  return { skillsNames, attachmentNames, allNames };
}

/** The set `set`'s first use bootstraps surface.jsonc from -- so the first edit is a delta from reality, not a cliff. */
function defaultPublicSet(skillsNames: Set<string>, verbNames: Set<string>): Set<string> {
  return new Set<string>([...skillsNames, ...verbNames]);
}

function computeRows(
  packDir: string,
  verbNames: Set<string>,
  surface: SurfaceConfig | null,
): { source: string; rows: SurfaceRow[] } {
  const { skillsNames, attachmentNames, allNames } = collectRegistry(packDir, verbNames);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);
  const source = surface
    ? "pack/surface.jsonc"
    : "(no surface.jsonc yet -- inferred from current skills/ + stubs.jsonc placement)";

  const rows = [...allNames].sort().map((name) => {
    const dir = skillsNames.has(name)
      ? join(packDir, "skills", name)
      : attachmentNames.has(name)
        ? join(packDir, "attachments", name)
        : null;
    return {
      name,
      kind: classify(name, dir, verbNames),
      status: (publicSet.has(name) ? "public" : "internal") as "public" | "internal",
    };
  });

  return { source, rows };
}

function writeSurfaceConfig(packDir: string, publicList: string[]): void {
  const path = join(packDir, "pack", "surface.jsonc");
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify({ public: publicList }, null, 2);
  writeFileSync(path, `// surface.jsonc -- names this pack's public skills/ directories.\n${json}\n`);
}

function compileArgs(flags: SurfaceFlags, packDir: string): string[] {
  const args = ["--team", flags.team, "--pack-dir", packDir];
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

/** git mv keeps rename history for the common case; fixtures (and any non-git pack dir) fall back to a plain rename. */
function moveHandAuthoredDir(packDir: string, name: string, from: "skills" | "attachments", to: "skills" | "attachments"): string | null {
  const fromRel = join(from, name);
  const toRel = join(to, name);
  mkdirSync(join(packDir, to), { recursive: true });

  if (isInsideGitWorkTree(packDir)) {
    execFileSync("git", ["mv", fromRel, toRel], { cwd: packDir, stdio: "pipe" });
    return null;
  }

  renameSync(join(packDir, fromRel), join(packDir, toRel));
  return "plain rename -- pack dir is not a git repo";
}

function printSurfaceRows(flags: SurfaceFlags, source: string, rows: SurfaceRow[]): void {
  console.log(`rt skills surface -- team ${flags.team}`);
  console.log(`source: ${source}`);
  for (const row of rows) {
    console.log(`  ${row.status.padEnd(9)}${row.kind.padEnd(15)}${row.name}`);
  }
}

async function runList(flags: SurfaceFlags): Promise<void> {
  const { packDir } = resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const { source, rows } = computeRows(packDir, verbNames, surface);

  printSurfaceRows(flags, source, rows);
  if (rows.length === 0) console.log("(no skills registered in this pack)");
}

async function runApply(flags: SurfaceFlags): Promise<void> {
  const { packDir } = resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const { skillsNames, attachmentNames } = collectRegistry(packDir, verbNames);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);

  const candidates = [...new Set<string>([...skillsNames, ...attachmentNames])].sort();
  let moved = 0;

  for (const name of candidates) {
    const currentlyUnderSkills = skillsNames.has(name);
    const dir = join(packDir, currentlyUnderSkills ? "skills" : "attachments", name);
    if (classify(name, dir, verbNames) === "compiled") continue; // regenerated/removed by the compile step below, never git-mv'd

    const wantPublic = publicSet.has(name);
    if (currentlyUnderSkills === wantPublic) continue;

    const from = currentlyUnderSkills ? "skills" : "attachments";
    const to = currentlyUnderSkills ? "attachments" : "skills";
    moved++;

    if (flags.dryRun) {
      console.log(`would move ${name}: ${from}/ -> ${to}/`);
      continue;
    }

    const note = moveHandAuthoredDir(packDir, name, from, to);
    console.log(`moved ${name}: ${from}/ -> ${to}/${note ? ` (${note})` : ""}`);
  }

  if (moved === 0) console.log("no moves needed");

  await skillsCompile(compileArgs(flags, packDir));
}

async function runSet(name: string, want: "public" | "internal", flags: SurfaceFlags): Promise<void> {
  const { packDir } = resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const { skillsNames, allNames } = collectRegistry(packDir, verbNames);

  if (!allNames.has(name)) {
    throw new SkillsUsageError(
      `"${name}" is not a known skill or verb in this pack (checked skills/, attachments/, stubs.jsonc)`,
    );
  }

  const surface = readSurface(packDir);
  const publicSet = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);

  if (want === "public") publicSet.add(name);
  else publicSet.delete(name);

  writeSurfaceConfig(packDir, [...publicSet].sort());
  console.log(`${name}: ${want}`);

  await runApply(flags);
}

export type SurfaceDelta = { toPublic: string[]; toInternal: string[] };

export type PaletteAction =
  | { kind: "no-changes" }
  | { kind: "write"; delta: SurfaceDelta }
  | { kind: "declined"; delta: SurfaceDelta };

/**
 * Pure decision seam for the palette's accept path -- fzf's default --multi
 * semantics emit the cursor row on Enter even when nothing is marked, so a
 * deliberate "uncheck everything" can silently reintroduce one row. Called
 * once (confirmed=false) to compute the delta for the pre-write preview, and
 * again with the real answer once the user has seen it.
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
  const { packDir } = resolveSurfacePaths(flags);
  const verbNames = new Set(readVerbRoster(packDir).map((v) => v.name));
  const surface = readSurface(packDir);
  const { skillsNames } = collectRegistry(packDir, verbNames);
  const previousPublic = surface ? new Set(surface.public) : defaultPublicSet(skillsNames, verbNames);
  const { source, rows } = computeRows(packDir, verbNames, surface);

  if (rows.length === 0) {
    console.log("(no skills registered in this pack)");
    return;
  }

  const fzfPath = resolveFzf();
  if (!fzfPath || !process.stdin.isTTY) {
    printSurfaceRows(flags, source, rows);
    console.log("");
    console.log("no tty or fzf not found -- edit one at a time: rt skills surface set <name> --public|--internal");
    return;
  }

  const preselected = rows
    .map((row, i) => (row.status === "public" ? i + 1 : null))
    .filter((i): i is number => i !== null);
  const loadBind = preselected.length
    ? `load:${preselected.map((pos) => `pos(${pos})+toggle`).join("+")}+pos(1)`
    : "load:pos(1)";

  const input = rows
    .map((row) => `${row.name}\t${row.status.padEnd(9)}${row.kind.padEnd(15)}${row.name}`)
    .join("\n");

  const result = spawnSync(
    "fzf",
    [
      "--multi",
      "--with-nth=2..",
      "--delimiter=\t",
      "--layout=reverse",
      "--border=rounded",
      "--border-label= rt skills surface ",
      "--prompt=  filter: ",
      "--header=space: toggle public  tab: toggle+next  enter: review changes  esc: cancel",
      "--no-mouse",
      "--bind=space:toggle,tab:toggle+down",
      `--bind=${loadBind}`,
    ],
    { input, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.log("cancelled -- no changes made");
    return;
  }

  const selectedSet = new Set(
    (result.stdout ?? "")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split("\t")[0]!)
      .filter(Boolean),
  );

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
      const name = args[1];
      if (!name || name.startsWith("--")) {
        throw new SkillsUsageError("set requires a skill name: rt skills surface set <name> --public|--internal");
      }
      const { flags, rest } = parseSurfaceFlags(args.slice(2));
      let want: "public" | "internal" | null = null;
      for (const a of rest) {
        if (a === "--public") want = "public";
        else if (a === "--internal") want = "internal";
        else throw new SkillsUsageError(`unrecognized argument "${a}"`);
      }
      if (!want) throw new SkillsUsageError("set requires --public or --internal");
      await runSet(name, want, flags);
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
