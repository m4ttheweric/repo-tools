# repo-tools Roadmap

## Current State (Completed)

What's been built and is working today:

### Architecture
- **Declarative Command Tree** (`lib/command-tree.ts`) — centralized dispatcher handling screen clearing, breadcrumb headers (`rt › branch › switch`), fzf pickers, lazy module loading, and repo context
- **HTTP-over-Unix-Socket Daemon** (`lib/daemon.ts`) — `Bun.serve()` on `~/.rt/rt.sock`; client uses `fetch()` with `unix:` option. Replaced raw TCP socket protocol that was causing chunking/backpressure issues.
- **Batch API Layer** — single-call Linear (aliased GraphQL fields) and GitLab MR enrichment via `@workforge/glance-sdk`
- **Local Branch Cache** — daemon indexes all local branches (not just worktrees), ~56 entries with full ticket/MR data

### Migrated Commands
| Command | Status | Notes |
|---|---|---|
| `branch` (switch, create, team) | ✅ Fully migrated | Exports handler functions, declarative subcommands |
| `daemon` (install, uninstall, start, stop, status, logs) | ✅ Fully migrated | Exports handler functions, declarative subcommands |
| `open` (mr, pipeline, repo, ticket) | ✅ Fully migrated | 4 subcommands with aliases (`ci` → pipeline, `linear` → ticket). Linear ticket opener uses daemon cache for instant title/status. |

### Unmigrated Commands (functional, but use `run()` export pattern)
| Command | File | Has Subcommands? | `requiresRepo` |
|---|---|---|---|
| `x` | `commands/x.ts` | No (has internal wizard) | Yes |
| `build` | `commands/build-select.ts` | No | Yes |
| `hooks` | `commands/hooks.ts` | No | Yes (repo only, not worktree-specific) |
| `kill-port` | `commands/kill-port.ts` | No | No |
| `doctor` | `commands/doctor.ts` | No | No |
| `cd` | `commands/cd.ts` | No | No |
| `code` | `commands/code.ts` | No | No |
| `uninstall` | `commands/uninstall.ts` | No | Yes |
| `setup-keys` | `lib/linear.ts` | No | No |
| `type-check` | `commands/type-check.ts` | No | Yes (not yet in CLI tree) |

---

## Phase 1: Complete Command Tree Migration

> **Goal:** Every command exports named handler functions; no `run()` entry points remain. The command tree in `cli.ts` is the sole source of truth for command structure.

### Steps

For each unmigrated command:
1. Rename `export async function run(args)` → `export async function commandName(args)` (or keep it if the name is already descriptive)
2. Remove any manual `console.clear()`, header rendering, or `requireIdentity()` calls from the handler — the dispatcher does this
3. Remove any manual `filterableSelect()` sub-picker if the dispatcher's tree-based picker is appropriate
4. Update the `module`/`fn` reference in `cli.ts` if the export name changed

### Command-Specific Notes

| Command | Migration Notes |
|---|---|
| `x` | Most complex. Has its own internal wizard (script picker → run). Keep the wizard inside the handler — the dispatcher just calls it. Remove top-level `console.clear()`. |
| `hooks` | Only applies to repos, NOT worktrees. `requiresRepo: true` is correct but it should NOT prompt for worktree selection — just the repo. May need a `requiresRepoOnly` flag or adjust `requireIdentity` behavior. |
| `build` | Has its own turbo package selector. Keep that; remove boilerplate. |
| `type-check` | Not yet registered in `cli.ts`. Add it to the tree. |
| ~~`open`~~ | ~~Already a thin leaf. Trivial migration.~~ ✅ Done — now a branch node with 4 subcommands. |
| `cd` / `code` | These are repo pickers themselves — need careful handling so the dispatcher's `requiresRepo` doesn't conflict with their own picker. Set `requiresRepo: false`. |

### Verification
- `rt --help` shows all commands
- `rt <command>` direct invocation works for every command
- Interactive picker at every level shows clean screen + breadcrumb
- No duplicate headers or leftover artifacts

---

## Phase 2: Worktree Context Extension → repo-tools Integration

