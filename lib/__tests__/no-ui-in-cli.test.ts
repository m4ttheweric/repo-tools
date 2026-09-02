import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { resolve, relative } from "path";

// The rt TS CLI (commands/, lib/, cli.ts, scripts/) is pure orchestration:
// all UI rendering lives in the Go rt-ui helper. packages/ (e.g. settings-kit,
// a react UI kit for the web console) is a separate concern and is not
// scanned.
const ROOT = resolve(import.meta.dir, "..", "..");
const SCAN_ROOTS = ["commands", "lib", "cli.ts", "scripts"];
const SELF = resolve(import.meta.dir, "no-ui-in-cli.test.ts");

const FORBIDDEN_MODULE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "ink", re: /\bink\b/ },
  { label: "@inkjs/*", re: /@inkjs\// },
  { label: "ink-*", re: /\bink-[\w-]+/ },
  { label: "fullscreen-ink", re: /fullscreen-ink/ },
  { label: "react", re: /^react$/ },
  { label: "react-dom", re: /^react-dom$/ },
  { label: "preact", re: /^preact$/ },
  { label: "vue", re: /^vue$/ },
  { label: "solid-js", re: /^solid-js$/ },
  { label: "svelte", re: /^svelte$/ },
];

function matchForbiddenModule(specifier: string): string | null {
  for (const { label, re } of FORBIDDEN_MODULE_PATTERNS) {
    if (re.test(specifier)) return label;
  }
  return null;
}

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.name === "node_modules") return [];
    if (entry.isDirectory()) return collectFiles(full);
    return [full];
  });
}

function listScanTargets(): string[] {
  return SCAN_ROOTS.flatMap((root) => {
    const full = resolve(ROOT, root);
    return full.endsWith(".ts") ? [full] : collectFiles(full);
  }).filter((file) => file !== SELF);
}

test("no .tsx file exists under the CLI source (commands/, lib/, cli.ts, scripts/)", () => {
  const offenders = listScanTargets().filter((file) => file.endsWith(".tsx"));
  expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
});

test("no CLI source file imports a UI-rendering framework", () => {
  const offenders: string[] = [];

  for (const file of listScanTargets()) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");

    // Static imports/exports, `require(...)`, and dynamic `import(...)` all
    // count: any of the three would put UI-rendering code on the CLI's
    // module graph, whether loaded eagerly or lazily.
    const specifierMatches = source.matchAll(
      /(?:\bfrom\s*|^\s*import\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/gm,
    );
    for (const m of specifierMatches) {
      const specifier = m[1]!;
      const label = matchForbiddenModule(specifier);
      if (label) {
        offenders.push(`${relative(ROOT, file)}: imports "${specifier}" (forbidden UI module: ${label})`);
      }
    }

    if (/\/\/\s*@jsx(?:ImportSource)?\b/.test(source)) {
      offenders.push(`${relative(ROOT, file)}: contains a @jsx/@jsxImportSource pragma comment`);
    }
  }

  expect(offenders).toEqual([]);
});

test("the scan excludes packages/ (settings-kit's react is allowed there)", () => {
  const targets = listScanTargets();
  const leaked = targets.filter((f) => relative(ROOT, f).startsWith("packages/"));
  expect(leaked).toEqual([]);
});
