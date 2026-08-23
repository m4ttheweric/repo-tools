# rt Startup Performance + Substrate Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut rt's fixed per-invocation cost from ~110ms, then collapse the loose JSON state under `~/.mattstack/rt` into the two substrates that already exist — settings stores for human intent, `state.db` for everything derived — including the two files whose readers are not TypeScript.

**Architecture:** Phase 1 removes work from every invocation: one Error class is dragging React+Ink+yoga into the dispatcher, and the compiled binary eagerly evaluates all 30 command modules. Phase 2 adds stores to the **existing** `lib/state` layer (RT-48) — it is not a greenfield sqlite build. Phase 3 pays the two costs Matt ruled in (2026-08-22): the git hook execs `rt hooks check` instead of grepping JSON, and the Swift daemon shim reads sqlite instead of `dev-mode.json`. Phase 1 must merge before Phase 3, because Phase 3 puts an `rt` spawn on the git-hook hot path.

**Tech Stack:** Bun (TypeScript, `bun:sqlite`), Swift (rt-tray daemon shim), sh (git hooks, PATH shims).

**Spec:** None separate. Evidence base: `~/.mattstack/work/scratch/mattstack-file-substrate-survey.md`, the measurements below, and `docs/settings-architecture.md` (binding for anything touching settings stores).

## Measured baseline (2026-08-22, warm, load ~1.8)

Reproduce with `/usr/bin/time -p <binary>` over 5+ runs; first runs are cold and misleading.

| Subject | Time | Meaning |
|---|---|---|
| Empty `bun build --compile` binary (63MB) | ~0ms | Bun runtime and binary size are NOT the cost |
| `dist/rt --version` (compiled) | **~110ms** | The floor every command pays |
| `rt --version` (dev-mode wrapper) | ~250ms | What Matt experiences daily |
| `import "lib/module-registry.ts"` | ~105ms | Nearly the whole cost |
| `import "lib/rt-render.tsx"` (Ink+React) | **~30ms** | Inside the above; also on the dispatcher's path |
| `import "lib/command-tree-def.ts"` | ~0ms | Command tree is not the cost |
| `rt settings get <key>` | ~110ms | Settings resolution is ~0 delta |
| Registry rewritten as `() => import(...)` thunks | ~60ms | Proven ceiling for Task 2 |
| `--bytecode` build | **fails** | `yoga-layout/dist/src/index.js:13` parse error |

Two independent causes:

1. `lib/command-tree.ts:31` does `import { BackNavigation } from "./rt-render.tsx"` — a four-line `class BackNavigation extends Error` used for one `instanceof` check — and `rt-render.tsx` statically imports `ink` and `@inkjs/ui`. Every invocation loads the whole TUI graph for an error class.
2. `lib/module-registry.ts` statically imports all 30 command modules (it exists because `bun build --compile` cannot resolve `import(variable)`), so every invocation evaluates the entire command surface to run one command. `cli.ts:60` claims handlers are lazy-loaded; true in source mode, silently false in the compiled binary.

**Ink reachability (corrected — an earlier draft of this plan got this wrong).** Ink is NOT confined to `commands/status/*`. `lib/rt-render.tsx` is rt's interactive prompt kit (`select`, `confirm`, `textInput`, `filterableSelect`, `multiselect`, spinners, step runners) and is reached from ~17 command modules plus `lib/{arg-collector,pickers,plugin-api,repo,rebase-escalation,navigate,command-tree}` and `lib/tui/*`. `lib/ScrollableList.tsx` imports `ink` directly too. Most of those reach it through `await import()`, which defers *evaluation* but still *bundles* — so lazy loading does not remove Ink from a `--compile` bundle, and therefore does not unblock `--bytecode`. Treat bytecode as unlikely (Task 3).

## Global Constraints

