#!/usr/bin/env bun

/**
 * rt — Zero-footprint repo CLI.
 *
 * All command navigation is handled by the command tree dispatcher.
 * Commands register declaratively; the dispatcher handles screen clearing,
 * breadcrumb headers, fzf pickers, and repo context.
 *
 * Usage:
 *   rt                        interactive menu
 *   rt branch switch          direct subcommand
 *   rt branch                 subcommand picker
 *   rt build                  direct command
 */

import { dispatch, type CommandNode } from "./lib/command-tree.ts";

// ─── Command Tree ────────────────────────────────────────────────────────────
//
// Branch nodes: have subcommands → dispatcher shows a picker
// Leaf nodes: have module/fn → dispatcher lazy-imports and calls the handler
//
// The tree is defined here so we have a single source of truth for
// command names, descriptions, and structure. Handlers are lazy-loaded.

const TREE: Record<string, CommandNode> = {
  x: {
    description: "Script runner (setup → commands → teardown)",
    module: "./commands/x.ts",
    fn: "scriptRunner",
  },

  branch: {
    description: "Branch management (switch, create)",
    subcommands: {
      switch: {
        description: "Checkout with stash handling",
        module: "./commands/branch.ts",
        fn: "switchBranch",
        requiresRepo: true,
        aliases: ["sw"],
      },
      create: {
        description: "From Linear ticket or scratch",
        module: "./commands/branch.ts",
        fn: "createBranchFlow",
        requiresRepo: true,
        aliases: ["new"],
      },
    },
  },

  build: {
    description: "Interactive turbo build selector",
    module: "./commands/build-select.ts",
    fn: "buildSelect",
  },

  hooks: {
    description: "Toggle git hooks on/off (husky)",
    module: "./commands/hooks.ts",
    fn: "toggleHooks",
  },

  port: {
    description: "Scan known ports, kill orphaned processes",
    module: "./commands/port.ts",
  },

  doctor: {
    description: "Environment health check",
    module: "./commands/doctor.ts",
  },

  open: {
    description: "Open external pages for the current branch",
    subcommands: {
      mr: {
        description: "GitLab merge request",
        module: "./commands/open.ts",
        fn: "openMR",
        requiresRepo: true,
      },
      pipeline: {
        description: "GitLab CI pipelines",
        module: "./commands/open.ts",
        fn: "openPipeline",
        requiresRepo: true,
        aliases: ["ci"],
      },
      repo: {
        description: "Repository page",
        module: "./commands/open.ts",
        fn: "openRepo",
        requiresRepo: true,
      },
      ticket: {
        description: "Linear ticket for this branch",
        module: "./commands/open.ts",
        fn: "openTicket",
        requiresRepo: true,
        aliases: ["linear"],
      },
    },
  },

  cd: {
    description: "Worktree/repo directory picker",
    module: "./commands/cd.ts",
    fn: "worktreePicker",
  },

  code: {
    description: "Open a worktree in your preferred editor",
    module: "./commands/code.ts",
    fn: "openInEditor",
  },

  daemon: {
    description: "Manage the rt background daemon",
    subcommands: {
      install: {
        description: "Install the daemon",
        module: "./commands/daemon.ts",
        fn: "install",
      },
      uninstall: {
        description: "Remove the daemon",
        module: "./commands/daemon.ts",
        fn: "uninstall",
      },
      start: {
        description: "Start the daemon",
        module: "./commands/daemon.ts",
        fn: "start",
      },
      stop: {
        description: "Stop the daemon",
        module: "./commands/daemon.ts",
        fn: "stop",
      },
      status: {
        description: "Show daemon status",
        module: "./commands/daemon.ts",
        fn: "showStatus",
      },
      logs: {
        description: "Show daemon logs",
        module: "./commands/daemon.ts",
        fn: "showLogs",
      },
    },
  },

  settings: {
    description: "Configure tokens, team, and repo data",
    subcommands: {
      linear: {
        description: "Linear API configuration",
        subcommands: {
          token: {
            description: "Set Linear API key",
            module: "./commands/settings.ts",
            fn: "setLinearToken",
          },
          team: {
            description: "Set default Linear team",
            module: "./commands/settings.ts",
            fn: "setLinearTeam",
          },
        },
      },
      gitlab: {
        description: "GitLab API configuration",
        subcommands: {
          token: {
            description: "Set GitLab personal access token",
            module: "./commands/settings.ts",
            fn: "setGitlabToken",
          },
        },
      },
      uninstall: {
        description: "Remove all rt data for this repo",
        module: "./commands/settings.ts",
        fn: "uninstallRepo",
        requiresRepo: true,
      },
    },
  },
};

// ─── Entry ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const baseDir = import.meta.dir; // resolve module paths relative to cli.ts

if (args[0] === "--help" || args[0] === "-h") {
  // Non-interactive help — dispatch handles showUsage when !isTTY
  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false });
  await dispatch(TREE, [], ["rt"], baseDir);
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY });
} else {
  await dispatch(TREE, args, ["rt"], baseDir);
}
