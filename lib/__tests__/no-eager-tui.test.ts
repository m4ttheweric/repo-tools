import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { resolve, dirname, basename } from "path";

function findEagerTuiImports(source: string): string[] {
  // Import statements can span multiple lines (e.g. multi-symbol named
  // imports), so split on `;` rather than `\n` before filtering.
  const statements = source
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^import\b/.test(s))
    .filter((s) => !/^import\s+type\b/.test(s));

  return statements.filter((s) => /from\s*["'][^"']*(rt-render|\bink\b)[^"']*["']/.test(s));
}

test("command-tree.ts has no static value import of rt-render or ink", () => {
  const source = readFileSync(resolve(import.meta.dir, "..", "command-tree.ts"), "utf8");
  expect(findEagerTuiImports(source)).toEqual([]);
});

test("no command module has a static value import of rt-render or ink", () => {
  const commandsDir = resolve(import.meta.dir, "..", "..", "commands");

  function collectFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  const offenders = collectFiles(commandsDir).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return findEagerTuiImports(source).map((stmt) => `${file}: ${stmt}`);
  });

  expect(offenders).toEqual([]);
});

test("daemon graph never transitively reaches the CLI picker chain (repo-arg, repo, fzf, rt-render, ink)", () => {
  // Full resolver walk from the daemon entry point, not a fixed file list --
  // a new daemon module that reaches one of these transitively must fail
  // this test without anyone remembering to extend a scanned set by hand.
  const libDir = resolve(import.meta.dir, "..");
  const bannedRelativeBasenames = new Set(["repo-arg.ts", "repo.ts", "fzf.ts", "fzf-select.ts", "rt-render.ts", "spawn.ts", "prompts.ts", "steps.ts"]);
  const bannedBareSpecifiers = ["ink"];

  function resolveRelativeImport(fromFile: string, specifier: string): string | null {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  // Both value and type-only import/export specifiers count: this guard
  // tracks source-graph coupling, not bundle payload, so a type-only edge
  // to a banned module is exactly as much of a regression as a value one.
  function importSpecifiers(source: string): string[] {
    return source
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^(import|export)\b/.test(s))
      .flatMap((s) => {
        // Match `... from "x"` and bare side-effect `import "x"`: the latter
        // has no `from` but still eagerly loads its module, so a daemon-side
        // `import "./repo.ts";` must count as a violation.
        const m = s.match(/(?:\bfrom\s*|^import\s*)["']([^"']+)["']/);
        return m ? [m[1]!] : [];
      });
  }

  const visited = new Set<string>();
  const offenders: string[] = [];

  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const specifiers = importSpecifiers(readFileSync(file, "utf8"));
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) {
        if (bannedBareSpecifiers.some((b) => spec === b || spec.startsWith(`${b}/`))) {
          offenders.push(`${file} -> "${spec}"`);
        }
        continue;
      }
      const resolved = resolveRelativeImport(file, spec);
      if (!resolved) continue;
      if (bannedRelativeBasenames.has(basename(resolved))) {
        offenders.push(`${file} -> ${resolved}`);
      }
      visit(resolved);
    }
  }

  visit(resolve(libDir, "daemon.ts"));

  expect(offenders).toEqual([]);
});
