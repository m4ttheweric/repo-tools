#!/usr/bin/env bun

/**
 * rt — Zero-footprint repo CLI.
 *
 * Usage:
 *   rt                   interactive menu
 *   rt dev [preset]      dev workflow composer
 *   rt type-check [...]  tsgo type-check
 *   rt build             turbo build selector
 *   rt kill-port [port]  orphaned port killer
 *   rt doctor            environment health check
 *   rt open [target]     GitLab URL launcher
 */

import { bold, cyan, dim, green, yellow, reset } from "./lib/tui.ts";
import { getRepoIdentity } from "./lib/repo.ts";

const COMMANDS: Record<string, { description: string; module: string; fn?: string }> = {
  dev:          { description: "dev workflow composer (pick apps, setup, concurrent servers)", module: "./commands/dev.ts" },
  "type-check": { description: "tsgo type-check with baseline regression detection",        module: "./commands/type-check.ts" },
  build:        { description: "interactive turbo build selector",                            module: "./commands/build-select.ts" },
  hooks:        { description: "toggle git hooks on/off (husky)",                             module: "./commands/hooks.ts" },
  "kill-port":  { description: "kill orphaned processes on known ports",                      module: "./commands/kill-port.ts" },
  doctor:       { description: "environment health check",                                    module: "./commands/doctor.ts" },
  open:         { description: "open GitLab MR, pipeline, or repo page",                     module: "./commands/open.ts" },
  uninstall:    { description: "remove all rt data for this repo",                            module: "./commands/uninstall.ts" },
  cd:           { description: "worktree/repo directory picker (use rt cd shell function)",   module: "./commands/cd.ts" },
  code:         { description: "open a worktree in your preferred editor",                    module: "./commands/code.ts" },
  "setup-keys": { description: "configure Linear and GitLab API keys",                       module: "./lib/linear.ts", fn: "setupSecrets" },
};

async function runCommand(name: string, args: string[]): Promise<void> {
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.log(`\n  ${yellow}unknown command: ${name}${reset}`);
    showHelp();
    process.exit(1);
  }

  const mod = await import(cmd.module);
  const handler = mod[cmd.fn || "run"];
  return handler(args);
}

function showHelp(): void {
  console.log("");
  console.log(`  ${bold}${cyan}rt${reset}  ${dim}— zero-footprint repo CLI${reset}`);
  console.log("");
  console.log(`  ${dim}usage:${reset}  rt ${dim}<command> [args]${reset}`);
  console.log("");

  for (const [name, { description }] of Object.entries(COMMANDS)) {
    const padded = name.padEnd(14);
    console.log(`  ${bold}${padded}${reset} ${dim}${description}${reset}`);
  }
  console.log("");
}

async function interactiveMenu(): Promise<void> {
  if (!process.stdin.isTTY) {
    showHelp();
    process.exit(0);
  }

  const { select } = await import("./lib/rt-render.tsx");
  const identity = getRepoIdentity();

  const availableCommands = Object.entries(COMMANDS);

  const repoHint = identity ? ` (${identity.repoName})` : "";
  console.log(`\n  ${bold}${cyan}rt${reset}${dim}${repoHint}${reset}\n`);

  const selected = await select({
    message: "Select a command",
    options: availableCommands.map(([name, { description }]) => ({
      value: name,
      label: name,
      hint: description,
    })),
  });

  console.log("");
  await runCommand(selected, []);
}


// ─── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const firstArg = args[0];
  if (args.length === 0 || firstArg === "--help" || firstArg === "-h") {
    if (firstArg === "--help" || firstArg === "-h") {
      showHelp();
      process.exit(0);
    }
    await interactiveMenu();
    return;
  }

  const commandName = firstArg!;
  const commandArgs = args.slice(1);
  await runCommand(commandName, commandArgs);
}

await main();
