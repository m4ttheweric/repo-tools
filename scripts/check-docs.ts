/**
 * Fail if the committed command reference drifts from the tree, and report
 * commands that still lack declared args. Usage: bun scripts/check-docs.ts
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { TREE } from "../lib/command-tree-def.ts";
import { coverageGaps } from "./lib/docs-coverage.ts";
import { HAND_WRITTEN_REFERENCE } from "./lib/docs-hand.ts";

const COMMITTED = "website/docs/reference";
const tmp = mkdtempSync(join(tmpdir(), "rt-docs-"));

// Regenerate into a temp dir using the same generator.
const gen = spawnSync("bun", ["scripts/gen-docs.ts", "--out", tmp], { encoding: "utf8" });
if (gen.status !== 0) {
  console.error(gen.stderr);
  process.exit(1);
}

// Diff temp vs committed. `diff -r` exits non-zero on any difference.
// Hand-written files (never generated) are excluded from the comparison.
const excludes = HAND_WRITTEN_REFERENCE.flatMap((n) => ["--exclude", n]);
const diff = spawnSync("diff", ["-r", "-u", ...excludes, COMMITTED, tmp], { encoding: "utf8" });
rmSync(tmp, { recursive: true, force: true });

const gaps = coverageGaps(TREE);
console.log(`\ncoverage: ${gaps.length} command(s) with no declared args`);
if (gaps.length) console.log(gaps.map((g) => `  - rt ${g}`).join("\n"));

if (diff.status !== 0) {
  console.error("\n✗ docs are stale — regenerate with `bun scripts/gen-docs.ts`:\n");
  console.error(diff.stdout);
  process.exit(1);
}
console.log("\n✓ command reference is in sync with the tree");
