/**
 * rt branch — GitHub Desktop-inspired branch management.
 *
 * Subcommands:
 *   switch  — Switch branches with enriched picker, stash handling, stash restore
 *   create  — Create branch from Linear ticket (existing or new)
 *
 * Team configuration has moved to `rt settings linear team`.
 * Uses the rt daemon for instant cache reads when available.
 */

import { execSync } from "child_process";
import { green, yellow, red, reset, bold, dim, cyan } from "../lib/tui.ts";
import {
  loadSecrets,
  getTeamConfig,
  createIssue,
  fetchMyTodoTickets,
  claimTicket,
  type LinearTicket,
} from "../lib/linear.ts";
import {
  listAllBranches,
  getWorktreeBranches,
  getCurrentBranch,
  hasUncommittedChanges,
  stashChanges,
  findDesktopStash,
  popStash,
  dropStash,
  checkoutBranch,
  createBranch,
  fetchRemoteBranch,
  getRemoteDefaultBranch,
  type BranchInfo,
} from "../lib/git-ops.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

const DEFAULT_BRANCH_NAMES = new Set(["master", "main", "develop", "development", "staging", "production"]);

// ─── Exported handlers (called by command tree dispatcher) ───────────────────
// The dispatcher handles: screen clearing, breadcrumbs, requireIdentity, pickers

// ─── Switch branch ───────────────────────────────────────────────────────────

