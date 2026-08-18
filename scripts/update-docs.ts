/**
 * Prepare docs + release notes for a release. Regenerates the command
 * reference, runs the drift/coverage check, scaffolds grouped release notes
 * from <base>..HEAD into RELEASE_NOTES.md, and (unless --no-agent) shells to
 * Claude headless to update the concept guides. Leaves everything STAGED;
 * never commits, tags, pushes, or deploys.
 *
 * Usage:
 *   bun scripts/update-docs.ts [--range <base>] [--no-agent] [--dry-run]
 *     --range <base>  commit-ish to diff from (default: latest tag)
 *     --no-agent      deterministic only: regen + check + notes scaffold
 *     --dry-run       print the plan (incl. the Claude prompt); change nothing
 */
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { parseCommit, buildReleaseNotes } from "./lib/release-notes.ts";

const REPO_URL = "https://github.com/m4ttstack/rt";
const SKILL_PATH = "skills/rt-docs/SKILL.md";
const NOTES_FILE = "RELEASE_NOTES.md";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noAgent = argv.includes("--no-agent");
const rangeIdx = argv.indexOf("--range");
const explicitBase = rangeIdx >= 0 ? argv[rangeIdx + 1] : undefined;

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function latestTag(): string {
  const r = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

const base = explicitBase ?? latestTag();
const subjects = base
  ? sh("git", ["log", "--pretty=%s", `${base}..HEAD`]).split("\n").filter(Boolean)
  : sh("git", ["log", "--pretty=%s"]).split("\n").filter(Boolean);
const notes = buildReleaseNotes(subjects.map(parseCommit), base || "(root)", "HEAD", REPO_URL);

const agentPrompt =
  `Read and follow ${SKILL_PATH}. Update the rt.cool concept guides for the ` +
  `release covering commit range ${base || "(root)"}..HEAD. Regenerate the ` +
  `reference, update only the hand-written guides/partials that changed ` +
  `behavior requires, leave everything staged, and do not commit.`;

if (dryRun) {
  console.log(`[dry-run] base=${base || "(root)"}  commits=${subjects.length}`);
  console.log(`[dry-run] would write ${NOTES_FILE}:\n${notes}`);
  console.log(`[dry-run] would run: bun run docs:gen && bun run docs:check`);
  console.log(`[dry-run] agent step: ${noAgent ? "skipped (--no-agent)" : `claude -p <<prompt>>`}`);
  if (!noAgent) console.log(`[dry-run] prompt:\n${agentPrompt}`);
  process.exit(0);
}

// 1. Deterministic: regenerate the reference and report drift/coverage.
console.log(sh("bun", ["run", "docs:gen"]));
const check = spawnSync("bun", ["run", "docs:check"], { encoding: "utf8" });
process.stdout.write(check.stdout);
if (check.status !== 0) process.stderr.write(check.stderr);

// 2. Write the notes scaffold.
writeFileSync(NOTES_FILE, notes);
console.log(`update-docs: wrote ${NOTES_FILE} (${subjects.length} commits from ${base || "root"})`);

// 3. Judgment (optional): let Claude update the guides.
if (!noAgent) {
  const claude = spawnSync("claude", ["-p", agentPrompt], { stdio: "inherit" });
  if (claude.status !== 0) {
    console.error("update-docs: claude step failed; deterministic outputs are still staged.");
  }
}

// 4. Stage (never commit). Guides staged by the agent; stage the deterministic outputs here.
spawnSync("git", ["add", "website/docs/reference", NOTES_FILE], { stdio: "inherit" });
console.log("update-docs: staged reference + notes. Review, then commit as part of the release.");
