import { join } from "path";
import { loadStepSource, parseStageQualifiedName, type PluginRoots } from "./sources.ts";
import type { StageEntry, StepSource, VerbDef } from "./types.ts";

type Resolved = {
  packDir: string;
  pipelines: Record<string, string[]>;
  pluginRoots: PluginRoots;
};

type CompileTarget = { verb: VerbDef; isPublic: boolean };

/**
 * Builds each work type's ordered StageEntry[] from its manifest pipeline
 * list: one entry per qualified name, carrying the stage's dir, consumes,
 * and produces. Stage names are validated upstream by parseStageQualifiedName
 * (shared with stageRoster) before they ever reach outDirFor's rmSync; a dir
 * here is always a sibling path relative to the orchestrator's own
 * ${CLAUDE_SKILL_DIR}, never packDir-relative.
 */
export function buildStageEntries(input: Pick<Resolved, "pipelines" | "pluginRoots">): Record<string, StageEntry[]> {
  const out: Record<string, StageEntry[]> = {};
  for (const [type, names] of Object.entries(input.pipelines)) {
    out[type] = names.map((qualified) => {
      let name: string;
      try {
        name = parseStageQualifiedName(qualified, `pipeline "${type}"`);
      } catch (err) {
        throw new Error((err as Error).message);
      }
      let step: StepSource;
      try {
        step = loadStepSource(name, input.pluginRoots);
      } catch (err) {
        throw new Error(`pipeline "${type}": "${name}": ${(err as Error).message}`);
      }
      if (!step.stageMeta) {
        throw new Error(`pipeline "${type}": "${name}" has no metadata.stage; it cannot appear in a pipeline`);
      }
      return {
        name,
        stage: step.stageMeta.stage,
        dir: `\${CLAUDE_SKILL_DIR}/../../attachments/${name}`,
        consumes: step.stageMeta.consumes,
        produces: step.stageMeta.produces,
      };
    });
  }
  return out;
}

/** outDirFor/otherSideDir also name the stale side of a name that flips public/internal, so compile can clean it up. */
export function outDirFor(packDir: string, name: string, isPublic: boolean): string {
  return join(packDir, isPublic ? "skills" : "attachments", name);
}

export function otherSideDir(packDir: string, name: string, isPublic: boolean): string {
  return join(packDir, isPublic ? "attachments" : "skills", name);
}

/**
 * Where this run's targets land, for the sibling-reference lint. Derived from
 * outDirFor, never from a StageEntry's `dir`: that one hardcodes
 * attachments/<name> and is wrong the moment a stage is made surface-public.
 */
export function targetOutDirs(resolved: Resolved, targets: CompileTarget[]): string[] {
  return targets.map((t) => outDirFor(resolved.packDir, t.verb.name, t.isPublic));
}
