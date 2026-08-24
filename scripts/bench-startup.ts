#!/usr/bin/env bun

/**
 * Startup benchmark for the compiled rt binary.
 *
 * Runs `dist/rt --version` and reports min/median/max wall time.
 * Verifies the binary exists and exits 0 before trusting any timing —
 * a missing or crashing binary returns near-instantly and reads as a
 * fast result if that check is skipped.
 *
 * Usage: bun scripts/bench-startup.ts [thresholdMs]
 *
 * Default threshold (86ms) is 20% above the ~71.5ms median achieved after
 * the lazy module registry (task 2) and the remaining eager-TUI cleanup
 * (task 3) — see .superpowers/sdd/2026-08-22-startup-and-substrate/task-3-report.md.
 * Wired into the release workflow so a reintroduced eager import (e.g. a
 * static rt-render/ink import in command-tree.ts or module-registry.ts)
 * fails the build instead of shipping silently.
 *
 * ADVISORY on macos-15 (release.yml runs this step with continue-on-error)
 * — the threshold above was set on different hardware and has never been
 * calibrated against that runner. Exit code below still reflects pass/fail;
 * only the workflow step is non-blocking. Remove continue-on-error there
 * once a real macos-15 baseline sets this number.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const BINARY = resolve(import.meta.dir, "..", "dist", "rt");
/**
 * The compiled binary reads and WRITES ~/.mattstack on any invocation — even
 * `--version` runs the first-run check. Benchmarking it against the
 * developer's real HOME indexes whatever repo the benchmark happens to run
 * in, so every run gets a throwaway one, per the repo's "a built binary is
 * only ever run under an isolated HOME" rule.
 */
const BENCH_HOME = mkdtempSync(join(tmpdir(), "rt-bench-home-"));
process.on("exit", () => rmSync(BENCH_HOME, { recursive: true, force: true }));
const WARMUP_RUNS = 2;
const TIMED_RUNS = 10;
const DEFAULT_THRESHOLD_MS = 86;
const threshold = Number(process.argv[2] ?? DEFAULT_THRESHOLD_MS);

function runOnce(): number {
  const start = performance.now();
  const result = spawnSync(BINARY, ["--version"], { stdio: "ignore", env: { ...process.env, HOME: BENCH_HOME } });
  const elapsed = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(`rt --version exited ${result.status} (signal ${result.signal})`);
  }
  return elapsed;
}

if (!existsSync(BINARY)) {
  console.error(`bench-startup: binary not found at ${BINARY} — build with:`);
  console.error(`  bun build --compile ./cli.ts --outfile dist/rt`);
  process.exit(1);
}

try {
  for (let i = 0; i < WARMUP_RUNS; i++) runOnce();
} catch (err) {
  console.error(`bench-startup: warmup run failed — ${(err as Error).message}`);
  process.exit(1);
}

const timings: number[] = [];
try {
  for (let i = 0; i < TIMED_RUNS; i++) timings.push(runOnce());
} catch (err) {
  console.error(`bench-startup: timed run failed — ${(err as Error).message}`);
  process.exit(1);
}

if (timings.length === 0) {
  console.error("bench-startup: no timed runs recorded");
  process.exit(1);
}

timings.sort((a, b) => a - b);
const min = timings.at(0)!;
const max = timings.at(-1)!;
const mid = Math.floor(timings.length / 2);
const median = timings.length % 2 === 0 ? (timings.at(mid - 1)! + timings.at(mid)!) / 2 : timings.at(mid)!;

console.log(`rt --version: min=${min.toFixed(1)}ms median=${median.toFixed(1)}ms max=${max.toFixed(1)}ms (n=${TIMED_RUNS})`);

if (median > threshold) {
  console.error(`bench-startup: median ${median.toFixed(1)}ms exceeds threshold ${threshold}ms`);
  process.exit(1);
}