export async function switchBranch(): Promise<void> {
  const cwd = process.cwd();
  const currentBranch = getCurrentBranch(cwd);

  // 1. Get branches (excluding worktree-occupied ones)
  const allBranches = listAllBranches(cwd);
  const worktreeBranches = getWorktreeBranches(cwd);

  const branches = allBranches.filter(
    (b) => b.name === currentBranch || !worktreeBranches.has(b.name),
  );

  if (branches.length === 0) {
    console.log(`\n  ${yellow}no branches found${reset}\n`);
    return;
  }

  // 2. Try to get enrichment data from daemon cache
  // Request all entries — the cache is small (~20-30 entries), much cheaper
  // than sending 3000+ branch names over the socket
  let enrichmentData: Record<string, any> = {};
  const daemonResult = await daemonQuery("cache:read");
  if (daemonResult?.ok && daemonResult.data) {
    enrichmentData = daemonResult.data;
  }

  // 3. Build fzf picker items
  const { filterableSelect } = await import("../lib/rt-render.tsx");

  // Group: current, local (hoisted defaults first), remote
  const currentInfo = branches.find((b) => b.name === currentBranch);
  const localBranches = branches.filter((b) => b.isLocal && b.name !== currentBranch);
  const remoteBranches = branches.filter((b) => !b.isLocal && b.name !== currentBranch);

  // Hoist main/master to front of local
  const hoisted = localBranches.filter((b) => DEFAULT_BRANCH_NAMES.has(b.name));
  const rest = localBranches.filter((b) => !DEFAULT_BRANCH_NAMES.has(b.name));
  const sortedLocal = [...hoisted, ...rest];

  function formatBranchOption(b: BranchInfo, isCurrent = false): { value: string; label: string; hint: string } {
    const enriched = enrichmentData[b.name];
    const parts: string[] = [];

    if (isCurrent) parts.push("(current)");

    // Linear ticket info — title only (ID is already in the branch name)
    if (enriched?.ticket) {
      const title = enriched.ticket.title.length > 60
        ? enriched.ticket.title.slice(0, 59) + "…"
        : enriched.ticket.title;
      const status = enriched.ticket.stateName ? ` [${enriched.ticket.stateName}]` : "";
      parts.push(`${title}${status}`);
    }

    // MR indicator
    if (enriched?.mr?.webUrl) parts.push("MR");

    const info = parts.join("  ");

    return {
      value: b.name,
      label: info ? `${b.name}  ${cyan}${info}${reset}` : b.name,
      hint: "",
    };
  }

  const options: Array<{ value: string; label: string; hint: string }> = [];

  if (currentInfo) {
    options.push(formatBranchOption(currentInfo, true));
  }

  for (const b of sortedLocal) {
    options.push(formatBranchOption(b));
  }

  for (const b of remoteBranches) {
    options.push(formatBranchOption(b));
  }

  const targetBranch = await filterableSelect({
    message: "Switch branch",
    options,
    exact: true,
  });

  if (!targetBranch || targetBranch === currentBranch) return;

  // 4. Check if working tree is dirty
  const dirty = hasUncommittedChanges(cwd);

  if (dirty && currentBranch) {
    const { select } = await import("../lib/rt-render.tsx");

    const existingStash = findDesktopStash(cwd, currentBranch);

    console.clear();
    console.log(`  ${bold}${cyan}rt branch switch${reset} → ${bold}${targetBranch}${reset}\n`);

    const action = await select({
      message: "You have uncommitted changes",
      options: [
        {
          value: "stash",
          label: `Leave my changes on ${currentBranch}`,
          hint: "stash and switch",
        },
        {
          value: "bring",
          label: `Bring my changes to ${targetBranch}`,
          hint: "carry uncommitted work",
        },
      ],
    });

    if (action === "stash") {
      // Warn before overwriting existing Desktop stash
      if (existingStash) {
        const { confirm } = await import("../lib/rt-render.tsx");
        const overwrite = await confirm({
          message: `Overwrite existing stash on '${currentBranch}'?`,
          initialValue: true,
        });
        if (!overwrite) return;

        try {
          dropStash(cwd, existingStash.name);
        } catch { /* continue anyway */ }
      }

      try {
        stashChanges(cwd, currentBranch);
        console.log(`  ${green}✓${reset} stashed changes on ${currentBranch}`);
      } catch (err) {
        console.log(`  ${red}✗${reset} failed to stash: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    // "bring" — just fall through to checkout, let git carry the changes
  }

  // 5. Checkout
  const isRemoteOnly = !allBranches.find((b) => b.name === targetBranch)?.isLocal;

  try {
    if (isRemoteOnly) {
      // Fetch and create local tracking branch
      const remoteName = "origin";
      fetchRemoteBranch(cwd, remoteName, targetBranch);
      // checkout -b creates a local branch tracking the remote
      execSync(`git checkout -b "${targetBranch}" "${remoteName}/${targetBranch}"`, {
        cwd, stdio: "pipe",
      });
    } else {
      checkoutBranch(cwd, targetBranch);
    }
    console.log(`  ${green}✓${reset} switched to ${bold}${targetBranch}${reset}`);
  } catch (err) {
    console.log(`  ${red}✗${reset} failed to checkout: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 6. Check for stashed changes on target branch (non-blocking restore prompt)
  const targetStash = findDesktopStash(cwd, targetBranch);
  if (targetStash) {
    const { confirm } = await import("../lib/rt-render.tsx");
    const restore = await confirm({
      message: `Restore stashed changes on '${targetBranch}'?`,
      initialValue: true,
    });

    if (restore) {
      try {
        popStash(cwd, targetStash.name);
        console.log(`  ${green}✓${reset} restored stashed changes`);
      } catch (err) {
        console.log(`  ${yellow}!${reset} failed to restore stash: ${err instanceof Error ? err.message : String(err)}`);
        console.log(`  ${dim}your stash is still saved${reset}`);
      }
    }
  }

  // 7. Notify daemon to refresh
  daemonQuery("cache:refresh").catch(() => {});
}

// ─── Create branch ───────────────────────────────────────────────────────────

export async function createBranchFlow(args: string[]): Promise<void> {
  // Direct mode: rt branch create <name> [--from <ref>]
  if (args.length > 0 && !args[0]!.startsWith("-")) {
    const branchName = args[0]!;
    const fromIdx = args.indexOf("--from");
    const startPoint = fromIdx !== -1 ? args[fromIdx + 1] : undefined;
    return createBranchDirect(branchName, startPoint);
  }

  const secrets = loadSecrets();
  if (!secrets.linearApiKey) {
    console.log(`\n  ${yellow}Linear API key not configured${reset}`);
    console.log(`  ${dim}run: rt settings linear token${reset}\n`);
    return;
  }

  const { select } = await import("../lib/rt-render.tsx");
  const mode = await select({
    message: "Create branch",
    options: [
      { value: "existing", label: "From existing Linear ticket", hint: "pick from your team's active tickets" },
      { value: "new",      label: "Create new ticket + branch",  hint: "create ticket on your team, then branch" },
      { value: "scratch",  label: "From scratch",                hint: "just enter a branch name" },
    ],
  });

  if (mode === "existing") await createFromExistingTicket(secrets.linearApiKey);
  else if (mode === "new") await createNewTicketAndBranch(secrets.linearApiKey);
  else if (mode === "scratch") await createFromScratch();
}

async function createFromExistingTicket(apiKey: string): Promise<void> {
  const teamConfig = getTeamConfig();
  if (!teamConfig) {
    console.log(`\n  ${yellow}Linear team not configured${reset}`);
    console.log(`  ${dim}run: rt settings linear team${reset}\n`);
    return;
  }
  const { teamId } = teamConfig;

  const { filterableSelect } = await import("../lib/rt-render.tsx");

  const REFRESH = "__refresh__";

  /** Fetch tickets with an inline spinner written to stderr. */
  async function loadTickets(): Promise<LinearTicket[]> {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];
    let fi = 0;
    const timer = setInterval(() => {
      process.stderr.write(`\r  ${dim}${frames[fi++ % frames.length]} fetching tickets…${reset}`);
    }, 80);

    try {
      const tickets = await fetchMyTodoTickets(apiKey, teamId);
      clearInterval(timer);
      process.stderr.write(`\r\x1b[K`); // erase spinner line
      return tickets;
    } catch {
      clearInterval(timer);
      process.stderr.write(`\r\x1b[K`);
      return [];
    }
  }

  /** Build fzf options list from ticket array. */
  function buildOptions(tickets: LinearTicket[]): Array<{ value: string; label: string; hint: string }> {
    const ticketOptions = tickets
      .map((t) => {
        const title = t.title.length > 50 ? t.title.slice(0, 49) + "…" : t.title;
        const info = `${title}${t.stateName ? ` [${t.stateName}]` : ""}`;
        return {
          value: t.identifier,
          label: `${t.identifier}  ${cyan}${info}${reset}`,
          hint: "",
        };
      });

    return [
      { value: REFRESH, label: `${dim}↻  Refresh tickets${reset}`, hint: "" },
      ...ticketOptions,
    ];
  }

  // Initial load
  let tickets = await loadTickets();

  while (true) {
    if (tickets.length === 0) {
      console.log(`  ${yellow}no active tickets found for your team${reset}\n`);
      // Still offer a refresh in case they just created a ticket
      const retry = await filterableSelect({
        message: "Select a ticket",
        options: [{ value: REFRESH, label: `${dim}↻  Refresh tickets${reset}`, hint: "" }],
      });
      if (!retry || retry !== REFRESH) return;
      tickets = await loadTickets();
      continue;
    }

    const options = buildOptions(tickets);
    const selectedId = await filterableSelect({
      message: "Select a ticket",
      options,
    });

    if (!selectedId) return; // ESC / cancelled

    if (selectedId === REFRESH) {
      tickets = await loadTickets();
      continue;
    }

    const ticket = tickets.find((t) => t.identifier === selectedId);
    if (!ticket) return;

    const branchName = ticket.branchName ?? inferBranchName(ticket.identifier, ticket.title);
    claimTicket(apiKey, ticket.id, teamId).catch(() => {/* best-effort */});
    await createWithBaseRef(branchName, ticket);
    return;
  }
}

async function createNewTicketAndBranch(apiKey: string): Promise<void> {
  // Ensure team is configured
  const teamConfig = getTeamConfig();
  if (!teamConfig) {
    console.log(`\n  ${yellow}no default team configured${reset}`);
    console.log(`  ${dim}run: rt settings linear team${reset}\n`);
    return;
  }

  const { textInput } = await import("../lib/rt-render.tsx");

  let title: string;
  try {
    title = await textInput({ message: "Ticket title", placeholder: "What are you working on?" });
  } catch { return; } // user cancelled

  if (!title.trim()) {
    console.log(`  ${yellow}title is required${reset}`);
    return;
  }

  let description: string | undefined;
  try {
    description = await textInput({ message: "Description (optional)", placeholder: "Enter to skip" });
  } catch { /* skipped */ }

  console.log(`\n  ${dim}creating ticket on ${teamConfig.teamKey}…${reset}`);

  try {
    const ticket = await createIssue(apiKey, teamConfig.teamId, title.trim(), description?.trim());
    if (!ticket) {
      console.log(`  ${red}✗${reset} failed to create ticket\n`);
      return;
    }

    console.log(`  ${green}✓${reset} created ${bold}${ticket.identifier}${reset}: ${ticket.title}`);

    if (!ticket.branchName) {
      console.log(`  ${yellow}!${reset} no suggested branch name from Linear`);
      console.log(`  ${dim}ticket created but branch not created${reset}\n`);
      return;
    }

    await createWithBaseRef(ticket.branchName, ticket);
  } catch (err) {
    console.log(`  ${red}✗${reset} ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function createFromScratch(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");

  let branchName: string;
  try {
    branchName = await textInput({ message: "Branch name", placeholder: "feature/my-branch" });
  } catch { return; }

  if (!branchName.trim()) return;

  const fromIdx = process.argv.indexOf("--from");
  const startPoint = fromIdx !== -1 ? process.argv[fromIdx + 1] : undefined;

  await createBranchDirect(branchName.trim(), startPoint);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function inferBranchName(identifier: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return `${identifier.toLowerCase()}-${slug}`;
}

async function createWithBaseRef(branchName: string, ticket?: LinearTicket): Promise<void> {
  const cwd = process.cwd();

  // Pick base ref
  const currentBranch = getCurrentBranch(cwd);
  const remoteDefault = getRemoteDefaultBranch(cwd);

  const { select } = await import("../lib/rt-render.tsx");

  let startPoint: string | undefined;

  if (remoteDefault) {
    const base = await select({
      message: "Base branch",
      options: [
        { value: "remote",  label: `Remote default (${remoteDefault})`, hint: "recommended" },
        { value: "current", label: `Current branch (${currentBranch ?? "HEAD"})`, hint: "" },
      ],
    });

    if (base === "remote") {
      const remoteName   = remoteDefault.split("/")[0]!;
      const remoteBranch = remoteDefault.split("/").slice(1).join("/");

      // Animated spinner — git fetch can take 3–8s on slow connections
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];
      let fi = 0;
      const spinnerTimer = setInterval(() => {
        process.stderr.write(`\r  ${dim}${frames[fi++ % frames.length]} fetching ${remoteDefault}…${reset}`);
      }, 80);

      const fetchStart = Date.now();
      try {
        fetchRemoteBranch(cwd, remoteName, remoteBranch);
        clearInterval(spinnerTimer);
        const ms = Date.now() - fetchStart;
        process.stderr.write(`\r\x1b[K`); // erase spinner line
        console.log(`  ${green}✓${reset} fetched ${bold}${remoteDefault}${reset}  ${dim}(${ms}ms)${reset}`);
      } catch {
        clearInterval(spinnerTimer);
        process.stderr.write(`\r\x1b[K`);
        console.log(`  ${yellow}!${reset} fetch failed — branching from local ref`);
      }
      startPoint = remoteDefault;
    }
  }

  try {
    createBranch(cwd, branchName, startPoint);
    console.log(`  ${green}✓${reset} created and checked out ${bold}${branchName}${reset}`);
    if (ticket) {
      console.log(`  ${dim}${ticket.identifier}: ${ticket.title}${reset}`);
    }
    console.log("");

    // Notify daemon — fire and forget, runner's FSEvents watcher will
    // pick up the HEAD change independently and update the UI immediately
    daemonQuery("cache:refresh").catch(() => {});
  } catch (err) {
    console.log(`  ${red}✗${reset} failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function createBranchDirect(branchName: string, startPoint?: string): Promise<void> {
  const cwd = process.cwd();
  try {
    createBranch(cwd, branchName, startPoint);
    console.log(`\n  ${green}✓${reset} created and checked out ${bold}${branchName}${reset}`);
    if (startPoint) {
      console.log(`  ${dim}from ${startPoint}${reset}`);
    }
    console.log("");
    daemonQuery("cache:refresh").catch(() => {});
  } catch (err) {
    console.log(`\n  ${red}✗${reset} failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}


