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

function getBaseUrl(): { baseUrl: string; repoName: string } {
  const remote = execSync("git config --get remote.origin.url", {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

  // SSH: git@gitlab.com:org/repo.git → https://gitlab.com/org/repo
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (sshMatch) {
    const repoName = sshMatch[2]!.split("/").pop() || sshMatch[2]!;
    return { baseUrl: `https://${sshMatch[1]}/${sshMatch[2]}`, repoName };
  }

  // HTTPS: https://gitlab.com/org/repo.git → same
  const httpsMatch = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (httpsMatch) {
    const repoName = httpsMatch[2]!.split("/").pop() || httpsMatch[2]!;
    return { baseUrl: `https://${httpsMatch[1]}/${httpsMatch[2]}`, repoName };
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
  const { baseUrl, repoName } = getBaseUrl();
  const url = `${baseUrl}/-/merge_requests?scope=all&search=${encodeURIComponent(branch)}`;

  console.log(`\n  ${dim}${repoName} · ${branch}${reset}`);
  openUrl(url);
}

export async function openPipeline(): Promise<void> {
  const branch = getCurrentBranch();
  const { baseUrl, repoName } = getBaseUrl();
  const url = `${baseUrl}/-/pipelines?ref=${encodeURIComponent(branch)}`;

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
