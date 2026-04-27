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
      pull: {
        description: "Pull from origin (mirror of GitHub Desktop's Pull button)",
        module: "./commands/git/pull.ts",
        fn: "pullCommand",
        context: "worktree",
      },
      push: {
        description: "Push current branch to origin/<branch>, fixing wrong upstream",
        module: "./commands/git/push.ts",
        fn: "pushCommand",
        context: "worktree",
        subcommands: {
          force: {
            description: "Push with --force-with-lease (after rebase/amend)",
            module: "./commands/git/push.ts",
            fn: "forcePushCommand",
            context: "worktree",
          },
        },
      },
      upstream: {
        description: "Fix branch upstream to track origin/<branch>",
        module: "./commands/git/push.ts",
        fn: "upstreamCommand",
        context: "worktree",
      },
    },
  },

  mr: {
    description: "Merge request operations (GitLab) — `pr` works too",
    aliases: ["pr"],
    subcommands: {
      open: {
        description: "Open a bare MR on the current branch via glab",
        module: "./commands/mr.ts",
        fn: "openCommand",
        context: "worktree",
      },
      describe: {
        description: "Draft an MR description with an agent (streams to stdout)",
        module: "./commands/mr.ts",
        fn: "describeCommand",
        context: "worktree",
      },
      ship: {
        description: "All-in-one: push + describe + open (the daily driver)",
        module: "./commands/mr.ts",
        fn: "shipCommand",
        context: "worktree",
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
    subcommands: {
      again: {
        description: "Pick from recently run scripts across all repos",
        module: "./commands/run.ts",
        fn: "runAgainCommand",
        requiresTTY: true,
      },
    },
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

  proxy: {
    description: "Pause/resume daemon-managed reverse proxies",
    subcommands: {
      list: {
        description: "Show all registered proxies and their state",
        module: "./commands/proxy.ts",
        fn: "listCommand",
      },
      pause: {
        description: "Pause a proxy by port, picker if no port, or --all",
        module: "./commands/proxy.ts",
        fn: "pauseCommand",
      },
      resume: {
        description: "Resume a paused proxy by port, picker if no port, or --all",
        module: "./commands/proxy.ts",
        fn: "resumeCommand",
      },
    },
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

  "pick-cmd-template": {
    description: "Command template picker for a lane entry (used by runner)",
    module: "./commands/pick-cmd-template.ts",
    fn: "pickCmdTemplate",
    hidden: true,
  },

  update: {
    description: "Update rt to the latest version via Homebrew",
    module: "./commands/update.ts",
    fn: "runUpdate",
  },

  version: {
    description: "Show current version and prod/dev mode",
    module: "./commands/version.ts",
    fn: "runVersion",
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

  nav: {
    description: "Navigate filesystem with fzf — descend folders, open files",
    module: "./commands/nav.ts",
    fn: "navigate",
    requiresTTY: true,
  },

  code: {
    description: "Open a worktree in your preferred editor",
    module: "./commands/code.ts",
    fn: "openInEditor",
    requiresTTY: true,
  },

  agent: {
    description: "Launch a CLI coding agent (Claude Code, Cursor, etc.) in a worktree",
    module: "./commands/agent.ts",
    fn: "launchAgent",
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

  park: {
    description: "Auto-park worktrees when their MR merges or closes",
    subcommands: {
      status: {
        description: "Show whether auto-park is enabled + worktree bindings",
        module: "./commands/parking-lot.ts",
        fn: "statusCommand",
      },
      enable: {
        description: "Turn on auto-park",
        module: "./commands/parking-lot.ts",
        fn: "enableCommand",
      },
      disable: {
        description: "Turn off auto-park (daemon scans become no-ops)",
        module: "./commands/parking-lot.ts",
        fn: "disableCommand",
      },
      scan: {
        description: "Run the park check immediately against the live cache",
        module: "./commands/parking-lot.ts",
        fn: "scanCommand",
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
} else if (args[0] === "--grant-fda") {
  // Hidden entry point: open System Settings → Privacy → Full Disk Access.
  // The daemon inherits TCC grants from rt-tray.app via SMAppService's
  // AssociatedBundleIdentifiers, so the grant goes on rt-tray, not on rt.
  const { execSync } = await import("child_process");
  const { homedir } = await import("os");
  const { join } = await import("path");
  const trayPath = join(homedir(), "Applications", "rt-tray.app");
  console.log("\n  Opening System Settings → Privacy → Full Disk Access…\n");
  console.log(`  1. Click ${"\x1b[1m"}+${"\x1b[0m"} and add: ${"\x1b[1m"}${trayPath}${"\x1b[0m"}`);
  console.log(`     (the rt daemon inherits this grant via SMAppService)`);
  console.log(`  2. Restart the daemon: ${"\x1b[1m"}rt daemon restart${"\x1b[0m"}\n`);
  try {
    execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
  } catch {
    console.error("  Could not open System Settings — open it manually: System Settings → Privacy & Security → Full Disk Access");
    process.exit(1);
  }
} else if (args[0] === "update") {
  // `update` bypasses first-run setup — its own post-upgrade step runs it.
  const { runUpdate } = await import("./commands/update.ts");
  await runUpdate(args.slice(1));
  process.exit(0);
} else {
  // ── First-run auto-setup ──────────────────────────────────────────────────
  // If daemon.json doesn't exist, post-install hasn't completed outside the
  // Homebrew sandbox. Run it now transparently before the requested command.
  // This also applies to `rt verify`, which is the command we recommend users
  // run after `brew install` — it should set up + then verify in one shot.
  if (process.env.CI !== "true" && process.env.RT_SKIP_SETUP !== "1") {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    if (!existsSync(join(homedir(), ".rt", "daemon.json"))) {
      console.log("\n  rt — first run detected, completing setup…\n");
      const { runPostInstall } = await import("./commands/post-install.ts");
      await runPostInstall();
    }
  }

  if (args[0] === "verify") {
    const { runVerify } = await import("./commands/verify.ts");
    await runVerify(args.slice(1));
    process.exit(0);
  }

  // ── Command dispatch ────────────────────────────────────────────────────
  if (args[0] === "--help" || args[0] === "-h") {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false });
    await dispatch(TREE, [], ["rt"], baseDir);
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY });
  } else {
    await dispatch(TREE, args, ["rt"], baseDir);
  }
}
