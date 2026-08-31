import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";

// Files with sync-exec that Phase 1 does NOT remove. Each entry names the
// finding/phase that will delete it, so this list shrinks as later phases land.
// A regression that reintroduces sync-exec into any OTHER daemon-reachable
// module fails this gate (the rule has been re-broken twice).
const ALLOWLIST = new Set<string>([
  "lib/daemon/user-path.ts",        // Phase 6 PATH rebuild (S013/S014/S062)
  "lib/daemon/boot-reconcile.ts",   // Phase 0.6 / S044 (Bun.sleepSync)
  "lib/state/db.ts",                // Phase 0.7 / S072-S073 busy-retry
  "lib/state/busy.ts",              // Phase 0.7 / S072-S073 busy-retry
  "lib/repo-index.ts",              // Phase 5.3 dedup (heal/derive execSync)
  "lib/repo.ts",                    // R050 / Phase 5.4 (via handlers/system-processes.ts)
  "lib/git.ts",                     // R050 / Phase 5.4 (via repo.ts)
  "lib/herdr-launch.ts",            // Phase 5 herdr (via handlers/pane.ts)
  "lib/rt-render.ts",              // R050 / Phase 5.4 (daemon carries the TUI)
]);

const SYNC_EXEC = [
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\bBun\.spawnSync\s*\(/,
  /\bBun\.sleepSync\s*\(/,
];

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const stripShebang = (s: string) => s.replace(/^#!.*\n/, "");
const tsT = new Bun.Transpiler({ loader: "ts" });
const tsxT = new Bun.Transpiler({ loader: "tsx" });
const loaderFor = (f: string) => (f.endsWith(".tsx") || f.endsWith(".jsx") ? tsxT : tsT);

/** Files reachable from lib/daemon.ts via relative imports (the daemon graph). */
function daemonClosure(): string[] {
  const entry = resolve(REPO_ROOT, "lib/daemon.ts");
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let src: string;
    try { src = stripShebang(readFileSync(file, "utf8")); } catch { continue; }
    let imports: { path: string }[];
    try { imports = loaderFor(file).scanImports(src); } catch { continue; }
    for (const imp of imports) {
      if (!imp.path.startsWith(".")) continue; // external package
      stack.push(resolve(dirname(file), imp.path));
    }
  }
  return [...visited];
}

function hasSyncExec(source: string): boolean {
  return SYNC_EXEC.some((re) => re.test(source));
}

test("no daemon-reachable module calls sync exec (outside the allowlist)", () => {
  const offenders: string[] = [];
  for (const file of daemonClosure()) {
    const rel = file.replace(REPO_ROOT + "/", "");
    if (ALLOWLIST.has(rel)) continue;
    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    if (hasSyncExec(src)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

test("the checker flags a reintroduced sync-exec call (proves the gate bites)", () => {
  // Permanent RED proof: the matcher must catch a fresh offense.
  expect(hasSyncExec(`import { execSync } from "child_process";\nexecSync("true");`)).toBe(true);
  expect(hasSyncExec(`await Bun.sleepSync(10);`)).toBe(true);
  expect(hasSyncExec(`// a comment mentioning execSync without a call`)).toBe(false);
});

test("the daemon closure actually resolves (guards against a walker that finds nothing)", () => {
  const closure = daemonClosure();
  expect(closure.length).toBeGreaterThan(50); // ~151 today; a collapse means the walk broke
});
