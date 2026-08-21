/**
 * Guards against a stale dist/ silently breaking rt-client's node/type
 * consumers. package.json's "exports" map routes bun (`"bun": "./src/index.ts"`)
 * straight to source, so bun consumers never see a stale dist/ at all — this
 * only protects the "types" and "import"/"default" conditions (node
 * consumers, and any type-checker that resolves through those conditions
 * instead of the bun one), and `file:` consumers (mr-board, gitq), which
 * install by copying whatever dist/ currently holds on disk.
 *
 * This must DETECT staleness, not repair it: it builds into a throwaway
 * temp dir and diffs that fresh output against the dist/ actually sitting
 * on disk, failing on any mismatch. It never writes into the real dist/ —
 * a passing run proves dist/ is current; a failing one means someone needs
 * to run `bun run build` (or prepack needs to, at publish time) before the
 * checked-in copy is trustworthy again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

  const types = Bun.spawnSync(
    ["bunx", "tsc", "-p", "tsconfig.json", "--outDir", outDir],
    { cwd: pkgDir, stdout: "pipe", stderr: "pipe" },
  );
  if (types.exitCode !== 0) throw new Error(`tsc -p tsconfig.json failed:\n${types.stdout.toString()}${types.stderr.toString()}`);

  return outDir;
}

describe("dist/ freshness", () => {
  test("the committed dist/ matches a from-scratch build byte for byte", () => {
    const freshDir = buildIntoTempDir();

    if (!existsSync(onDiskDist)) {
      throw new Error("dist/ is missing on disk — run `bun run build` in packages/rt-client");
    }

    for (const file of ["index.d.ts", "commands.d.ts"]) {
      const fresh = readFileSync(join(freshDir, file), "utf8");
      const onDisk = readFileSync(join(onDiskDist, file), "utf8");
      if (fresh !== onDisk) {
        throw new Error(`dist/${file} is stale — it no longer matches a fresh build. Run \`bun run build\` in packages/rt-client.`);
      }
    }
  });

  test("a fresh build's commands.d.ts carries the deck-scope catalog (cfApiToken) — catches whitelist/build drift", () => {
    const freshDir = buildIntoTempDir();
    const contents = readFileSync(join(freshDir, "commands.d.ts"), "utf8");
    expect(contents).toContain("cfApiToken");
  });
});
