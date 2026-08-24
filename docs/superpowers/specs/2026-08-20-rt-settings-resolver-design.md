# rt settings resolver: four files, one namespace — design

**Ticket:** RT-47 (build) — decision record: Linear doc "settings architecture: four files, one resolver" (project distribution); evidence: the settings-inventory doc + the 2026-08-19 code-to-file trace.
**Date:** 2026-08-20 (rev 2, after fable review round 1)
**Status:** Approved design (ruled with Matt 2026-08-19 late), wave 1 scope.

## Problem

Mattstack configuration is ~40 scattered files across five bespoke systems (rt per-repo overlays, rt app files, skills manifests, board config, deck settings), mostly backed up nowhere, with team knowledge trapped on one machine and every shared artifact needing a copy+regen pipeline (merge-manifests, config.team.json, intercepts.json) that buys a staleness bug class. A team invite cannot fulfill rt/board settings from anywhere.

## The ruling (summary; the decision record is authoritative)

Four authored stores, one resolver, no materialized artifacts for our own tools:

1. **user** — `~/.mattstack/user/settings.jsonc` (in the mattstack-prefs repo): global keys + `repos.<identity>` sections.
2. **team** — `~/.mattstack/teams/<team>/mattstack/settings.jsonc` (in the team repo zone): shared keys + `repos.<identity>` sections.
3. **machine** — `~/.mattstack/settings.local.jsonc`: local overrides; the ONLY scope where path literals are legal. Never travels.
4. **secrets** — namespace reserved now (schema `secret: true`); values stay where they are until RT-32.

## Resolution model

**Scope order** (weakest to strongest): `default < legacy < team < user < team.repos < user.repos < machine < machine.repos`.

- `legacy` = the pre-migration per-tool file for that key (wave 1: per-repo `config.json` keys). It beats the registry default and loses to every store. Its use is first-class in provenance so migration progress is observable.
- **Merge semantics are per-key schema, not global.** `SettingDef.merge: "replace" | "deep"`. `replace`: the strongest scope's value wins atomically. `deep`: object values overlay field-by-field walking weakest→strongest (arrays inside a deep key still replace atomically; scalars replace). Wave-1 assignments: `rt.worktrees` deep (proof case: team supplies `onDeck`/`ready`, user supplies `namePool`, legacy supplies whatever a repo still has — all coexist), `rt.roles` deep at every object level (user may override one role's `pool` without restating the team's other roles), `rt.intercepts` replace (an array; splicing rule lists is a footgun).
- **teamLocked** keys resolve `team.repos > team > default` only; user/machine/legacy values are ignored AND reported as `shadowed` by `explain`.
- **Unknown keys**: explicit `get`/`set` of an unregistered key = hard error (honesty rule). Unregistered keys FOUND in store files = warn + skip + labeled in `list` as `unregistered` — never a hard failure, because teammates run version-skewed binaries and one new key in the team store must not brick older rt's resolution.

## Store file format

```jsonc
{
  "rt.llm": { "provider": "ollama", "model": "qwen3" },        // global key
  "repos": {
    "gitlab.com/acme/acme-dev": {                         // repo IDENTITY, never a path
      "rt.roles": { "backend": { "pool": [{ "from": 10400, "to": 10463 }], "preserveEnv": ["POSTGRES_URL", "FEATURE_FLAG_*"], "env": { "PORT": "${port}" }, "hook": "bun ${team:acme}/packs/acme/scripts/rt-dev-hook.ts" } },
      "rt.intercepts": [ /* same shape as lib/endpoint/config.ts today */ ]
    }
  }
}
```

Keys are namespaced flat strings. Values may be large objects — a big key beats a separate file. JSONC comments are first-class and MUST survive writes.

## Variables

Expansion replaces ONLY the closed set `${repoRoot}`, `${worktree}`, `${home}`, `${team:<name>}`; **any other `${...}` passes through verbatim** (domain templates like the interceptor's `${port}`/`${envKeys}` are not ours to expand). `${team:<name>}` expands lexically to `~/.mattstack/teams/<name>` with NO existence check (a missing team surfaces at use time through the consumer's own fail-open path — e.g. hooks). An unexpandable variable FROM THE CLOSED SET (e.g. `${repoRoot}` with no repo context) errors loudly. Expansion happens in `get` when `expand: true` (default) with the caller's context.

## Repo identity

Identity = normalized remote: `host/path` lowercase-host form (`gitlab.com/acme/acme-dev`); strip protocol, credentials, trailing `.git`; unify `ssh://` and `git@host:` forms. **Only recognized host forms normalize; a local-path remote (they exist in the wild: repos.json has two) yields identity null**, meaning repo sections are unreachable and only global scopes + legacy apply — honest degrade. Verified: all worktrees of a repo share `remote.origin.url`, so identity is checkout-location-independent (the requirement that started this).

