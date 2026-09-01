// lib/command-tree-def.ts
/**
 * The built-in rt command tree: the single source of truth for command
 * names, descriptions, args, and structure. Kept in its own side-effect-free
 * module so both cli.ts (runtime dispatch) and scripts/gen-docs.ts (docs
 * generation) can import it without triggering the CLI entry logic.
 */
import type { CommandArg, CommandNode } from "./command-tree.ts";

const eventsSubcommands: Record<string, CommandNode> = {
  emit: {
    description: "Publish an event to a topic",
    module: "./commands/events.ts",
    fn: "eventsEmit",
    omitBehavior: { exempt: "the topic is a free-form string; nothing to enumerate" },
    args: [
      { name: "Topic", type: "text", placeholder: "job/myherd/report", hint: "Topic string; slash-separated by convention" },
      { name: "Payload", flag: "--json", type: "text", placeholder: "{\"k\":1}", hint: "Optional JSON payload (convention: small pointers, files carry data)" },
    ],
  },
  wait: {
    description: "Block until a matching event lands (long-poll; exit 124 on timeout)",
    module: "./commands/events.ts",
    fn: "eventsWait",
    omitBehavior: { exempt: "the match pattern is a free-form glob; nothing to enumerate" },
    args: [
      { name: "Pattern", type: "text", placeholder: "job/myherd/*", hint: "Glob pattern (* within a segment, ** across segments)" },
      { name: "After", flag: "--after", type: "text", placeholder: "42", hint: "Cursor from a previous response; omit for only-new events" },
      { name: "Timeout", flag: "--timeout", type: "text", placeholder: "5m", hint: "Give up after this long (30s, 5m, 500ms, bare seconds); omit to wait forever" },
    ],
  },
  tail: {
    description: "Stream matching events as NDJSON until interrupted",
    module: "./commands/events.ts",
    fn: "eventsTail",
    omitBehavior: "list",
    args: [
      { name: "Pattern", type: "text", placeholder: "job/**", hint: "Glob pattern to follow" },
      { name: "After", flag: "--after", type: "text", placeholder: "42", hint: "Start from this cursor (replays the journal first)" },
    ],
  },
  list: {
    description: "Read matching events from the journal (non-blocking)",
    module: "./commands/events.ts",
    fn: "eventsList",
    omitBehavior: "list",
    args: [
      { name: "Pattern", type: "text", placeholder: "job/**", hint: "Glob pattern to match" },
      { name: "After", flag: "--after", type: "text", placeholder: "0", hint: "Only events with id greater than this cursor" },
      { name: "Limit", flag: "--limit", type: "text", placeholder: "100", hint: "Cap the number of returned events" },
    ],
  },
};

