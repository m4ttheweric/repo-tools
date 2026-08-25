import { existsSync } from "fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from "path";
import { assertNoPlaceholders, findPlaceholders, skillDirFor, substitute } from "./placeholders.ts";
import type {
  AttachmentSource,
  CompiledFile,
  CompileResult,
  PlaceholderContext,
  StageEntry,
  StepSource,
  VerbDef,
} from "./types.ts";

const CLAUDE_SKILL_DIR_TOKEN = "${CLAUDE_SKILL_DIR}";
const RESOLVER_RE = /\bresolve-args\.sh\b/;

/** Exported so `rt skills surface` can classify a directory as compiled by checking its SKILL.md body prefix. */
export const HEADER_COMMENT =
  "<!-- compiled by rt skills compile from the sources below; slots pre-resolved; edits here are working-tree drift (rt skills promote) -->";

const SKILL_DIR_PATH_RE = /\$\{CLAUDE_SKILL_DIR\}\/[^\s"'`)]+/g;

/**
 * A `../` path only reads as a body reference when it starts one: the same
 * characters after a slash are the tail of a shell-composed path
 * (`$(dirname "$X")/../forge/…`) whose base is unknown at compile time.
 */
const RELATIVE_PATH_RE = /(?<![^\s("'`[<,])\.\.\/[^\s"'`)]+/g;

/** Vendored assets are addressed from the skill's own directory, so a bare one names an emitted file or nothing at all. */
const BARE_ASSET_RE = /(?<![^\s("'`[<,])(?:scripts|references)\/[^\s"'`)]+/g;

/** Where a compiled verb lands, so a body path can be resolved the way the reading agent will resolve it. */
type CompiledLayout = { packRoot: string; compiledDir: string };

type BodyPath = {
  text: string;
  relPath: string;
  line: number;
  kind: "token" | "relative" | "asset";
  namesFile: boolean;
};

const TRAILING_PUNCTUATION_RE = /[.,;:!?\])]+$/;

/**
 * Prose wraps a path in a sentence and in markdown, so the punctuation trailing
 * it belongs to neither the file name nor the lint message -- except in a `..`
 * segment, whose dots are the path. What is left may name no file at all
 * (`scripts/` in prose, or the compiled `work`'s `${CLAUDE_SKILL_DIR}/../..`
 * pack root in any spelling), and only a named file can be checked against what
 * this compile emits.
 */
function readPath(raw: string): { text: string; namesFile: boolean } {
  const segments = raw.split("/");
  const last = segments.length - 1;
  if (segments[last] === "..") return { text: raw, namesFile: false };
  segments[last] = segments[last]!.replace(TRAILING_PUNCTUATION_RE, "");
  return { text: segments.join("/"), namesFile: segments[last] !== "" };
}

function bodyPaths(body: string): BodyPath[] {
  const out: BodyPath[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(SKILL_DIR_PATH_RE)) {
      const { text, namesFile } = readPath(m[0]);
      out.push({
        text,
        relPath: text.slice(`${CLAUDE_SKILL_DIR_TOKEN}/`.length),
        line: i + 1,
        kind: "token",
        namesFile,
      });
    }
    for (const m of line.matchAll(RELATIVE_PATH_RE)) {
      const { text, namesFile } = readPath(m[0]);
      out.push({ text, relPath: text, line: i + 1, kind: "relative", namesFile });
    }
    for (const m of line.matchAll(BARE_ASSET_RE)) {
      const { text, namesFile } = readPath(m[0]);
      out.push({ text, relPath: text, line: i + 1, kind: "asset", namesFile });
    }
  }
  return out;
}

const SEAM_RE = /^<!-- part: .*\bpath=(\S+) lines=(\d+)-\d+ -->$/;

/**
 * A compiled body is assembled from several files, so its own line numbers name
 * nothing on disk -- and an erroring compile writes no artifact to count in
 * anyway. Every section is introduced by a seam carrying its source path and
 * the line its body starts on, so the nearest seam above a line maps it back.
 */
function sourceCoordinate(lines: string[], line: number): string | null {
  for (let i = line - 2; i >= 0; i--) {
    const seam = lines[i]!.trim().match(SEAM_RE);
    if (!seam) continue;
    const seamLine = i + 1;
    // A seam pushed as its own section has a blank line under it; one substituted
    // in place by a placeholder sits directly above its body.
    const firstBodyLine = seamLine + (lines[seamLine]?.trim() === "" ? 2 : 1);
    return `${seam[1]}:${Number(seam[2]) + (line - firstBodyLine)}`;
  }
  return null;
}

function escapesPackRoot(layout: CompiledLayout, relPath: string): boolean {
  const rel = relativePath(layout.packRoot, resolvePath(layout.compiledDir, relPath));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * A `../` read the pack can actually satisfy is a sibling reference, not a
 * dangling one: either something already in the working tree, or the output dir
 * of another target in this compile, which may not be written yet.
 *
 * Reading the working tree makes this lint state-dependent -- `compile` and
 * `check` can disagree across a file add or removal, and a scoped `--verb` run
 * has fewer target dirs to match against than a whole-pack run.
 */
function packSatisfies(layout: CompiledLayout, relPath: string, emittedTargetDirs: string[]): boolean {
  const abs = resolvePath(layout.compiledDir, relPath);
  if (existsSync(abs)) return true;
  return emittedTargetDirs.some((dir) => {
    const target = resolvePath(dir);
    return abs === target || abs.startsWith(`${target}${sep}`);
  });
}

/** rt's own namespace, always linted even when no pack is installed. */
const OWN_NAMESPACE = "mattstack";

/**
 * Namespaces are the ones this compilation knows about — rt's own, whatever the
 * roster names, and the packs supplying the fills — rather than a fixed list.
 * The fills matter: a body referencing its own pack's binding must still warn
 * when that binding is missing from the roster, and the pack is not in the
 * roster to be discovered from.
 *
 * A hard-coded alternation only ever linted the teams someone thought to add,
 * so any other pack went unchecked, and it put specific team names in the
 * source of a general-purpose tool.
 */
function registeredNameRe(...sources: Iterable<string>[]): RegExp {
  const namespaces = new Set<string>([OWN_NAMESPACE]);
  for (const source of sources) {
    for (const token of source) {
      const ns = token.split(":")[0];
      if (ns && /^[a-z][a-z0-9-]*$/.test(ns)) namespaces.add(ns);
    }
  }
  // Longest first so `acme-dev:` cannot be shadowed by a shorter `acme:`.
  const alternation = [...namespaces].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`\\b(?:${alternation}):[a-z][a-z0-9-]*\\b`, "g");
}

type BoundSlot = { slotName: string; fill: AttachmentSource };

/**
 * Registered-and-public is the only case that stays a reference instead of
 * being vendored into the compiled body -- everything else (unregistered
 * attachments, and registered-but-still-internal fills mid surface
 * transition) inlines. Exported so callers outside the compiler (composition
 * reporting) can't drift from this rule by re-deriving it.
 */
export function isInlined(fill: AttachmentSource, internalRoster: Set<string>): boolean {
  return !fill.registered || internalRoster.has(fill.binding);
}

function rewriteSkillDirRefs(text: string, slotName: string): string {
  return text.split(CLAUDE_SKILL_DIR_TOKEN).join(`${CLAUDE_SKILL_DIR_TOKEN}/parts/${slotName}`);
}

function dedupePreserveOrder(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Shared by both seam kinds so the step and slot formats cannot drift apart. */
function span(src: { srcPath: string; bodyStartLine: number; body: string }): string {
  const lines = src.body.split("\n").length;
  return `path=${src.srcPath} lines=${src.bodyStartLine}-${src.bodyStartLine + lines - 1}`;
}

function resolveBoundSlots(
  verb: VerbDef,
  step: StepSource,
  fills: Record<string, AttachmentSource | null>,
): BoundSlot[] {
  const boundSlots: BoundSlot[] = [];

  for (const slotName of Object.keys(step.slots)) {
    const spec = step.slots[slotName];
    if (!spec) continue;
    const fill = fills[slotName] ?? null;

    if (fill === null) {
      if (spec.required) {
        throw new Error(
          `verb "${verb.name}": slot "${slotName}" requires contract "${spec.contract}" but is unbound`,
        );
      }
      continue;
    }

    if (fill.provides !== spec.contract) {
      throw new Error(
        `verb "${verb.name}": slot "${slotName}" requires contract "${spec.contract}" but binding "${fill.binding}" provides "${fill.provides}"`,
      );
    }

    boundSlots.push({ slotName, fill });
  }

  return boundSlots;
}

/** Union'd stage rules carry `${CLAUDE_SKILL_DIR}` from the stage that declared them; the orchestrator has no single stage dir, so it needs the leading-wildcard form instead. */
function toWildcardRule(rule: string): string {
  const prefix = `${CLAUDE_SKILL_DIR_TOKEN}/`;
  const at = rule.indexOf(prefix);
  if (at < 0) return rule;
  return rule.slice(0, at) + "*/" + rule.slice(at + prefix.length);
}

function buildAllowedTools(
  step: StepSource,
  boundSlots: BoundSlot[],
  stageRules: string[],
  ctx: PlaceholderContext,
): string[] {
  const entries = [
    ...step.allowedTools,
    ...boundSlots.flatMap(({ slotName, fill }) =>
      fill.allowedTools.map((tool) => tool.split(CLAUDE_SKILL_DIR_TOKEN).join(skillDirFor(fill, ctx, slotName))),
    ),
    ...stageRules.map(toWildcardRule),
  ];
  return dedupePreserveOrder(entries);
}

function buildFrontmatter(verb: VerbDef, allowedTools: string[], compiledParts: string[]): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${yamlQuote(verb.name)}`);
  lines.push(`description: ${yamlQuote(verb.description)}`);
  if (allowedTools.length > 0) {
    lines.push("allowed-tools:");
    for (const tool of allowedTools) {
      lines.push(`  - ${yamlQuote(tool)}`);
    }
  }
  lines.push("metadata:");
  lines.push(`  compiled: ${yamlQuote(compiledParts.join(" + "))}`);
  lines.push("---");
  return lines.join("\n");
}

type BuildOpts = {
  internalRoster: Set<string>;
  ctx: PlaceholderContext | null;
  stageDir: string | null;
};

/**
 * PLACEHOLDER_RE only recognizes well-formed markers, so a malformed one
 * (empty arg, internal whitespace, an uppercase kind) never shows up in
 * findPlaceholders/assertNoPlaceholders -- it must be caught by scanning for
 * the literal token instead, or it ships verbatim in the compiled body.
 */
function firstBraceLine(body: string): number | null {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes("{{")) return i + 1;
  }
  return null;
}

function assertNoStrayBraces(body: string, engineName: string): void {
  const line = firstBraceLine(body);
  if (line !== null) {
    throw new Error(
      `engine "${engineName}": literal "{{" near line ${line} -- "{{" is reserved for compiler placeholders and has no escape, so a compiled body may not contain it`,
    );
  }
}

function buildBody(step: StepSource, boundSlots: BoundSlot[], opts: BuildOpts): { body: string; notes: string[] } {
  const notes: string[] = [];
  const sections: string[] = [HEADER_COMMENT];
  sections.push(`<!-- part: step source=${step.plugin}:${step.name} version=${step.version} ${span(step)} -->`);

  // A stage's own scripts live beside it, not at the orchestrator's ${CLAUDE_SKILL_DIR}; fill/include
  // bodies are rewritten separately by `substitute` via partsPrefix, so this rewrite must not touch them.
  let stepBody = step.body;
  if (opts.stageDir) stepBody = stepBody.split(`${CLAUDE_SKILL_DIR_TOKEN}/`).join(`${opts.stageDir}/`);

  const compileNative = findPlaceholders(stepBody).length > 0;
  if (compileNative) {
    if (RESOLVER_RE.test(stepBody)) {
      throw new Error(`engine "${step.name}": compile-native engine calls the runtime resolver (resolve-args.sh)`);
    }
    if (!opts.ctx) throw new Error(`engine "${step.name}": placeholders present but no placeholder context`);
    const { body, used } = substitute(stepBody, opts.ctx, step.name);
    assertNoPlaceholders(body, step.name);
    assertNoStrayBraces(body, step.name);
    for (const { slotName } of boundSlots) {
      if (!used.slots.includes(slotName)) notes.push(`slot "${slotName}" is bound but never placed in the body`);
    }
    sections.push(body);
    return { body: sections.join("\n\n"), notes };
  }

  assertNoStrayBraces(stepBody, step.name);
  sections.push(stepBody);
  for (const { slotName, fill } of boundSlots) {
    if (!isInlined(fill, opts.internalRoster)) {
      // Registered, surface-public skills stay singly-canonical: reference, never inline.
      sections.push(
        `Slot ${slotName} is bound to \`${fill.binding}\` (${fill.binding}@${fill.version}) -- invoke that skill when this flow needs it.`,
      );
      continue;
    }

    if (fill.registered) {
      // Transition window: the file already lives under skills/ but surface.jsonc
      // has not declared it public yet -- inline so the compiled output stays correct.
      notes.push(`note: ${fill.binding} is surface-internal; inlined`);
    }

    sections.push(
      `<!-- part: slot:${slotName} binding=${fill.binding} version=${fill.version} ${span(fill)} -->`,
    );
    sections.push(rewriteSkillDirRefs(fill.body, slotName));
  }

  return { body: sections.join("\n\n"), notes };
}

function buildVendoredFiles(
  step: StepSource,
  boundSlots: BoundSlot[],
  includes: Record<string, AttachmentSource>,
): CompiledFile[] {
  const files: CompiledFile[] = [];

  for (const entry of step.stepFiles) {
    files.push({ path: entry, copyFrom: `${step.dir}/${entry}` });
  }

  for (const { slotName, fill } of boundSlots) {
    for (const entry of fill.extraFiles) {
      files.push({ path: `parts/${slotName}/${entry}`, copyFrom: `${fill.dir}/${entry}` });
    }
  }

  for (const [name, inc] of Object.entries(includes)) {
    for (const entry of inc.extraFiles) {
      files.push({ path: `parts/include-${name}/${entry}`, copyFrom: `${inc.dir}/${entry}` });
    }
  }

  return files;
}

function isCompilerCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === HEADER_COMMENT || trimmed.startsWith("<!-- part: ");
}

