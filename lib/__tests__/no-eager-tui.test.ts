import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("command-tree.ts has no static value import of rt-render or ink", () => {
  const source = readFileSync(resolve(import.meta.dir, "..", "command-tree.ts"), "utf8");
  const staticImports = source
    .split("\n")
    .filter((line) => /^import\b/.test(line.trim()))
    .filter((line) => !/^import type\b/.test(line.trim()));

  const eagerTuiImports = staticImports.filter((line) => /["'].*(rt-render|\bink\b).*["']/.test(line));

  expect(eagerTuiImports).toEqual([]);
});
