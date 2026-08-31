// Resolves a workflow_dispatch apps input against deps.lock's repo-bearing
// rows and emits the build matrix. Unknown names fail the whole dispatch
// before anything builds.
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../../lib/bundle-layout.ts";

export function planMatrix(lockText: string, appsInput: string): { name: string; repo: string }[] {
  const buildable = parseDepsLock(lockText)
    .tools.filter((t) => t.repo)
    .map((t) => ({ name: t.name, repo: t.repo! }));
  const input = appsInput.trim();
  if (!input) throw new Error(`apps input is empty; pass app names or "all"`);
  if (input === "all") return buildable;
  return input.split(",").map((raw) => {
    const name = raw.trim();
    const row = buildable.find((b) => b.name === name);
    if (!row) {
      const known = buildable.map((b) => b.name).join(", ");
      throw new Error(`unknown app "${name}" (buildable: ${known})`);
    }
    return row;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const lockFlag = args.indexOf("--lock");
  const lockPath = lockFlag >= 0
    ? args[lockFlag + 1]!
    : join(import.meta.dir, "..", "..", "rt-tray", "deps.lock");
  const appsArgs = args.filter((_, i) => lockFlag < 0 || (i !== lockFlag && i !== lockFlag + 1));
  const apps = appsArgs[0] ?? "";
  try {
    console.log(JSON.stringify({ include: planMatrix(readFileSync(lockPath, "utf8"), apps) }));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