// Seam/header comments carry deliberately non-invocable names (e.g. an internal
// attachment's binding); only author prose is lint material.
function stripCompilerComments(body: string): string {
  return body
    .split("\n")
    .filter((line) => !isCompilerCommentLine(line))
    .join("\n");
}

/**
 * Paths are judged from the compiled skill's own directory, which is where the
 * reading agent resolves them: a path that leaves the pack root cannot be read
 * at run time (the pack is what ships), while one that stays inside may name a
 * sibling compiled target, so it only warns.
 */
function lintReferences(
  body: string,
  roster: Set<string>,
  files: CompiledFile[],
  known: Iterable<string>,
  opts: {
    where: string;
    exemptPrefixes?: string[];
    layout?: CompiledLayout | null;
    emittedTargetDirs?: string[];
  },
): string[] {
  const warnings: string[] = [];
  const lintableBody = stripCompilerComments(body);
  const exemptPrefixes = opts.exemptPrefixes ?? [];
  const emittedTargetDirs = opts.emittedTargetDirs ?? [];

  const seenNames = new Set<string>();
  for (const match of lintableBody.matchAll(registeredNameRe(roster, known))) {
    const token = match[0];
    if (seenNames.has(token)) continue;
    seenNames.add(token);
    if (!roster.has(token)) {
      warnings.push(`body references ${token} which is not invocable`);
    }
  }

  const emittedPaths = new Set(files.map((f) => f.path));
  const seenPaths = new Set<string>();
  // Paths are scanned in the unstripped body because the seam comments are what
  // map an offending line back to its source file; only names are lint material.
  const bodyLines = body.split("\n");
  for (const { text, relPath, line, kind, namesFile } of bodyPaths(body)) {
    if (opts.layout && escapesPackRoot(opts.layout, relPath)) {
      const at = sourceCoordinate(bodyLines, line) ?? `compiled body line ${line}`;
      throw new Error(`${opts.where}: "${text}" at ${at} resolves outside the pack root`);
    }
    if (!namesFile || seenPaths.has(text)) continue;
    seenPaths.add(text);
    if (kind === "token" && exemptPrefixes.some((p) => text.startsWith(p))) continue;
    if (kind === "relative" && opts.layout && packSatisfies(opts.layout, relPath, emittedTargetDirs)) continue;
    if (!emittedPaths.has(relPath)) {
      warnings.push(
        kind === "asset"
          ? `bare path ${text} is not an emitted file`
          : `body references ${text} which is not an emitted file`,
      );
    }
  }

  return warnings;
}