- Worktree `/Users/matt/Documents/GitHub/repo-tools-perf-wt`, branch `startup-and-substrate` off origin/main.
- **Rebuild command is `bun build --compile ./cli.ts --outfile dist/rt`.** There is no `build` script in package.json.
- **The benchmark is a gate, not a note.** Task 1 lands `scripts/bench-startup.ts`; every later task re-runs it and records the number. A task regressing startup >10ms fails review.
- **`lib/state/` already exists (RT-48) and is the only way to touch `state.db`.** Every consumer outside `lib/state/` imports through the barrel `lib/state/index.ts`, never `./db.ts` or a store module directly — store modules register legacy importers into `LEGACY_IMPORTS` at import time and a bypassing consumer can permanently skip a migration. Read that barrel's header before writing any Phase 2 code. Never open a second connection to `state.db`.
- **Never touch the real `~/.mattstack`.** Tests repoint `process.env.HOME` via the existing bunfig preload. Live migration on Matt's machine is ORCHESTRATOR-ONLY, never a subagent action.
- Bun freezes `os.homedir()` and spawn-PATH at process start — resolve HOME at call time (`process.env.HOME ?? homedir()`).
- Phase 2 files are **caches and machine-local state, not settings**: no ownership latch, no registry row, do NOT route them through `getSetting`.
- Comments constraint-only. One commit per task. Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gates per task, FOREGROUND: `bun test lib commands packages` + `bun x tsc --noEmit`, plus the bench from Task 1 onward.
- Known load-dependent flakes: `worktree-reconciler` kick() and `worktree-handlers` fail under full-suite load, pass isolated. Verify isolated; do not chase.

---

## Phase 1 — Startup

### Task 1: Bench harness + get Ink off the dispatcher

**Files:**
- Create: `scripts/bench-startup.ts` — 2 warmup runs then N=10 timed runs of `dist/rt --version`; reports min/median/max ms; exits non-zero if median exceeds a threshold from argv (default 120).
- Create: `lib/back-navigation.ts` — move `class BackNavigation extends Error` (currently `lib/rt-render.tsx:36`) here verbatim. Zero dependencies.
- Modify: `lib/rt-render.tsx` — re-export `BackNavigation` from the new module so existing importers keep working.
- Modify: `lib/command-tree.ts:31-32` — import `BackNavigation` from `./back-navigation.ts`; the `SelectOption` import at :32 is already `import type` (erased, free) but must NOT be converted to a value import.
- Test: `lib/__tests__/no-eager-tui.test.ts` — asserts `lib/command-tree.ts` has no static import of `rt-render`/`ink`. This is the regression guard; the class can drift back easily.

- [ ] **Step 1:** Write `scripts/bench-startup.ts`. Build (`bun build --compile ./cli.ts --outfile dist/rt`) and record the baseline median. Expect ~110ms.
- [ ] **Step 2:** Write the failing guard test. Run it, watch it fail against the current eager import.
- [ ] **Step 3:** Extract `BackNavigation`, re-export, repoint `command-tree.ts`.
- [ ] **Step 4:** Rebuild, re-bench. Record both numbers. Expected: ~30ms off. If the saving is under 10ms, report — the measurement above may not survive real dispatch, and that changes Task 3's appetite.
- [ ] **Step 5:** Full gates, commit.

### Task 2: Lazy module registry

**Files:**
- Modify: `lib/module-registry.ts` — replace the 30 `import * as x` statements and namespace-valued `MODULE_REGISTRY` with `Record<string, () => Promise<any>>` of **literal** dynamic imports: `"./commands/run.ts": () => import("../commands/run.ts")`. Literal specifiers stay statically analyzable, so the compiled-binary constraint the module header describes still holds — update that header to say why thunks are safe where `import(variable)` is not.
- Modify: `lib/command-tree.ts:523-527` — `resolveHandler` is already `async` (verified), so this is `const mod = await loader();` before reading `mod[node.fn || "run"]`. Leave the source-mode dynamic-import fallback untouched.
- Test: `lib/__tests__/module-registry.test.ts` — every command-tree `module:` entry has a registry key; every thunk resolves to a module exporting its declared `fn`.

- [ ] **Step 1:** Failing test (registry values are functions; each resolves and exports its fn).
- [ ] **Step 2:** Convert the registry; update `resolveHandler`.
- [ ] **Step 3:** Rebuild, re-bench. Expected ~60ms or better combined with Task 1.
- [ ] **Step 4:** Gates, commit.

### Task 3: Remaining eager TUI + bounded bytecode spike + regression gate

