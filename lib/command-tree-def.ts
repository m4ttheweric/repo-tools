// lib/command-tree-def.ts
/**
 * The built-in rt command tree — the single source of truth for command
 * names, descriptions, args, and structure. Kept in its own side-effect-free
 * module so both cli.ts (runtime dispatch) and scripts/gen-docs.ts (docs
 * generation) can import it without triggering the CLI entry logic.
 */
import type { CommandNode } from "./command-tree.ts";

export const TREE: Record<string, CommandNode> = {
  git: {
    description: "Git operations (rebase, reset, branch, commit, backup)",
    subcommands: {
      rebase: {
        description: "Smart rebase onto origin/master with auto-resolve; on conflict, --json/--agent/--no-agent control escalation (--agent needs a TTY and a running herdr)",
        module: "./commands/git/rebase.ts",
        fn: "rebaseCommand",
        context: "worktree",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would happen without doing it" },
        ],
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
        description: "Branch management (switch, create, rename, clean)",
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
          rename: {
            description: "Rename the current branch",
            module: "./commands/branch.ts",
            fn: "renameBranch",
            context: "worktree",
            aliases: ["mv"],
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
    description: "Sync branches: rebase onto master + push (daily routine); on conflict, --json/--agent/--no-agent control escalation (--agent needs a TTY and a running herdr)",
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
    description: "Branch management (switch, create, rename, clean)",
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
      rename: {
        description: "Rename the current branch",
        module: "./commands/branch.ts",
        fn: "renameBranch",
        context: "worktree",
        aliases: ["mv"],
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

  turbo: {
    description: "Turborepo operations",
    subcommands: {
      build: {
        description: "Interactive turbo build selector",
        module: "./commands/build-select.ts",
        fn: "buildSelect",
        context: "worktree",
        requiresTTY: true,
      },
    },
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

  port: {
    description: "Port scanner + killer (zero-config, daemon-powered)",
    module: "./commands/port.ts",
    fn: "portScanner",
  },

  sdm: {
    description: "StrongDM connections: pick, connect, verify",
    subcommands: {
      connect: {
        description: "Pick a connection and connect (or connect <key> directly)",
        module: "./commands/sdm.ts",
        fn: "connectCmd",
        args: [
          { name: "Duration", flag: "--duration", type: "text", placeholder: "8h", hint: "How long to keep the connection open" },
          { name: "Reason", flag: "--reason", type: "text", placeholder: "e.g. debugging ticket", hint: "Why you need this connection" },
        ],
      },
      status: {
        description: "CLI auth health + connected tunnels",
        module: "./commands/sdm.ts",
        fn: "statusCmd",
      },
      login: {
        description: "Log in to StrongDM (browser popup; --manual for terminal, --visible to watch)",
        module: "./commands/sdm.ts",
        fn: "loginCmd",
        args: [
          { name: "Manual login", flag: "--manual", type: "boolean", default: false, hint: "Use terminal-based login instead of browser popup" },
          { name: "Show browser", flag: "--visible", type: "boolean", default: false, hint: "Show the browser window during login" },
        ],
      },
      refresh: {
        description: "Re-scan StrongDM and refresh the resource cache",
        module: "./commands/sdm.ts",
        fn: "refreshCmd",
      },
      enrichment: {
        description: "Show or scaffold (init) the declarative enrichment map",
        module: "./commands/sdm.ts",
        fn: "enrichmentCmd",
      },
      "set-email": {
        description: "Set your StrongDM email (skips the browser-login email prompt)",
        module: "./commands/settings.ts",
        fn: "setSdmEmail",
      },
    },
  },

  status: {
    description: "Live branch dashboard with MR actions, pipeline & review status",
    module: "./commands/status/index.tsx",
    fn: "showStatus",
    context: "repo",
    fullscreen: true,
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
    description: "Navigate filesystem with fzf — persistent picker, esc to quit",
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
      this: {
        description: "Park the current worktree now (manual override; ignores enabled flag)",
        module: "./commands/parking-lot.ts",
        fn: "parkThisCommand",
        context: "worktree",
      },
      pick: {
        description: "Pick worktrees in this repo to park (multi-select)",
        module: "./commands/parking-lot.ts",
        fn: "parkPickCommand",
        context: "repo",
        requiresTTY: true,
      },
    },
  },

  worktree: {
    description: "Worktree-wide operations",
    subcommands: {
      each: {
        description: "Run a command in each worktree (--all | --parked, else pick)",
        module: "./commands/worktree.ts",
        fn: "worktreeEach",
        context: "repo",
      },
    },
  },

  doppler: {
    description: "Per-repo Doppler template + sync into ~/.doppler/.doppler.yaml",
    subcommands: {
      init: {
        description: "Capture existing Doppler entries for this repo into a template",
        module: "./commands/doppler.ts",
        fn: "initCommand",
        context: "repo",
      },
      sync: {
        description: "Apply the template across all worktrees (manual trigger)",
        module: "./commands/doppler.ts",
        fn: "syncCommand",
        context: "repo",
      },
      status: {
        description: "Show template vs. actual config per worktree",
        module: "./commands/doppler.ts",
        fn: "statusCommand",
        context: "repo",
      },
      edit: {
        description: "Open the template in $EDITOR",
        module: "./commands/doppler.ts",
        fn: "editCommand",
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
      notifications: {
        description: "Toggle notification preferences",
        module: "./commands/settings.ts",
        fn: "configureNotifications",
        requiresTTY: true,
      },
      "test-push": {
        description: "Send a test push notification via rt tray",
        module: "./commands/settings.ts",
        fn: "sendTestPushNotification",
      },
      runaway: {
        description: "Configure runaway process detection thresholds",
        module: "./commands/settings.ts",
        fn: "configureRunaway",
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
      llm: {
        description: "Configure local LLM for branch naming and other features",
        module: "./commands/settings.ts",
        fn: "configureLlm",
        requiresTTY: true,
      },
    },
  },

  plugin: {
    description: "Manage user plugins",
    subcommands: {
      new: {
        description: "Scaffold a new plugin",
        module: "./commands/plugin.ts",
        fn: "runNew",
      },
      list: {
        description: "List installed plugins",
        module: "./commands/plugin.ts",
        fn: "runList",
      },
      validate: {
        description: "Deep-validate installed plugins",
        module: "./commands/plugin.ts",
        fn: "runValidate",
      },
    },
  },
};
