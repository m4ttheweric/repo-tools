// lib/command-tree-def.ts
/**
 * The built-in rt command tree: the single source of truth for command
 * names, descriptions, args, and structure. Kept in its own side-effect-free
 * module so both cli.ts (runtime dispatch) and scripts/gen-docs.ts (docs
 * generation) can import it without triggering the CLI entry logic.
 */
import type { CommandNode } from "./command-tree.ts";

const branchSubcommands: Record<string, CommandNode> = {
  switch: {
    description: "Checkout with stash handling",
    module: "./commands/branch.ts",
    fn: "switchBranch",
    context: "worktree",
    aliases: ["sw"],
    args: [],
  },
  create: {
    description: "From Linear ticket or scratch",
    module: "./commands/branch.ts",
    fn: "createBranchFlow",
    context: "worktree",
    aliases: ["new"],
    args: [
      { name: "Branch name", type: "text", placeholder: "feature/my-branch", hint: "Skip the interactive picker and create this branch directly" },
      { name: "From", flag: "--from", type: "text", placeholder: "origin/main", hint: "Start point for the new branch" },
    ],
  },
  rename: {
    description: "Rename the current branch",
    module: "./commands/branch.ts",
    fn: "renameBranch",
    context: "worktree",
    aliases: ["mv"],
    args: [],
  },
  clean: {
    description: "Delete stale branches interactively",
    module: "./commands/branch-clean.ts",
    fn: "cleanBranches",
    context: "worktree",
    requiresTTY: true,
    args: [
      { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Preview deletions without deleting (alias -n)" },
      { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Skip the open-MR warning and force-delete (alias -f)" },
    ],
  },
};

// Shared so `rt commit` and `rt git commit` are one node (enrich once, render once).
const commitNode: CommandNode = {
  description: "Interactive staged/unstaged commit picker with live diff preview",
  module: "./commands/commit.ts",
  fn: "commitFlow",
  context: "worktree",
  requiresTTY: true,
  args: [],
};

export const TREE: Record<string, CommandNode> = {
  git: {
    description: "Git operations (rebase, reset, branch, commit, backup)",
    subcommands: {
      rebase: {
        description: "Smart rebase onto origin/master with auto-resolve",
        module: "./commands/git/rebase.ts",
        fn: "rebaseCommand",
        context: "worktree",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would happen without doing it" },
          { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "On conflict, emit a JSON conflict bundle and exit 3 instead of prompting" },
          { name: "Agent", flag: "--agent", type: "boolean", default: false, hint: "On conflict, skip the prompt and hand off straight to a Claude agent in herdr (requires a TTY)" },
          { name: "No agent", flag: "--no-agent", type: "boolean", default: false, hint: "On conflict, never offer agent escalation; abort instead" },
        ],
        subcommands: {
          onto: {
            description: "Rebase onto a specific branch",
            module: "./commands/git/rebase.ts",
            fn: "ontoCommand",
            context: "worktree",
            args: [
              { name: "Branch", type: "text", placeholder: "main", hint: "Branch to rebase onto" },
              { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would happen without doing it" },
              { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "On conflict, emit a JSON conflict bundle and exit 3 instead of prompting" },
              { name: "Agent", flag: "--agent", type: "boolean", default: false, hint: "On conflict, skip the prompt and hand off straight to a Claude agent in herdr (requires a TTY)" },
              { name: "No agent", flag: "--no-agent", type: "boolean", default: false, hint: "On conflict, never offer agent escalation; abort instead" },
            ],
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
            args: [],
          },
          soft: {
            description: "Soft reset to HEAD (unstage files)",
            module: "./commands/git/reset.ts",
            fn: "softResetCommand",
            context: "worktree",
            args: [],
          },
          hard: {
            description: "Hard reset to HEAD (discard all changes)",
            module: "./commands/git/reset.ts",
            fn: "hardResetCommand",
            context: "worktree",
            args: [],
          },
        },
      },
      branch: {
        description: "Branch management (switch, create, rename, clean)",
        subcommands: branchSubcommands,
      },
      commit: commitNode,
      backup: {
        description: "Back up the current branch",
        module: "./commands/git/backup.ts",
        fn: "backupCommand",
        context: "worktree",
        args: [],
      },
      restore: {
        description: "Restore from a backup branch",
        module: "./commands/git/backup.ts",
        fn: "restoreCommand",
        context: "worktree",
        requiresTTY: true,
        args: [],
      },
      pull: {
        description: "Pull from origin (mirror of GitHub Desktop's Pull button)",
        module: "./commands/git/pull.ts",
        fn: "pullCommand",
        context: "worktree",
        args: [
          { name: "Remote", flag: "--remote", type: "text", placeholder: "origin", hint: "Remote to pull from" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show the git command without running it" },
          { name: "No verify", flag: "--no-verify", type: "boolean", default: false, hint: "Skip pre-pull hooks" },
          { name: "Rebase", flag: "--rebase", type: "boolean", default: false, hint: "Force rebase instead of merge, overriding pull.rebase config" },
          { name: "No rebase", flag: "--no-rebase", type: "boolean", default: false, hint: "Force merge instead of rebase, overriding pull.rebase config" },
        ],
      },
      push: {
        description: "Push current branch to origin/<branch>, fixing wrong upstream",
        module: "./commands/git/push.ts",
        fn: "pushCommand",
        context: "worktree",
        args: [
          { name: "Remote", flag: "--remote", type: "text", placeholder: "origin", hint: "Remote to push to" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show the git command without running it" },
          { name: "No verify", flag: "--no-verify", type: "boolean", default: false, hint: "Skip pre-push hooks" },
        ],
        subcommands: {
          force: {
            description: "Push with --force-with-lease (after rebase/amend)",
            module: "./commands/git/push.ts",
            fn: "forcePushCommand",
            context: "worktree",
            args: [
              { name: "Remote", flag: "--remote", type: "text", placeholder: "origin", hint: "Remote to push to" },
              { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show the git command without running it" },
              { name: "No verify", flag: "--no-verify", type: "boolean", default: false, hint: "Skip pre-push hooks" },
            ],
          },
        },
      },
      upstream: {
        description: "Fix branch upstream to track origin/<branch>",
        module: "./commands/git/push.ts",
        fn: "upstreamCommand",
        context: "worktree",
        args: [
          { name: "Remote", flag: "--remote", type: "text", placeholder: "origin", hint: "Remote to set the upstream to" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would change without applying it" },
        ],
      },
    },
  },

  mr: {
    description: "Merge request operations (GitLab); `pr` works too",
    aliases: ["pr"],
    subcommands: {
      open: {
        description: "Open a bare MR on the current branch via glab",
        module: "./commands/mr.ts",
        fn: "openCommand",
        context: "worktree",
        args: [
          { name: "Target branch", flag: "--target", type: "text", placeholder: "master", hint: "Target branch for the MR (defaults to config or repo default)" },
          { name: "Title", flag: "--title", type: "text", placeholder: "...", hint: "MR title (defaults to the last commit subject)" },
          { name: "Draft", flag: "--draft", type: "boolean", default: false, hint: "Open as a draft MR" },
          { name: "No draft", flag: "--no-draft", type: "boolean", default: false, hint: "Force non-draft even if config defaults to draft" },
          { name: "Description", flag: "--description", type: "text", placeholder: "...", hint: "Inline description body" },
          { name: "Description file", flag: "--description-file", type: "text", placeholder: "path or -", hint: "Read description from a file (- for stdin)" },
          { name: "Fill", flag: "--fill", type: "boolean", default: false, hint: "Let glab fill the description from commits" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Preview the glab command without creating the MR" },
          { name: "Web", flag: "--web", type: "boolean", default: false, hint: "Open the new MR in the browser" },
        ],
      },
      describe: {
        description: "Draft an MR description with an agent (streams to stdout)",
        module: "./commands/mr.ts",
        fn: "describeCommand",
        context: "worktree",
        args: [
          { name: "Target branch", flag: "--target", type: "text", placeholder: "master", hint: "Target branch to diff against" },
          { name: "Inline guidance", flag: "--inline", type: "text", placeholder: "...", hint: "Extra inline guidance appended to the prompt" },
          { name: "Debug", flag: "--debug", type: "boolean", default: false, hint: "Print the assembled prompt instead of calling the agent" },
        ],
      },
      ship: {
        description: "All-in-one: push + describe + open (the daily driver)",
        module: "./commands/mr.ts",
        fn: "shipCommand",
        context: "worktree",
        args: [
          { name: "Target branch", flag: "--target", type: "text", placeholder: "master", hint: "Target branch for the MR" },
          { name: "Title", flag: "--title", type: "text", placeholder: "...", hint: "MR title (overrides the agent-drafted title)" },
          { name: "Draft", flag: "--draft", type: "boolean", default: false, hint: "Open as a draft MR" },
          { name: "No draft", flag: "--no-draft", type: "boolean", default: false, hint: "Force non-draft even if config defaults to draft" },
          { name: "Inline guidance", flag: "--inline", type: "text", placeholder: "...", hint: "Extra inline guidance appended to the description prompt" },
          { name: "Debug", flag: "--debug", type: "boolean", default: false, hint: "Print the assembled prompt and stop before creating the MR" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Rehearse push + MR creation without doing either" },
          { name: "Web", flag: "--web", type: "boolean", default: false, hint: "Open the new MR in the browser" },
          { name: "Remote", flag: "--remote", type: "text", placeholder: "origin", hint: "Remote to push to (forwarded to the push step)" },
          { name: "No verify", flag: "--no-verify", type: "boolean", default: false, hint: "Skip pre-push hooks (forwarded to the push step)" },
        ],
      },
    },
  },

  sync: {
    description: "Sync branches: rebase onto master + push (daily routine)",
    module: "./commands/sync.ts",
    fn: "syncCommand",
    context: "worktree",
    args: [
      { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would happen without doing it" },
      { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "On conflict, emit a JSON conflict bundle and exit 3 instead of prompting" },
      { name: "Agent", flag: "--agent", type: "boolean", default: false, hint: "On conflict, skip the prompt and hand off straight to a Claude agent in herdr (requires a TTY)" },
      { name: "No agent", flag: "--no-agent", type: "boolean", default: false, hint: "On conflict, never offer agent escalation; abort instead" },
    ],
    subcommands: {
      all: {
        description: "Sync all worktrees in the current repo",
        module: "./commands/sync.ts",
        fn: "syncAllCommand",
        context: "repo",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Show what would happen without doing it" },
        ],
      },
    },
  },

  // Aliases: rt branch and rt commit still work as before
  branch: {
    description: "Branch management (switch, create, rename, clean)",
    subcommands: branchSubcommands,
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
        args: [
          { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Force turbo to ignore its build cache" },
        ],
      },
    },
  },

  hooks: {
    description: "Toggle git hooks on/off (husky)",
    module: "./commands/hooks.ts",
    fn: "toggleHooks",
    context: "repo",
    args: [
      { name: "Target", type: "text", placeholder: "off | on | status | pre-push", hint: "Global action (off, on, status) or a specific hook name to target; omit for the interactive picker" },
      { name: "State", type: "select", hint: "on/off state to apply when Target is a specific hook name", options: [{ value: "on", label: "on" }, { value: "off", label: "off" }] },
    ],
  },

  run: {
    description: "Interactive script runner (repo → worktree → package → script)",
    module: "./commands/run.ts",
    fn: "runCommand",
    context: "worktree",
    requiresTTY: true,
    args: [
      { name: "Preset", type: "text", placeholder: "backend-lite", hint: "Launch a saved preset directly by name, skipping the picker chain" },
    ],
    subcommands: {
      again: {
        description: "Pick from recently run scripts across all repos",
        module: "./commands/run.ts",
        fn: "runAgainCommand",
        requiresTTY: true,
        args: [],
      },
    },
  },

  commit: commitNode,

  port: {
    description: "Port scanner + killer (zero-config, daemon-powered)",
    module: "./commands/port.ts",
    fn: "portScanner",
    args: [
      { name: "Port or subcommand", type: "text", placeholder: "8080 | kill", hint: "A port number to kill directly, or 'kill' to open the interactive kill picker; omit to list all ports" },
      { name: "Port", type: "text", placeholder: "8080", hint: "When the first argument is 'kill', a port number to kill directly instead of opening the picker" },
    ],
  },

  sdm: {
    description: "StrongDM connections: pick, connect, verify",
    subcommands: {
      connect: {
        description: "Pick a connection and connect",
        module: "./commands/sdm.ts",
        fn: "connectCmd",
        args: [
          { name: "Connection key", type: "text", placeholder: "e.g. prod-db", hint: "Connect to this connection directly; omit for the interactive picker" },
          { name: "Duration", flag: "--duration", type: "text", placeholder: "8h", hint: "How long to keep the connection open" },
          { name: "Reason", flag: "--reason", type: "text", placeholder: "e.g. debugging ticket", hint: "Why you need this connection" },
          { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Non-interactive; emit a JSON result envelope on stdout" },
          { name: "Confirm production", flag: "--confirm-production", type: "boolean", default: false, hint: "Required to connect to a production-tier resource non-interactively" },
        ],
      },
      connections: {
        description: "List StrongDM connections (machine-readable with --json)",
        module: "./commands/sdm.ts",
        fn: "connectionsCmd",
        args: [
          { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Envelope with connections, offered durations, and per-connection default reason" },
        ],
      },
      status: {
        description: "CLI auth health + connected tunnels",
        module: "./commands/sdm.ts",
        fn: "statusCmd",
        args: [
          { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Machine-readable health + appRunning + tunnels" },
        ],
      },
      login: {
        description: "Log in to StrongDM (browser popup by default)",
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
        args: [],
      },
      enrichment: {
        description: "Show or scaffold (init) the declarative enrichment map",
        module: "./commands/sdm.ts",
        fn: "enrichmentCmd",
        args: [
          { name: "Subcommand", type: "select", hint: "Omit to show enrichment coverage; 'init' scaffolds the enrichment file", options: [{ value: "init", label: "init", hint: "Scaffold ~/.rt/sdm/enrichment.jsonc from the scanned catalog" }] },
        ],
      },
      "set-email": {
        description: "Set your StrongDM email (skips the browser-login email prompt)",
        module: "./commands/settings.ts",
        fn: "setSdmEmail",
        args: [
          { name: "Email", type: "text", placeholder: "you@example.com", hint: "Your StrongDM account email; omit to be prompted interactively" },
        ],
      },
    },
  },

  status: {
    description: "Live branch dashboard with MR actions, pipeline & review status",
    module: "./commands/status/index.tsx",
    fn: "showStatus",
    context: "repo",
    fullscreen: true,
    args: [
      { name: "Fresh", flag: "--fresh", type: "boolean", hint: "Refresh the cache before rendering" },
      { name: "Max age", flag: "--max-age", type: "text", placeholder: "30s", hint: "Refresh first if the cache is older than this (45, 45s, 2m, 1h)" },
    ],
  },

  update: {
    description: "Update rt to the latest version via Homebrew",
    module: "./commands/update.ts",
    fn: "runUpdate",
    args: [],
  },

  version: {
    description: "Show current version and prod/dev mode",
    module: "./commands/version.ts",
    fn: "runVersion",
    args: [],
  },

  verify: {
    description: "Verify an rt installation end-to-end (run after brew install)",
    module: "./commands/verify.ts",
    fn: "runVerify",
    args: [
      { name: "CI", flag: "--ci", type: "boolean", default: false, hint: "Minimal, no-color output for CI logs" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable JSON output" },
    ],
  },

  open: {
    description: "Open external pages for the current branch",
    subcommands: {
      mr: {
        description: "GitLab merge request",
        module: "./commands/open.ts",
        fn: "openMR",
        context: "worktree",
        args: [],
      },
      pipeline: {
        description: "GitLab CI pipelines",
        module: "./commands/open.ts",
        fn: "openPipeline",
        context: "worktree",
        aliases: ["ci"],
        args: [],
      },
      repo: {
        description: "Repository page",
        module: "./commands/open.ts",
        fn: "openRepo",
        context: "worktree",
        args: [],
      },
      ticket: {
        description: "Linear ticket for this branch",
        module: "./commands/open.ts",
        fn: "openTicket",
        context: "worktree",
        aliases: ["linear"],
        args: [],
      },
    },
  },

  cd: {
    description: "Worktree/repo directory picker",
    module: "./commands/cd.ts",
    fn: "worktreePicker",
    requiresTTY: true,
    args: [
      { name: "Repo picker", flag: "--repo", type: "boolean", default: false, hint: "Always show the repo picker instead of the current repo's worktree list" },
      { name: "Package picker", flag: "--package", type: "boolean", default: false, hint: "Opt into the monorepo package picker, one level deeper than the worktree root (alias --packages)" },
      { name: "Worktree", flag: "--worktree", type: "text", placeholder: "feature/my-branch", hint: "Jump straight to the worktree whose branch starts with this text" },
    ],
  },

  nav: {
    description: "Navigate filesystem with fzf; persistent picker, esc to quit",
    module: "./commands/nav.ts",
    fn: "navigate",
    requiresTTY: true,
    args: [
      { name: "Path", type: "text", placeholder: ".", hint: "Starting directory; defaults to the current directory" },
    ],
  },

  code: {
    description: "Open a worktree in your preferred editor",
    module: "./commands/code.ts",
    fn: "openInEditor",
    requiresTTY: true,
    args: [
      { name: "Pick", flag: "--pick", type: "boolean", default: false, hint: "Force the worktree/repo picker instead of using the current repo (alias -p)" },
    ],
  },

  agent: {
    description: "Launch a CLI coding agent (Claude Code, Cursor, etc.) in a worktree",
    module: "./commands/agent.ts",
    fn: "launchAgent",
    requiresTTY: true,
    args: [
      { name: "Here", flag: "--here", type: "boolean", default: false, hint: "Use the exact current directory instead of resolving a repo/worktree (alias -h)" },
      { name: "Pick", flag: "--pick", type: "boolean", default: false, hint: "Force the repo/worktree picker before launching (alias -p)" },
    ],
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
        args: [
          { name: "Status", flag: "--status", type: "boolean", default: false, hint: "Show current sync config and watcher state" },
          { name: "Off", flag: "--off", type: "boolean", default: false, hint: "Disable syncing and remove the file watcher" },
        ],
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
        args: [],
      },
      enable: {
        description: "Turn on auto-park",
        module: "./commands/parking-lot.ts",
        fn: "enableCommand",
        args: [],
      },
      disable: {
        description: "Turn off auto-park (daemon scans become no-ops)",
        module: "./commands/parking-lot.ts",
        fn: "disableCommand",
        args: [],
      },
      scan: {
        description: "Run the park check immediately against the live cache",
        module: "./commands/parking-lot.ts",
        fn: "scanCommand",
        args: [],
      },
      this: {
        description: "Park the current worktree now (manual override; ignores enabled flag)",
        module: "./commands/parking-lot.ts",
        fn: "parkThisCommand",
        context: "worktree",
        args: [],
      },
      pick: {
        description: "Pick worktrees in this repo to park (multi-select)",
        module: "./commands/parking-lot.ts",
        fn: "parkPickCommand",
        context: "repo",
        requiresTTY: true,
        args: [],
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
        args: [
          { name: "All", flag: "--all", type: "boolean", default: false, hint: "Run in every worktree (mutually exclusive with --parked)" },
          { name: "Parked", flag: "--parked", type: "boolean", default: false, hint: "Run only in parked worktrees" },
          { name: "Command", type: "text", placeholder: "git status", hint: "Command to run in each selected worktree; omit both flags to pick interactively" },
        ],
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
        args: [],
      },
      sync: {
        description: "Apply the template across all worktrees (manual trigger)",
        module: "./commands/doppler.ts",
        fn: "syncCommand",
        context: "repo",
        args: [],
      },
      status: {
        description: "Show template vs. actual config per worktree",
        module: "./commands/doppler.ts",
        fn: "statusCommand",
        context: "repo",
        args: [],
      },
      edit: {
        description: "Open the template in $EDITOR",
        module: "./commands/doppler.ts",
        fn: "editCommand",
        context: "repo",
        requiresTTY: true,
        args: [],
      },
    },
  },

  // devOnly until the mattcloud cluster is live (validation-farm plan Task 9):
  // the compiled binary must not ship a verb whose backend exists nowhere yet.
  validate: {
    description: "Validate the worktree on the farm (snapshot → cluster verdict)",
    module: "./commands/validate.ts",
    fn: "validateCommand",
    context: "worktree",
    devOnly: true,
    args: [
      { name: "Wait", flag: "--wait", type: "boolean", default: false, hint: "Block until the farm verdict (exit 0 farm-green, 1 red, 2 infra)" },
      { name: "Manifest", flag: "--manifest", type: "text", placeholder: "~/.rt/repos/<repo>/gates.jsonc", hint: "Gate manifest path (defaults to the repo overlay's gates.jsonc)" },
    ],
    subcommands: {
      status: {
        description: "Per-group results for a run (defaults to the last submitted run)",
        module: "./commands/validate.ts",
        fn: "statusCommand",
        context: "worktree",
        args: [
          { name: "Run id", type: "text", placeholder: "run id", hint: "Controller run id; omit for the last run submitted from this repo" },
        ],
      },
      logs: {
        description: "Print a failed group's log from the controller",
        module: "./commands/validate.ts",
        fn: "logsCommand",
        args: [
          { name: "Run id", type: "text", placeholder: "run id", hint: "Controller run id" },
          { name: "Group", type: "text", placeholder: "tests", hint: "Task group name (format, lint, typecheck, cvi, tests)" },
        ],
      },
    },
  },

  cloud: {
    description: "mattcloud cluster operations",
    devOnly: true,
    subcommands: {
      secrets: {
        description: "Cluster Secret operations",
        subcommands: {
          sync: {
            description: "Doppler env snapshot → k8s Secret upsert (never touches disk)",
            module: "./commands/cloud.ts",
            fn: "secretsSyncCommand",
            context: "worktree",
            args: [],
          },
        },
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
        args: [],
      },
      uninstall: {
        description: "Remove the daemon",
        module: "./commands/daemon.ts",
        fn: "uninstall",
        args: [],
      },
      start: {
        description: "Start the daemon",
        module: "./commands/daemon.ts",
        fn: "start",
        args: [],
      },
      stop: {
        description: "Stop the daemon",
        module: "./commands/daemon.ts",
        fn: "stop",
        args: [],
      },
      restart: {
        description: "Restart the daemon",
        module: "./commands/daemon.ts",
        fn: "restart",
        args: [],
      },

      status: {
        description: "Show daemon status",
        module: "./commands/daemon.ts",
        fn: "showStatus",
        args: [],
      },
      track: {
        description: "Per-repo background tracking (live/poll/off)",
        module: "./commands/daemon.ts",
        fn: "manageTracking",
        aliases: ["events"],
        args: [
          { name: "Repo", type: "text", placeholder: "assured-dev", hint: "Repo name from ~/.rt/repos.json (omit to list; repo alone opens the interactive editor)" },
          { name: "Level", type: "text", placeholder: "live|poll|off", hint: "live (events + poll), poll (5-min only), off (on-demand only); omit to pick interactively" },
          { name: "Caches", type: "text", placeholder: "branches project-mrs", hint: "Cache kinds, space-separated: branches, project-mrs, discussions (default: branches)" },
        ],
      },
      logs: {
        description: "Show daemon logs",
        module: "./commands/daemon.ts",
        fn: "showLogs",
        args: [
          { name: "Terminal", flag: "--terminal", type: "boolean", default: false, hint: "Tail logs in terminal via lnav or pino-pretty instead of opening the web viewer (alias -t)" },
        ],
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
            args: [],
          },
          team: {
            description: "Set default Linear team",
            module: "./commands/settings.ts",
            fn: "setLinearTeam",
            args: [],
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
            args: [],
          },
        },
      },
      notifications: {
        description: "Toggle notification preferences",
        module: "./commands/settings.ts",
        fn: "configureNotifications",
        requiresTTY: true,
        args: [],
      },
      "test-push": {
        description: "Send a test push notification via rt tray",
        module: "./commands/settings.ts",
        fn: "sendTestPushNotification",
        args: [],
      },
      runaway: {
        description: "Configure runaway process detection thresholds",
        module: "./commands/settings.ts",
        fn: "configureRunaway",
        args: [
          { name: "Field", type: "select", hint: "Omit both to show current thresholds", options: [{ value: "cpu-threshold", label: "cpu-threshold", hint: "CPU percent" }, { value: "sustain-min", label: "sustain-min", hint: "Minutes sustained before flagging" }, { value: "grace-min", label: "grace-min", hint: "Grace period in minutes" }] },
          { name: "Value", type: "text", placeholder: "80", hint: "Numeric value for the chosen field" },
        ],
      },
      extension: {
        description: "Install RT Context extension in editors",
        module: "./commands/extension.ts",
        fn: "installExtension",
        requiresTTY: true,
        args: [],
      },
      "dev-mode": {
        description: "Toggle between local dev source and Homebrew production binary",
        module: "./commands/settings.ts",
        fn: "toggleDevMode",
        requiresTTY: true,
        args: [
          { name: "Target", type: "select", hint: "Omit to be prompted interactively", options: [{ value: "dev", label: "dev", hint: "Run from local source" }, { value: "prod", label: "prod", hint: "Run the Homebrew binary" }] },
        ],
      },
      llm: {
        description: "Configure local LLM for branch naming and other features",
        module: "./commands/settings.ts",
        fn: "configureLlm",
        requiresTTY: true,
        args: [],
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
        args: [
          { name: "Name", type: "text", placeholder: "my-plugin", hint: "Plugin name (kebab-case); omit to be prompted interactively" },
        ],
      },
      list: {
        description: "List installed plugins",
        module: "./commands/plugin.ts",
        fn: "runList",
        args: [],
      },
      validate: {
        description: "Deep-validate installed plugins",
        module: "./commands/plugin.ts",
        fn: "runValidate",
        args: [
          { name: "Plugin", type: "text", placeholder: "my-plugin", hint: "Validate only this plugin by directory name; omit to validate all installed plugins" },
        ],
      },
    },
  },
};