**Derivation is never a sync spawn.** `deriveRepoIdentity` is async (Bun.spawn capture), memoized per repo path in-process. `getSetting` itself takes only a pre-derived `repoIdentity` string — callers supply it from data in hand: `buildInterceptRules` already captures each repo's remote (zero extra spawns), `run.ts` has `rule.repoRemote`, daemon endpoint handlers derive once per claim via the async helper (repoName → path via the repo index → memoized remote capture). The intercept shim's match path keeps using the local rules cache and never derives anything.

Fork/multi-remote pinning: machine store key `rt.repoIdentityOverrides`, a map **keyed by remote URL** (`{ "<observed-remote>": "<identity>" }`) so one entry covers every worktree of a repo (path-keyed maps break under worktree pools).

## Schema registry

`lib/settings/registry.ts`: `interface SettingDef { key: string; type: "string"|"number"|"boolean"|"object"|"array"; scopes: Scope[]; default?: unknown; merge: "replace"|"deep"; teamLocked?: boolean; secret?: boolean; repoScoped?: boolean; migrated: boolean; legacyFile?: string; description: string }`.

- `migrated: true` = the reader goes through the resolver (wave 1: `rt.roles`, `rt.intercepts`, `rt.worktrees`).
- A registered key whose FOUND value fails type validation in some store: warn + skip that scope (labeled `invalid` in `list`/`explain`), never a hard error — same version-skew reasoning as unregistered keys.
- `rt.repoIdentityOverrides` is itself a registered machine-scope key (`type: object`, `merge: replace`).
- `migrated: false` entries exist so `rt settings list` shows the full map — but list LABELS them (`reads legacy: <file>`), and `set` on them REFUSES with a pointer to the legacy file AND to the live sibling subcommand where one exists (`rt settings notifications`, `rt settings runaway`) (writing a store value nothing reads is the dishonesty class this design bans). Wave-1 `migrated:false` entries: `rt.llm`, `rt.cron`, `rt.repoTracking`, `rt.notifications`, `rt.mr`, `rt.sync`, `rt.branchNaming`, `rt.variations`, `rt.presets`, `rt.workspaceSync`, `rt.dopplerTemplate`, `rt.workspacePrefs`, `rt.runaway`, `rt.hooks`.
- No `path` type exists; shared-scope validation rejects absolute-path-looking string values outside the machine store (heuristic: leading `/` or `~` on keys/fields documented as locations; enforced for wave-1 keys on the `hook` field specifically, best-effort elsewhere). Computed defaults that cannot live in the registry (e.g. `rt.worktrees.root` = `join(repoPath, ".worktrees")`) stay in the reader, documented on the def.

## Resolver

`lib/settings/resolve.ts`:

```ts
export type Scope = "machine.repo"|"machine"|"user.repo"|"team.repo"|"user"|"team"|"legacy"|"default";
export interface Provenance { scope: Scope; file: string | null }
export function getSetting<T>(key: string, opts?: { repoIdentity?: string | null; expand?: boolean; expandCtx?: { repoRoot?: string; worktree?: string }; legacy?: { repoName?: string } }): { value: T; provenance: Provenance[] }   // ALWAYS an array, weakest-first; length 1 for replace keys
export function listSettings(opts?): Array<{ key; value; provenance; migrated: boolean; unregistered?: true }>
export function explainSetting(key, opts?): Array<{ scope: Scope; file: string|null; present: boolean; value?: unknown; shadowed?: "teamLocked" }>
export function setSetting(key, value, scope: "user"|"team"|"machine", opts?: { repoIdentity? }): void
```

