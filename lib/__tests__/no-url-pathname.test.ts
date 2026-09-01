import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { resolve, relative } from "path";

// `new URL(import.meta.url).pathname` does not round-trip a path containing a
// literal `%`: import.meta.url encodes it as `%25`, and `.pathname` hands back
// the still-encoded string, naming a file that does not exist. rt's own
// worktree pool roots contain `%3A` (RT-95), so this reached three runtime
// call sites at once. `fileURLToPath(import.meta.url)` decodes; so does Bun's
// `import.meta.dir` where only the directory is wanted.
const ROOT = resolve(import.meta.dir, "..", "..");
const SCAN_ROOTS = ["commands", "lib", "cli.ts", "scripts"];
const SELF = resolve(import.meta.dir, "no-url-pathname.test.ts");
const FORBIDDEN = /new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/;

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.name === "node_modules") return [];
    if (entry.isDirectory()) return collectFiles(full);
    return [full];
  });
}

test("no source file derives a path from new URL(import.meta.url).pathname", () => {
  const files = SCAN_ROOTS.flatMap((root) => {
    const full = resolve(ROOT, root);
    return full.endsWith(".ts") ? [full] : collectFiles(full);
  }).filter((f) => f !== SELF && (f.endsWith(".ts") || f.endsWith(".tsx")));

  const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
});
