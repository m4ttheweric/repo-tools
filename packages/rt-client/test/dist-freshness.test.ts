/**
 * Guards against a stale on-disk dist/ silently breaking rt-client's
 * node/type consumers. package.json's "exports" map routes bun
 * (`"bun": "./src/index.ts"`) straight to source, so bun consumers never see
 * dist/ at all — this only protects the "types" and "import"/"default"
 * conditions (node consumers, and any type-checker that resolves through
 * those conditions instead of the bun one).
 *
 * dist/ is a GITIGNORED build artifact, not something committed to git —
 * `file:` consumers (mr-board, gitq) install by copying whatever dist/
 * happens to be sitting on disk at install time. `prepack` (package.json)
 * only rebuilds dist/ for `npm pack`/publish; it does nothing for that
 * local dev-linking path, so an on-disk dist/ that's drifted from src/ is
 * invisible to every other guard in this repo.
 *
 * This must DETECT staleness, not repair it: it builds into a throwaway
 * temp dir and diffs that fresh output — file listing AND byte content of
 * every emitted file (the JS bundle, every .d.ts) — against dist/ actually
 * sitting on disk, failing on any mismatch. It never writes into the real
 * dist/. A passing run proves the on-disk dist/ is current; a failing one
 * (including a missing dist/ — the state a fresh clone starts in) names
 * `bun run build` as the fix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

const pkgDir = join(import.meta.dir, "..");
const onDiskDist = join(pkgDir, "dist");

let tmpOutDir: string | undefined;

afterEach(() => {
  if (tmpOutDir) rmSync(tmpOutDir, { recursive: true, force: true });
  tmpOutDir = undefined;
});

/** Builds JS + .d.ts into a fresh temp dir, entirely separate from the real dist/ — this never touches the on-disk copy under test. */
function buildIntoTempDir(): string {
  const outDir = mkdtempSync(join(tmpdir(), "rt-client-dist-check-"));
  tmpOutDir = outDir;

  const bundle = Bun.spawnSync(
    ["bun", "build", "src/index.ts", "--outdir", outDir, "--target", "node", "--format", "esm", "--packages", "external"],
    { cwd: pkgDir, stdout: "pipe", stderr: "pipe" },
  );
  if (bundle.exitCode !== 0) throw new Error(`bun build failed:\n${bundle.stderr.toString()}`);

  // Mirrors the package build's second entry: the browser-safe identity
  // codec bundled separately (target browser) for the ./identity subpath.
  const codec = Bun.spawnSync(
    ["bun", "build", "src/settings/identity-codec.ts", "--outfile", join(outDir, "settings", "identity-codec.js"), "--target", "browser", "--format", "esm"],
    { cwd: pkgDir, stdout: "pipe", stderr: "pipe" },
  );
  if (codec.exitCode !== 0) throw new Error(`bun build (identity codec) failed:\n${codec.stderr.toString()}`);

  const types = Bun.spawnSync(
    ["bunx", "tsc", "-p", "tsconfig.json", "--outDir", outDir],
    { cwd: pkgDir, stdout: "pipe", stderr: "pipe" },
  );
  if (types.exitCode !== 0) throw new Error(`tsc -p tsconfig.json failed:\n${types.stdout.toString()}${types.stderr.toString()}`);

  return outDir;
}

/** Every file under `root`, as paths relative to `root`, sorted — recurses into subdirs (dist/settings/*.d.ts included). */
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

describe("dist/ freshness", () => {
  test("the on-disk dist/ matches a fresh build — every emitted file, not just index.d.ts", () => {
    if (!existsSync(onDiskDist)) {
      throw new Error(
        "dist/ does not exist on disk. It's gitignored (a build artifact, not checked into git), and " +
          "file: consumers (mr-board, gitq) install by copying whatever's there — run `bun run build` " +
          "in packages/rt-client, then rerun this test.",
      );
    }

    const freshDir = buildIntoTempDir();
    const freshFiles = listFilesRecursive(freshDir);
    const onDiskFiles = listFilesRecursive(onDiskDist);

    expect(onDiskFiles).toEqual(freshFiles);

    for (const file of freshFiles) {
      const fresh = readFileSync(join(freshDir, file));
      const onDisk = readFileSync(join(onDiskDist, file));
      if (!fresh.equals(onDisk)) {
        throw new Error(
          `dist/${file} is stale — it no longer matches a fresh build. dist/ is a gitignored artifact ` +
            "that file: consumers copy as-is; prepack only regenerates it for npm publish, not for local " +
            "dev-linking. Run `bun run build` in packages/rt-client.",
        );
      }
    }
  }, 20_000);

  test("a fresh build's commands.d.ts carries the deck-scope catalog (cfApiToken) — catches whitelist/build drift", () => {
    const freshDir = buildIntoTempDir();
    const contents = readFileSync(join(freshDir, "commands.d.ts"), "utf8");
    expect(contents).toContain("cfApiToken");
  }, 20_000);
});
