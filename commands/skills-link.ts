/**
 * rt skills link -- reconcile agent-skill symlinks for the current repo.
 *
 * Links every `skills/<dir>/SKILL.md` in the repo you run it from into
 * ~/.claude/skills/<frontmatter name>, replacing the estate's hand-managed
 * symlink convention with a verb. Creates missing links, repoints links whose
 * target moved inside the repo, prunes links whose target is gone, and
 * reports (never touches) names owned by anything outside this repo.
 *
 * `--from <dir>` names the source directory instead of deriving it from a
 * checkout, so the mattstack installer can link an app's skills out of the
 * .app bundle, where no repo exists.
 */

import { execFileSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { pruneLinksFrom, readSkillsIgnore, reconcileSkillLinks, type LinkAction, type ReconcileResult } from "../lib/skills/link.ts";
import { envelope } from "../lib/setup/contract.ts";

function fail(message: string): never {
  console.error(`rt skills link: ${message}`);
  process.exit(1);
}

const GLYPH: Record<LinkAction["kind"], string> = {
  create: "+",
  ok: "=",
  relink: "~",
  prune: "-",
  conflict: "!",
  skip: "·",
};

/** The skills source: `--from` verbatim when given, else `<repo root>/skills`. */
export function resolveSkillsDir(opts: {
  from?: string;
  repoRoot: () => string | null;
}): { dir: string } | { error: string } {
  if (opts.from !== undefined) {
    const dir = resolve(opts.from);
    if (!existsSync(dir)) return { error: `${dir} does not exist` };
    if (!statSync(dir).isDirectory()) return { error: `${dir} is not a directory` };
    return { dir };
  }
  const root = opts.repoRoot();
  if (root === null) {
    return { error: "not inside a git repo — run it from the repo whose skills/ you want linked, or pass --from <dir>" };
  }
  const dir = join(root, "skills");
  if (!existsSync(dir)) return { error: `${dir} does not exist — this repo has no skills/ directory` };
  return { dir };
}

function gitRepoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function skillsLink(args: string[]): Promise<void> {
  let dryRun = false;
  let json = false;
  let from: string | undefined;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run": dryRun = true; break;
      case "--json": json = true; break;
      case "--from": {
        const value = args[++i];
        if (value === undefined) fail("--from needs a directory");
        from = value;
        break;
      }
      default: fail(`unknown flag ${args[i]}`);
    }
  }

  const claudeSkillsDir = join(process.env.HOME ?? "", ".claude", "skills");
  const source = resolveSkillsDir({ from, repoRoot: gitRepoRoot });

  if ("error" in source) {
    // A --from that has vanished is the uninstall case, not a bad argument:
    // drop the links that pointed into it. With none to drop it IS a bad
    // argument (a typo), so the original error still stands.
    if (from !== undefined) {
      const gone = pruneLinksFrom({ skillsDir: resolve(from), claudeSkillsDir, dryRun });
      if (gone.actions.length > 0) {
        report(resolve(from), claudeSkillsDir, gone, dryRun, json);
        return;
      }
    }
    fail(source.error);
  }

  // `.skillsignore` names skills the source declines to DISTRIBUTE, so it
  // binds the bundle path (--from) and not a checkout: in this estate a user
  // never has a checkout, so linking from a repo is the author linking their
  // own work, author-only skills included.
  const ignore = from === undefined ? [] : readSkillsIgnore(source.dir);

  report(source.dir, claudeSkillsDir, reconcileSkillLinks({ skillsDir: source.dir, claudeSkillsDir, dryRun, ignore }), dryRun, json);
}

function report(skillsDir: string, claudeSkillsDir: string, result: ReconcileResult, dryRun: boolean, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(envelope({ ok: true, dryRun, skillsDir, claudeSkillsDir, changed: result.changed, actions: result.actions })));
    return;
  }

  const label = dryRun ? " (dry run)" : "";
  console.log(`\n  rt skills link${label} — ${skillsDir} → ${claudeSkillsDir}\n`);
  for (const a of result.actions) {
    const name = a.name.padEnd(24);
    console.log(`  ${GLYPH[a.kind]} ${name} ${a.kind}${a.detail ? ` — ${a.detail}` : ""}`);
  }
  const conflicts = result.actions.filter((a) => a.kind === "conflict");
  if (conflicts.length > 0) {
    console.log(`\n  ${conflicts.length} name(s) are owned by something outside this repo — resolve by hand; rt never removes what it did not create.`);
  }
  if (!result.changed && conflicts.length === 0) console.log("  Everything already linked.");
  console.log();
}
