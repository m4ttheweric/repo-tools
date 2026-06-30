/**
 * rt open — Open external pages for the current branch.
 *
 *   rt open              interactive picker
 *   rt open mr           GitLab merge request
 *   rt open pipeline     GitLab CI pipelines
 *   rt open repo         GitLab/GitHub repo page
 *   rt open ticket       Linear ticket (desktop app or web)
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { extractLinearId } from "../lib/linear.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentBranch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

type Forge = "github" | "gitlab";

function getBaseUrl(): { baseUrl: string; repoName: string; forge: Forge } {
  let remote: string;
  try {
    remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    console.log(`\n  ${yellow}this repo has no origin remote — nothing to open${reset}`);
    console.log(`  ${dim}add one with: git remote add origin <url>${reset}\n`);
    process.exit(1);
  }

  // SSH: git@gitlab.com:org/repo.git → https://gitlab.com/org/repo
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (sshMatch) {
    const host = sshMatch[1]!;
    const repoName = sshMatch[2]!.split("/").pop() || sshMatch[2]!;
    const forge: Forge = host.includes("github") ? "github" : "gitlab";
    return { baseUrl: `https://${host}/${sshMatch[2]}`, repoName, forge };
  }

  // HTTPS: https://gitlab.com/org/repo.git → same
  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (httpsMatch) {
    const host = httpsMatch[1]!;
    const repoName = httpsMatch[2]!.split("/").pop() || httpsMatch[2]!;
    const forge: Forge = host.includes("github") ? "github" : "gitlab";
    return { baseUrl: `https://${host}/${httpsMatch[2]}`, repoName, forge };
  }

  throw new Error(`could not parse remote URL: ${remote}`);
}

function openUrl(url: string): void {
  console.log(`  ${green}→${reset} ${dim}${url}${reset}\n`);
  try {
    execSync(`open "${url}"`, { stdio: "pipe" });
  } catch {
    console.log(`  ${yellow}could not open — copy the URL above${reset}`);
  }
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

export async function openMR(): Promise<void> {
  const branch = getCurrentBranch();
  const { repoName, forge } = getBaseUrl();

  console.log(`\n  ${dim}${repoName} · ${branch}${reset}`);

  const cmd = forge === "github" ? "gh pr view --web" : "glab mr view --web";
  try {
    execSync(cmd, { stdio: "pipe" });
  } catch {
    console.log(`  ${yellow}no open ${forge === "github" ? "PR" : "MR"} found for this branch${reset}\n`);
  }
}

export async function openPipeline(): Promise<void> {
  const branch = getCurrentBranch();
  const { baseUrl, repoName, forge } = getBaseUrl();

  const url = forge === "github"
    ? `${baseUrl}/actions?query=branch%3A${encodeURIComponent(branch)}`
    : `${baseUrl}/-/pipelines?ref=${encodeURIComponent(branch)}`;

  console.log(`\n  ${dim}${repoName} · ${branch}${reset}`);
  openUrl(url);
}

export async function openRepo(): Promise<void> {
  const { baseUrl, repoName } = getBaseUrl();

  console.log(`\n  ${dim}${repoName}${reset}`);
  openUrl(baseUrl);
}

export async function openTicket(): Promise<void> {
  const branch = getCurrentBranch();

  const linearId = extractLinearId(branch);
  if (!linearId) {
    console.log(`\n  ${yellow}no Linear ticket ID found in branch: ${dim}${branch}${reset}\n`);
    process.exit(1);
  }

  // Try daemon cache for rich data
  let url: string | null = null;
  let title: string | null = null;
  let stateName: string | null = null;

  const result = await daemonQuery("cache:read");
  if (result?.ok && result.data) {
    const entry = result.data[branch];
    if (entry?.ticket?.url) {
      url = entry.ticket.url;
      title = entry.ticket.title;
      stateName = entry.ticket.stateName;
    }
  }

  if (!url) {
    url = `https://linear.app/issue/${linearId}`;
  }

  console.log(`\n  ${bold}${cyan}${linearId}${reset}${title ? `  ${title}` : ""}${stateName ? `  ${dim}[${stateName}]${reset}` : ""}`);
  openUrl(url);
}
