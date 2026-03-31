# repo-tools (rt) CLI Roadmap

Multi-phase roadmap for rt CLI: command restructure + tree migration, worktree-context extension integration, and daemon-powered features (status dashboard, port discovery, notifications).

## Phases

- [ ] **Phase 0** — [Command Restructure](phase-0.md) — Rationalize the command surface: remove type-check, create settings branch node (absorbing setup-keys, branch team, uninstall), rename kill-port to port with scan/kill subcommands.
- [ ] **Phase 1** — [Leaf Command Migration](phase-1.md) — Migrate all remaining commands from run() exports to named handler functions in the declarative command tree.
- [ ] **Phase 2** — [Worktree Context Extension Integration](phase-2.md) — Move the worktree-context VS Code extension into repo-tools and refactor it to query the rt daemon via HTTP instead of making independent API calls.
- [ ] **Phase 3** — [Daemon Port Discovery](phase-3.md) — Add zero-config port discovery to the daemon by scanning listening TCP ports and matching process CWD to known worktree/repo paths.
- [ ] **Phase 4** — [Status Dashboard & Notifications](phase-4.md) — Build rt status (instant branch dashboard from daemon cache) and smart macOS notifications for pipeline failures, MR approvals, and stale ports.

## Conventions

- Each phase has: **Setup → Steps (with commits) → Wiring Check → Teardown → Next Agent Prompt**
- Commit after each step: `phase-N: step description`
- Git status must be clean at end of each phase
- Use MCP tools to update phase status: `start_phase`, `complete_phase`
- Use `get_next_prompt` to get the pre-built prompt for the next agent session
