# rt agent — the agent-handoff verb

**Date:** 2026-08-25
**Status:** Draft (spike-verified; pending review loop)
**Owner:** rt

## Problem

Four launchers in the estate hand work to a Claude Code agent, and each
re-implements the same contract by hand:

| launcher | invocation | model/account | session id | resume |
|---|---|---|---|---|
| mr-board `src/herdr.ts` (422 lines) | `cd cwd && <claudeCommand> '<prompt>'` | one global opaque string (`board.claudeCommand`: `cswap run <acct> --share-history -- --model 'opus[1m]'`) | agent self-reports via status-bin from `CLAUDE_CODE_SESSION_ID` | review/respond only; doctor structurally unresumable |
| gitq `src/server/herdr.ts` (163 lines, ~70% copied from mr-board) | `cd cwd && claude '<prompt>'` | none | stored, unused | none (comment promises it) |
| shepherdr `spawn-agent.sh` | `[cswap run X --] claude --model --effort`, wait idle, `agent prompt` | per-spawn | none | none |
| rt `lib/herdr-agent.ts` | `cd && claude`, wait idle, send task file | none | none | none |

The copies have drifted (`$bunfs` detection, dedup reporting), every new
capability lands once per app, and `lib/herdr-agent.ts` is **broken today**:
it calls `herdr wait agent-status`, a verb the current herdr binary rejects
(`unknown command: wait`; the live verb is `herdr agent wait --until`), so
rt's rebase-escalation pane path fails against the installed herdr.

History: rt shipped and deleted all three seeds of this feature —
`rt agent` (interactive launcher, deleted 2026-08-20), `lib/agent-runner.ts`
(headless `claude -p` piping, same day), and `lib/llm.ts` + `rt settings llm`
(Ollama, deleted 2026-08-21) — all in RT-50, all for lack of callers. This
design revives the surface with four concrete callers and one shared
implementation.

## Ratified decisions (Matt, 2026-08-24/25)

1. **Boundary: launch + record + resume only.** No liveness, no status, no
   restart, no fleet view. Liveness stays herdr's (`herdr agent wait`); work
   status stays in the caller's state files and skills. This preserves the
   rt-agent-boundary and managed-process-deprecation rulings.
2. **Spawn happens in the daemon**; the CLI verb is a thin client. Same
   layering as `rt chat` (CLI → daemon handlers → state.db).
3. **V1 provider: claude only**, both surfaces (herdr pane + headless
   `-p`). The record carries a `provider` field so codex can land later
   without a schema change; no other provider code ships.
4. **Policy is decomposed settings** (`agent.model`, `agent.account`,
   `agent.effort`) with call-time overrides and an opaque extra-args tail
   as the escape hatch. `board.claudeCommand`'s opaque-string pattern is
   the thing being retired (board migration is follow-up work, not V1).
5. **Name: `rt agent`** — `start | resume | show | list`.

## Spike findings (2026-08-25, all live-verified)

The spike reproduced the daemon's exact start env
(`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME SHELL USER`) and proved:

1. **Caller env is irrelevant for panes.** Two panes launched into the same
   herdr workspace — one by a bare-env caller, one by a full-env caller —
   have byte-identical environments except per-pane ids
   (`HERDR_PANE_ID`/`HERDR_TAB_ID`, mise/starship session keys). herdr's
   server owns the pane env; the caller contributes only the herdr binary
   path, the socket path, and the command string. The board has proven this
   in production for months (its launchd env is equally static).
2. **Minted session ids work.** `claude --session-id <uuid>` is honored
   interactively (pane) and headless (`-p`). A session started in a pane
   was resumed **headless** under the bare env with full memory — the
   cross-surface resume the board needs.
