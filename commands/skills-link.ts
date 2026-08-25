/**
 * rt skills link -- reconcile agent-skill symlinks for the current repo.
 *
 * Links every `skills/<dir>/SKILL.md` in the repo you run it from into
 * ~/.claude/skills/<frontmatter name>, replacing the estate's hand-managed
 * symlink convention with a verb. Creates missing links, repoints links whose
 * target moved inside the repo, prunes links whose target is gone, and
 * reports (never touches) names owned by anything outside this repo.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { reconcileSkillLinks, type LinkAction } from "../lib/skills/link.ts";
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

export async function skillsLink(args: string[]): Promise<void> {
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run": dryRun = true; break;
      case "--json": json = true; break;
      default: fail(`unknown flag ${args[i]}`);
    }
  }

  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    fail("not inside a git repo — run it from the repo whose skills/ you want linked");
  }
  const skillsDir = join(repoRoot, "skills");
  if (!existsSync(skillsDir)) {
    fail(`${skillsDir} does not exist — this repo has no skills/ directory`);
  }

  const claudeSkillsDir = join(process.env.HOME ?? "", ".claude", "skills");
  const result = reconcileSkillLinks({ skillsDir, claudeSkillsDir, dryRun });

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
