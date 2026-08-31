/**
 * Reconcile agent-skill symlinks: every `<repoRoot>/skills/<dir>/SKILL.md`
 * whose frontmatter carries a `name:` gets a symlink
 * `<claudeSkillsDir>/<name>` pointing at the skill directory. The frontmatter
 * name is the link name verbatim (`rt:settings` → `skills/rt-settings`),
 * matching the estate's manual-symlink convention this verb replaces.
 *
 * Ownership boundary: reconciliation only ever creates links into THIS
 * repo's skills dir and only ever removes links that already point inside
 * it. A link occupying a wanted name but pointing elsewhere — or a real
 * file/dir squatting the name — is reported as a conflict and left alone.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { stripFrontmatter } from "./sources.ts";

export type LinkActionKind =
  | "create"   // link missing → symlink created (or would be, dry run)
  | "ok"       // link already resolves to this skill dir
  | "relink"   // link points into skillsDir but at the wrong/stale dir → repointed
  | "prune"    // link points into skillsDir but its target is gone → removed
  | "conflict" // name taken by a foreign link or a real file/dir → untouched
  | "skip";    // SKILL.md unreadable or frontmatter name unusable → untouched

export interface LinkAction {
  kind: LinkActionKind;
  /** Frontmatter skill name — the link's basename. */
  name: string;
  /** Absolute link path under claudeSkillsDir. */
  link: string;
  /** Absolute skill dir the link should target (null for prune/foreign conflicts). */
  target: string | null;
  detail: string | null;
}

export interface ReconcileResult {
  actions: LinkAction[];
  changed: boolean;
}

/** A link name must be a single path segment — anything else escapes claudeSkillsDir. */
function usableName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}

function resolveLinkTarget(link: string, raw: string): string {
  return isAbsolute(raw) ? raw : resolve(join(link, ".."), raw);
}

export function reconcileSkillLinks(opts: {
  skillsDir: string;
  claudeSkillsDir: string;
  dryRun?: boolean;
}): ReconcileResult {
  const dryRun = opts.dryRun === true;
  const skillsDir = realpathSync(opts.skillsDir);
  const actions: LinkAction[] = [];

  const wanted = new Map<string, string>();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let name: unknown;
    try {
      name = stripFrontmatter(readFileSync(skillMd, "utf8")).frontmatter.name;
    } catch {
      actions.push({ kind: "skip", name: entry.name, link: "", target: dir, detail: "SKILL.md frontmatter unreadable" });
      continue;
    }
    if (typeof name !== "string" || !usableName(name)) {
      actions.push({ kind: "skip", name: entry.name, link: "", target: dir, detail: "frontmatter has no usable name:" });
      continue;
    }
    const clash = wanted.get(name);
    if (clash) {
      actions.push({ kind: "skip", name, link: "", target: dir, detail: `duplicate skill name — already provided by ${clash}` });
      continue;
    }
    wanted.set(name, dir);
  }

  if (!dryRun) mkdirSync(opts.claudeSkillsDir, { recursive: true });
  const claudeDirExists = existsSync(opts.claudeSkillsDir);

  for (const [name, dir] of wanted) {
    const link = join(opts.claudeSkillsDir, name);
    let st;
    try {
      st = lstatSync(link);
    } catch {
      actions.push({ kind: "create", name, link, target: dir, detail: null });
      if (!dryRun) symlinkSync(dir, link);
      continue;
    }
    if (!st.isSymbolicLink()) {
      actions.push({ kind: "conflict", name, link, target: dir, detail: "a real file or directory occupies this name" });
      continue;
    }
    const raw = readlinkSync(link);
    const pointsAt = resolveLinkTarget(link, raw);
    let resolved: string | null = null;
    try {
      resolved = realpathSync(pointsAt);
    } catch {
      resolved = null;
    }
    if (resolved === dir || resolved === realpathSafe(dir)) {
      actions.push({ kind: "ok", name, link, target: dir, detail: null });
      continue;
    }
    if (pointsAt.startsWith(skillsDir + "/") || (resolved !== null && resolved.startsWith(skillsDir + "/"))) {
      actions.push({ kind: "relink", name, link, target: dir, detail: `was → ${raw}` });
      if (!dryRun) {
        unlinkSync(link);
        symlinkSync(dir, link);
      }
      continue;
    }
    actions.push({ kind: "conflict", name, link, target: dir, detail: `points outside this repo: ${raw}` });
  }

  if (claudeDirExists) {
    for (const entry of readdirSync(opts.claudeSkillsDir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const link = join(opts.claudeSkillsDir, entry.name);
      if (wanted.has(entry.name)) continue;
      const raw = readlinkSync(link);
      const pointsAt = resolveLinkTarget(link, raw);
      if (!pointsAt.startsWith(skillsDir + "/")) continue;
      if (existsSync(pointsAt) && statSync(pointsAt).isDirectory()) continue;
      actions.push({ kind: "prune", name: entry.name, link, target: null, detail: `target gone: ${raw}` });
      if (!dryRun) unlinkSync(link);
    }
  }

  return { actions, changed: actions.some((a) => a.kind === "create" || a.kind === "relink" || a.kind === "prune") };
}

/**
 * Remove links pointing into a skills dir that no longer exists — an app
 * whose bundled skills went away with it. Reconciliation cannot express this:
 * it reads the source to learn what should exist, and here there is nothing
 * left to read. Only links already pointing inside `skillsDir` are touched,
 * so one app's uninstall never disturbs another's.
 */
export function pruneLinksFrom(opts: {
  skillsDir: string;
  claudeSkillsDir: string;
  dryRun?: boolean;
}): ReconcileResult {
  const dryRun = opts.dryRun === true;
  const actions: LinkAction[] = [];
  if (!existsSync(opts.claudeSkillsDir)) return { actions, changed: false };

  // The links were created against the source's realpath, but the source is
  // gone and cannot be realpath'd now — so resolve through its nearest
  // surviving ancestor (/var vs /private/var on macOS) and match either form.
  const prefixes = [...new Set([opts.skillsDir, realpathThroughAncestor(opts.skillsDir)])]
    .map((p) => p.replace(/\/+$/, "") + "/");
  for (const entry of readdirSync(opts.claudeSkillsDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(opts.claudeSkillsDir, entry.name);
    const raw = readlinkSync(link);
    const pointsAt = resolveLinkTarget(link, raw);
    if (!prefixes.some((p) => pointsAt.startsWith(p))) continue;
    actions.push({ kind: "prune", name: entry.name, link, target: null, detail: `source gone: ${raw}` });
    if (!dryRun) unlinkSync(link);
  }
  return { actions, changed: actions.length > 0 };
}

/** `p` with its nearest existing ancestor realpath'd, so a gone path still compares. */
function realpathThroughAncestor(p: string): string {
  const tail: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
}

function realpathSafe(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
