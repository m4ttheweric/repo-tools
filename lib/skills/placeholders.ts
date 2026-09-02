import { existsSync, statSync } from "fs";
import { join } from "path";
import type { AttachmentSource, PlaceholderContext, StageEntry } from "./types.ts";

export type Placeholder = { kind: string; arg: string | null; line: number; raw: string };

const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9.-]*)(?::([^}\s]+))?\}\}/g;

export function findPlaceholders(body: string): Placeholder[] {
  const out: Placeholder[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(PLACEHOLDER_RE)) {
      out.push({ kind: m[1]!, arg: m[2] ?? null, line: i + 1, raw: m[0] });
    }
  }
  return out;
}

export function assertNoPlaceholders(body: string, where: string): void {
  const first = findPlaceholders(body)[0];
  if (first) throw new Error(`${where}: unfilled placeholder ${first.raw} at line ${first.line}`);
}

function spanOf(src: { srcPath: string; bodyStartLine: number; body: string }): string {
  const lines = src.body.split("\n").length;
  return `path=${src.srcPath} lines=${src.bodyStartLine}-${src.bodyStartLine + lines - 1}`;
}

function fenced(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

const SKILL_DIR_TOKEN = "${CLAUDE_SKILL_DIR}";

/**
 * A parts dir is only emitted for a source that vendors files, so a source
 * without any keeps the host skill's own directory -- rewriting to a parts dir
 * that will never exist leaves every runtime use of the token dangling.
 * Exported because a fill's `allowed-tools` rules must land on the same
 * directory its body does, or the frontmatter grants a path the body never names.
 */
export function skillDirFor(source: AttachmentSource, ctx: PlaceholderContext, partsName: string): string {
  if (source.extraFiles.length > 0) return `${ctx.partsPrefix}/${partsName}`;
  return ctx.stageDir ?? SKILL_DIR_TOKEN;
}

function slotText(name: string, fill: AttachmentSource | null, mode: "inline" | "reference", ctx: PlaceholderContext, packPaths: string[]): string {
  if (fill === null) return "";
  if (mode === "reference") {
    return `Slot ${name} is bound to \`${fill.binding}\` (${fill.binding}@${fill.version}) -- invoke that skill when this flow needs it.`;
  }
  const rewritten = fill.body.split(SKILL_DIR_TOKEN).join(skillDirFor(fill, ctx, name));
  const inlined = substituteIncludesOnly(rewritten, ctx, fill.binding);
  packPaths.push(...inlined.packPaths);
  return `<!-- part: slot:${name} binding=${fill.binding} version=${fill.version} ${spanOf(fill)} -->\n${inlined.body}`;
}

function includeText(name: string, inc: AttachmentSource, ctx: PlaceholderContext): string {
  const body = inc.body.split(SKILL_DIR_TOKEN).join(skillDirFor(inc, ctx, `include-${name}`));
  return `<!-- part: include:${name} source=${inc.plugin}:${name} version=${inc.version} ${spanOf(inc)} -->\n${body}`;
}

/**
 * loadInclude enforces that an include target is itself slotless and
 * placeholder-free, so a fill body carrying {{include}} lines cannot recurse --
 * `where` is the fill's own binding, matching how a step body names itself.
 */
export function substituteIncludesOnly(body: string, ctx: PlaceholderContext, where: string): { body: string; packPaths: string[] } {
  const packPaths: string[] = [];
  const out = body.split("\n").map((line, i) =>
    line.replace(PLACEHOLDER_RE, (raw, kind: string, arg?: string) => {
      switch (kind) {
        case "include": {
          if (line.trim() !== raw) throw new Error(`${where}: ${raw} must be alone on its line (line ${i + 1})`);
          const inc = arg ? ctx.includes[arg] : undefined;
          if (!arg || !inc) throw new Error(`${where}: include "${arg}" is not a loaded attachment`);
          return includeText(arg, inc, ctx);
        }
        case "verb.path": return verbPath(ctx, arg, raw, where);
        case "pack.path": {
          const rendered = packPath(ctx, arg, raw, where);
          packPaths.push(rendered);
          return rendered;
        }
        default:
          throw new Error(`${where}: ${raw} -- a fill may carry {{include}}, {{verb.path}} or {{pack.path}} only (line ${i + 1})`);
      }
    }),
  );
  return { body: out.join("\n"), packPaths };
}

function workTypeText(pipelines: Record<string, StageEntry[]>, where: string): string {
  const types = Object.keys(pipelines);
  if (types.length === 0) throw new Error(`${where}: {{work-type}} cannot be filled -- the manifest declares no pipelines`);
  if (types.length === 1) return `The work type is \`${types[0]}\`. Continue.`;
  const menu = types.map((t) => `- \`${t}\``).join("\n");
  return `This pack declares several work types:\n\n${menu}\n\nAsk one structured question to pick one, then use that key in the stage list and run-start flags below.`;
}

const VERB_NAME_RE = /^[a-z][a-z0-9-]*$/;

function runStartFlags(ctx: PlaceholderContext, arg: string | undefined, raw: string, where: string): string {
  // run-start's flag parser takes the token after a flag as its value, so an empty
  // sha must drop the flag entirely rather than leave `--mattstack-dirty` as the value.
  const sha = ctx.mattstackSha ? ` --mattstack-sha ${ctx.mattstackSha}` : "";
  const pack = ctx.packSha ? ` --pack-sha ${ctx.packSha}` : "";
  const tail = `${sha} --mattstack-dirty ${ctx.mattstackDirty}${pack}`;
  if (arg !== undefined) {
    if (!VERB_NAME_RE.test(arg)) throw new Error(`${where}: ${raw} -- verb must match [a-z][a-z0-9-]*`);
    return fenced({ [arg]: `--repo ${ctx.repoKey} --work-type ${arg} --pipeline ${arg}${tail}` });
  }
  const out: Record<string, string> = {};
  for (const t of Object.keys(ctx.pipelines)) {
    out[t] = `--repo ${ctx.repoKey} --work-type ${t} --pipeline ${t}${tail}`;
  }
  return fenced(out);
}

/** A reading path from the current output file to a sibling target's SKILL.md: relative to this file, never a shell path. */
function verbPath(ctx: PlaceholderContext, arg: string | undefined, raw: string, where: string): string {
  if (arg === undefined || !VERB_NAME_RE.test(arg)) throw new Error(`${where}: ${raw} -- verb name must match [a-z][a-z0-9-]*`);
  const side = ctx.verbSides[arg];
  if (!side) throw new Error(`${where}: ${raw} -- ${arg} is not a compiled verb of this pack`);
  return side === ctx.side ? `../${arg}/SKILL.md` : `../../${side}/${arg}/SKILL.md`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Anchored on the invoking skill's dir rather than this file's, so the same
 * text works inside a shell command from any public skill in the pack. A
 * compiled target's output is written only after every target compiles, so
 * naming one would pass the existence check on a recompile and fail on a
 * clean one; only pack-authored source is addressable.
 */
function packPath(ctx: PlaceholderContext, arg: string | undefined, raw: string, where: string): string {
  const slash = arg?.indexOf("/") ?? -1;
  if (!arg || slash <= 0 || slash === arg.length - 1) throw new Error(`${where}: ${raw} -- pack.path takes <attachment>/<file>`);
  const attachment = arg.slice(0, slash);
  const file = arg.slice(slash + 1);
  if (!VERB_NAME_RE.test(attachment)) throw new Error(`${where}: ${raw} -- <attachment> must match [a-z][a-z0-9-]*`);
  if (file.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`${where}: ${raw} -- <file> may not contain "..", "." or empty segments`);
  }
  if (attachment in ctx.verbSides) throw new Error(`${where}: ${raw} -- ${attachment} is a compiled verb; pack.path names source files only`);
  const packRoot = ctx.packRoot;
  if (!packRoot) throw new Error(`${where}: ${raw} -- pack.path needs a pack root`);
  const sides = (["attachments", "skills"] as const).filter((side) => isDirectory(join(packRoot, side, attachment)));
  if (sides.length === 2) throw new Error(`${where}: ${raw} -- ${attachment} exists under both attachments/ and skills/`);
  const side = sides[0];
  if (!side) throw new Error(`${where}: ${raw} -- ${attachment} is not a directory under attachments/ or skills/`);
  const rel = `${side}/${attachment}/${file}`;
  if (!existsSync(join(packRoot, rel))) throw new Error(`${where}: ${raw} -- ${rel} does not exist`);
  return `${SKILL_DIR_TOKEN}/../../${rel}`;
}

function stageFields(meta: NonNullable<PlaceholderContext["stageMeta"]>): string {
  const q = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
  const consume = meta.consumes.length ? `You consume ${q(meta.consumes)}.` : "You consume nothing.";
  const produce = meta.produces.length ? `You must produce ${q(meta.produces)}.` : "You produce nothing.";
  return `${consume} ${produce}`;
}

export type Used = { slots: string[]; includes: string[]; packPaths: string[] };

// Global-regex `.replace` resets `lastIndex` per call, so PLACEHOLDER_RE is safe to share with findPlaceholders.
function substituteLine(line: string, i: number, ctx: PlaceholderContext, where: string, used: Used): string {
  return line.replace(PLACEHOLDER_RE, (raw, kind: string, arg?: string) => {
    // The console's parser and stripCompilerComments both require a slot/include
    // seam marker to start a line, so the placeholder that produces it must be
    // alone on its own line too -- an inline one would emit a marker neither
    // recognizes, turning a legitimate binding into unstrippable lint material.
    switch (kind) {
      case "slot": {
        if (line.trim() !== raw) throw new Error(`${where}: ${raw} must be alone on its line (line ${i + 1})`);
        if (!arg) throw new Error(`${where}: ${raw} needs a slot name`);
        if (!(arg in ctx.fills)) throw new Error(`${where}: slot "${arg}" is not declared by this engine`);
        used.slots.push(arg);
        return slotText(arg, ctx.fills[arg] ?? null, ctx.slotMode[arg] ?? "inline", ctx, used.packPaths);
      }
      case "include": {
        if (line.trim() !== raw) throw new Error(`${where}: ${raw} must be alone on its line (line ${i + 1})`);
        const inc = arg ? ctx.includes[arg] : undefined;
        if (!arg || !inc) throw new Error(`${where}: include "${arg}" is not a loaded attachment`);
        used.includes.push(arg);
        return includeText(arg, inc, ctx);
      }
      case "pipeline.stages": return fenced(ctx.pipelines);
      case "work-type": return workTypeText(ctx.pipelines, where);
      case "run-start.flags": return runStartFlags(ctx, arg, raw, where);
      case "verb.path": return verbPath(ctx, arg, raw, where);
      case "pack.path": {
        const rendered = packPath(ctx, arg, raw, where);
        used.packPaths.push(rendered);
        return rendered;
      }
      case "compiled-from": return ctx.compiledFrom;
      case "stage.dir":
        if (!ctx.stageDir) throw new Error(`${where}: {{stage.dir}} used in a public verb`);
        return ctx.stageDir;
      case "stage.fields":
        if (!ctx.stageMeta) throw new Error(`${where}: {{stage.fields}} used outside a stage`);
        return stageFields(ctx.stageMeta);
      default:
        throw new Error(`${where}: unknown placeholder ${raw} at line ${i + 1}`);
    }
  });
}

export function substitute(body: string, ctx: PlaceholderContext, where: string): { body: string; used: Used } {
  const used: Used = { slots: [], includes: [], packPaths: [] };
  const out = body.split("\n").map((line, i) => substituteLine(line, i, ctx, where, used));
  return { body: out.join("\n"), used };
}
