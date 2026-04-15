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

  git: {
    description: "Git operations (rebase, reset, branch, commit, backup)",
    subcommands: {
      rebase: {
        description: "Smart rebase onto origin/master with auto-resolve",
        module: "./commands/git/rebase.ts",
        fn: "rebaseCommand",
        context: "worktree",
        subcommands: {
          onto: {
            description: "Rebase onto a specific branch",
            module: "./commands/git/rebase.ts",
            fn: "ontoCommand",
            context: "worktree",
          },
        },
      },
      reset: {
        description: "Safe reset with divergence detection",
        subcommands: {
          origin: {
            description: "Sync with origin/current-branch (after remote rebase)",
            module: "./commands/git/reset.ts",
            fn: "originCommand",
            context: "worktree",
          },
          soft: {
            description: "Soft reset to HEAD (unstage files)",
            module: "./commands/git/reset.ts",
            fn: "softResetCommand",
            context: "worktree",
          },
          hard: {
            description: "Hard reset to HEAD (discard all changes)",
            module: "./commands/git/reset.ts",
            fn: "hardResetCommand",
            context: "worktree",
          },
        },
      },
      branch: {
        description: "Branch management (switch, create, clean)",
        subcommands: {
          switch: {
            description: "Checkout with stash handling",
            module: "./commands/branch.ts",
            fn: "switchBranch",
            context: "worktree",
            aliases: ["sw"],
          },
          create: {
            description: "From Linear ticket or scratch",
            module: "./commands/branch.ts",
            fn: "createBranchFlow",
            context: "worktree",
            aliases: ["new"],
          },
          clean: {
            description: "Delete stale branches interactively",
            module: "./commands/branch-clean.ts",
            fn: "cleanBranches",
            context: "worktree",
            requiresTTY: true,
          },
        },
      },
      commit: {
        description: "Interactive staging + commit with live diff preview",
        module: "./commands/commit.ts",
        fn: "commitFlow",
        context: "worktree",
        requiresTTY: true,
      },
      backup: {
        description: "Back up the current branch",
        module: "./commands/git/backup.ts",
        fn: "backupCommand",
        context: "worktree",
      },
      restore: {
        description: "Restore from a backup branch",
        module: "./commands/git/backup.ts",
        fn: "restoreCommand",
        context: "worktree",
        requiresTTY: true,
      },
    },
  },

  sync: {
    description: "Sync branches: rebase onto master + push (daily routine)",
    module: "./commands/sync.ts",
    fn: "syncCommand",
    context: "worktree",
    subcommands: {
      all: {
        description: "Sync all worktrees in the current repo",
        module: "./commands/sync.ts",
        fn: "syncAllCommand",
        context: "repo",
      },
    },
  },

  // Aliases — rt branch and rt commit still work as before
  branch: {
    description: "Branch management (switch, create, clean)",
    subcommands: {
      switch: {
        description: "Checkout with stash handling",
        module: "./commands/branch.ts",
        fn: "switchBranch",
        context: "worktree",
        aliases: ["sw"],
      },
      create: {
        description: "From Linear ticket or scratch",
        module: "./commands/branch.ts",
        fn: "createBranchFlow",
        context: "worktree",
        aliases: ["new"],
      },
      clean: {
        description: "Delete stale branches interactively",
        module: "./commands/branch-clean.ts",
        fn: "cleanBranches",
        context: "worktree",
        requiresTTY: true,
      },
    },
  },

  gitx: {
    description: "Git passthrough in rt-resolved directory",
    module: "./commands/gitx.ts",
    fn: "gitPassthrough",
    context: "worktree",
  },

  build: {
    description: "Interactive turbo build selector",
    module: "./commands/build-select.ts",
    fn: "buildSelect",
    context: "worktree",
    requiresTTY: true,
  },

  hooks: {
    description: "Toggle git hooks on/off (husky)",
    module: "./commands/hooks.ts",
    fn: "toggleHooks",
    context: "repo",
  },

  run: {
    description: "Interactive script runner (repo → worktree → package → script)",
    module: "./commands/run.ts",
    fn: "runCommand",
    context: "worktree",
    requiresTTY: true,
  },

  commit: {
    description: "Interactive staged/unstaged commit picker with live diff preview",
    module: "./commands/commit.ts",
    fn: "commitFlow",
    context: "worktree",
    requiresTTY: true,
  },

  attach: {
    description: "Attach terminal to a daemon-managed process",
    module: "./commands/attach.ts",
    fn: "attachProcess",
    requiresTTY: true,
  },

  runner: {
    description: "Multiplexed service runner dashboard",
    module: "./commands/runner.tsx",
    fn: "showRunner",
    fullscreen: true,
  },

  port: {
    description: "Port scanner + killer (zero-config, daemon-powered)",
    module: "./commands/port.ts",
    fn: "portScanner",
  },

  status: {
    description: "Live branch dashboard with MR actions, pipeline & review status",
    module: "./commands/status.tsx",
    fn: "showStatus",
    context: "repo",
    fullscreen: true,
  },

  "mr-status": {
    description: "MR status card for a branch (used by runner info pane)",
    module: "./commands/mr-status.tsx",
    fn: "showMrStatus",
    fullscreen: true,
    hidden: true,
  },

  "pick-lane": {
    description: "Repo + port picker for adding a runner lane (used by runner)",
    module: "./commands/pick-lane.ts",
    fn: "pickLane",
    hidden: true,
  },

  doctor: {
    description: "Environment health check",
    module: "./commands/doctor.ts",
    fn: "runDoctor",
  },

  open: {
    description: "Open external pages for the current branch",
    subcommands: {
      mr: {
        description: "GitLab merge request",
        module: "./commands/open.ts",
        fn: "openMR",
        context: "worktree",
      },
      pipeline: {
        description: "GitLab CI pipelines",
        module: "./commands/open.ts",
        fn: "openPipeline",
        context: "worktree",
        aliases: ["ci"],
      },
      repo: {
        description: "Repository page",
        module: "./commands/open.ts",
        fn: "openRepo",
        context: "worktree",
      },
      ticket: {
        description: "Linear ticket for this branch",
        module: "./commands/open.ts",
        fn: "openTicket",
        context: "worktree",
        aliases: ["linear"],
      },
    },
  },

  cd: {
    description: "Worktree/repo directory picker",
    module: "./commands/cd.ts",
    fn: "worktreePicker",
    requiresTTY: true,
  },

  code: {
    description: "Open a worktree in your preferred editor",
    module: "./commands/code.ts",
    fn: "openInEditor",
    requiresTTY: true,
  },

  workspace: {
    description: "VS Code workspace management",
    subcommands: {
      sync: {
        description: "Auto-sync workspace file across worktrees",
        module: "./commands/workspace.ts",
        fn: "workspaceSyncCommand",
        context: "repo",
        requiresTTY: true,
      },
    },
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
      restart: {
        description: "Restart the daemon",
        module: "./commands/daemon.ts",
        fn: "restart",
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
        context: "worktree",
      },
      notifications: {
        description: "Toggle notification preferences",
        module: "./commands/settings.ts",
        fn: "configureNotifications",
        requiresTTY: true,
      },
      extension: {
        description: "Install RT Context extension in editors",
        module: "./commands/extension.ts",
        fn: "installExtension",
        requiresTTY: true,
      },
      "dev-mode": {
        description: "Toggle between local dev source and Homebrew production binary",
        module: "./commands/settings.ts",
        fn: "toggleDevMode",
        requiresTTY: true,
      },
    },
  },
};

