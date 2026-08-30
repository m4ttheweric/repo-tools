/**
 * Bidirectional drift guard (R016): every command-name literal passed to
 * `rtCommand` anywhere in rt-client's own source must be listed in
 * COMMAND_NAMES. Without this, a call site can silently target an
 * uncataloged command (as `cache:read` once did) with no type error and no
 * test failure anywhere else.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { COMMAND_NAMES } from "../src/commands.ts";

const srcDir = join(import.meta.dir, "..", "src");

/**
 * Matches `rtCommand` / `rtCommand<...>(` and captures the first string
 * literal argument. The generic-arg group is lazy and dotAll so it spans
 * nested generics (`rtCommand<Record<string, X>>(`, which has two `>`
 * before the call parenthesis) and call sites that put the command literal
 * on the line after the opening paren rather than on the same line.
 */
const CALL_SITE_RE = /rtCommand\s*(?:<.*?>)?\s*\(\s*["']([^"']+)["']/gs;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function findCallSites(): { file: string; name: string }[] {
  const sites: { file: string; name: string }[] = [];
  for (const file of tsFilesUnder(srcDir)) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(CALL_SITE_RE)) {
      const name = match[1];
      if (name !== undefined) sites.push({ file, name });
    }
  }
  return sites;
}

describe("rtCommand call sites are cataloged (R016)", () => {
  test("the scan finds a non-trivial number of call sites", () => {
    // A floor, not the real count: guards against a regex edit that
    // silently stops matching (and would otherwise pass vacuously).
    expect(findCallSites().length).toBeGreaterThan(20);
  });

  test("every call-site command name is present in COMMAND_NAMES", () => {
    const catalog = new Set<string>(COMMAND_NAMES);
    const uncataloged = findCallSites()
      .filter((site) => !catalog.has(site.name))
      .map((site) => `${relative(srcDir, site.file)}: "${site.name}"`);

    // Empty on success; on failure, expect()'s array diff names the
    // offending file(s) and the missing command name(s) directly.
    expect(uncataloged).toEqual([]);
  });
});