- [ ] **Step 1:** Find every remaining static (non-`await import`) importer of `rt-render`/`ink` on a hot path — `commands/commit.ts` is one. Convert to `await import()` at the call site, matching the pattern `commands/worktree.ts:246` already uses. Re-bench.
- [ ] **Step 2 (SPIKE, timeboxed — expected to fail):** Attempt `bun build --compile --bytecode`. It currently dies on `yoga-layout`. Because dynamic imports are still bundled, this only succeeds if Ink is excluded from the bundle entirely, which means the status dashboard and every prompt in `rt-render` leave the main binary. Do NOT restructure the TUI to chase this. Record the exact error and stop.
- [ ] **Step 3:** Wire `scripts/bench-startup.ts` into `rt verify` (or the release path) with the threshold set 20% above the achieved median, so an eager import cannot silently reintroduce the regression.
- [ ] **Step 4:** Update `CLAUDE.md`'s module-registry footgun: the registry is still mandatory, its values are thunks, and adding an eager `import` there or to `command-tree.ts` is a startup regression.
- [ ] **Step 5:** Gates, commit.

---

## Phase 2 — `state.db` for TypeScript-only state

Ten paths from the survey are read and written exclusively by TypeScript. `machine-key` is NOT among them: there is exactly one machine-key file, `~/.mattstack/machine-key` (the user-facing override read by `lib/rt-paths.ts`), nothing under `rt/`, and it does not move.

### Task 4: Schema v2 on the existing state layer

**Context the implementer must verify first:** the live `state.db` is `user_version = 1` (`SCHEMA_VERSION = 1` in `lib/state/db.ts:25`) with tables `branch_cache`, `discussions`, `kv`, `notify_queue`, `project_mrs`, `project_mrs_meta`, `project_mr_demands`. The v0→v1 migration that drains `LEGACY_IMPORTS` is one-shot and has **already run on Matt's machine**, so a legacy importer registered now would never fire there.

- [ ] **Step 1:** Read `lib/state/db.ts` and `lib/state/index.ts` in full. Determine whether `migrate()` steps version-by-version or jumps straight to `SCHEMA_VERSION` (line ~237 reads `user_version` then applies and stamps). Report which, because it decides whether v1→v2 needs its own step function. Do not write code before reporting this.
- [ ] **Step 2:** Failing tests: a v1 database migrates to v2 gaining the new tables with existing rows intact; a fresh database reaches v2 directly; the one-shot legacy-import behavior for the new stores works on BOTH paths (fresh and already-v1).
- [ ] **Step 3:** Implement `SCHEMA_VERSION = 2`, the v1→v2 step, and the new tables. Decide whether the new state fits the existing generic `kv` table or warrants its own tables, and state which and why in the report.
- [ ] **Step 4:** **File mode decision.** The live `state.db` is `0644`; this plan later moves `api-token` (a credential) into it. Tighten the database to `0600` — every reader is the same uid (CLI, daemon, tray, VS Code extension host) so nothing needs group/other read — and add a test asserting the mode. If tightening breaks any reader, STOP and report; `api-token` then stays a file rather than moving into a world-readable database.
- [ ] **Step 5:** Gates, commit.

### Task 5: Migrate the pure caches (6 files)

`repos.json`, `intercepts.json`, `worktree-reactor-state.json`, `home-snapshot-state.json`, `sdm/state.json`, `sdm/scan-cache.json` — all regenerable, all TS-only (reviewer-confirmed). No migration ceremony: point reader/writer at the store through the barrel, best-effort unlink the legacy file on first write.

**Files:** `lib/repo-index.ts`, `lib/endpoint/shim.ts`, the reactor-state and snapshot-state writers, `lib/sdm/*`. Exact writer/reader lines are in the survey.

- [ ] **Step 1:** Per file: failing test that the value round-trips through the store and a stale on-disk file is ignored.
- [ ] **Step 2:** Implement all six in one commit — same mechanical change, one review surface.
- [ ] **Step 3:** Bench (`repos.json` is on the hot path — confirm no regression), gates, commit.

### Task 6: Per-repo state + api-token

`repos/<repo>/endpoints.json`, `repos/<repo>/run-history.jsonl`, `repos/<repo>/worktrees.json`, and `api-token`.

- Per-repo paths become rows keyed by repo name; the per-repo directory stays for what must remain files (`agent-tasks/`, installed hook shims).
- `run-history.jsonl` is append-with-compaction today; in sqlite it is rows with a bounded delete, deleting the compaction logic entirely.
- `api-token` moves ONLY if Task 4 Step 4 achieved `0600`. Its reader `extensions/vscode/rt-context/src/secrets.ts:24-31` reads the file directly from the extension host (a separate Node process) and must be updated in this same task or the extension breaks.