// ─── Entry ───────────────────────────────────────────────────────────────────

// Injected at compile time via `bun build --define RT_VERSION='"v1.x.x"'`.
// Falls back to "dev" when running from source.
declare const RT_VERSION: string;
const _RT_VERSION = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";

const args = process.argv.slice(2);
const baseDir = import.meta.dir; // resolve module paths relative to cli.ts

if (args[0] === "--version" || args[0] === "-V") {
  console.log(`rt ${_RT_VERSION}`);
} else if (args[0] === "--daemon") {
  // Hidden entry point: start the daemon server directly.
  // Used when rt is a compiled binary — daemon install spawns `rt --daemon`
  // instead of `bun run lib/daemon.ts`.
  const { startDaemon } = await import("./lib/daemon.ts");
  startDaemon();
} else if (args[0] === "--post-install") {
  // Hidden entry point: called by the Homebrew formula's post_install hook.
  // Handles tray app, extension install, daemon setup, and shell integration.
  const { runPostInstall } = await import("./commands/post-install.ts");
  await runPostInstall();
} else if (args[0] === "verify") {
  // Statically imported so bun --compile includes verify.ts in the bundle.
  const { runVerify } = await import("./commands/verify.ts");
  await runVerify(args.slice(1));
  process.exit(0);
} else if (args[0] === "update") {
  const { runUpdate } = await import("./commands/update.ts");
  await runUpdate(args.slice(1));
  process.exit(0);
} else if (args[0] === "--help" || args[0] === "-h") {
  // Non-interactive help — dispatch handles showUsage when !isTTY
  const originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false });
  await dispatch(TREE, [], ["rt"], baseDir);
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY });
} else {
  await dispatch(TREE, args, ["rt"], baseDir);
}
