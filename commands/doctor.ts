#!/usr/bin/env bun

/**
 * rt doctor — Environment health check.
 *
 * Checks all rt dependencies, daemon health, API token status,
 * extension installation, and shell integration.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

function check(ok: boolean, label: string, detail: string): void {
  const icon = ok ? `${green}✓${reset}` : `${red}✗${reset}`;
  console.log(`  ${icon} ${label}  ${dim}${detail}${reset}`);
}

function warn(label: string, detail: string): void {
  console.log(`  ${yellow}⚠${reset} ${label}  ${dim}${detail}${reset}`);
}

function info(label: string, detail: string): void {
  console.log(`  ${dim}●${reset} ${label}  ${dim}${detail}${reset}`);
}

function section(title: string): void {
  console.log(`  ${dim}── ${title} ──${reset}`);
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runDoctor(_args: string[]): Promise<void> {
  const repoRoot = getRepoRoot();
  const identity = getRepoIdentity();

  console.log("");
  console.log(`  ${bold}${cyan}rt doctor${reset}`);
  console.log("");

  // ─── Repo context ──────────────────────────────────────────────────────────

  section("repo");
  if (repoRoot) {
    const branch = getCurrentBranch();
    info("root", repoRoot);
    if (branch) info("branch", branch);
    if (identity) {
      info("data dir", `~/.rt/${identity.repoName}/`);
    }

    const status = commandOutput(`git -C "${repoRoot}" status --porcelain`);
    if (status) {
      const count = status.split("\n").filter((l) => l.trim()).length;
      check(false, "working tree", `${count} dirty file${count !== 1 ? "s" : ""}`);
    } else {
      check(true, "working tree", "clean");
    }

    const trackingOutput = commandOutput(
      `git -C "${repoRoot}" rev-list --left-right --count HEAD...@{upstream} 2>/dev/null`,
    );
    if (trackingOutput) {
      const [ahead = 0, behind = 0] = trackingOutput.split("\t").map(Number);
      if (ahead === 0 && behind === 0) {
        check(true, "remote sync", "up to date");
      } else {
        const parts: string[] = [];
        if (ahead > 0) parts.push(`${ahead} ahead`);
        if (behind > 0) parts.push(`${behind} behind`);
        warn("remote sync", parts.join(", "));
      }
    }
  } else {
    warn("repo", "not in a git repo — some checks skipped");
  }

  console.log("");

  // ─── Dependencies ─────────────────────────────────────────────────────────

  section("dependencies");

  // fzf — hard required
  const fzfVersion = commandOutput("fzf --version");
  if (fzfVersion) {
    check(true, "fzf", fzfVersion);
  } else {
    check(false, "fzf", "not found — required  brew install fzf");
  }

  // bun
  const bunVersion = commandOutput("bun --version");
  if (bunVersion) {
    check(true, "bun", bunVersion);
  } else {
    check(false, "bun", "not found — https://bun.sh");
  }

  // zellij — recommended (runner)
  const zellijVersion = commandOutput("zellij --version");
  if (zellijVersion) {
    check(true, "zellij", zellijVersion);
  } else {
    warn("zellij", "not installed — brew install zellij  (recommended for rt runner)");
  }

  // terminal-notifier — recommended (notifications)
  const tnVersion = commandOutput("terminal-notifier -version");
  if (tnVersion) {
    check(true, "terminal-notifier", tnVersion);
  } else {
    warn("terminal-notifier", "not installed — brew install terminal-notifier  (recommended for notifications)");
  }

  console.log("");

  // ─── API tokens ───────────────────────────────────────────────────────────

  section("api tokens");

  const secretsPath = join(homedir(), ".rt", "secrets.json");
  let secrets: Record<string, string> = {};
  if (existsSync(secretsPath)) {
    try {
      secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    } catch { /* ignore */ }
  }

  if (secrets.linearApiKey) {
    // Quick validation — just check it's non-empty and looks right
    const key = secrets.linearApiKey;
    check(true, "linear api key", `configured (${key.slice(0, 6)}…)`);
  } else {
    warn("linear api key", `not set — run: ${bold}rt settings linear token${reset}`);
  }

  if (secrets.linearTeamKey) {
    check(true, "linear team", `${secrets.linearTeamKey} (${secrets.linearTeamId ?? "?"})`);
  } else {
    warn("linear team", `not set — run: ${bold}rt settings linear team${reset}`);
  }

  if (secrets.gitlabToken) {
    const token = secrets.gitlabToken;
    check(true, "gitlab token", `configured (${token.slice(0, 6)}…)`);
  } else {
    warn("gitlab token", `not set — run: ${bold}rt settings gitlab token${reset}`);
  }

  console.log("");

  // ─── Extension ────────────────────────────────────────────────────────────

  section("rt-context extension");

  const editors = [
    { name: "Cursor",             appPath: "/Applications/Cursor.app",             cliBinary: "cursor" },
    { name: "Cursor Personal",    appPath: "/Applications/Cursor Personal.app",    cliBinary: "cursor" },
    { name: "Visual Studio Code", appPath: "/Applications/Visual Studio Code.app", cliBinary: "code" },
    { name: "Antigravity",        appPath: "/Applications/Antigravity.app",         cliBinary: "antigravity" },
    { name: "Windsurf",           appPath: "/Applications/Windsurf.app",            cliBinary: "windsurf" },
  ];

  let anyEditorFound = false;
  for (const editor of editors) {
    if (!existsSync(editor.appPath)) continue;
    anyEditorFound = true;

    const cliPath = join(editor.appPath, "Contents/Resources/app/bin", editor.cliBinary);
    if (!existsSync(cliPath)) {
      warn(editor.name, "app found but CLI binary missing — install Shell Command from editor");
      continue;
    }

    // Check if rt-context is installed by listing extensions
    const result = spawnSync(cliPath, ["--list-extensions"], { encoding: "utf8", timeout: 10_000 });
    const extensions = result.stdout?.split("\n").map((e: string) => e.trim().toLowerCase()) ?? [];
    const installed = extensions.some((e: string) => e.includes("rt-context") || e.includes("local.rt-context"));

    if (installed) {
      check(true, editor.name, "rt-context installed");
    } else {
      warn(editor.name, `rt-context not installed — run: ${bold}rt settings extension${reset}`);
    }
  }

  if (!anyEditorFound) {
    warn("editors", "no VS Code-compatible editors found in /Applications");
  }

  console.log("");

  // ─── Shell integration ─────────────────────────────────────────────────────

  section("shell");

  // Check rtcd alias is available
  const rtcdCheck = commandOutput("which rtcd 2>/dev/null || type rtcd 2>/dev/null");
  if (rtcdCheck && !rtcdCheck.includes("not found")) {
    check(true, "rtcd alias", "available");
  } else {
    // Check if it's in .zshrc even if not active in this shell
    const zshrc = join(homedir(), ".zshrc");
    const inZshrc = existsSync(zshrc) && readFileSync(zshrc, "utf8").includes("rtcd");
    if (inZshrc) {
      warn("rtcd alias", "defined in .zshrc but not active — restart your terminal");
    } else {
      warn("rtcd alias", "not configured — added automatically by brew install");
    }
  }

  // rt-tray
  const trayPath = join(homedir(), "Applications", "rt-tray.app");
  if (existsSync(trayPath)) {
    // Read version from Info.plist
    const plist = join(trayPath, "Contents/Info.plist");
    const trayVersion = existsSync(plist)
      ? commandOutput(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plist}" 2>/dev/null`)
      : null;
    check(true, "rt-tray", trayVersion ? `v${trayVersion} installed` : "installed");
  } else {
    warn("rt-tray", "not installed — installed automatically by brew install");
  }

  console.log("");

  // ─── Daemon ───────────────────────────────────────────────────────────────

  section("daemon");

  {
    const { isDaemonInstalled } = await import("../lib/daemon-config.ts");
    const { isDaemonRunning, daemonQuery } = await import("../lib/daemon-client.ts");

    if (isDaemonInstalled()) {
      const running = await isDaemonRunning();
      if (running) {
        const response = await daemonQuery("status");
        if (response?.ok) {
          const { pid, uptime, watchedRepos, cacheEntries } = response.data;
          check(true, "daemon", `running  pid ${pid}  uptime ${formatUptime(uptime)}`);
          console.log(`    ${dim}watching ${watchedRepos} repo${watchedRepos !== 1 ? "s" : ""}  ·  ${cacheEntries} cache entries${reset}`);
        } else {
          check(true, "daemon", "running");
        }
      } else {
        check(false, "daemon", `installed but not running — run: ${bold}rt daemon start${reset}`);
      }
    } else {
      warn("daemon", `not installed — run: ${bold}rt daemon install${reset}  (use launchd mode for auto-start on login)`);
    }
  }

  // Hooks
  if (repoRoot && identity) {
    console.log("");
    const hooksPath = commandOutput(`git -C "${repoRoot}" config core.hooksPath`);
    const shimDir = join(identity.dataDir, "hooks");

    if (hooksPath && hooksPath.includes(".rt")) {
      if (existsSync(shimDir)) {
        const hookFiles = readdirSync(shimDir).filter((f) => !f.startsWith("."));
        check(hookFiles.length > 0, "hooks", `managed by rt (${hookFiles.length} shims)`);

        const configPath = join(identity.dataDir, "hooks.json");
        if (existsSync(configPath)) {
          try {
            const raw = JSON.parse(readFileSync(configPath, "utf8"));
            if (!raw.enabled) {
              console.log(`    ${yellow}⏸ all hooks disabled${reset}`);
            } else {
              const disabled = Object.entries(raw.hooks || {})
                .filter(([_, v]) => !v)
                .map(([k]) => k);
              if (disabled.length > 0) {
                console.log(`    ${yellow}disabled: ${disabled.join(", ")}${reset}`);
              }
            }
          } catch { /* ignore */ }
        }
      } else {
        check(false, "hooks", "core.hooksPath points to missing directory — run rt hooks");
      }
    } else {
      info("hooks", `using ${hooksPath || ".git/hooks"} (not managed by rt)`);
    }
  }

  console.log("");
}
