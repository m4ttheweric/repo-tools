// Prints rt-tray/deps.lock as TSV so build.sh / fetch-deps.sh / check-bundle.sh
// never parse JSON in bash. Usage:
//   bun scripts/lib/deps-lock.ts [--kind K] [--status S]
//   bun scripts/lib/deps-lock.ts --arch   (prints just the lock's arch, no rows)
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock, type DepsLockTool } from "../../lib/bundle-layout.ts";

// A row a bash `read` can trust: no field may itself carry the row or line
// delimiter, or a later parse ends up silently reading a fragment of it.
const TSV_BREAKING_CHARS = /[\t\n\r]/;
function tsvField(value: string, toolName: string, field: string): string {
  if (TSV_BREAKING_CHARS.test(value)) {
    throw new Error(`deps.lock: ${toolName}.${field} contains a tab or newline, which would corrupt the TSV row`);
  }
  return value;
}

export function toTsvRow(t: DepsLockTool): string {
  return [
    tsvField(t.name, t.name, "name"),
    tsvField(t.version, t.name, "version"),
    tsvField(t.url, t.name, "url"),
    tsvField(t.sha256, t.name, "sha256"),
    tsvField(t.archive, t.name, "archive"),
    tsvField(t.extract, t.name, "extract"),
    tsvField(t.bundlePath, t.name, "bundlePath"),
    tsvField(t.entitlements, t.name, "entitlements"),
    tsvField(t.status, t.name, "status"),
    tsvField(t.kind, t.name, "kind"),
    String(t.exposeByDefault),
  ].join("\t");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (flag: string): string | null => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const value = args[i + 1];
    // A flag with no value must not fall back to the default lock: the caller
    // asked for a specific file and would never see that it was ignored.
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  const kind = opt("--kind");
  const status = opt("--status");
  const wantArch = args.includes("--arch");

  const lockPath = opt("--lock") ?? join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const lock = parseDepsLock(readFileSync(lockPath, "utf8"));

  if (wantArch) {
    console.log(lock.arch);
  } else {
    for (const t of lock.tools) {
      if (kind && t.kind !== kind) continue;
      if (status && t.status !== status) continue;
      console.log(toTsvRow(t));
    }
  }
}
