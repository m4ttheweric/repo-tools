import type { AttachmentSource, CompiledFile, CompileResult, StepSource, VerbDef } from "./types.ts";

const CLAUDE_SKILL_DIR_TOKEN = "${CLAUDE_SKILL_DIR}";

/** Exported so `rt skills surface` can classify a directory as compiled by checking its SKILL.md body prefix. */
export const HEADER_COMMENT =
  "<!-- compiled by rt skills compile from the sources below; slots pre-resolved; edits here are working-tree drift (rt skills promote) -->";

const REGISTERED_NAME_RE = /\b(mattstack|claimview|assured):[a-z][a-z0-9-]*\b/g;
const SKILL_DIR_PATH_RE = /\$\{CLAUDE_SKILL_DIR\}\/[^\s"'`)]+/g;

type BoundSlot = { slotName: string; fill: AttachmentSource };

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

function buildAllowedTools(step: StepSource, boundSlots: BoundSlot[]): string[] {
  const entries = [
    ...step.allowedTools,
    ...boundSlots.flatMap(({ slotName, fill }) =>
      fill.allowedTools.map((tool) => rewriteSkillDirRefs(tool, slotName)),
    ),
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

function buildBody(
  step: StepSource,
  boundSlots: BoundSlot[],
  internalRoster: Set<string>,
): { body: string; notes: string[] } {
  const sections: string[] = [HEADER_COMMENT];
  const notes: string[] = [];

  sections.push(`<!-- part: step source=${step.plugin}:${step.name} version=${step.version} ${span(step)} -->`);
  sections.push(step.body);

  for (const { slotName, fill } of boundSlots) {
    const internal = internalRoster.has(fill.binding);

    if (fill.registered && !internal) {
      // Registered, surface-public skills stay singly-canonical: reference, never inline.
      sections.push(
        `Slot ${slotName} is bound to \`${fill.binding}\` (${fill.binding}@${fill.version}) -- invoke that skill when this flow needs it.`,
      );
      continue;
    }

    if (fill.registered && internal) {
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

function buildVendoredFiles(step: StepSource, boundSlots: BoundSlot[]): CompiledFile[] {
  const files: CompiledFile[] = [];

  for (const entry of step.stepFiles) {
    files.push({ path: entry, copyFrom: `${step.dir}/${entry}` });
  }

  for (const { slotName, fill } of boundSlots) {
    for (const entry of fill.extraFiles) {
      files.push({ path: `parts/${slotName}/${entry}`, copyFrom: `${fill.dir}/${entry}` });
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

function lintReferences(body: string, roster: Set<string>, files: CompiledFile[]): string[] {
  const warnings: string[] = [];
  const lintableBody = stripCompilerComments(body);

  const seenNames = new Set<string>();
  for (const match of lintableBody.matchAll(REGISTERED_NAME_RE)) {
    const token = match[0];
    if (seenNames.has(token)) continue;
    seenNames.add(token);
    if (!roster.has(token)) {
      warnings.push(`body references ${token} which is not invocable`);
    }
  }

  const emittedPaths = new Set(files.map((f) => f.path));
  const seenPaths = new Set<string>();
  for (const match of lintableBody.matchAll(SKILL_DIR_PATH_RE)) {
    const full = match[0];
    if (seenPaths.has(full)) continue;
    seenPaths.add(full);
    const relPath = full.slice(`${CLAUDE_SKILL_DIR_TOKEN}/`.length);
    if (!emittedPaths.has(relPath)) {
      warnings.push(`body references ${full} which is not an emitted file`);
    }
  }

  return warnings;
}

function lintInternalRoster(text: string, internalRoster: Set<string>, where: string): string[] {
  const errors: string[] = [];
  const lintableText = stripCompilerComments(text);

  const seenNames = new Set<string>();
  for (const match of lintableText.matchAll(REGISTERED_NAME_RE)) {
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
  opts?: { internalRoster?: Set<string> },
): CompileResult {
  const internalRoster = opts?.internalRoster ?? new Set<string>();
  const boundSlots = resolveBoundSlots(verb, step, fills);

  const allowedTools = buildAllowedTools(step, boundSlots);
  const compiledParts = [
    `${step.plugin}@${step.version}`,
    ...boundSlots.map(({ fill }) => `${fill.binding}@${fill.version}`),
  ];

  const { body, notes } = buildBody(step, boundSlots, internalRoster);
  const frontmatter = buildFrontmatter(verb, allowedTools, compiledParts);
  const content = `${frontmatter}\n\n${body}\n`;

  const files: CompiledFile[] = [{ path: "SKILL.md", content }, ...buildVendoredFiles(step, boundSlots)];

  const warnings = [...lintReferences(body, roster, files), ...notes];
  const errors = [
    ...lintInternalRoster(body, internalRoster, "body"),
    ...lintInternalRoster(verb.description, internalRoster, "description"),
  ];

  return { files, warnings, errors };
}
