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
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const BINARY = resolve(import.meta.dir, "..", "dist", "rt");
const WARMUP_RUNS = 2;
const TIMED_RUNS = 10;
const DEFAULT_THRESHOLD_MS = 86;
const threshold = Number(process.argv[2] ?? DEFAULT_THRESHOLD_MS);

function runOnce(): number {
  const start = performance.now();
  const result = spawnSync(BINARY, ["--version"], { stdio: "ignore" });
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