const runsSubcommands: Record<string, CommandNode> = {
  show: {
    description: "One run: stages, fields, decisions",
    module: "./commands/runs.ts",
    fn: "runsShow",
    omitBehavior: "picker",
    args: [
      { name: "Run", type: "text", placeholder: "20260821-010101-abcd", hint: "Run id (repo auto-resolved; --repo to pin)" },
      { name: "Repo", flag: "--repo", type: "text", placeholder: "myrepo", hint: "Registry repo name" },
    ],
  },
  abandon: {
    description: "Mark a wedged run abandoned (the run died with its session and the DB still says running)",
    module: "./commands/runs.ts",
    fn: "runsAbandon",
    omitBehavior: "picker",
    args: [
      { name: "Run id", type: "text", placeholder: "20260822-134012-x4x2", hint: "Run to reconcile" },
      { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Repo the run belongs to; omit to scan" },
      { name: "Reason", flag: "--reason", type: "text", placeholder: "no owning process", hint: "Recorded against the run" },
    ],
  },
};

const interceptSubcommands: Record<string, CommandNode> = {
  run: {
    description: "Hidden verb the generated PATH shim execs — never call directly",
    module: "./commands/intercept.ts",
    fn: "interceptRun",
    hidden: true,
    args: [],
  },
  status: {
    description: "Shim + rule health for command interception",
    module: "./commands/intercept.ts",
    fn: "interceptStatus",
    args: [
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of a table" },
    ],
  },
  install: {
    description: "(Re)write PATH shims for every registered intercept command",
    module: "./commands/intercept.ts",
    fn: "interceptInstall",
    args: [
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of a summary" },
    ],
  },
  uninstall: {
    description: "Remove every generated intercept shim",
    module: "./commands/intercept.ts",
    fn: "interceptUninstall",
    args: [
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of a summary" },
    ],
  },
};

const endpointSubcommands: Record<string, CommandNode> = {
  lookup: {
    description: "Does this worktree hold a dev-endpoint claim for a role?",
    module: "./commands/endpoint.ts",
    fn: "endpointLookup",
    omitBehavior: "picker",
    args: [
      { name: "Role", type: "text", placeholder: "backend", hint: "Role name declared in the repo's endpoint config" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of a plain line" },
    ],
  },
  release: {
    description: "Manually free a worktree's dev-endpoint claim(s) (escape hatch for a claim liveness can't clear)",
    module: "./commands/endpoint.ts",
    fn: "endpointRelease",
    omitBehavior: "picker",
    args: [
      { name: "Worktree", type: "text", placeholder: "/path/to/worktree", hint: "Worktree whose claim(s) to release" },
      { name: "Role", flag: "--role", type: "text", placeholder: "backend", hint: "Only release this role; omit to release every role for the worktree" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of a plain line" },
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

const SETUP_JSON_ARG = { name: "JSON", flag: "--json", type: "boolean" as const, default: false, hint: "Machine-readable result" };

/**
 * One `status`/`connect` pair per integration id, generated so the tree, the
 * module's `setup<Id>Status`/`setup<Id>Connect` exports, and the app's
 * contract stay in lockstep. Slack alone also gets `create-app` (the
 * owner-once Slack app bootstrap). Pure — no side effects, safe to call at
 * module load. Stdin is self-describing (JSON parses as JSON, anything else
 * is read as the raw value) so there is no `--token-stdin`/
 * `--config-token-stdin` flag to declare; `--use-gh` only ever does anything
 * on github's `connect`, so only github's node offers it.
 */
function integrationNode(id: string, title: string): CommandNode {
  const fnId = id[0]!.toUpperCase() + id.slice(1);
  const connectArgs: CommandArg[] = [SETUP_JSON_ARG];
  if (id === "github") {
    connectArgs.push({ name: "Use gh", flag: "--use-gh", type: "boolean", default: false, hint: "Use the existing gh CLI session instead of a token" });
  }
  if (id === "gitlab" || id === "switchboard") {
    connectArgs.push({
      name: "Host",
      flag: "--host",
      type: "text",
      hint:
        id === "gitlab"
          ? "Confirm a self-hosted GitLab (e.g. gitlab.example.com) — a team-declared host is never used until you confirm it here"
          : "Confirm your switchboard URL (e.g. https://switchboard.example.com) — a team-declared URL is never used until you confirm it here",
    });
  }
  const subcommands: Record<string, CommandNode> = {
    status: {
      description: `${title}: check this account`,
      module: "./commands/setup.ts",
      fn: `setup${fnId}Status`,
      args: [SETUP_JSON_ARG],
    },
    connect: {
      description: `${title}: connect this account`,
      module: "./commands/setup.ts",
      fn: `setup${fnId}Connect`,
      args: connectArgs,
    },
  };
  if (id === "slack") {
    subcommands["create-app"] = {
      description: "Slack: create the team's Slack app (owner-once)",
      module: "./commands/setup.ts",
      fn: "setupSlackCreateApp",
      args: [SETUP_JSON_ARG],
    };
  }
  return { description: `${title}: check or connect this account`, subcommands };
}

export const TREE: Record<string, CommandNode> = {
  git: {
    description: "Git operations (rebase, reset, commit, backup)",
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
            omitBehavior: "picker",
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

  hooks: {
    description: "Toggle git hooks on/off (husky)",
    module: "./commands/hooks.ts",
    fn: "toggleHooks",
    omitBehavior: "picker",
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
    omitBehavior: "picker",
    context: "worktree",
    requiresTTY: true,
    // Every stage (fzf pickers, the launched board) owns the alt-screen, so the
    // dispatcher header would only leak into the normal buffer behind them.
    fullscreen: true,
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

  runner: {
    description: "Board of long-running commands in headless herdr panes (add, tail, restart, stop, focus)",
    module: "./commands/runner.ts",
    fn: "runnerCommand",
    context: "worktree",
    requiresTTY: true,
    fullscreen: true,
    args: [],
  },

  commit: commitNode,

  port: {
    description: "Port scanner + killer (zero-config, daemon-powered)",
    module: "./commands/port.ts",
    fn: "portScanner",
    omitBehavior: "list",
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
        omitBehavior: "picker",
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
        omitBehavior: "list",
        args: [
          { name: "Subcommand", type: "select", hint: "Omit to show enrichment coverage; 'init' scaffolds the enrichment file", options: [{ value: "init", label: "init", hint: "Scaffold ~/.mattstack/rt/sdm/enrichment.jsonc from the scanned catalog" }] },
        ],
      },
      "set-email": {
        description: "Set your StrongDM email (skips the browser-login email prompt)",
        module: "./commands/settings.ts",
        fn: "setSdmEmail",
        omitBehavior: "prompt",
        args: [
          { name: "Email", type: "text", placeholder: "you@example.com", hint: "Your StrongDM account email; omit to be prompted interactively" },
        ],
      },
    },
  },

  update: {
    description: "Check for updates via mattstack.app",
    module: "./commands/update.ts",
    fn: "runUpdate",
    args: [SETUP_JSON_ARG],
  },

  version: {
    description: "Show current version and prod/dev mode",
    module: "./commands/version.ts",
    fn: "runVersion",
    args: [],
  },

  verify: {
    description: "Verify an rt installation end-to-end (run after installing)",
    module: "./commands/verify.ts",
    fn: "runVerify",
    args: [
      { name: "CI", flag: "--ci", type: "boolean", default: false, hint: "Minimal, no-color output for CI logs" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable JSON output" },
    ],
  },

  cd: {
    description: "Worktree/repo directory picker",
    module: "./commands/cd.ts",
    fn: "worktreePicker",
    // The hidden --emit-rows reload path (commands/cd.ts) is deliberately
    // non-interactive, so it must clear the TTY gate on a plain pipe even
    // without RT_BATCH set. It is not declared in `args` below, so it never
    // shows up in help or a picker.
    requiresTTY: (args) => !args.includes("--emit-rows"),
    args: [
      { name: "Repo picker", flag: "--repo", type: "boolean", default: false, hint: "Always show the repo picker instead of the current repo's worktree list" },
      { name: "Package picker", flag: "--package", type: "boolean", default: false, hint: "Opt into the monorepo package picker, one level deeper than the worktree root (alias --packages)" },
      { name: "Worktree", flag: "--worktree", type: "text", placeholder: "feature/my-branch", hint: "Jump straight to the worktree whose branch starts with this text" },
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

  nav: {
    description: "Navigate filesystem with fzf; persistent picker, esc to quit",
    module: "./commands/nav.ts",
    fn: "navigate",
    omitBehavior: "picker",
    requiresTTY: true,
    args: [
      { name: "Path", type: "text", placeholder: ".", hint: "Starting directory; defaults to the current directory" },
    ],
  },

  worktree: {
    description: "Worktree lifecycle (provision/dispose/list) + worktree-wide operations",
    subcommands: {
      provision: {
        description: "Claim a worktree for a ticket or branch (from the on-deck pool, or freshly created)",
        module: "./commands/worktree.ts",
        fn: "worktreeProvision",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Registered repo name (defaults to the current repo)" },
          { name: "Ticket", flag: "--ticket", type: "text", placeholder: "RT-40", hint: "Linear ticket id — derives the branch name" },
          { name: "Title", flag: "--title", type: "text", placeholder: "Prune the parking lot", hint: "Ticket title, used with --ticket to derive the branch slug" },
          { name: "Branch", flag: "--branch", type: "text", placeholder: "feature/my-branch", hint: "Explicit branch name (overrides --ticket)" },
          { name: "Owner", flag: "--owner", type: "text", placeholder: "matt", hint: "Who's claiming this tree" },
          { name: "Disposal", flag: "--disposal", type: "text", placeholder: "merge", hint: "Disposal mode: merge (default) or job" },
          { name: "Wait", flag: "--wait", type: "boolean", default: false, hint: "Block until background ready steps (installs, migrations) settle instead of returning immediately" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      "claude-hook": {
        description: "Claude Code WorktreeCreate/WorktreeRemove hook endpoint (stdin JSON in, tree path out)",
        module: "./commands/worktree-hook.ts",
        fn: "claudeHookCommand",
        hidden: true,
        omitBehavior: { exempt: "agent-facing; driven by Claude Code over stdin, never interactively" },
        args: [
          { name: "Remove", flag: "--remove", type: "boolean", default: false, hint: "Handle a WorktreeRemove event (courtesy guarded dispose)" },
        ],
      },
      hook: {
        description: "Claude Code worktree hook: install, remove, or inspect the WorktreeCreate/WorktreeRemove wiring",
        subcommands: {
          install: {
            description: "Write the hook pair into ~/.claude/settings.json",
            module: "./commands/worktree-hook.ts",
            fn: "hookInstallCommand",
            args: [
              { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Print the result as JSON" },
            ],
          },
          uninstall: {
            description: "Remove rt's hook entries from ~/.claude/settings.json",
            module: "./commands/worktree-hook.ts",
            fn: "hookUninstallCommand",
            args: [
              { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Print the result as JSON" },
            ],
          },
          status: {
            description: "Report whether the hook is installed and healthy",
            module: "./commands/worktree-hook.ts",
            fn: "hookStatusCommand",
            args: [
              { name: "JSON output", flag: "--json", type: "boolean", default: false, hint: "Print the result as JSON" },
            ],
          },
        },
      },
      create: {
        description: "Create a fresh worktree (optionally straight into the on-deck pool)",
        module: "./commands/worktree.ts",
        fn: "worktreeCreate",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Registered repo name (defaults to the current repo)" },
          { name: "On-deck", flag: "--on-deck", type: "boolean", default: false, hint: "Put the new tree in the on-deck pool instead of claiming it" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      dispose: {
        description: "Dispose a worktree (no target + TTY → picker)",
        module: "./commands/worktree.ts",
        fn: "worktreeDispose",
        omitBehavior: "picker",
        args: [
          { name: "Tree", type: "text", placeholder: "my-tree", hint: "Tree name to dispose; omit to pick interactively" },
          { name: "Owner", flag: "--owner", type: "text", placeholder: "matt", hint: "Dispose every tree owned by this owner (can span repos)" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Narrow to this registered repo" },
          { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Override the dirty/unpushed guard" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      restore: {
        description: "Restore a disposed worktree from its retained trash entry (no target + TTY → picker)",
        module: "./commands/worktree.ts",
        fn: "worktreeRestore",
        omitBehavior: "picker",
        args: [
          { name: "Tree", type: "text", optional: true, placeholder: "my-tree", hint: "Disposed tree name to restore; omit to pick interactively" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Registered repo name (defaults to the current repo)" },
          { name: "List", flag: "--list", type: "boolean", default: false, hint: "List restorable entries instead of restoring one" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      "ready-approve": {
        description: "Approve a repo's team-authored `ready` shell before it runs (no repo + TTY → picker)",
        module: "./commands/worktree.ts",
        fn: "worktreeReadyApprove",
        omitBehavior: "picker",
        args: [
          { name: "Repo", type: "text", optional: true, placeholder: "repo-tools", hint: "Repo whose team `ready` ladder to approve; omit to pick interactively" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      list: {
        description: "List worktrees",
        module: "./commands/worktree.ts",
        fn: "worktreeList",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Narrow to this registered repo (default: every registered repo)" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      freshen: {
        description: "Freshen worktrees (no arg + TTY → picker over freshenable trees)",
        module: "./commands/worktree.ts",
        fn: "worktreeFreshen",
        omitBehavior: "picker",
        args: [
          { name: "Tree", type: "text", placeholder: "my-tree", hint: "Tree name to freshen; omit to pick interactively (or run for every repo, headless)" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Narrow to this registered repo" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      "await-ready": {
        description: "Wait for a claimed tree's background ready steps to settle (no tree + TTY → picker)",
        module: "./commands/worktree.ts",
        fn: "worktreeAwaitReady",
        omitBehavior: "picker",
        args: [
          { name: "Tree", type: "text", placeholder: "my-tree", hint: "Claimed tree to wait on; omit to pick interactively" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Registered repo name (defaults to the current repo)" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      adopt: {
        description: "One-shot migration: adopt an unmanaged repo's worktrees into the registry",
        module: "./commands/worktree.ts",
        fn: "worktreeAdopt",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Registered repo name (required)" },
          { name: "Claim", flag: "--claim", type: "boolean", default: false, hint: "Take ownership: adopt foreign worktrees as auto-disposing ephemerals (default: leave them unmanaged, untouched)" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the raw result as JSON" },
        ],
      },
      each: {
        description: "Run a command in each worktree (--all | --on-deck, else pick)",
        module: "./commands/worktree.ts",
        fn: "worktreeEach",
        omitBehavior: { exempt: "the command to run is free-text; nothing to enumerate (the worktrees themselves do get a picker)" },
        context: "repo",
        args: [
          { name: "All", flag: "--all", type: "boolean", default: false, hint: "Run in every worktree (mutually exclusive with --on-deck)" },
          { name: "On-deck", flag: "--on-deck", type: "boolean", default: false, hint: "Run only in on-deck worktrees (alias --parked)" },
          { name: "Command", type: "text", placeholder: "git status", hint: "Command to run in each selected worktree; omit both flags to pick interactively" },
        ],
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
        args: [
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit the verdict as JSON instead of the formatted lines" },
        ],
      },
      track: {
        description: "Per-repo background tracking (live/poll/off)",
        module: "./commands/daemon.ts",
        fn: "manageTracking",
        omitBehavior: "list",
        aliases: ["events"],
        args: [
          { name: "Repo", type: "text", placeholder: "acme-dev", hint: "Repo name from ~/.mattstack/rt/repos.json (omit to list; repo alone opens the interactive editor)" },
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
      "log-level": {
        description: "Show or set the daemon's live log level",
        module: "./commands/daemon.ts",
        fn: "setLogLevel",
        omitBehavior: "list",
        args: [
          { name: "Level", type: "select", hint: "Omit to show the current level",
            options: [
              { value: "trace", label: "trace" }, { value: "debug", label: "debug" },
              { value: "info", label: "info" }, { value: "warn", label: "warn" },
              { value: "error", label: "error" },
            ] },
        ],
      },
    },
  },

  events: {
    description: "Optional event bus for panes and skills",
    subcommands: eventsSubcommands,
  },

  // Self-dispatching leaf: agent() routes its own verbs (start/resume/show/list).
  agent: {
    description: "Hand a prompt to a Claude Code agent (herdr pane or headless) and keep the receipt",
    module: "./commands/agent.ts",
    fn: "agent",
    omitBehavior: "picker",
    args: [
      { name: "Verb", type: "text", placeholder: "start | resume | show | list", hint: "The agent action to run" },
      { name: "Id", type: "text", placeholder: "ag-1a2b3c4d", hint: "For resume/show: the handoff id or session uuid" },
      { name: "Repo", flag: "--repo", type: "text", placeholder: "~/Documents/GitHub/x", hint: "Repo path (default: the current repo)" },
      { name: "Prompt", flag: "--prompt", type: "text", placeholder: "...", hint: "Initial prompt (required for headless)" },
      { name: "Prompt file", flag: "--prompt-file", type: "text", placeholder: "path/to/prompt.md", hint: "Read the prompt from a file (mutually exclusive with --prompt)" },
      { name: "Surface", flag: "--surface", type: "text", placeholder: "herdr | headless", hint: "Where the agent runs (default herdr)" },
      { name: "Model", flag: "--model", type: "text", placeholder: "sonnet", hint: "Override agent.model" },
      { name: "Effort", flag: "--effort", type: "text", placeholder: "high", hint: "Override agent.effort" },
      { name: "Account", flag: "--account", type: "text", placeholder: "me@example.com", hint: "cswap account (override agent.account)" },
      { name: "Label", flag: "--label", type: "text", placeholder: "job7", hint: "Caller's display label; used as the herdr tab name" },
      { name: "Caller", flag: "--caller", type: "text", placeholder: "board:review", hint: "Identifies what invoked this handoff" },
      { name: "Workspace", flag: "--workspace", type: "text", placeholder: "reviews", hint: "herdr workspace label (default: the repo label)" },
      { name: "Tab", flag: "--tab", type: "text", placeholder: "!7", hint: "herdr tab label (default: the label or handoff id)" },
      { name: "Extra args", flag: "--extra-args", type: "text", placeholder: "\"--foo bar\"", hint: "Opaque extra claude arguments appended to the launch (override agent.extraArgs)" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit the record as JSON" },
    ],
  },

  // Self-dispatching leaf: chat() routes its own verbs (join/leave/archive/
  // post/read/rooms/who/mark/prune/sign-in/sign-out/away/back/buddies/dm/invite),
  // so all args flow through rather than a subcommand map.
  chat: {
    description: "Group chat for agents and their human, over the rt daemon",
    module: "./commands/chat.ts",
    fn: "chat",
    omitBehavior: "picker",
    args: [
      { name: "Verb", type: "text", placeholder: "join | leave | archive | post | read | rooms | who | mark | prune | sign-in | sign-out | away | back | buddies | dm | invite", hint: "The chat action to run" },
      { name: "Room", type: "text", optional: true, placeholder: "build", hint: "Room name for join/leave/archive/post/read/who/mark; the target handle for dm; the pane id for invite; omit on read/rooms/who to span everything, and on prune/sign-in/sign-out/buddies/back/away, which take no room" },
      { name: "Text", type: "text", optional: true, placeholder: "@handle message", hint: "A one-line message body (every word after the room/handle) — post, dm; leave it out and feed the body on stdin (a heredoc) so paragraphs and lists survive; away takes this directly, with no room before it" },
      { name: "As handle", flag: "--as", type: "text", placeholder: "repo-tools-main", hint: "Override the derived handle for this invocation; refused while signed in (sign out first)" },
      { name: "Wake on", flag: "--wake-on", type: "text", placeholder: "mention | all | none", hint: "For join: when this handle gets delivered a message (default mention)" },
      { name: "Reopen", flag: "--reopen", type: "boolean", default: false, hint: "For archive: clear the archive instead of setting it" },
      { name: "Limit", flag: "--limit", type: "text", placeholder: "20", hint: "For read: max messages (default 20)" },
      { name: "Since", flag: "--since", type: "text", placeholder: "5m", hint: "For read: a non-advancing peek at messages newer than this duration" },
      { name: "Last", flag: "--last", type: "text", optional: true, placeholder: "10", hint: "read: the newest N messages regardless of your cursor, then mark read" },
      { name: "Full", flag: "--full", type: "boolean", default: false, hint: "For read: uncapped message bodies" },
      { name: "Room filter", flag: "--room", type: "text", placeholder: "build", hint: "For sign-in: override the derived repository room; for invite: the room to join the invited pane into" },
      { name: "Note", flag: "--note", type: "text", optional: true, placeholder: "you own the vite side", hint: "invite: a one-line note appended to the /chat:join command" },
      { name: "Session", flag: "--session", type: "text", placeholder: "abc123", hint: "Session id override (default: CLAUDE_CODE_SESSION_ID); resolves position 0 handle for every verb, and is required by away/back" },
      { name: "Status", flag: "--status", type: "text", placeholder: "rebasing #67", hint: "For sign-in: an away/status message to set on the presence row" },
      { name: "No room", flag: "--no-room", type: "boolean", default: false, hint: "For sign-in: skip joining the derived repository room" },
      { name: "Pane", flag: "--pane", type: "text", placeholder: "w1:p1", hint: "For sign-in/sign-out: target this herdr pane's Claude session daemon-side (resolved via herdr), no CLAUDE_CODE_SESSION_ID needed" },
      { name: "Body file", flag: "--file", type: "text", placeholder: "post.md", hint: "For post/dm: read the body from a file instead of stdin or the text" },
      { name: "As is", flag: "--as-is", type: "boolean", default: false, hint: "For post/dm: post a long single-line body anyway (500+ characters with no line break is refused by default)" },
      { name: "Quiet", flag: "--quiet", type: "boolean", default: false, hint: "For sign-out: suppress output (the SessionEnd hook's flag)" },
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit machine-readable JSON instead of the plain rendering (join/leave/archive/post/read/rooms/who/mark/prune/buddies/dm/away/back/sign-in/sign-out/invite)" },
    ],
  },

  runs: {
    description: "Pipeline run state (read-only, from the run DB)",
    module: "./commands/runs.ts",
    fn: "runsList",
    args: [
      { name: "Repo", flag: "--repo", type: "text", placeholder: "myrepo", hint: "Scope to one registry repo" },
    ],
    subcommands: runsSubcommands,
  },

  intercept: {
    description: "Generic dev-command interception (PATH shims, port claiming)",
    subcommands: interceptSubcommands,
  },

  endpoint: {
    description: "Dev-endpoint claims (ports allocated for intercepted commands)",
    subcommands: endpointSubcommands,
  },

  deps: {
    description: "Bundled tools: resolve by absolute path, expose on PATH with tagged links",
    subcommands: {
      resolve: {
        description: "Show where a tool actually runs from — bundled, a user copy on PATH, or unresolved",
        module: "./commands/deps.ts",
        fn: "depsResolve",
        omitBehavior: "picker",
        args: [
          { name: "Tool", type: "text", placeholder: "gh", hint: "Tool name (rt, gh, fast-browser, gitq, deck, ...)" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the envelope as JSON" },
        ],
      },
      link: {
        description: "Expose a bundled tool at ~/.local/bin/<tool> (symlink, or a tagged wrapper for multi-argv tools)",
        module: "./commands/deps.ts",
        fn: "depsLink",
        omitBehavior: "picker",
        args: [
          { name: "Tool", type: "text", placeholder: "gh", hint: "Tool name to link" },
          { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Replace an existing user copy or unrelated file at the link path" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the outcome as JSON" },
        ],
      },
      unlink: {
        description: "Remove a tagged link (only ever removes rt's own links, never a user's file)",
        module: "./commands/deps.ts",
        fn: "depsUnlink",
        omitBehavior: "picker",
        args: [
          { name: "Tool", type: "text", placeholder: "gh", hint: "Tool name to unlink" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the outcome as JSON" },
        ],
      },
      reconcile: {
        description: "Auto-unlink any tagged link whose tool now has a genuine user copy elsewhere on PATH",
        module: "./commands/deps.ts",
        fn: "depsReconcile",
        args: [
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the outcome as JSON" },
        ],
      },
    },
  },

  state: {
    description: "rt's own state.db: backup, restore, and integrity",
    subcommands: {
      backup: {
        description: "Write a stamped state.db backup (VACUUM INTO) and prune backups past retention",
        module: "./commands/state.ts",
        fn: "stateBackup",
        args: [
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the outcome as JSON" },
        ],
      },
      restore: {
        description: "Restore state.db from a stamped backup copy (refuses while the daemon is running unless --force)",
        module: "./commands/state.ts",
        fn: "stateRestore",
        omitBehavior: "picker",
        args: [
          { name: "Copy", type: "text", placeholder: "state-2026-08-29T12-00-00-000Z.db", hint: "Backup filename (under rt state's backups dir) or an absolute path" },
          { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Override the running-daemon refusal (state.db is shared and WAL-mode; stop the daemon instead when possible)" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Print the outcome as JSON" },
        ],
      },
    },
  },

  settings: {
    description: "Configure tokens, team, and repo data",
    subcommands: {
      get: {
        description: "Read a resolved setting (value + provenance) through the settings resolver",
        module: "./commands/settings-keys.ts",
        fn: "settingsGet",
        omitBehavior: { exempt: "agent-facing; the key is passed explicitly (discover the set with rt settings list)" },
        args: [
          { name: "Key", type: "text", placeholder: "rt.worktrees", hint: "Namespaced settings key (see rt settings list)" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Repo name from ~/.mattstack/rt/repos.json — enables repo-scoped rungs and ${repoRoot}" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable output" },
        ],
      },
      set: {
        description: "Write a setting into one authored store (user/team/machine)",
        module: "./commands/settings-keys.ts",
        fn: "settingsSet",
        omitBehavior: { exempt: "agent-facing; key and value are passed explicitly (discover keys with rt settings list)" },
        args: [
          { name: "Key", type: "text", placeholder: "rt.worktrees", hint: "Namespaced settings key (must be migrated:true)" },
          { name: "Value", type: "text", placeholder: "{\"onDeck\":3}", hint: "JSON(C) value" },
          { name: "Scope", flag: "--scope", type: "select", hint: "Which store to write into", options: [{ value: "user", label: "user", hint: "~/.mattstack/user/settings.user.jsonc" }, { value: "team", label: "team", hint: "the local team clone's settings.team.jsonc" }, { value: "machine", label: "machine", hint: "~/.mattstack/user/local/<machine-key>/settings.local.jsonc" }] },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Repo name from ~/.mattstack/rt/repos.json — required for repo-scoped keys" },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which team's local store to write, for --scope team (only needed when several are cloned)" },
        ],
      },
      list: {
        description: "List every registered setting resolved through the settings resolver",
        module: "./commands/settings-keys.ts",
        fn: "settingsList",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Repo name from ~/.mattstack/rt/repos.json — enables repo-scoped rungs" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable output" },
        ],
      },
      explain: {
        description: "Show the full scope chain for one setting, weakest first",
        module: "./commands/settings-keys.ts",
        fn: "settingsExplain",
        omitBehavior: { exempt: "agent-facing; the key is passed explicitly (discover the set with rt settings list)" },
        args: [
          { name: "Key", type: "text", placeholder: "rt.worktrees", hint: "Namespaced settings key (see rt settings list)" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "acme-dev", hint: "Repo name from ~/.mattstack/rt/repos.json — enables repo-scoped rungs" },
        ],
      },
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
        omitBehavior: "list",
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
        description: "Toggle between local dev source and the installed production binary",
        module: "./commands/settings.ts",
        fn: "toggleDevMode",
        omitBehavior: "prompt",
        // A TTY is needed only to PROMPT for a target: an explicit target,
        // --json, and the bare read-only tuple print are all non-interactive.
        requiresTTY: () => false,
        args: [
          { name: "Target", type: "select", hint: "Omit to be prompted interactively", options: [{ value: "dev", label: "dev", hint: "Run from local source" }, { value: "prod", label: "prod", hint: "Run the installed binary (from mattstack.app)" }] },
        ],
      },
    },
  },

  home: {
    description: "The git-backed ~/.mattstack/user personal repo",
    subcommands: {
      init: {
        description: "Provision this machine: print, then run, the plan (which clones or git-inits the user repo as one of its steps)",
        module: "./commands/home.ts",
        fn: "homeInit",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print the plan without running it" },
          {
            name: "Clone URL",
            flag: "--url",
            type: "text",
            hint: "The user repo to clone — falls back to the setup intent's homeRepo, then RT_HOME_URL, then a local-only git init with no remote",
          },
          {
            name: "Profile",
            flag: "--profile",
            type: "text",
            hint: "Adopt this machine profile (user/local/<key>/); combine with --new-profile to create a new one under this name — skips the interactive picker on a fresh machine",
          },
          {
            name: "New profile",
            flag: "--new-profile",
            type: "boolean",
            default: false,
            hint: "Start a new machine profile (named by --profile, or this machine's hostname slug) instead of adopting an existing one",
          },
          {
            name: "No materialize",
            flag: "--no-materialize",
            type: "boolean",
            default: false,
            hint: "Skip the last phase — regenerating rt's PATH shims/daemon registration and each installed tool's setup verb",
          },
        ],
      },
      key: {
        description: "The mattstack age key (keychain-custodied)",
        subcommands: {
          export: {
            description: "Print the age private key once, for your password manager",
            module: "./commands/home.ts",
            fn: "homeKeyExport",
            args: [],
          },
          import: {
            description: "Import an age private key into the keychain (from your password manager)",
            module: "./commands/home.ts",
            fn: "homeKeyImport",
            args: [
              { name: "Stdin", flag: "--stdin", type: "boolean", default: false, hint: "Read the private key from stdin instead of a no-echo prompt (scripting)" },
              { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Overwrite a key already in the keychain" },
            ],
          },
        },
      },
      snapshot: {
        description: "Run the snapshot daemon now (or show its status with --status)",
        module: "./commands/home.ts",
        fn: "homeSnapshot",
        args: [
          {
            name: "Status",
            flag: "--status",
            type: "boolean",
            default: false,
            hint: "Show status instead of snapshotting: enabled, last run/commit, push state, claimed zones",
          },
        ],
      },
      claim: {
        description: "Claim a zone so the daemon leaves it for you to commit by hand",
        module: "./commands/home.ts",
        fn: "homeClaim",
        omitBehavior: "prompt",
        args: [
          {
            name: "Zone",
            type: "text",
            placeholder: "prefs/",
            hint: "Path (relative to the home repo) the daemon should stop auto-committing — a directory (prefs/) or a single file (scripts/deploy.sh)",
          },
          { name: "Owner", flag: "--owner", type: "text", hint: "Defaults to <you>@<machine-key>" },
          { name: "Note", flag: "--note", type: "text", hint: "Optional free-text reason, visible to anyone reading the owners file" },
          { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Reassign a zone already claimed by someone else" },
        ],
      },
      release: {
        description: "Release a claimed zone so the daemon resumes auto-committing it",
        module: "./commands/home.ts",
        fn: "homeRelease",
        omitBehavior: "picker",
        args: [
          { name: "Zone", type: "text", placeholder: "prefs/", hint: "Zone to release" },
        ],
      },
    },
  },

  secrets: {
    description: "sops-encrypted secrets under ~/.mattstack/user/secrets/",
    subcommands: {
      set: {
        description: "Write a secret (creates the domain file, or one key within it) — value prompted, never a CLI arg",
        module: "./commands/secrets.ts",
        fn: "secretsSet",
        omitBehavior: "prompt",
        args: [
          { name: "Domain", type: "text", placeholder: "rt", hint: "Secrets domain (rt, deck, board)" },
          { name: "Key", type: "text", placeholder: "linearApiKey", hint: "Key name within the domain" },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Write to this team's N-recipient store instead of your personal one" },
          { name: "Stdin", flag: "--stdin", type: "boolean", default: false, hint: "Read the value from stdin instead of a no-echo prompt (scripting)" },
        ],
      },
      list: {
        description: "List a domain's secret names (never prints values)",
        module: "./commands/secrets.ts",
        fn: "secretsList",
        omitBehavior: "picker",
        args: [
          { name: "Domain", type: "text", placeholder: "rt", hint: "Secrets domain (rt, deck, board)" },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "List from this team's store instead of your personal one" },
        ],
      },
      rotate: {
        description: "Replace a secret's value, or (--team with no domain/key) re-encrypt every team domain file to its current recipients — value prompted, never a CLI arg",
        module: "./commands/secrets.ts",
        fn: "secretsRotate",
        omitBehavior: "picker",
        args: [
          { name: "Domain", type: "text", placeholder: "rt", hint: "Secrets domain (rt, deck, board) — omit with --team to re-encrypt every domain file instead" },
          { name: "Key", type: "text", placeholder: "gitlabToken", hint: "Key name within the domain — omit with --team to re-encrypt every domain file instead" },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Rotate in this team's N-recipient store instead of your personal one" },
          { name: "Stdin", flag: "--stdin", type: "boolean", default: false, hint: "Read the new value from stdin instead of a no-echo prompt (scripting) — ignored by --team with no domain/key, which re-encrypts instead of taking a value" },
        ],
      },
    },
  },

  pane: {
    description: "herdr panes as rt sees them: list with chat presence, peek, spawn claude, cswap accounts, directory suggestions",
    subcommands: {
      list: {
        description: "Claude panes with their chat handle, status and rooms joined in (needs herdr)",
        module: "./commands/pane.ts",
        fn: "paneList",
        args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON instead of one line per pane" }],
      },
      peek: {
        description: "The last lines of a pane's visible screen",
        module: "./commands/pane.ts",
        fn: "panePeek",
        omitBehavior: { exempt: "agent-facing; the pane id is passed explicitly (discover panes with rt pane list)" },
        args: [
          { name: "Pane", type: "text", placeholder: "w7A:pY", hint: "herdr pane id" },
          { name: "Lines", flag: "--lines", type: "text", optional: true, placeholder: "8", hint: "How many lines from the bottom" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
      spawn: {
        description: "Open a herdr tab in a directory and start claude in it, optionally under a cswap account",
        module: "./commands/pane.ts",
        fn: "paneSpawn",
        args: [
          { name: "Directory", flag: "--cwd", type: "text", placeholder: "~/Documents/GitHub/chat", hint: "Absolute directory to start in" },
          { name: "Account", flag: "--account", type: "text", optional: true, placeholder: "Acme", hint: "cswap alias, email or slot" },
          { name: "Model", flag: "--model", type: "text", optional: true, placeholder: "claude-fable-5", hint: "claude --model" },
          { name: "Effort", flag: "--effort", type: "text", optional: true, placeholder: "high", hint: "claude --effort" },
          { name: "Prompt", flag: "--prompt", type: "text", optional: true, placeholder: "read AGENTS.md", hint: "Typed once claude is idle" },
          { name: "Workspace", flag: "--workspace", type: "text", optional: true, placeholder: "chat", hint: "herdr workspace label; default chat.herdrWorkspace" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
      send: {
        description: "Inject text into a pane as if typed and submitted (--text - reads stdin)",
        module: "./commands/pane.ts",
        fn: "paneSend",
        omitBehavior: { exempt: "agent-facing; the pane id is passed explicitly (discover panes with rt pane list)" },
        args: [
          { name: "Pane", type: "text", placeholder: "w7A:pY", hint: "herdr pane id to send to" },
          { name: "Text", flag: "--text", type: "text", placeholder: "standup in 5", hint: "Body to inject; pass - to read the body from stdin" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit the delivery result as JSON instead of the plain line" },
        ],
      },
      focus: {
        description: "Bring a herdr pane to the front (via the tray: workspace + tab focus and terminal window raise)",
        module: "./commands/pane.ts",
        fn: "paneFocus",
        omitBehavior: { exempt: "agent-facing; the pane id is passed explicitly (discover panes with rt pane list)" },
        args: [
          { name: "Pane", type: "text", placeholder: "w7A:pY", hint: "herdr pane id to focus" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit the focus result as JSON instead of the plain line" },
        ],
      },
      accounts: {
        description: "cswap accounts with rate-limit headroom, for spawn --account",
        module: "./commands/pane.ts",
        fn: "paneAccounts",
        args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" }],
      },
      directories: {
        description: "Repos and worktrees rt knows, as suggestions for spawn --cwd",
        module: "./commands/pane.ts",
        fn: "paneDirectories",
        args: [
          { name: "Filter", flag: "--q", type: "text", optional: true, placeholder: "chat", hint: "Substring of the path" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Emit JSON" },
        ],
      },
    },
  },

  repos: {
    description: "Register repos with rt (index + tracking)",
    subcommands: {
      register: {
        description: "Add repo paths to the rt index, optionally granting background tracking",
        module: "./commands/repos.ts",
        fn: "reposRegister",
        omitBehavior: "picker",
        args: [
          { name: "Path", type: "text", placeholder: "/path/to/repo", hint: "Repo path to register (pass more than one to register several at once)" },
          { name: "Track", flag: "--track", type: "select", options: [{ value: "live", label: "live" }, { value: "poll", label: "poll" }], hint: "Grant background tracking at this level; omit to register without tracking" },
          { name: "Caches", flag: "--caches", type: "text", placeholder: "branches,project-mrs", hint: "Comma-separated cache kinds for --track (default branches)" },
          SETUP_JSON_ARG,
        ],
      },
      prune: {
        description: "Drop index entries whose path is gone, and duplicate names left behind by a repo rename",
        module: "./commands/repos.ts",
        fn: "reposPrune",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would be removed without writing" },
          SETUP_JSON_ARG,
        ],
      },
      locate: {
        description: "Tell rt where a repo moved to — re-points the index, worktree registry, endpoint claims and git's worktree admin files together",
        module: "./commands/repos.ts",
        fn: "reposLocate",
        omitBehavior: "picker",
        args: [
          { name: "New path", type: "text", placeholder: "/path/to/moved-repo", hint: "Where the repo lives now; omit to pick from candidates under rt.repoRoots" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Which indexed repo moved (identity, path, or name); omit to match by the new path's own identity" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would be re-pointed without writing" },
          SETUP_JSON_ARG,
        ],
      },
    },
  },

  skills: {
    description: "Compile, check, and manage the surface of the pack's committed skills",
    subcommands: {
      link: {
        description: "Symlink a skills/*/SKILL.md tree into ~/.claude/skills by frontmatter name (create, repoint, prune; conflicts reported, never touched)",
        module: "./commands/skills-link.ts",
        fn: "skillsLink",
        args: [
          { name: "From", flag: "--from", type: "text", placeholder: "path/to/skills", hint: "Link this directory instead of the current repo's skills/ (no checkout needed)" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would change without touching disk" },
          SETUP_JSON_ARG,
        ],
      },
      materialize: {
        description: "Run merge-manifests.sh to materialize skill bindings for registered repos",
        module: "./commands/skills.ts",
        fn: "skillsMaterialize",
        args: [
          { name: "Repo", flag: "--repo", type: "text", placeholder: "myrepo", hint: "Materialize only this registered repo; omit for every known repo" },
          SETUP_JSON_ARG,
        ],
      },
      compile: {
        description: "Compile pack verbs from step sources + manifest bindings into committed SKILL.md files",
        module: "./commands/skills.ts",
        fn: "skillsCompile",
        args: [
          { name: "Pack", flag: "--pack", type: "text", placeholder: "acme", hint: "Pack name (--team still accepted); omit to pick from the discovered packs" },
          { name: "Verb", flag: "--verb", type: "text", placeholder: "watch-ci", hint: "Compile only this verb (repeatable); omit for every verb in the roster" },
          { name: "Manifest", flag: "--manifest", type: "text", placeholder: "/path/to/skills.jsonc", hint: "Manifest path; omit to auto-find the newest ~/.mattstack/repos/*/skills.jsonc naming this pack" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would be written without touching disk" },
          { name: "Preview", flag: "--preview", type: "boolean", default: false, hint: "Print the compiled SKILL.md to stdout and write nothing (needs a single --verb)" },
          SETUP_JSON_ARG,
        ],
      },
      check: {
        description: "Report compiled skills that no longer match their sources",
        module: "./commands/skills.ts",
        fn: "skillsCheck",
        args: [
          { name: "Pack", flag: "--pack", type: "text", placeholder: "acme", hint: "Pack name (--team still accepted); omit to pick from the discovered packs" },
          { name: "Verb", flag: "--verb", type: "text", placeholder: "watch-ci", hint: "Check only this verb (repeatable); omit for every compiled verb" },
          { name: "Manifest", flag: "--manifest", type: "text", placeholder: "/path/to/skills.jsonc", hint: "Manifest path; omit to auto-find the newest ~/.mattstack/repos/*/skills.jsonc naming this pack" },
          SETUP_JSON_ARG,
        ],
      },
      surface: {
        description: "List, set, or apply the pack's public/internal skill surface (bare invocation opens an fzf multi-toggle palette)",
        module: "./commands/skills.ts",
        fn: "skillsSurface",
        omitBehavior: "picker",
        args: [
          { name: "Mode", type: "text", placeholder: "list", hint: "list | set <name>... --public|--internal | apply; omit for the fzf palette" },
          { name: "Pack", flag: "--pack", type: "text", placeholder: "acme", hint: "Pack name (--team still accepted); omit to pick from the discovered packs" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "apply only: print planned moves without touching disk" },
          SETUP_JSON_ARG,
        ],
      },
      packs: {
        description: "List packs discovered from installed marketplace plugins that carry a surface.jsonc",
        module: "./commands/skills.ts",
        fn: "skillsPacks",
        args: [
          SETUP_JSON_ARG,
        ],
      },
      composition: {
        description: "Report the pack's full binding composition -- verbs, slots, fills, and every binder in the manifest (roster and stages both)",
        module: "./commands/skills.ts",
        fn: "skillsComposition",
        args: [
          { name: "Pack", flag: "--pack", type: "text", placeholder: "acme", hint: "Pack name (--team still accepted); omit to pick from the discovered packs" },
          { name: "Manifest", flag: "--manifest", type: "text", placeholder: "/path/to/skills.jsonc", hint: "Manifest path; omit to auto-find the newest ~/.mattstack/repos/*/skills.jsonc naming this pack" },
          SETUP_JSON_ARG,
        ],
      },
      bind: {
        description: "Write bindings.<engineRef>.<slot> = <fill> into the manifest (jsonc-parser, comments preserved), validate the fill against the slot's contract, and recompile (a stage bind recompiles the whole pack)",
        module: "./commands/skills.ts",
        fn: "skillsBind",
        omitBehavior: "picker",
        args: [
          { name: "Verb", type: "text", placeholder: "watch-ci", hint: "Roster verb or pipeline stage" },
          { name: "Slot", type: "text", placeholder: "domain", hint: "Slot declared on the verb's step" },
          { name: "Fill", type: "text", placeholder: "acme:watch-ci-domain-v2", hint: "<plugin>:<skill> binding string; must provide the slot's declared contract" },
          { name: "Pack", flag: "--pack", type: "text", placeholder: "acme", hint: "Pack name (--team still accepted); omit to pick from the discovered packs" },
          { name: "Manifest", flag: "--manifest", type: "text", placeholder: "/path/to/skills.jsonc", hint: "Manifest path; omit to auto-find the newest ~/.mattstack/repos/*/skills.jsonc naming this pack" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would change without writing" },
        ],
      },
    },
  },

  cron: {
    description: "Daemon cron triggers",
    subcommands: {
      install: {
        description: "Install a daemon cron trigger",
        module: "./commands/cron.ts",
        fn: "cronInstall",
        omitBehavior: "picker",
        args: [
          { name: "Trigger", type: "select", options: [{ value: "board-triage", label: "board-triage" }] },
          SETUP_JSON_ARG,
        ],
      },
      remove: {
        description: "Remove an installed daemon cron trigger",
        module: "./commands/cron.ts",
        fn: "cronRemove",
        omitBehavior: "picker",
        args: [
          { name: "Trigger", type: "select", options: [{ value: "board-triage", label: "board-triage" }] },
          SETUP_JSON_ARG,
        ],
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
        omitBehavior: "prompt",
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
        omitBehavior: "list",
        args: [
          { name: "Plugin", type: "text", placeholder: "my-plugin", hint: "Validate only this plugin by directory name; omit to validate all installed plugins" },
        ],
      },
    },
  },

  setup: {
    description: "Set this Mac up for mattstack: readiness plan, install steps, account connections",
    module: "./commands/setup.ts",
    fn: "setupInteractive",
    args: [
      { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan (skips the interactive walk)" },
      { name: "Force", flag: "--force", type: "boolean", default: false, hint: "Confirm install even though required rows are missing" },
    ],
    subcommands: {
      plan: {
        description: "Compute the readiness checklist",
        module: "./commands/setup.ts",
        fn: "setupPlan",
        args: [
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to plan for" },
          { name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan" },
        ],
      },
      status: {
        description: "The same checklist as a post-install health view",
        module: "./commands/setup.ts",
        fn: "setupStatus",
        args: [{ name: "JSON", flag: "--json", type: "boolean", default: false, hint: "Machine-readable plan" }],
      },
      apply: {
        description: "Run the install steps (hidden — the app spawns this for Install)",
        module: "./commands/setup.ts",
        fn: "setupApply",
        hidden: true,
        args: [
          { name: "From", flag: "--from", type: "text", placeholder: "path.link", hint: "Resume from this step id" },
          { name: "Non-interactive", flag: "--non-interactive", type: "boolean", default: false, hint: "Never prompt; skip steps that need a human" },
          { name: "Team of one", flag: "--team-of-one", type: "boolean", default: false, hint: "Solo install, no team" },
          { name: "CI", flag: "--ci", type: "boolean", default: false, hint: "Headless CI run" },
          { name: "No launch", flag: "--no-launch", type: "boolean", default: false, hint: "Never open a GUI app" },
          SETUP_JSON_ARG,
        ],
      },
      pack: {
        description: "Install a pack's plugins + skills, then check its pipeline stages resolve",
        module: "./commands/setup.ts",
        fn: "setupPack",
        args: [
          { name: "Non-interactive", flag: "--non-interactive", type: "boolean", default: false, hint: "Never prompt; skip steps that need a human" },
          { name: "Team of one", flag: "--team-of-one", type: "boolean", default: false, hint: "Solo install, no team" },
          { name: "CI", flag: "--ci", type: "boolean", default: false, hint: "Headless CI run" },
          SETUP_JSON_ARG,
        ],
      },
      intent: {
        description: "Record a setup intent for the app to act on (hidden)",
        module: "./commands/setup.ts",
        fn: "setupIntent",
        hidden: true,
        args: [
          { name: "Mode", type: "text", placeholder: "restore", hint: "restore <org>/<repo> | clear" },
          { name: "HomeRepo", type: "text", placeholder: "org/repo", hint: "org/repo of the home repo to restore (restore only)" },
          SETUP_JSON_ARG,
        ],
      },
      github: integrationNode("github", "GitHub"),
      gitlab: integrationNode("gitlab", "GitLab"),
      linear: integrationNode("linear", "Linear"),
      slack: integrationNode("slack", "Slack"),
      switchboard: integrationNode("switchboard", "Switchboard"),
      sdm: integrationNode("sdm", "StrongDM"),
      doppler: integrationNode("doppler", "Doppler"),
      ldcli: integrationNode("ldcli", "LaunchDarkly"),
    },
  },

  services: {
    description: "App-registered services (daemon, deck) via mattstack.app",
    subcommands: {
      list: {
        description: "List LaunchAgents mattstack.app has registered",
        module: "./commands/services.ts",
        fn: "servicesList",
        args: [SETUP_JSON_ARG],
      },
      register: {
        description: "Ask mattstack.app to register the daemon (and deck, when bundled) LaunchAgents",
        module: "./commands/services.ts",
        fn: "servicesRegister",
        args: [
          { name: "Plist", flag: "--plist", type: "text", placeholder: "com.mattstack.daemon.plist", hint: "Plist filename to register (repeatable); omit for the default set" },
          SETUP_JSON_ARG,
        ],
      },
      restart: {
        description: "Ask mattstack.app to restart a registered LaunchAgent",
        module: "./commands/services.ts",
        fn: "servicesRestart",
        omitBehavior: "picker",
        args: [
          { name: "Label", type: "text", placeholder: "com.mattstack.daemon", hint: "LaunchAgent label" },
          SETUP_JSON_ARG,
        ],
      },
    },
  },

  tools: {
    description: "Install or run the setup verb for a tool from a setup plan row",
    subcommands: {
      install: {
        description: "Install a tool (brew, vendor curl|sh, apple-clt, or the bundled copy)",
        module: "./commands/tools.ts",
        fn: "toolsInstall",
        omitBehavior: "picker",
        args: [
          { name: "Tool", type: "text", placeholder: "herdr", hint: "Tool name (herdr, claude, apple-clt, or a team-declared tool)" },
          SETUP_JSON_ARG,
        ],
      },
      setup: {
        description: "Run a tool's own post-install setup (herdr integration, fast-browser runtime, editor extension)",
        module: "./commands/tools.ts",
        fn: "toolsSetup",
        omitBehavior: "picker",
        args: [
          { name: "Tool", type: "text", placeholder: "herdr", hint: "Tool name (herdr, fast-browser, extension)" },
          { name: "Config dir", flag: "--config-dir", type: "text", placeholder: "/path/to/.claude", hint: "Extra Claude config dir to set up (repeatable); herdr's own CLAUDE_CONFIG_DIR + ~/.claude are always included" },
          SETUP_JSON_ARG,
        ],
      },
    },
  },

  uninstall: {
    description: "Uninstall mattstack: reverses setup — services, links, plugins, optionally ~/.mattstack",
    module: "./commands/uninstall.ts",
    fn: "runUninstallCommand",
    args: [
      { name: "Keep data", flag: "--keep-data", type: "boolean", default: false, hint: "Keep ~/.mattstack (settings, teams, secrets) — the default" },
      { name: "Delete data", flag: "--delete-data", type: "boolean", default: false, hint: "Also delete ~/.mattstack; requires --yes when not on a TTY" },
      { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "List what would be removed without removing anything" },
      { name: "Yes", flag: "--yes", type: "boolean", default: false, hint: "Skip the confirmation prompt" },
      SETUP_JSON_ARG,
    ],
  },

  team: {
    description: "Team repo: create, join, invite, publish, members",
    subcommands: {
      create: {
        description: "Scaffold a fresh team zone (~/.mattstack/teams/<slug>) and set its remote — Install pushes it",
        module: "./commands/team.ts",
        fn: "teamCreate",
        omitBehavior: "prompt",
        args: [
          { name: "Name", type: "text", placeholder: "Acme", hint: "Team display name — slugified for the on-disk directory" },
          { name: "Remote", flag: "--remote", type: "text", placeholder: "https://github.com/acme/mattstack-team-acme.git", hint: "An existing empty repo's URL" },
          { name: "Create repo", flag: "--create-repo", type: "text", placeholder: "acme", hint: "Owner (user or org) to create <owner>/mattstack-team-<slug> under via gh, instead of pasting --remote" },
          { name: "Others", flag: "--others", type: "boolean", default: false, hint: "Mark the team as having members beyond you" },
          SETUP_JSON_ARG,
        ],
      },
      publish: {
        description: "Push the local team zone to its remote (or a new one)",
        module: "./commands/team.ts",
        fn: "teamPublish",
        args: [
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to publish; omit when only one is cloned" },
          { name: "Remote", flag: "--remote", type: "text", placeholder: "https://github.com/acme/mattstack-team-acme.git", hint: "Set (or change) the remote before pushing" },
          SETUP_JSON_ARG,
        ],
      },
      invite: {
        description: "Mint an opaque invite code for a handle, and grant them forge read access",
        module: "./commands/team.ts",
        fn: "teamInvite",
        args: [
          { name: "Handle", flag: "--handle", type: "text", placeholder: "octocat", hint: "The invitee's forge username" },
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to invite into; omit when only one is cloned" },
          SETUP_JSON_ARG,
        ],
      },
      join: {
        description: "Redeem an invite (code on stdin, never an argument)",
        module: "./commands/team.ts",
        fn: "teamJoin",
        args: [
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Validate the code and check access without cloning or redeeming" },
          SETUP_JSON_ARG,
        ],
      },
      members: {
        description: "Roster: collect invitee keys / remove a member",
        subcommands: {
          sync: {
            description: "Collect every outstanding invite's reply key and add it as a sops recipient",
            module: "./commands/team.ts",
            fn: "teamMembersSync",
            args: [
              { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to sync; omit when only one is cloned" },
              SETUP_JSON_ARG,
            ],
          },
          remove: {
            description: "Revoke forge access, drop the roster entry, and re-encrypt without the member's key",
            module: "./commands/team.ts",
            fn: "teamMembersRemove",
            omitBehavior: "picker",
            args: [
              { name: "Handle", type: "text", placeholder: "octocat", hint: "The member's forge username" },
              { name: "Key", flag: "--key", type: "text", placeholder: "age1...", hint: "The recipient to remove, if it isn't recorded on the roster (a hand-edited store, a suspect entry)" },
              { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to remove from; omit when only one is cloned" },
              SETUP_JSON_ARG,
            ],
          },
        },
      },
      status: {
        description: "Team summary (name, remote, last push, members)",
        module: "./commands/team.ts",
        fn: "teamStatus",
        args: [
          { name: "Team", flag: "--team", type: "text", placeholder: "acme", hint: "Which cloned team to summarize; omit when only one is cloned" },
          SETUP_JSON_ARG,
        ],
      },
    },
  },
};