- Reads parse the three store files fresh per call via **jsonc-parser** (one new dependency, the VS Code library, zero transitive; it serves BOTH reads and writes — `lib/jsonc.ts`'s stripper stays for its existing callers and new settings code never uses it). Files are small; memoization is a later optimization.
- The resolver is daemon-FREE and safe ON the daemon thread (no sync spawns anywhere in it).
- Legacy layer: when `opts.legacy.repoName` is provided and the key is wave-1-migrated, the resolver reads the named key from `repos/<repoName>/config.json` (via the existing loaders' raw shapes) and slots it at `legacy` strength. **The name/identity bridge is the caller's job**: repos.json maps name→path (it is NOT an identity registry; wording corrected from rev 1), and every wave-1 caller has the repoName in hand.
- Writes: jsonc-parser `modify`/`applyEdits` with JSONPath segments (`["repos", "<identity>", "rt.roles"]` — segments tolerate dots), preserving comments/formatting. `setSetting` refuses: disallowed scope for the def, `team` scope when the team store file is missing, unregistered keys, `migrated:false` keys. A `team`-scope write edits the LOCAL clone only and prints one reminder line that it needs commit+push to reach teammates (the snapshot daemon automates this later; wave 1 is manual).
- Store path constructors live in `lib/rt-paths.ts` (`userSettingsPath()`, `teamSettingsPath(name)`, `machineSettingsPath()`) — the one-layout-home rule; the source guard's `.rt` ban is unaffected (these live under `~/.mattstack` but not under `rtDir()`).

## CLI + daemon

`rt settings get <key> [--repo <name>] [--json]`, `set <key> <json-value> --scope user|team|machine [--repo <name>]`, `list [--repo <name>] [--json]`, `explain <key> [--repo <name>]`. `--repo` takes a repo NAME (resolved to identity via the async helper; also feeds the legacy layer). These verbs JOIN the existing `rt settings` family (dev-mode, notifications, runaway leaves unchanged). Tree + module registry + docs:gen. Daemon: `settings:get`/`settings:list` on HandlerMap, read-only.

## Consumer migrations (wave 1: exactly two, end to end)

1. **Endpoint/intercept config** (`lib/endpoint/config.ts`): `loadEndpointConfig({ repoIdentity, repoName })` reads `rt.roles` + `rt.intercepts` through the resolver (legacy layer = today's config.json keys). `buildInterceptRules` derives identity from remotes it captures (it now captures one per REGISTERED repo rather than only repos with intercepts — install-time cost, ~20 async spawns, acceptable). Daemon endpoint handlers derive identity async-memoized per claim. `run.ts` normalizes `rule.repoRemote`. **intercepts.json staleness, three-part answer**: (a) `rt settings set` touching `rt.intercepts`/`rt.roles` regenerates it; (b) `rt intercept install` remains the manual regen after hand-edits or team-store pulls; (c) `rt intercept status` and the verify check gain a staleness probe (store-file mtimes newer than cache mtime = warn "run rt intercept install"). The multi-owner header comment in `lib/endpoint/config.ts` is rewritten to describe the resolver + legacy window.
2. **Worktree config** (`lib/worktree/config.ts`): `rt.worktrees` (deep-merge proof case) through the resolver with legacy fallback; `root`'s computed default stays in the reader. `loadWorktreeRepoConfig` becomes async (identity derivation) — ALL FIVE callsites plumb the await (they live in async daemon/reconciler/handler contexts). `loadWorktreeAppConfig` (global enabled/killProcesses) stays legacy in wave 1. Header comment rewritten. `root`/`branchFormat`: any shared-scope value for these MUST use `${repoRoot}`-style variables (documented on the def; the machine store may hold literals).

Readers keep exported signatures where possible; internals swap.

## Data migration + machine hygiene (orchestrator steps, not implementer code)

1. Team store seeded in the acme zone: acme-dev section with `rt.roles` (hook via `${team:acme}`), `rt.intercepts`, worktree defaults COPYING THE LIVE VALUES (`onDeck: 3`, the two ready steps) — a partial seed would shadow the legacy fields it omits under deep merge; committed + pushed.
2. User store seeded in mattstack-prefs: acme-dev `rt.worktrees` override (`namePool`); committed + pushed.
3. Machine store scaffolded with a header comment.
4. After the resolver proves green end to end: REMOVE the migrated keys (`roles`, `intercepts`, `worktrees`, plus the dead `ports`) from `~/.mattstack/rt/repos/acme-dev/config.json` — under deep merge a stale legacy FIELD keeps applying invisibly, so key removal is part of the migration, not optional hygiene. Before deleting, DIFF the resolved output against the legacy file field-by-field and port any legacy-only field into the appropriate store (empty set expected for acme-dev today, but verify, never assume). Then run `rt intercept install` (fresh rules from the stores) and restart the daemon (new handlers + readers).
5. The attic step: archive the trace's DEAD/LEGACY-SUSPECT files to a dated tarball, then delete (list in the trace report; switchboard token keys in secrets.json are KEPT — foreign-owned).

## Out of scope (wave 1)

Secrets values (RT-32), snapshot daemon (RT-30), skills-bindings keys + merge-manifests retirement (wave 3), board/deck readers (wave 3; note mr-board reads secrets.json directly today), prose/dotfiles (wave 4), repos.json restructure (it remains the name→path registry), generated $schema file (wave 2), multi-team precedence (revisit at second team).

## Invariants that bind every task

- Identity, never path, in shared stores; closed-set variables; path literals only in the machine store.
- Explicit get/set of unknown keys is loud; unknown keys in files degrade with labels.
- JSONC comments survive every programmatic write.
- The resolver is daemon-free, sync-spawn-free, and the shim fast path never resolves.
- Legacy sits between default and the stores, carries real provenance, and its reads are observable.
- No new outcome logging; source-guard + module-registry + docs:gen rules as in RT-28.
