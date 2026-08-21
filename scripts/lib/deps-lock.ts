// Prints rt-tray/deps.lock as TSV so build.sh / fetch-deps.sh / check-bundle.sh
// never parse JSON in bash. Usage: bun scripts/lib/deps-lock.ts [--kind K] [--status S]
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

const args = process.argv.slice(2);
const opt = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const kind = opt("--kind");
const status = opt("--status");

const lock = parseDepsLock(readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"));
for (const t of lock.tools) {
  if (kind && t.kind !== kind) continue;
  if (status && t.status !== status) continue;
  console.log(
    [t.name, t.version, t.url, t.sha256, t.archive, t.extract, t.bundlePath, t.entitlements, t.status, t.kind, String(t.exposeByDefault)].join(
      "\t",
    ),
  );
}
