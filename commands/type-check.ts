#!/usr/bin/env bun

/**
 * rt type-check — tsgo type-checking with baseline regression detection.
 *
 * Reads the app's real tsconfig.json, patches it for tsgo compatibility,
 * writes a temp file to /tmp, and runs tsgo piped through tsc-baseline.
 * Zero footprint in the target repo. Baselines stored in ~/.rt/<repo>/baselines/.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, symlinkSync, copyFileSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { requireIdentity, getWorkspacePackages } from "../lib/repo.ts";
import { createTsgoConfig } from "../lib/tsconfig.ts";

function checkDependencies(): boolean {
  let ok = true;
  try {
    execSync("which tsgo", { stdio: "pipe" });
  } catch {
    console.log(`  ${red}✗ tsgo not found${reset}`);
    console.log(`  ${dim}install: npm install -g @typescript/native-preview${reset}`);
    ok = false;
  }
  try {
    execSync("which tsc-baseline", { stdio: "pipe" });
  } catch {
    console.log(`  ${red}✗ tsc-baseline not found${reset}`);
    console.log(`  ${dim}install: npm install -g tsc-baseline${reset}`);
    ok = false;
  }
  return ok;
}

function baselinePath(dataDir: string, appName: string): string {
  const dir = join(dataDir, "baselines");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${appName}.tsc-baseline.json`);
}

function setupBaselineDir(baselineFile: string): string {
  const tmpDir = join("/tmp", "rt-typecheck-work");
  mkdirSync(tmpDir, { recursive: true });
  const linkPath = join(tmpDir, ".tsc-baseline.json");
  try { unlinkSync(linkPath); } catch { /* doesn't exist */ }
  if (existsSync(baselineFile)) {
    symlinkSync(baselineFile, linkPath);
  }
  return tmpDir;
}

function copyBaselineBack(tmpDir: string, baselineFile: string): void {
  const generated = join(tmpDir, ".tsc-baseline.json");
  if (existsSync(generated)) {
    copyFileSync(generated, baselineFile);
  }
}

// ─── Tsgo + baseline pipeline helpers ────────────────────────────────────────

function runTsgo(appDir: string, tmpConfig: string): string {
  const result = spawnSync("tsgo", ["-p", tmpConfig, "--noEmit"], {
    cwd: appDir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  return (result.stdout || "") + (result.stderr || "");
}

function runBaseline(
  mode: "check" | "save",
  workDir: string,
  input: string,
): { status: number | null; stdout: string } {
  const result = spawnSync(
    "tsc-baseline",
    [mode, "--ignoreMessages"],
    {
      cwd: workDir,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", mode === "check" ? "inherit" : "pipe"],
    },
  );
  return { status: result.status, stdout: result.stdout || "" };
}

export async function run(args: string[]): Promise<void> {
  const identity = await requireIdentity("rt type-check");

  const { repoRoot, dataDir } = identity;

  // Auto-discover apps with tsconfig.json
  const targets = getWorkspacePackages(repoRoot)
    .filter(pkg => pkg.path.startsWith("apps/"))
    .filter(pkg => existsSync(join(repoRoot, pkg.path, "tsconfig.json")))
    .map(pkg => pkg.path);

  if (targets.length === 0) {
    console.log(`\n  ${yellow}no apps with tsconfig.json found${reset}\n`);
    process.exit(1);
  }

  if (!checkDependencies()) {
    process.exit(1);
  }

  let mode: "check" | "save" = "check";
  let targetArg: string | undefined;

  for (const arg of args) {
    if (arg === "save") {
      mode = "save";
    } else if (!arg.startsWith("-")) {
      targetArg = arg;
    }
  }

  let target: string;
  if (targetArg) {
    const match = targets.find(
      (t) => t === targetArg || basename(t) === targetArg,
    );
    if (!match) {
      console.log(`\n  ${red}unknown target: ${targetArg}${reset}`);
      console.log(`  ${dim}available: ${targets.join(", ")}${reset}\n`);
      process.exit(1);
    }
    target = match;
  } else if (targets.length === 1) {
    target = targets[0]!;
  } else {
    const { select } = await import("../lib/rt-render.tsx");
    target = await select({
      message: "Select type-check target",
      options: targets.map((t) => ({ label: t, value: t, hint: basename(t) || t })),
    });
  }

  const appDir = join(repoRoot, target);
  const tsconfigPath = join(appDir, "tsconfig.json");
  const appName = target.replace(/\//g, "-");

  if (!existsSync(tsconfigPath)) {
    console.log(`\n  ${red}tsconfig.json not found at ${tsconfigPath}${reset}\n`);
    process.exit(1);
  }

  const tmpConfig = createTsgoConfig(tsconfigPath, appName);
  const baselineFile = baselinePath(dataDir, appName);

  if (mode === "check" && !existsSync(baselineFile)) {
    console.log(`\n  ${yellow}no baseline found for ${basename(target)}${reset}`);
    console.log(`  ${dim}run ${bold}rt type-check save${reset}${dim} first on a known-good TypeScript state${reset}`);
    console.log(`  ${dim}this creates the baseline at ${baselineFile}${reset}\n`);
    process.exit(1);
  }

  const workDir = setupBaselineDir(baselineFile);

  const pkgName = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
      return pkg.name || basename(target);
    } catch {
      return basename(target);
    }
  })();

  console.log("");

  const tsgoOutput = runTsgo(appDir, tmpConfig);

  if (mode === "check") {
    console.log(`  ${bold}${cyan}type-checking${reset} ${pkgName} ${dim}with tsgo (baseline mode)${reset}`);
    console.log(`  ${dim}config: ${tmpConfig}${reset}`);
    console.log(`  ${dim}baseline: ${baselineFile}${reset}`);
    console.log("");

    if (!tsgoOutput.trim()) {
      console.log(`  ${green}${bold}✓ zero errors${reset}\n`);
      return;
    }

    const result = runBaseline("check", workDir, tsgoOutput);
    if (result.status !== 0) {
      if (result.stdout) console.log(result.stdout);
      process.exit(result.status || 1);
    }
  } else {
    console.log(`  ${bold}${cyan}saving baseline${reset} for ${pkgName}`);
    console.log("");

    const result = runBaseline("save", workDir, tsgoOutput);
    if (result.status === 0) {
      copyBaselineBack(workDir, baselineFile);
      console.log(`\n  ${green}${bold}✓ baseline saved${reset} → ${dim}${baselineFile}${reset}\n`);
    } else {
      process.exit(result.status || 1);
    }
  }
}
