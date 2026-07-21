import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";

/**
 * Remove previously generated pages from `outDir`, preserving any entry named
 * in `handWritten` (hand-authored files the generator must never destroy).
 */
export function cleanGenerated(outDir: string, handWritten: string[] = []): void {
  if (!existsSync(outDir)) return;
  const keep = new Set(handWritten);
  for (const name of readdirSync(outDir)) {
    if (keep.has(name)) continue;
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}
