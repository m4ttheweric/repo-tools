/**
 * Link the skills the .app bundle ships. Each managed app's release artifact
 * carries its `skills/` dir verbatim, which the build lands at
 * `Contents/Helpers/skills/<app>/`; this walks that tree and reconciles each
 * app's skills into ~/.claude/skills by frontmatter name.
 *
 * A user machine never has a checkout, so this is the only path by which an
 * app's skills reach them. The per-app gate is the app's own binary being
 * bundled, and each app reconciles against its own directory alone, so one
 * app's skills never disturb another's links.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { readSkillsIgnore, reconcileSkillLinks } from "../skills/link.ts";

export interface BundledSkillsResult {
  app: string;
  /** Links this app now owns; 0 when skipped. */
  linked: number;
  changed: boolean;
  /** Why the app was passed over, absent when it was linked. */
  skipped?: string;
}

export function linkBundledSkills(opts: {
  /** `<bundle>/Contents/Helpers/skills`. */
  skillsRoot: string;
  claudeSkillsDir: string;
  /** True when the app's own binary is in the bundle. */
  isBundled: (app: string) => boolean;
  dryRun?: boolean;
}): BundledSkillsResult[] {
  if (!existsSync(opts.skillsRoot)) return [];

  const results: BundledSkillsResult[] = [];
  for (const entry of readdirSync(opts.skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const app = entry.name;
    if (!opts.isBundled(app)) {
      results.push({ app, linked: 0, changed: false, skipped: "not bundled" });
      continue;
    }
    const skillsDir = join(opts.skillsRoot, app);
    const result = reconcileSkillLinks({
      skillsDir,
      claudeSkillsDir: opts.claudeSkillsDir,
      dryRun: opts.dryRun,
      ignore: readSkillsIgnore(skillsDir),
    });
    const linked = result.actions.filter((a) => a.kind === "create" || a.kind === "ok" || a.kind === "relink").length;
    results.push({ app, linked, changed: result.changed });
  }
  return results;
}
