#!/usr/bin/env bun

/**
 * rt open — Open GitLab/GitHub pages for the current branch.
 *
 * Derives the base URL from the git remote, no config needed.
 *   rt open mr       — merge request page
 *   rt open pipeline  — CI pipelines
 *   rt open repo      — repository homepage
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { requireIdentity } from "../lib/repo.ts";

export async function run(args: string[]): Promise<void> {
  const identity = await requireIdentity("rt open");

  const { baseUrl, repoName } = identity;
  let branch: string;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    console.log(`\n  ${red}could not determine current branch${reset}\n`);
    process.exit(1);
  }

  const target = args[0] || "mr";
  let url: string;

  switch (target) {
    case "mr":
    case "merge-request":
      url = `${baseUrl}/-/merge_requests?scope=all&search=${encodeURIComponent(branch)}`;
      break;
    case "pipeline":
    case "pipelines":
    case "ci":
      url = `${baseUrl}/-/pipelines?ref=${encodeURIComponent(branch)}`;
      break;
    case "repo":
      url = baseUrl;
      break;
    default:
      console.log(`\n  ${red}unknown target: ${target}${reset}`);
      console.log(`  ${dim}available: mr, pipeline, repo${reset}\n`);
      process.exit(1);
  }

  console.log(`\n  ${bold}${cyan}rt open${reset} ${dim}(${repoName})${reset}`);
  console.log(`  ${dim}branch: ${branch}${reset}`);
  console.log(`  ${green}→${reset} ${url}\n`);

  try {
    execSync(`open "${url}"`, { stdio: "pipe" });
  } catch {
    console.log(`  ${yellow}could not open browser — copy the URL above${reset}`);
  }
}
