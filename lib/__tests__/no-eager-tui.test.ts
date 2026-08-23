import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

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

test("no command module (other than the status dashboard, which is an Ink app by nature) has a static value import of rt-render or ink", () => {
  const commandsDir = resolve(import.meta.dir, "..", "..", "commands");

  function collectFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "status") return [];
        return collectFiles(full);
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  const offenders = collectFiles(commandsDir).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return findEagerTuiImports(source).map((stmt) => `${file}: ${stmt}`);
  });

  expect(offenders).toEqual([]);
});
