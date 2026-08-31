import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

export interface BuildResult {
  name: string;
  version: string;
  url: string;
  sha256: string;
}

function rowSpan(lockText: string, name: string): { start: number; end: number } {
  const marker = `"name": "${name}"`;
  const idx = lockText.indexOf(marker);
  if (idx < 0) throw new Error(`deps.lock has no row named ${name}`);
  const start = lockText.lastIndexOf("{", idx);
  let depth = 0;
  let inString = false;
  let escaped = false;
  // Braces inside a quoted value (a url or license may carry one) must not
  // move the depth, or the row span silently truncates or overruns.
  for (let i = start; i < lockText.length; i++) {
    const ch = lockText[i];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === "{") depth++;
    else if (!inString && ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`unterminated row object for ${name}`);
}

function setField(block: string, field: string, value: string, name: string): string {
  // The existing value may itself contain an escaped quote, so consume escape
  // sequences rather than stopping at the first `"` after the opener.
  const re = new RegExp(`("${field}":\\s*")(?:[^"\\\\]|\\\\.)*(")`);
  if (!re.test(block)) throw new Error(`row ${name} has no "${field}" field to rewrite`);
  // A callback, not a replacement string: `$&` and friends inside a value
  // would otherwise be expanded. The value is JSON-escaped as well, so a
  // quote or backslash cannot end the string it is being written into.
  const encoded = JSON.stringify(value).slice(1, -1);
  return block.replace(re, (_m, open: string, close: string) => `${open}${encoded}${close}`);
}

export function applyBuildResults(lockText: string, results: BuildResult[]): string {
  let out = lockText;
  for (const r of results) {
    const { start, end } = rowSpan(out, r.name);
    let block = out.slice(start, end);
    block = setField(block, "version", r.version, r.name);
    block = setField(block, "url", r.url, r.name);
    block = setField(block, "sha256", r.sha256, r.name);
    block = setField(block, "status", "bundled", r.name);
    block = setField(block, "archive", "tar.gz", r.name);
    block = setField(block, "extract", r.name, r.name);
    out = out.slice(0, start) + block + out.slice(end);
  }
  parseDepsLock(out);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const lockFlag = args.indexOf("--lock");
  const lockPath = lockFlag >= 0
    ? args[lockFlag + 1]!
    : join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const resultsPath = args.filter((a, i) => lockFlag < 0 || (i !== lockFlag && i !== lockFlag + 1))[0];
  if (!resultsPath) {
    console.error("usage: update-lock.ts <results.json> [--lock <path>]");
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as BuildResult[];
  writeFileSync(lockPath, applyBuildResults(readFileSync(lockPath, "utf8"), results));
  console.log(`updated ${results.map((r) => `${r.name}@${r.version}`).join(", ")}`);
}
