/**
 * `rt setup pack` — installs a team pack's plugins, materializes skills, then
 * checks that the pack's declared work-type pipeline is actually usable: every
 * stage it names must resolve to a non-empty binding in the first registered
 * repo's per-repo manifest. This is the "can someone actually run this pack"
 * check, distinct from `plugins.install`/`skills.materialize`'s own honesty
 * (those report what they did, not whether the result is complete).
 */

import { join } from "path";
import { getKnownRepos } from "../repo-index.ts";
import { stripJsonc } from "../jsonc.ts";
import type { ApplyContext } from "./apply.ts";
import { installPlugins } from "./steps/plugins.ts";
import { materializeSkills } from "./skills-materialize.ts";

const DEFAULT_WORK_TYPE = "feature";

export const NO_MANIFEST_DETAIL = "no per-repo manifest yet";

interface PipelineManifest {
  pipelines?: Record<string, { stages?: string[] } | undefined>;
  bindings?: Record<string, unknown>;
}

function firstRegisteredRepo(): string | null {
  return getKnownRepos().find((r) => r.registered !== false)?.repoName ?? null;
}

/** A manifest that fails to parse reads as empty — the same "nothing declared yet" shape as a missing pipeline, never a crash. */
function parseManifest(text: string): PipelineManifest {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text));
    return typeof parsed === "object" && parsed !== null ? (parsed as PipelineManifest) : {};
  } catch {
    return {};
  }
}

function isBound(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export async function setupPackFlow(ctx: ApplyContext): Promise<{ ok: boolean; stage?: string; detail: string }> {
  // A pack requirements file that failed to parse is reported honestly here
  // rather than silently falling back to DEFAULT_WORK_TYPE, which would mask
  // the malformed file behind an unrelated "stage unresolved" error later.
  const packError = ctx.reqs[0]?.error;
  if (packError) return { ok: false, detail: packError };

  const pluginsOutcome = await installPlugins(ctx);
  if (pluginsOutcome.state === "failed") return { ok: false, detail: pluginsOutcome.detail };

  const materialized = await materializeSkills(ctx.p, {});
  if (!materialized.skipped) {
    for (const r of materialized.repos) {
      if (!r.ok) ctx.log("plugins.install", `materialize ${r.name}: ${r.detail}`);
    }
  }

  const repoName = firstRegisteredRepo();
  const manifestPath = repoName ? join(ctx.p.home, ".mattstack", "repos", repoName, "skills.jsonc") : null;
  const text = manifestPath ? ctx.p.readFile(manifestPath) : null;
  if (text === null) return { ok: false, detail: NO_MANIFEST_DETAIL };

  const workType = ctx.reqs[0]?.workType ?? DEFAULT_WORK_TYPE;
  const manifest = parseManifest(text);
  const stages = manifest.pipelines?.[workType]?.stages ?? [];
  const bindings = manifest.bindings ?? {};

  for (const stage of stages) {
    if (!isBound(bindings[stage])) return { ok: false, stage, detail: `stage "${stage}" is unresolved` };
  }

  return { ok: true, detail: `${stages.length} stage(s) resolved for "${workType}"` };
}
