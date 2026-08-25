import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { RT_BINARY } from "./harness.ts";

const REPO_ROOT = import.meta.dir.replace("/e2e", "");

/** Newest mtime (ms) under `path`, file or directory — a stat walk, no hashing. */
function newestMtimeMs(path: string): number {
  const st = statSync(path);
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory()) return 0;
  let newest = 0;
  for (const entry of readdirSync(path)) {
    try {
      newest = Math.max(newest, newestMtimeMs(join(path, entry)));
    } catch { /* removed between readdir and stat — ignore */ }
  }
  return newest;
}

/**
 * A binary that exists but predates its own sources tests old code with no
 * signal at all — a leftover build turns a missing verb into a convincing
 * test failure.
 */
function rtBinaryIsStale(): boolean {
  if (!existsSync(RT_BINARY)) return true;
  const binaryMtime = statSync(RT_BINARY).mtimeMs;
  const sources = ["cli.ts", "lib", "commands", "packages/rt-client/src"].map((p) => join(REPO_ROOT, p));
  const newestSource = Math.max(0, ...sources.filter(existsSync).map(newestMtimeMs));
  return newestSource > binaryMtime;
}

if (!process.env.RT_BINARY && rtBinaryIsStale()) {
  console.log("e2e: building rt binary...");
  const proc = Bun.spawnSync([
    "bun", "build", "--compile",
    "./cli.ts",
    "--outfile", RT_BINARY,
    "--define", 'RT_VERSION="e2e-test"',
  ], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    console.error("e2e: failed to build rt binary");
    process.exit(1);
  }

  Bun.spawnSync([
    "codesign", "--remove-signature", RT_BINARY,
  ]);
  Bun.spawnSync([
    "codesign", "--force", "--sign", "-",
    "--entitlements", import.meta.dir.replace("/e2e", "/scripts/entitlements.plist"),
    RT_BINARY,
  ]);

  console.log("e2e: binary built and signed at", RT_BINARY);
}