- [ ] **Step 1:** Failing tests per path, including an extension-side test for the api-token reader.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Gates, commit.

### Task 7: `logdy-pino-columns.json` → `rt/tmp/`

Not sqlite-able (logdy reads it via `--config`) but it needn't persist. Write it under `rt/tmp/` at viewer launch. Writer is `commands/daemon.ts:736-739`.

- [ ] Failing test → implement → gates → commit.

---

## Phase 3 — The two non-JS readers

**Do not start before Phase 1 is merged.**

### Task 8: `hooks.json` → `rt hooks check`

The installed hook (`commands/hooks.ts:108-136`, wired via `core.hooksPath`) greps raw JSON on every git operation. **It also does more than that**: an inline on-deck-branch bash guard and delegation to `.husky/$HOOK_NAME`. This task replaces ONLY the JSON grep with `rt hooks check <hook-name>`; the on-deck guard and husky delegation stay in bash. Moving those into rt is out of scope.

- [ ] **Step 1:** Measure the current hook's cost (`/usr/bin/time` on a git operation in a hooked repo). Record it — this is the number the change is judged against.
- [ ] **Step 2:** Failing tests: `rt hooks check <name>` exits 0/1 per stored config; the generated hook body execs rt, propagates the exit code, and still runs the on-deck guard and husky delegation.
- [ ] **Step 3:** Implement — config into the store (barrel API), grep becomes an exec.
- [ ] **Step 4:** Re-measure git-operation cost. If the delta exceeds the Phase 1 saving, STOP and report: the ruling assumed startup would absorb it.
- [ ] **Step 5:** Gates, commit.

### Task 9: `dev-mode.json` → sqlite in the Swift daemon shim

`rt-tray/Sources-daemon-shim/main.swift:53-66` reads this file to `execv` into `bun run lib/daemon.ts`, before bun or the daemon exist. Writer `commands/settings.ts:405`, TS reader `commands/settings.ts:357`.

- [ ] **Step 1:** Confirm `libsqlite3` links cleanly in that target with no dependency beyond the system library. If it drags in more, STOP and report.
- [ ] **Step 2:** Define and document the exact table/columns the Swift reader queries — a foreign reader hard-codes schema, so this couples the shim to the migration story. Note in `lib/state/db.ts` that this table has an out-of-tree reader and cannot be renamed casually.
- [ ] **Step 3:** Implement the Swift read, including: missing file/table tolerated the way today's `standDown("no dev-mode config...")` path does, and `busy_timeout` set so a concurrent CLI writer cannot wedge boot.
- [ ] **Step 4:** Keep `dev-restore-cwd.ts` a file (it is code, loaded via `--preload`).
- [ ] **Step 5:** Verify a dev-mode daemon actually starts **under launchd** — this is the exact path that produced the `exit 127` incident; a green build is not evidence.
- [ ] **Step 6:** Gates, commit.

---

## Phase 4 — Sweep

### Task 10: Verify and clean

- [ ] **Step 1:** Re-run the survey's method over every remaining path under `~/.mattstack/rt`; report anything with no live reader.
- [ ] **Step 2:** Confirm legacy files are gone on a live machine and a fresh `rt home init` on a clean HOME produces none (orchestrator-only).
- [ ] **Step 3:** Final bench vs the ~110ms baseline; record in the ledger and in `CLAUDE.md` if worth carrying.
- [ ] **Step 4:** Gates, commit.

---

## Explicitly out of scope

- **The self-describing layer** (path registry, `rt home explain`, or a lightweight settings/state UI). Matt's ruling 2026-08-22: design it after this cleanup, when the substrate has stopped moving.
- **Replacing Ink** (e.g. with ratatat). Evaluated 2026-08-22: its win is render throughput, not import cost; it still uses yoga so it would not unblock bytecode; its native Rust engine is a poor fit for `bun build --compile`; and it is early-stage. Revisit only if the status dashboard becomes a live-updating app.
- `hooks/` shim scripts, `plugins/`, `plugin-api/`, `plugin-data/`, `dev-restore-cwd.ts`, `logs/`, `tmp/`, `rt.sock`, `tray.sock`, `rt.pid`, `sync.log`, `sdm/chrome-profile/`, `repos/<repo>/agent-tasks/` — structural files, OS primitives, or code.
- `user/secrets/*` — sops operates on files by design.
- `branch-naming.json` — blocked on the VS Code extension (RT-53).
