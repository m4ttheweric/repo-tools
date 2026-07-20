/**
 * Generate the rt command reference (MDX) from the built-in command tree.
 * Deterministic, no LLM, no handler imports. Usage:
 *   bun scripts/gen-docs.ts [--dry-run] [--out <dir>]
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { TREE } from "../lib/command-tree-def.ts";
import { walkTree } from "./lib/docs-walk.ts";
import { renderPage, type RenderOpts } from "./lib/docs-render.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const outIdx = args.indexOf("--out");
const OUT = (outIdx >= 0 ? args[outIdx + 1] : undefined) ?? "website/docs/reference";

const COMMON_FLAGS = new Set(["--json", "--dry-run", "--repo", "--agent", "--no-agent"]);
const opts: RenderOpts = {
  common: { flags: COMMON_FLAGS, href: "/guides/common-flags" },
  sourceBase:
    process.env.RT_DOCS_SOURCE_BASE ??
    "https://github.com/m4ttheweric/repo-tools/blob/main/",
  hasPartial: (rel) => existsSync(join(OUT, "_partials", `${rel}.mdx`)),
};

const specs = walkTree(TREE);

// Clean previously generated pages (never touch _partials/).
if (!dryRun && existsSync(OUT)) {
  for (const name of readdirSync(OUT)) {
    if (name === "_partials") continue;
    rmSync(join(OUT, name), { recursive: true, force: true });
  }
}

let written = 0;
for (const spec of specs) {
  const target = join(OUT, `${spec.relPath}.mdx`);
  const body = spec.isCanonical
    ? renderPage(spec.node, spec.path, spec.relPath, opts)
    : renderStub(spec.path);
  if (dryRun) {
    console.log(`${target}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written++;
  }
}

function renderStub(path: string[]): string {
  const name = path.at(-1)!;
  return [
    "---",
    `title: rt ${path.join(" ")}`,
    `sidebar_label: ${name}`,
    "---",
    "",
    `# rt ${path.join(" ")}`,
    "",
    `Alias. See the canonical reference for \`${name}\`.`,
    "",
  ].join("\n");
}

if (!dryRun) console.log(`gen-docs: wrote ${written} pages to ${OUT}`);
