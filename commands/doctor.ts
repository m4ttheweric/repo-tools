#!/usr/bin/env bun

/**
 * rt doctor — Environment health check.
 *
 * On-demand diagnostics for the current repo.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { bold, cyan, dim, green, yellow, red, reset, white } from "../lib/tui.ts";
import { getRepoIdentity, getRepoRoot, getCurrentBranch } from "../lib/repo.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function commandOutput(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function dirSize(dirPath: string): string | null {
  if (!existsSync(dirPath)) return null;
  try {
    const raw = execSync(`du -sh "${dirPath}" 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    return raw.split("\t")[0] || null;
  } catch {
    return null;
  }
}

function check(ok: boolean, label: string, detail: string): void {
  const icon = ok ? `${green}✓${reset}` : `${red}✗${reset}`;
  console.log(`  ${icon} ${label}  ${dim}${detail}${reset}`);
}

function info(label: string, detail: string): void {
  console.log(`  ${dim}●${reset} ${label}  ${dim}${detail}${reset}`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(_args: string[]): Promise<void> {
  const repoRoot = getRepoRoot();
  const identity = getRepoIdentity();

  console.log("");
  console.log(`  ${bold}${cyan}rt doctor${reset}`);
  console.log("");

  // ─── Git info ──────────────────────────────────────────────────────────────

  if (repoRoot) {
    const branch = getCurrentBranch();
    const configLabel = identity
      ? `  ${dim}repo: ${identity.repoName}  data: ~/.rt/${identity.repoName}/${reset}`
      : `  ${dim}no matching config${reset}`;

    info("repo", repoRoot);
    if (branch) info("branch", branch);
    console.log(configLabel);

    // Dirty files
    const status = commandOutput(`git -C "${repoRoot}" status --porcelain`);
    if (status) {
      const count = status.split("\n").filter((l) => l.trim()).length;
      check(false, "working tree", `${count} dirty file${count !== 1 ? "s" : ""}`);
    } else {
      check(true, "working tree", "clean");
    }

    // Ahead/behind
    const trackingOutput = commandOutput(
      `git -C "${repoRoot}" rev-list --left-right --count HEAD...@{upstream} 2>/dev/null`,
    );
    if (trackingOutput) {
      const parts = trackingOutput.split("\t").map(Number);
      const ahead = parts[0] ?? 0;
      const behind = parts[1] ?? 0;
      if (ahead === 0 && behind === 0) {
        check(true, "sync", "up to date with remote");
      } else {
        const parts: string[] = [];
        if (ahead > 0) parts.push(`${ahead} ahead`);
        if (behind > 0) parts.push(`${behind} behind`);
        check(false, "sync", parts.join(", "));
      }
    }
  } else {
    console.log(`  ${yellow}not in a git repo${reset}`);
  }

  console.log("");

  // ─── Node / pnpm ──────────────────────────────────────────────────────────

  const nodeVersion = commandOutput("node -v");
  if (nodeVersion) {
    const currentVersion = nodeVersion.replace(/^v/, "");
    if (repoRoot) {
      const nvmrcPath = join(repoRoot, ".nvmrc");
      if (existsSync(nvmrcPath)) {
        const required = readFileSync(nvmrcPath, "utf8")
          .split("\n")
          .filter((l) => !l.startsWith("#"))
          .join("")
          .trim();
        const matches = currentVersion === required;
        check(matches, "node", `${currentVersion} ${matches ? "=" : "≠"} required ${required}`);
      } else {
        info("node", currentVersion);
      }
    } else {
      info("node", currentVersion);
    }
  } else {
    check(false, "node", "not found");
  }

  const pnpmVersion = commandOutput("pnpm --version");
  if (pnpmVersion) {
    info("pnpm", pnpmVersion);
  } else {
    check(false, "pnpm", "not found");
  }

  // ─── tsgo ──────────────────────────────────────────────────────────────────

  const tsgoVersion = commandOutput("tsgo --version");
  if (tsgoVersion) {
    info("tsgo", tsgoVersion);
  } else {
    check(false, "tsgo", "not installed — npm install -g @typescript/native-preview");
  }

  const zellijVersion = commandOutput("zellij --version");
  if (zellijVersion) {
    info("zellij", zellijVersion);
  } else {
    check(false, "zellij", "not installed — brew install zellij (required for rt dev)");
  }

  const baselineVersion = commandOutput("tsc-baseline --version");
  if (baselineVersion) {
    info("tsc-baseline", baselineVersion);
  } else {
    check(false, "tsc-baseline", "not installed — npm install -g tsc-baseline");
  }

  console.log("");

  // ─── Hooks health ─────────────────────────────────────────────────────────

  if (repoRoot && identity) {
    const hooksPath = commandOutput(`git -C "${repoRoot}" config core.hooksPath`);
    const shimDir = join(identity.dataDir, "hooks");

    if (hooksPath && hooksPath.includes(".rt")) {
      // Hooks are redirected to rt shims
      if (existsSync(shimDir)) {
        const hookFiles = readdirSync(shimDir).filter(f => !f.startsWith("."));
        check(hookFiles.length > 0, "hooks", `managed by rt (${hookFiles.length} shims in ~/.rt/${identity.repoName}/hooks/)`);

        // Report disabled hooks
        const configPath = join(identity.dataDir, "hooks.json");
        if (existsSync(configPath)) {
          try {
            const raw = JSON.parse(readFileSync(configPath, "utf8"));
            if (!raw.enabled) {
              console.log(`    ${red}⏸ all hooks disabled${reset}`);
            } else {
              const disabledHooks = Object.entries(raw.hooks || {})
                .filter(([_, v]) => !v)
                .map(([k]) => k);
              if (disabledHooks.length > 0) {
                console.log(`    ${yellow}disabled: ${disabledHooks.join(", ")}${reset}`);
              }
            }
          } catch { /* ignore */ }
        }
      } else {
        check(false, "hooks", `core.hooksPath points to missing directory — run ${bold}rt hooks status${reset} to repair`);
      }
    } else {
      info("hooks", `using ${hooksPath || ".git/hooks"} (not managed by rt)`);
    }

    console.log("");
  }

  // ─── Disk usage ────────────────────────────────────────────────────────────

  if (repoRoot) {
    const dirs = [
      { path: "node_modules", label: "node_modules" },
      { path: ".turbo", label: ".turbo" },
      { path: ".next", label: ".next" },
      { path: "dist", label: "dist" },
    ];

    let anyDisk = false;
    for (const { path, label } of dirs) {
      const fullPath = join(repoRoot, path);
      const size = dirSize(fullPath);
      if (size) {
        if (!anyDisk) {
          console.log(`  ${dim}disk usage${reset}`);
          anyDisk = true;
        }
        console.log(`    ${dim}${label}${reset}  ${white}${size}${reset}`);
      }
    }

    if (anyDisk) console.log("");
  }
}