3. **Headless auth survives the bare env.** `claude -p` needs only `HOME`
   (auth is `~/.claude` file-based). `cswap run <acct> -- -p …` also works,
   but **cswap resolves `claude` via PATH** — the invoking env must carry
   `~/.local/bin` (the daemon's startup PATH overlay already does).
4. **Two CLI footguns the handler must guard:**
   - `--session-id ""` is **silently ignored** — claude mints a random id.
   - `-p --resume ""` **silently resumes the most recent session in cwd**.
   The handler validates the uuid (non-empty, UUID format) before any
   spawn, and never passes a resume id it did not read from the record.
5. **Session transcripts are per-account.** A session minted under one
   cswap account is invisible to another (per-profile `projects/` dirs).
   The account is therefore part of the resume identity: the record stores
   it, and `agent:resume` runs under the recorded account, erroring (not
   falling back) if asked to do otherwise.

## Design

### Command surface

```
rt agent start   [--repo <path>] [--prompt <text> | --prompt-file <path>]
                 [--surface herdr|headless] [--model M] [--effort E]
                 [--account A] [--label L] [--caller C]
                 [--workspace W] [--tab T] [--extra-args "<tail>"] [--json]
rt agent resume  <id|session-uuid> [--prompt <text>] [--surface herdr|headless] [--json]
rt agent show    <id|session-uuid> [--json]
rt agent list    [--repo <path>] [--json]
```

All four are thin clients over daemon commands `agent:start`,
`agent:resume`, `agent:get`, `agent:list`. `--json` emits the record —
the subroutine shape skills and apps consume. `commands/agent.ts` must be
registered in `lib/module-registry.ts` (compiled-binary footgun) as a
thunk, and stays off the eager-import list.

### Daemon handlers (`lib/daemon/handlers/agent.ts`)

**`agent:start`** — payload `{repo, cwd?, prompt | promptFile, surface,
model?, effort?, account?, label?, caller?, workspace?, tab?, extraArgs?}`.
`prompt` is required for the headless surface (`claude -p` with no prompt
blocks on stdin — refused, not spawned); optional for herdr (a bare
interactive pane). `workspace` and `tab` are herdr **labels** overriding
the defaults: workspace defaults to `repoLabel(repo)`, tab to `label`
(else the short id). `caller` is a free-form provenance string
(`"board:review"`, `"rt:rebase-escalation"`) recorded verbatim.

1. Resolve policy: explicit payload value → `agent.*` setting → code
   fallback (`surface: "herdr"`, model/effort/account unset ⇒ omitted from
   argv, matching today's plain-`claude` behavior). No registry defaults
   (fallbacks live in the read, per the settings contract).
2. Mint `sessionId = crypto.randomUUID()`; validate non-empty/UUID before
   building argv (spike footgun 4).
3. Build the claude argv:
   `[cswap run <account> --]? claude [--model M] [--effort E] --session-id <uuid> [<extraArgs…>] ['<prompt>']`.
4. Spawn per surface (below).
5. Insert the record; return it.

**`agent:resume`** — load record by rt id or session uuid; rebuild the
invocation with `--resume <sessionId>` under the **recorded** account and
cwd; optional new prompt; same surface as recorded unless overridden
(cross-surface resume is spike-proven). A resume onto the headless
surface requires a prompt, refused otherwise — the same stdin rule as
start. A herdr resume spawns a **fresh pane** via the same workspace/tab
sequence — no liveness check on the old one — with the tab label prefixed
`↺` (the board's `launchResume` precedent) so it never dedups against the
still-open launch tab; repeated resumes of the same record share that
label and dedup against each other (re-invoking focuses, doesn't
relaunch). The new `pane_id`/`tab_id`/`workspace_id` overwrite the
record's. Updates `lastResumedAt`. A missing record is an error — never
guess a session id.

**`agent:get` / `agent:list`** — read the table. `list` filters by repo
identity. No liveness field exists to report (decision 1).

### Surfaces

**herdr** — the board's proven verb sequence, lifted verbatim:
`workspace list` → (`workspace create --label … --no-focus` reusing its
initial tab, or `tab create --workspace … --label … --no-focus`, with
tab-label dedup: an existing live tab with the same label is focused, not
re-run) → `pane run <paneId> "cd '<cwd>' && <argv> '<prompt>'"`.
Kickoff is argv-prompt (board style), not wait-and-prompt: V1 targets
trusted cwds, where argv-prompt has months of production history. The
record stores `paneId`/`tabId`/`workspaceId`.

herdr is invoked by **absolute path** (`~/.local/bin/herdr` unless
`HERDR_BIN`) with `HERDR_SOCKET_PATH` set explicitly — Bun.spawn resolves
executables from the process-start PATH, so the daemon's runtime PATH
overlay does not apply to executable lookup (documented at
`lib/daemon.ts:110`). Every spawn passes `env: process.env` so the overlay
reaches children — which is what lets cswap find `claude` (spike finding 3).

**headless** — `claude -p --output-format json` spawned **async**
(`Bun.spawn`, never sync-exec on the daemon thread — MAT-222). The handler
returns the record immediately with `surface: "headless"`. On child exit
the daemon writes `exitCode`, `resultPath` (the captured JSON, under
`~/.rt/agents/<id>.json`), and `finishedAt` onto the record, and emits
`agent/done/<id>` on the events bus. Callers wait via `rt events wait` or
re-read `agent:get`. Recording the exit of a process rt itself spawned is
the result of the one bounded call, not supervision — rt still never
watches, restarts, or manages anything.

### The record (`agents` table, state.db)

```
id            TEXT PK      -- rt-minted short id
repo          TEXT         -- serialized repo identity (RT-62 wire form)
cwd           TEXT         -- realpath actually launched in
provider      TEXT         -- "claude" (V1)
surface       TEXT         -- "herdr" | "headless"
session_id    TEXT UNIQUE  -- minted uuid
model         TEXT NULL
effort        TEXT NULL
account       TEXT NULL    -- cswap account email; NULL = default profile
label         TEXT NULL    -- caller's display label
caller        TEXT NULL    -- e.g. "board:review", "rt:rebase-escalation"
pane_id / tab_id / workspace_id  TEXT NULL   -- herdr surface only
extra_args    TEXT NULL
exit_code     INTEGER NULL -- headless only
result_path   TEXT NULL    -- headless only
created_at / last_resumed_at / finished_at   INTEGER
```

Repo identity comes from rt-client 0.4.0
(`serializeIdentity(deriveRepoIdentity(cwd))`) — never re-derived with
local git calls, never the raw form, never shown to a human raw
(`repoLabel()` for display). `agent:list`'s repo filter takes the
serialized form only, matching every other repo-keyed verb.

### Settings (registry rows, new `agent.*` block)

| key | type | scopes | notes |
|---|---|---|---|
| `agent.model` | string | user, machine | no registry default; unset ⇒ no `--model` flag |
| `agent.effort` | string | user, machine | same |
| `agent.account` | string | user, machine | cswap email; unset ⇒ default profile |
| `agent.extraArgs` | string | user, machine | opaque tail appended to claude argv |

Fallbacks live in the handler's read (`getSetting(k).value ?? undefined`),
not in rows. Registry-first, then the per-consumer delivery checklist in
`docs/settings-architecture.md`.

### rt-client

`agentStart`, `agentResume`, `agentGet`, `agentList` wrappers + `Commands`
map entries, typed record. After the change: `bun run build` in
`packages/rt-client` and `bun install` in consumers (dist-staleness
footgun; `dist-freshness.test.ts` guards).

### In-repo consumer migration (V1 scope)

`lib/rebase-escalation.ts` moves from `lib/herdr-agent.ts` to the new
spawn path, which fixes its broken `wait agent-status` calls as a side
effect (the new code uses `herdr agent wait --until …`). `lib/herdr-agent.ts`
is deleted with it. `lib/herdr-launch.ts` (`rt run` fan-out, no agent) is
untouched.

### Error handling

- herdr socket absent / herdr exits nonzero → `{ok:false}` with herdr's
  stderr; nothing recorded.
- Resume with unknown id, or with `--account` differing from the record →
  error naming the recorded account (spike finding 5); no fallback.
- Malformed/empty session uuid at any boundary → refuse before spawning
  (spike finding 4).
- Empty-catch policy per repo CLAUDE.md: nothing below the handler seam
  swallows errors silently.

### Testing

- Unit: injectable herdr runner (the board's proven seam) asserting exact
  arg arrays for start/resume on both surfaces; uuid validation; policy
  resolution order; account-mismatch refusal.
- Store tests for the `agents` table (bunfig HOME isolation preserved).
- e2e: compiled binary under isolated HOME (`env -i HOME=<temp>`), fake
  `herdr`/`claude` shims on PATH via child-process env (Bun PATH snapshot
  rule) — no live herdr, no API calls in CI.

## Non-goals

- Liveness, status, supervision, restart, fleet views (ruled out).
- Codex / Cursor / Ollama providers (field reserved; no code).
- Orchestration of any kind — skills own workflows; this is one bounded
  launch per call.
- Migrating mr-board / gitq / shepherdr (follow-up lanes; the board keeps
  its `--state`/`--status-bin` prompt contract and simply stops needing
  session-id capture, since the launch response carries the minted id).
- Interactive pickers on the verb (subroutine shape; `rt run`-style UX can
  layer later if ever needed).
