# Test Coverage Design

## Context

This repository is a TypeScript/Bun developer CLI for repo workflows, daemon-managed processes, runner orchestration, notifications, Git workflows, and a VS Code extension. Development is largely agent-driven, so tests need to prioritize confidence and regression protection over raw coverage percentage.

The current broad coverage command:

```bash
bun test --coverage lib/daemon/__tests__ lib/__tests__ lib/runner/__tests__ lib/runner/keys/__tests__ commands/__tests__
```

reported 222 passing tests, 3 skipped tests, and 0 failures. The line coverage for imported files was about 53%. That number is useful as a trend, but it is incomplete because Bun only reports files imported by the selected tests.

The root `package.json` currently runs only `lib/daemon/__tests__`, while tests also exist under `lib/__tests__`, `lib/runner/__tests__`, `lib/runner/keys/__tests__`, and `commands/__tests__`. This makes the default test command narrower than the actual test suite.

## Goal

Increase confidence in agent-driven changes by adding fast, focused tests around high-risk behavior:

- Decision-heavy logic.
- Persistence and corrupt-file recovery.
- Process, daemon, and runner lifecycle behavior.
- Command argument interpretation and side effects.
- Extension parsing and cache behavior.

Coverage percentage should improve, but it is a secondary signal. The primary signal is whether critical workflows have regression coverage.

## Non-Goals

- Do not chase line coverage by snapshotting large TUI files directly.
- Do not make the PTY smoke test mandatory when a live daemon owns its port.
- Do not introduce broad refactors unless a small extraction is needed to test a high-risk path.
- Do not add slow end-to-end tests as the main safety net.

## Approach

Use a risk-first strategy:

1. Make the default test command run all existing first-party tests.
2. Add unit tests for pure logic and persistence helpers.
3. Add handler and command tests around routing and destructive-operation guards.
4. Expand runner dispatch and keymap tests through extracted, dependency-injected helpers.
5. Add lightweight tests for the VS Code extension's pure modules.
6. Add agent-facing test expectations so future changes either update tests or justify why not.

This approach gives agents quick feedback and clear boundaries without turning the suite into a brittle end-to-end harness.

## Phase 1: Test Command Baseline

Update root scripts so `bun test` runs all tracked test suites under:

- `commands/__tests__`
- `lib/__tests__`
- `lib/daemon/__tests__`
- `lib/runner/__tests__`
- `lib/runner/keys/__tests__`

Add a `test:coverage` script with the same suite scope and `--coverage`.

Keep the PTY smoke test skippable when port `9401` is owned by a real daemon. Document the skip as an integration constraint rather than a failure.

Expected result: the default test command reflects the real suite, and agents do not accidentally pass by running only daemon tests.

## Phase 2: Pure Logic and Persistence

Add focused tests for:

- `lib/repo.ts`: remote URL derivation, repo identity fallback, workspace package discovery, malformed package files, and missing config.
- `lib/enrich.ts`: remote URL parsing, branch label formatting, cache TTL behavior, missing secrets, provider fetch failures, and Linear ID extraction from MR titles.
- `lib/notifier.ts`: notification prefs defaults, queue persistence, branch transition detection, stale port transitions, approval transitions, and suppression rules.
- `lib/daemon-config.ts`, `lib/repo-config.ts`, and `lib/parking-lot-config.ts`: missing files, corrupt JSON, save/load round trips, and default values.
- `lib/git-ops.ts` and `lib/git.ts`: command failure handling and parsing behavior, using temporary repos where a real Git boundary is more valuable than mocks.

Expected result: high-change utility modules get cheap, deterministic coverage for edge cases that agents are likely to break.

## Phase 3: Daemon and Command Routing

Add handler-level tests for `lib/daemon/handlers/*` using fake `HandlerContext` objects. Prioritize:

- Process handler command payload validation and cleanup calls.
- Cache handler refresh/read behavior.
- Group, proxy, ports, parking-lot, workspace, discussions, hooks, and MR handler success/error envelopes.
- Status handler behavior when Git commands fail or repo paths are missing.

Add command-level tests for high-risk commands:

- `commands/agent.ts`: extend existing target resolution tests to cover installed-agent selection and spawn invocation shaping where practical.
- `commands/code.ts`: editor resolution, workspace target selection, preference persistence, and prompt decisions.
- `commands/workspace.ts`: workspace candidate selection and sync behavior.
- `commands/settings.ts`: token/team/dev-mode preference paths, with file writes isolated to temp directories.
- `commands/run.ts`, `commands/sync.ts`, and `commands/git/rebase.ts`: argument parsing, dry-run or quiet paths, failure handling, and destructive-operation guards.

Expected result: command and daemon behavior becomes testable without starting the whole daemon for every case.

## Phase 4: Runner Confidence

Expand tests around `lib/runner/dispatch.ts` and `lib/runner/keys/*`:

- Start, stop, restart, remove-entry, remove-lane, and reset mutations.
- Active entry and active command updates.
- Proxy start, pause, resume, and cleanup side effects.
- Command switching across running and stopped entries.
- Keymap collisions and shortcut behavior for normal, process, lane, picker, port, confirm, and open modes.

Avoid direct tests against the full `commands/runner.tsx` TUI unless behavior cannot be reached through extracted helpers.

Expected result: runner state transitions and keyboard-driven behavior are protected without relying on fragile render snapshots.

## Phase 5: VS Code Extension Tests

Add a lightweight test setup for `extensions/vscode/rt-context` using Bun where possible.

Start with pure modules:

- `branchParser.ts`: Linear ID extraction and remote URL parsing.
- `cache.ts`: TTL, invalidation, and branch-list snapshots.
- `git.ts`: parser helpers such as worktree and branch parsing; use temporary repos only for behavior that depends on real Git output.
- `worktreePicker.ts`: `resolveOpenTarget` and preference behavior with fake extension context objects.
- `statusBar.ts`: extract and test render helpers for ticket/MR/worktree labels before testing VS Code activation.

Expected result: extension logic gets coverage without needing a full VS Code integration test harness.

## Phase 6: Agent-Facing Quality Gates

Add a short testing policy for future agent work:

- Changes to covered modules should update or add tests.
- Changes to uncovered modules should either add coverage or document why the path is not practical to test yet.
- Bug fixes should include regression tests when the bug is reproducible.
- Risky process, Git, daemon, notification, or runner changes should include at least one test that would fail before the change.

Track two signals:

- Broad coverage trend from `test:coverage`.
- A critical-workflow checklist that marks whether each high-risk workflow has regression coverage.

The checklist matters more than the coverage percentage.

## Verification

Each phase should run:

```bash
bun test
bun test --coverage commands/__tests__ lib/__tests__ lib/daemon/__tests__ lib/runner/__tests__ lib/runner/keys/__tests__
```

When extension tests are added, include the extension test command in the root verification path or document it as a separate required check.

## Acceptance Criteria

- The default root test script runs every existing first-party Bun test suite.
- A root coverage script exists and uses the same suite scope.
- High-risk pure modules have targeted tests for success, failure, and corrupt-state paths.
- Daemon handlers have fake-context tests for success and error envelopes.
- Runner dispatch and keymap behavior has meaningful branch coverage for common actions.
- The VS Code extension has lightweight unit tests for parser/cache/target-resolution logic.
- The project has an agent-facing policy that makes tests expected for future changes.

