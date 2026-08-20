/**
 * Tiny JSON persistence helpers, factored out of the ~28 modules that each
 * hand-rolled the same "read JSON or return a default" and "write JSON, creating
 * the parent dir" boilerplate.
 *
 * Writes are write-temp-then-rename atomic — stores never tear (spec §4).
 *
 * Scope note: adopted in the per-repo store modules touched by the ~/.mattstack/rt/repos
 * move (repo-index, parking-lot). Other hand-rolled callsites are intentionally
 * left alone — converting all of them is a separate, app-wide sweep, not part
 * of the path refactor.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

/**
 * Read and parse a JSON file. Returns `fallback` on any failure — missing file,
 * malformed JSON, or read error. The fallback is returned as-is (not cloned), so
 * pass a fresh value if the caller mutates it.
 */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write `value` as pretty-printed JSON, creating the parent directory if needed.
 * Throws on write failure — callers that treat persistence as best-effort should
 * wrap this in their own try/catch (matching their existing logging).
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp file never got created, or was already cleaned up... nothing to do
    }
    throw err;
  }
}