function lintInternalRoster(text: string, internalRoster: Set<string>, where: string): string[] {
  const errors: string[] = [];
  const lintableText = stripCompilerComments(text);

  const seenNames = new Set<string>();
  for (const match of lintableText.matchAll(registeredNameRe(internalRoster))) {
    const token = match[0];
    if (seenNames.has(token)) continue;
    seenNames.add(token);
    if (internalRoster.has(token)) {
      errors.push(
        `${where} references ${token} which is surface-internal; inline it, reference it by path, or list it in surface.jsonc's public array`,
      );
    }
  }

  return errors;
}

export function compileSkill(
  verb: VerbDef,
  step: StepSource,
  fills: Record<string, AttachmentSource | null>,
  roster: Set<string>,
  opts: {
    internalRoster?: Set<string>;
    includes?: Record<string, AttachmentSource>;
    pipelines?: Record<string, StageEntry[]>;
    repoKey?: string;
    mattstackSha?: string;
    mattstackDirty?: 0 | 1;
    packSha?: string;
    stageDir?: string | null;
    stageAllowedTools?: string[];
    emittedSiblingDirs?: string[];
    packRoot?: string;
    compiledDir?: string;
    emittedTargetDirs?: string[];
    /** How the caller names this target in errors -- `stage "x"` for a pipeline stage. */
    where?: string;
  } = {},
): CompileResult {
  const internalRoster = opts.internalRoster ?? new Set<string>();
  const boundSlots = resolveBoundSlots(verb, step, fills);

  const compiledParts = [
    `${step.plugin}@${step.version}`,
    ...boundSlots.map(({ fill }) => `${fill.binding}@${fill.version}`),
  ];
  const compiledFrom = compiledParts.join(" + ");

  const slotMode: Record<string, "inline" | "reference"> = {};
  for (const { slotName, fill } of boundSlots) {
    slotMode[slotName] = isInlined(fill, internalRoster) ? "inline" : "reference";
  }
  const partsPrefix = opts.stageDir ? `${opts.stageDir}/parts` : `${CLAUDE_SKILL_DIR_TOKEN}/parts`;

  const ctx: PlaceholderContext = {
    fills,
    slotMode,
    partsPrefix,
    includes: opts.includes ?? {},
    pipelines: opts.pipelines ?? {},
    repoKey: opts.repoKey ?? "",
    mattstackSha: opts.mattstackSha ?? "",
    mattstackDirty: opts.mattstackDirty ?? 0,
    packSha: opts.packSha ?? "",
    stageDir: opts.stageDir ?? null,
    stageMeta: step.stageMeta,
    compiledFrom,
  };

  const allowedTools = buildAllowedTools(step, boundSlots, opts.stageAllowedTools ?? [], ctx);
  const { body, notes } = buildBody(step, boundSlots, {
    internalRoster,
    ctx,
    stageDir: opts.stageDir ?? null,
  });
  const frontmatter = buildFrontmatter(verb, allowedTools, compiledParts);
  const content = `${frontmatter}\n\n${body}\n`;

  const files: CompiledFile[] = [
    { path: "SKILL.md", content },
    ...buildVendoredFiles(step, boundSlots, opts.includes ?? {}),
  ];

  const fillBindings = boundSlots.map(({ fill }) => fill.binding);
  const layout = opts.packRoot && opts.compiledDir
    ? { packRoot: opts.packRoot, compiledDir: opts.compiledDir }
    : null;
  const warnings = [
    ...lintReferences(body, roster, files, fillBindings, {
      where: opts.where ?? `verb "${verb.name}"`,
      exemptPrefixes: opts.emittedSiblingDirs ?? [],
      layout,
      emittedTargetDirs: opts.emittedTargetDirs ?? [],
    }),
    ...notes,
  ];
  const errors = [
    ...lintInternalRoster(body, internalRoster, "body"),
    ...lintInternalRoster(verb.description, internalRoster, "description"),
  ];

  return { files, warnings, errors };
}