> **Goal:** Move the [worktree-context](file:///Users/matthew/Documents/GitHub/worktree-context) VS Code extension into `repo-tools/extensions/vscode/` and refactor it to query the `rt` daemon via HTTP instead of making its own API calls.

### Current Extension Architecture

The worktree-context extension (10 files, ~66KB) independently implements:

| Feature | Extension File | Equivalent in repo-tools |
|---|---|---|
| Branch parsing | `branchParser.ts` | `lib/linear.ts` → `extractLinearId()` |
| Linear ticket fetch | `linear.ts` + batch | `lib/linear.ts` → `fetchTicket()` / `fetchTicketsBatch()` |
| GitLab MR fetch | `gitlab.ts` | `lib/enrich.ts` via `@workforge/glance-sdk` |
| Git operations | `git.ts` | `lib/git-ops.ts` |
| Branch switching + stash | `branchSwitcher.ts` (652 lines) | `commands/branch.ts` → `switchBranch()` |
| Status bar enrichment | `statusBar.ts` (346 lines) | Daemon cache (`cache:read`) |
| Worktree picker | `worktreePicker.ts` | `lib/repo.ts` → `pickWorktree()` |
| Cache layer | `cache.ts` | Daemon in-memory cache + disk cache |

**Heavy duplication** — the extension does its own Linear/GitLab/Git calls when the daemon already has all this data cached and refreshed on a 5-minute interval.

### Migration Strategy

#### Step 1: Move Extension Into Monorepo
```
repo-tools/
  extensions/
    vscode/
      worktree-context/
        package.json
        src/
          extension.ts
          statusBar.ts
          ...
```

#### Step 2: Add Daemon HTTP Client to Extension

Replace the extension's direct API calls with daemon queries:

```typescript
// extensions/vscode/worktree-context/src/daemonClient.ts
const SOCKET_PATH = `${os.homedir()}/.rt/rt.sock`;

export async function daemonQuery(cmd: string, payload?: any) {
  // Use node:http with socketPath (VS Code extensions can't use Bun)
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET_PATH, path: `/${cmd}`, method: 'POST' }, ...);
    // ...
  });
}
```

#### Step 3: Refactor Status Bar to Use Daemon Cache

**Before (current):**
```
Extension starts → poll git every 30s → fetch Linear API → fetch GitLab API → render status bar
```

**After:**
```
Extension starts → query daemon /cache:read → render status bar (instant)
```

The daemon already has the cache warm. The status bar becomes a thin UI layer over the daemon's data.

#### Step 4: Simplify Branch Switcher

The extension's `branchSwitcher.ts` (652 lines) implements its own enrichment, stash handling, and switching. Replace with:

1. Branch list: `daemonQuery("cache:read")` for enrichment data
2. Git operations: Keep the VS Code Git API integration for checkout (it handles workspace reload)
3. Stash dialog: Keep the VS Code quickpick UX (it's the right pattern for a GUI)
4. Remove: All independent Linear/GitLab/Git exec calls

#### Step 5: Shared Types Package

Extract shared types into a small shared package or just import from repo-tools:

```typescript
// Shared between CLI and extension
export interface LinearTicket { ... }
export interface MRInfo { ... }  
export interface CacheEntry { ... }
```

### Extension Features to Preserve

These VS Code-specific features must be preserved (they don't have CLI equivalents):

| Feature | Notes |
|---|---|
| **Status bar item** | Shows ticket title + MR status inline in VS Code |
| **Open Linear ticket** | Command palette → open ticket URL |
| **Open GitLab MR** | Command palette → open MR URL |
| **Worktree picker** | Quick-switch between worktrees with workspace file preference |
| **Branch switcher** | VS Code quick pick (not fzf) with stash dialog |
| **API key management** | Store in VS Code secrets API (not `~/.rt/secrets.json`) |

> [!IMPORTANT]
> **Secrets bridge:** The extension currently stores API keys in VS Code's secrets store. After migration, it should read from `~/.rt/secrets.json` (shared with CLI) but fall back to VS Code secrets if that's where they were originally stored. Eventually unify to `~/.rt/secrets.json` only.

### New Daemon Endpoints Needed

| Endpoint | Method | Description |
|---|---|---|
| `GET /cache:read` | GET | Already exists — returns all cached branch data |
| `GET /status` | GET | Already exists — daemon health check |
| `POST /cache:refresh` | POST | Already exists — trigger background refresh |
| `GET /repos` | GET | List known repos + worktrees (extension needs this for picker) |
| `POST /branch:enrich` | POST | On-demand enrichment for a single branch (for new branches not yet in cache) |

### Verification
- Extension loads and shows status bar with daemon-sourced data
- Branch switcher shows enriched branches from daemon cache
- Extension falls back gracefully when daemon is not running
- `rt daemon status` shows VS Code as a connected client
- No duplicate API calls between extension and daemon

---

## Phase 3: New Features (Daemon-Powered)

> **Goal:** Leverage the daemon's always-warm cache for new high-value commands.

### `rt status` — Working Branch Dashboard
```
rt › status

  feature/cv-1415  ◉ MR opened  ✓ Pipeline passed  2/2 approved  [Code Review]
  feature/cv-1394  ◉ MR opened  ⟳ Pipeline running (3/17)       [Testing]
  feature/cv-1403    No MR       ● 3 commits ahead               [In Progress]
  master             ● Up to date
```
- All data from daemon cache — instant render
- `rt status --watch` for live updates

### `rt branch clean` — Stale Branch Cleanup
- Daemon tracks last-seen timestamps
- Show branches sorted by staleness
- Interactive bulk delete with safety checks

### Smart Notifications (macOS)
- Pipeline failures → native notification
- MR approved → notification 
- Merge conflicts detected → warning
- Via `osascript` for native macOS notification center

---

## Priority Order

1. **Phase 1: Command Tree Migration** — Incremental, low-risk. Can be done one command at a time.
2. **Phase 2: Worktree Context Integration** — High-value dedup. Eliminates a separate repo and shared maintenance burden.
3. **Phase 3: New Features** — Build on the foundation once Phases 1-2 are stable.
