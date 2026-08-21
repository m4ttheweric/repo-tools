import type { AttachmentSource, CompiledFile, CompileResult, StepSource, VerbDef } from "./types.ts";

const CLAUDE_SKILL_DIR_TOKEN = "${CLAUDE_SKILL_DIR}";

const HEADER_COMMENT =
  "<!-- compiled by rt skills compile from the sources below; slots pre-resolved; edits here are working-tree drift (rt skills promote) -->";

const REGISTERED_NAME_RE = /\b(mattstack|acme|acme):[a-z][a-z0-9-]*\b/g;
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
  lines.push("allowed-tools:");
  for (const tool of allowedTools) {
    lines.push(`  - ${yamlQuote(tool)}`);
  }
  lines.push("metadata:");
  lines.push(`  compiled: ${yamlQuote(compiledParts.join(" + "))}`);
  lines.push("---");
  return lines.join("\n");
}

function buildBody(step: StepSource, boundSlots: BoundSlot[]): string {
  const sections: string[] = [HEADER_COMMENT];

  sections.push(`<!-- part: step source=${step.plugin}:${step.name} version=${step.version} -->`);
  sections.push(step.body);

  for (const { slotName, fill } of boundSlots) {
    sections.push(`<!-- part: slot:${slotName} binding=${fill.binding} version=${fill.version} -->`);
    sections.push(rewriteSkillDirRefs(fill.body, slotName));
  }

  return sections.join("\n\n");
}

function buildVendoredFiles(step: StepSource, boundSlots: BoundSlot[]): CompiledFile[] {
  const files: CompiledFile[] = [];

  for (const entry of step.scriptFiles) {
    const tail = entry.startsWith("scripts/") ? entry.slice("scripts/".length) : entry;
    files.push({ path: `scripts/${tail}`, copyFrom: `${step.dir}/${entry}` });
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

export function compileSkill(
  verb: VerbDef,
  step: StepSource,
  fills: Record<string, AttachmentSource | null>,
  roster: Set<string>,
): CompileResult {
  const boundSlots = resolveBoundSlots(verb, step, fills);

  const allowedTools = buildAllowedTools(step, boundSlots);
  const compiledParts = [
    `${step.plugin}@${step.version}`,
    ...boundSlots.map(({ fill }) => `${fill.binding}@${fill.version}`),
  ];

  const body = buildBody(step, boundSlots);
  const frontmatter = buildFrontmatter(verb, allowedTools, compiledParts);
  const content = `${frontmatter}\n\n${body}\n`;

  const files: CompiledFile[] = [{ path: "SKILL.md", content }, ...buildVendoredFiles(step, boundSlots)];

  const warnings = lintReferences(body, roster, files);

  return { files, warnings };
}
