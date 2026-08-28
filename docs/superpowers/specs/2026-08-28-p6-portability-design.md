# Phase 6 · Someone else's Mac (p6-portability) ... design

**Status:** proposed
**Date:** 2026-08-28
**Branch:** `job/p6-portability` (stacked on `job/integration`, wave 1)
**Roadmap:** daemon-stability-audit-2026-08 §"Phase 6 · Someone else's Mac" (RT-83)

Phase 6 makes the daemon survive a machine that is not the author's: a
teammate whose login shell is fish, whose `.zshrc` blocks or execs into tmux,
whose Mac has a different hostname, who has no home repo yet, whose git has no
identity, or who is on an Intel Mac. The audit lists ~8 items across four
sub-themes. The `superpowers` chain runs a full spec for 6.1 and treats the
rest as bounded, plan-sized units.

## Verification pass ... what survived, what wave 1 already closed

Every Phase 6 finding was re-verified against the merged wave-1 code before
scoping this spec. Result:

**Open, in scope:**

| Item | Finding(s) | One-line defect |
|---|---|---|
| 6.1 PATH rebuild | S013, S014, S062 | fish emits space-separated PATH; boot hangs forever on a blocking `.zshrc`; silent fallback to launchd's bare PATH when `.zshrc` execs fish/tmux |
| 6.2 machine key | S071 | machine settings key derives from the mutable hostname |
| 6.2 dev wrapper | S020, S067 | a foreign `~/.local/bin/rt` `#!` script is misread as our dev-mode wrapper, parking prod |
| 6.3 platform | R051 | no Intel / unsupported-arch warning at setup |
| 6.4 first-run | S090 | missing `~/.mattstack/user` diagnosed as "git missing" not "not provisioned" |
| 6.4 first-run | R043 | no git `user.name`/`user.email` check with an actionable message |
| 6.4 first-run | S070 (sops half) | age-key spawn got a timeout in wave 1; the sops spawn in `lib/secrets/store.ts` still has none, so a locked keychain hangs `loadSecrets()` |
| 6.4 first-run | S069 | `branch_cache` keys on the bare branch name; a same-name branch in a second repo overwrites the first |

**Already closed by wave 1, dropped from scope** (verified in code):

- **S046** ... `lib/daemon/cron.ts:84` now passes `env: { ...process.env }`.
- **S099** ... `lib/rt-paths.ts` gates the `~/.rt` rename behind `hasRtSignature()` (`RT_SIGNATURE_ENTRIES`).
- **S066** ... `lib/deps/links.ts` keeps every `DEFAULT_EXPOSED` tool; reconcile never unlinks our own product surface by name.
- **S002** ... `lib/agent-herdr.ts` resolves herdr via `resolveHerdrBin()` (`HERDR_BIN` ?? `Bun.which("herdr")` ?? `~/.local/bin/herdr`) with a clear error.
- **S039** ... `agent-status-poller.ts` backs the herdr probe off after 3 null probes; `lib/runs/store.ts` memoizes run summaries by db mtime.
- **S051** ... `handlers/agent.ts` returns `ok:false` and rolls back the record when herdr focuses an existing tab.
- **S022** ... `lib/daemon/freshness.ts resolveUserIdAcrossTracking()` gates on grant, not live-vs-poll, so poll-only users get notifications.
- **S070 (age-key half)** ... `lib/home/age-key.ts` has the 30s timeout + `AgeKeyTimeoutError` already.

The one correction to the brief: the brief listed **S070 as done**. Only the
age-key half is; the sops spawn in `lib/secrets/store.ts` still has no timeout.
That half is kept in scope (6.4).

No change here requires a `SCHEMA_VERSION` bump (S069 reuses the existing
`branch TEXT PRIMARY KEY` column ... see 6.4). `packages/rt-client` is touched
(one new registry key), so `bun run build` runs in it before the final review.

---

## 6.1 · PATH resolution rebuilt (S013, S014, S062)

### The problem

`lib/daemon/user-path.ts resolveUserPath()` scrapes the user's PATH with
`execSync($SHELL -ilc 'echo $PATH')` at daemon boot (called synchronously at
`lib/daemon.ts:163`). Three failure classes on someone else's Mac:

- **S013 (fish):** `fish -ilc 'echo $PATH'` prints a *space-separated* list.
  The daemon splits on `:`, so every real dir lands inside one bogus entry;
  `git`/`node`/`pnpm` vanish from every child's PATH. `entries: 1` is logged;
  nothing warns.
- **S014 (hang):** `-i` sources `.zshrc`. Under launchd (no TTY, no network
  yet) a plugin, `gpg-agent`/pinentry, `direnv`, or a `read` can block
  forever. `execSync`'s timeout only SIGTERMs; an interactive shell ignores
  SIGTERM, so the daemon hangs before it binds anything ... the exact "starts,
  binds nothing, logs nothing" symptom CLAUDE.md warns gets misdiagnosed.
- **S062 (silent fallback):** `.zshrc` ending in `exec fish` / `exec tmux`
  replaces zsh before `-c` runs; stdout is empty, `|| resolvedPath` silently
  keeps launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. The pool then wedges with
  `env: node: No such file or directory` (the 2026-08-21 spawn-env incident),
  now for any common `.zshrc` idiom.

### Decisions

1. **Drop the interactive shell (`-i`).** The probe uses a *non-interactive
   login* shell (`-lc`), which sources `.zprofile`/`.zshenv` (zsh) or
   `.bash_profile` (bash) but never the interactive rc files (`.zshrc`,
   `.bashrc`). This removes both the hang (S014: interactive plugins live in
   `.zshrc`) and the exec-into-tmux fallback (S062: those idioms live in
   `.zshrc`) at the source. `.zshenv`'s absolute-path fnm bootstrap and
   `.zprofile`'s `brew shellenv` (both fixed by the 2026-08-21 spawn-env
   contract) are still sourced, so a standard Homebrew+fnm Mac resolves fully.

   **Accepted cost:** PATH exports that a user put *only* in `.zshrc` (classic
   `nvm` installs, hand-rolled `export PATH=` lines) are no longer picked up by
   the shell probe. This is the exact trade-off S062's fixer notes flagged.
   It is covered by (a) an explicit `rt.daemonPath` override (decision 4),
   (b) an explicit `nvm.sh` overlay inside the probe (decision 3), and (c) a
   loud missing-tools warning (decision 6). This reverses the current file's
   header preference for `-ilc`; the reversal is deliberate and is the crux of
   Phase 6, so it is called out here for the spec-review gate.

2. **Hard timeout in a killable process group.** The probe spawns via
   `Bun.spawn([...], { detached: true })` (a new session/process group; the
   same option `lib/worktree/trash.ts:183` already uses) and `proc.unref()`s
   it. A `setTimeout` pair escalates `process.kill(-proc.pid, "SIGTERM")` then,
   after a short grace, `process.kill(-proc.pid, "SIGKILL")` ... the negative
   pid targets the whole group, so a hung grandchild (pinentry, a stuck
   `direnv`) is reaped too, not just the shell. The result is a
   `Promise.race([captured, deadline])` so `resolveUserPath` always resolves
   within the timeout regardless of what the child does. `detached: true` is
   what makes `-pid` safe: without it, `-pid` would signal the daemon's own
   group. Default timeout 5000ms (a login shell resolves in well under 1s),
   overridable via `RT_PATH_PROBE_TIMEOUT_MS` and via an injected seam for
   tests.

3. **fish-aware, colon-joined output, nvm overlay.**
   - `shellName = basename($SHELL || "/bin/zsh")`.
   - fish: `[$SHELL, "-lc", "string join : $PATH"]` ... emits a colon-joined
     list (fixes S013).
   - everything else: `[$SHELL, "-lc", '{ [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; }; printf %s "$PATH"']`
     ... `printf %s "$PATH"` is already colon-joined; the nvm overlay replaces
     the current file's second `execSync` and is now the only way an
     `.zshrc`-only nvm node reaches PATH under `-lc`.

4. **Explicit `rt.daemonPath` override (settings registry).** A new
   machine-scoped key. When set to a non-empty value, `resolveUserPath` uses it
   verbatim and skips the shell probe entirely ... instant, deterministic, and
   the honest replacement for scraping an exotic shell. Registry row (in
   `packages/rt-client/src/settings/registry-defs.ts`, mirrored nowhere else):

   ```ts
   {
     key: "rt.daemonPath",
     type: "string",
     scopes: ["machine"],
     merge: "replace",
     // no `default`: absent means "resolve via the shell probe below".
     // no `pathGuardFields`: the value IS a PATH literal, and machine scope
     // is exempt from the path-literal guard anyway (write.ts).
     description: "Absolute colon-separated PATH the daemon uses for every child it spawns, instead of probing your login shell. Set this when the daemon can't find node/git/bun/pnpm (e.g. a fish shell, a blocking .zshrc, or PATH exports that live only in .zshrc). Machine-scoped: it never travels to another machine.",
   }
   ```

   Read synchronously via `getSetting<string>("rt.daemonPath")` (getSetting is
   sync and throws only on an *unregistered* key; an unset registered key
   resolves to `undefined`).

5. **Validate before trusting the probe.** Trim the output; reject it (keep the
   baseline `process.env.PATH`, warn) when it is empty, contains whitespace
   (a space/tab means a fish-unsplit or corrupt value), splits into fewer than
   two colon segments, or equals the launchd baseline verbatim (the S062
   silent-fallback signature). Acceptance is the only path that overwrites the
   baseline.

6. **Observability.** The probe's tool set grows to `node`, `git`, `bun`,
   `pnpm`. After resolution (override, probe, or baseline), if any are missing
   from the resolved PATH, log one `warn` naming the remedy ("set
   `rt.daemonPath`"). Distinguish, in the log, the three outcomes: override
   used / probe accepted / fell back to baseline (with the reason: killed,
   empty, invalid).

7. **Async integration (fence-granted).** `resolveUserPath` becomes
   `async (log) => Promise<string>`. `lib/daemon.ts:163` changes the one
   statement to `const resolvedPath = await resolveUserPath(log);` (shepherd
   granted this single-statement exception to the p2-health lane's ownership of
   `daemon.ts`; the surrounding block and everything else in the file stay
   p2's). `daemon.ts` already uses top-level `await` (lines 119, 145, ...), so
   this is a literal one-line change. Boot waits at most the hard timeout and
   can never hang. The bundle-Helpers + `~/.local/bin` prefix block that
   follows (`daemon.ts:167-183`) is unchanged and still runs after the await.

8. **Remove the sync-exec allowlist entry.** With both `execSync` calls gone
   (the code now uses async `Bun.spawn` only), delete
   `"lib/daemon/user-path.ts", // Phase 6 PATH rebuild (S013/S014/S062)` from
   the `ALLOWLIST` in `lib/__tests__/no-daemon-sync-exec.test.ts`. The gate's
   static regex scans for `execSync(`/`spawnSync(`/`Bun.spawnSync(`/
   `Bun.sleepSync(`; `Bun.spawn(` + `setTimeout` + `process.kill` match none.

### Shape

```
resolveUserPath(log):                          // async, Promise<string>
  override = getSetting("rt.daemonPath")        // sync read
  if override non-empty:
     result = override; source = "override"
  else:
     raw = await probe(shell, timeout)          // Bun.spawn detached, pgroup kill, race
     result = validate(raw) ? raw : baseline    // reject fish/empty/launchd-baseline
     source = accepted ? "probe" : "baseline"
  warnIfMissing(result, [node, git, bun, pnpm]) // one warn line, names rt.daemonPath
  log.info({ source, entries, hasNode, hasGit, hasBun, hasPnpm }, "PATH resolved")
  return result
```

`probe` is an injectable seam (default: the real `Bun.spawn`) so tests never
spawn a real shell.

### Tests (`lib/daemon/__tests__/user-path.test.ts`)

- fish-style space-separated output is rejected → baseline kept + warn.
- a hanging probe (injected seam that never settles) → resolves within the
  timeout, returns baseline, logs the killed/fallback reason.
- an `exec`-into-empty `.zshrc` (probe returns "") → baseline kept, distinguishable in the log.
- `rt.daemonPath` set → probe never called, value used verbatim.
- a valid colon PATH → accepted; `hasNode` etc. reflected; no warn.
- missing-tool warn fires once when node/git absent.
- `probeTools` existing coverage retained.

---

## 6.2 · Machine key from a stable identifier (S071)

### The problem

`machineKey()` (`lib/rt-paths.ts:140`, mirrored byte-for-byte in
`packages/rt-client/src/settings/paths.ts`) reads the `~/.mattstack/machine-key`
pin file, and *falls back to a slug of `os.hostname()`* when no pin exists. The
machine settings store lives at `user/local/<machineKey()>/settings.local.jsonc`.
Rename the Mac and the key changes; the machine's settings silently vanish.
`machineKey()` is on a hot synchronous path (every `getSetting` calls
`readStores()` → `machineSettingsPath()` → `machineKey()`), so it must stay
sync and subprocess-free.

Today the only pin writer is `rt home init` (`lib/home/init-exec.ts:103`
`writeMachineKey`), and it writes `config.machineKey`, which *defaults to
`machineKey()` itself* (`commands/home.ts:552`) ... i.e. the hostname slug. So
even a set-up machine self-pins its hostname slug rather than a stable id.

### Decision

Keep `machineKey()` exactly as-is (sync, pin-first, hostname fallback ... no
subprocess, so rt-paths ↔ rt-client parity is preserved). Establish a *stable*
pin at setup time, data-preservingly:

- New `async stableMachineId(): Promise<string | null>` (rt-side, e.g.
  `lib/home/machine-id.ts`): `Bun.spawn(["ioreg", "-rd1", "-c",
  "IOPlatformExpertDevice"])` (async, hard timeout, detached), parse
  `"IOPlatformUUID" = "<uuid>"`, slug it through `isSafeMachineKeySegment`.
  Returns `null` on any failure (non-mac, CI, parse miss).
- `rt home init`'s default key becomes `seams.key ?? (await resolveInitialMachineKey())`:
  1. pin file already exists → return `machineKey()` (its current value; **no change**).
  2. else the hostname-slug machine store already has data on disk → return the
     hostname slug (freeze the current key; this is the "migrate the
     hostname-keyed section" step, done with zero data movement).
  3. else (truly fresh) → `(await stableMachineId()) ?? machineKey()` (hardware
     UUID for new installs; hostname slug as the last resort).
  The interactive picker's explicit key still wins (`seams.key`).

**Data-preserving + idempotent:** an existing pin is never rewritten; a machine
with existing data keeps its current key (frozen); only a genuinely fresh
machine gets the hardware UUID. `machineKey()` reads the same value before and
after, so there is no within-boot key drift on any machine that has data.

**Deliberately out of this item:** no daemon-boot pin write (the write fence
grants only the one `resolveUserPath` statement in `daemon.ts`; adding a call
there is out of bounds, and setup is the correct owner of the pin anyway). No
hot-path warn (it would diverge the rt-paths ↔ rt-client mirror). A machine run
without `rt home init` therefore keeps the live hostname slug; this is a
dev-only residual, and the spec-review gate can add a setup-row surface for it
if wanted.

### Tests

- fresh (no pin, no data) + injected `stableMachineId` → pin written with the
  stable id.
- existing pin → `resolveInitialMachineKey` returns it unchanged.
- existing hostname-slug data, no pin → pin written with the hostname slug (frozen).
- `stableMachineId` parses a real `ioreg` fixture; returns null on a failing/empty probe.

---

## 6.2 · Dev-mode wrapper marker (S020, S067)

### The problem

`currentMode()` (`lib/dev-mode.ts:76`) classifies `~/.local/bin/rt` as "dev"
whenever its first two bytes are `#!`. Any foreign `#!` script parked there
reads as dev and the prod daemon parks forever. Its companion
`isDevModeWrapper()` (`lib/deps/links.ts:46`) treats any `#!` file whose line 2
does not start with `LINK_TAG` as our dev wrapper, so `rt deps link rt --force`
refuses to replace a foreign script (`dev-mode-owns-rt`). The current wrapper
(`renderDevModeWrapper()`, `commands/settings.ts:510`) carries no marker ... its
line 2 is a real `export PATH=...`.

### Decision

Mirror the `LINK_TAG` pattern (`lib/deps/resolve.ts:113`,
`# mattstack-link:`). Add a marker line 2 to new wrappers and centralize
detection so the two call sites cannot diverge (the audit's "fix both
together").

- `renderDevModeWrapper()` emits `# mattstack-dev-mode` as line 2 (after the
  shebang, before the `export PATH`).
- New shared `isDevModeWrapperContent(content): boolean` (in `lib/dev-mode.ts`,
  imported by `lib/deps/links.ts`): true iff `content` starts with `#!` **and**
  either line 2 starts with `# mattstack-dev-mode` (new wrappers) **or**
  `content.includes("RT_LAUNCH_CWD")` (the legacy markerless body's unique
  tell). A foreign `#!` script has neither → false → classified prod / eligible
  for replacement.
- `currentMode()` reads the whole (small) file and delegates to
  `isDevModeWrapperContent`; `isDevModeWrapper()` in `links.ts` delegates too.

**Backward-compatible:** existing dev machines whose wrapper predates the
marker still classify as dev (via the `RT_LAUNCH_CWD` tell), so no re-link is
needed and no dev machine flips to prod. This matters: a wrong flip is the
dev/prod standoff that `rt` daemon verbs cannot themselves repair.

### Tests

- a foreign `#!/bin/sh\necho hi` at the wrapper path → `currentMode()` prod,
  `isDevModeWrapper()` false.
- a legacy markerless wrapper (`RT_LAUNCH_CWD` body) → dev / true.
- a new marked wrapper → dev / true.
- a `LINK_TAG` link → not a dev wrapper.

---

## 6.3 · Unsupported platform at setup (R051)

### Decision

Add an architecture row to `lib/setup/validators/mac.ts`, mirroring
`macosVersionRow`'s honesty ruling:

```ts
async function archRow(p: Probes): Promise<Row> {
  const base = { id: "tool.arch", kind: "tool" as const, title: "Processor",
    why: "mattstack ships an Apple-silicon (arm64) build; Intel Macs are not supported.", required: true };
  const res = await p.exec(["uname", "-m"]);
  const arch = res.stdout.trim();
  if (res.code !== 0 || !arch) return row({ ...base, status: "error", detail: "Could not determine your processor" });
  if (arch === "arm64") return row({ ...base, status: "ready", detail: "Apple silicon (arm64)" });
  return row({ ...base, status: "invalid", detail: `${arch}: Apple silicon (arm64) required` });
}
```

`macRows()` returns `[macos, clt, archRow, pathRow]` (arch and macos/clt probe
in the same `Promise.all`). A failed probe reports `error` ("couldn't
determine"), never `invalid` ... same ruling as the macOS-version row.

### Tests

- `uname -m` = `arm64` → ready.
- `= x86_64` → invalid with an arm64 message.
- probe fails (code !== 0) → error, not invalid.

---

## 6.4 · First-run honesty

### S090 · "not provisioned" vs "git missing"

In `lib/daemon/home-snapshot.ts init()` (line 357), before the
`git rev-parse --is-inside-work-tree` spawn, `existsSync(deps.repoDir)`. When
the dir is absent set a distinct `disabledReason` (`"not-provisioned"`) and a
`warn` naming `rt home init`. The existing `exitCode === -1` branch stays for a
genuine spawn failure (git truly missing from PATH). Pure code change.

### R043 · git identity checked once

Before the first `home-snapshot` commit (and in
`lib/home/init-exec.ts commitInitialUserRepo`, which has the same gap), check
identity once: `git config user.name` and `git config user.email` via
`deps.exec`. If either is empty, set a distinct `disabledReason`
(`"no-git-identity"`), log one actionable `warn` (`git config --global
user.name/…user.email`), and skip committing (a commit would fail anyway).
Checking config directly is cleaner than parsing "Author identity unknown" out
of stderr and gives an actionable message once, not per cycle.

### S070 (sops half) · timeout on the secrets spawn

`createRealSecretsExecSeam` in `lib/secrets/store.ts` (the sops `Bun.spawn`,
awaited via `Promise.all([..., proc.exited])`) gains the exact pattern
`lib/home/age-key.ts` already uses: a `DEFAULT_SECRETS_TIMEOUT_MS` (30s), a
`setTimeout` → `proc.kill()` (SIGTERM then SIGKILL grace), and a distinguished
error (`SecretsTimeoutError`) so a locked-keychain hang surfaces as a timeout
rather than poisoning any cache with a generic failure. Async already; just add
the timer + distinguished error.

### S069 · branch_cache keyed by repo + branch

`branch_cache` has `branch TEXT PRIMARY KEY` with `repo` as a nullable
attribute column (already holding the serialized repo identity post the wave-1
`rekeyBranchCacheTable` migration). A same-name branch in a second repo
overwrites the first. Per `docs/repo-identity.md`, a state.db table keys on the
**serialized wire identity** (`remote:host%2Fpath` / `path:%2F…`).

**Fix without a schema bump:** make the primary-key *value* the composite
`${serializedIdentity}:${branch}`, reusing the existing `branch TEXT PRIMARY
KEY` column (no DDL change). This is safe to parse because a git branch name
cannot contain `:` (git `check-ref-format`), so the bare branch is always
`key.slice(key.lastIndexOf(":") + 1)` and the identity is everything before it.

- Store API takes `(identity, branch)` and composes internally; a shared
  `composeKey(identity, branch)` / `branchOf(key)` pair lives in
  `lib/state/branch-cache.ts`.
- Writers (`lib/enrich.ts writeEnriched`/`fetchAndCache`/`refreshAllMRs`, and
  the standalone `import.meta.main` entry) already hold the repo identity
  (via `serializeIdentity(await deriveRepoIdentity(...))` from the local
  `lib/settings/identity.ts` barrel); they pass it to `put`.
- Readers: `enrich.ts` composes the key for its `in store.entries` / lookup
  checks; `commands/status/data.ts` (raw SELECT for display) shows
  `branchOf(row.branch)` and reads identity from the `repo` column.
- `boot-migrate.ts`'s existing `repo`-column rekey is untouched and coexists.

**Migration:** none. Old bare-branch rows become unused and age out via the
existing GC; the cache self-heals. Idempotent, no backfill, no schema bump.

### Tests

- S090: missing `repoDir` → `disabledReason "not-provisioned"`, message names `rt home init`; present-but-not-a-repo and git-missing branches unchanged.
- R043: empty `user.name`/`user.email` → `no-git-identity`, one warn, no commit; identity present → commits normally.
- S070: an injected hanging sops seam → `SecretsTimeoutError` within the timeout; the daemon/caller never blocks.
- S069: two repos, same branch name → two distinct rows; lookups resolve per repo; `branchOf` recovers the display name; a branch containing no `:` round-trips.

---

## Task decomposition (preview for the plan)

Independent enough to parallelize; 6.1 is the spine.

1. **6.1a** ... `rt.daemonPath` registry key + `bun run build` in rt-client (unblocks 6.1b's override read).
2. **6.1b** ... rewrite `resolveUserPath` (async probe, detached pgroup kill, fish-aware, nvm overlay, validation, override, missing-tools warn) + its tests.
3. **6.1c** ... `daemon.ts:163` one-line `await`; remove the `user-path.ts` allowlist entry; gate stays green.
4. **6.2a** ... `stableMachineId` + `resolveInitialMachineKey` at `rt home init` + tests.
5. **6.2b** ... dev-mode marker: `renderDevModeWrapper` + shared `isDevModeWrapperContent` + both call sites + tests.
6. **6.3** ... `archRow` in `mac.ts` + tests.
7. **6.4a** ... S090 `existsSync` + R043 identity check in home-snapshot / init-exec + tests.
8. **6.4b** ... S070 sops timeout in `lib/secrets/store.ts` + test.
9. **6.4c** ... S069 composite branch-cache key across store + enrich + status + tests.

## Verification (must pass)

- `bun test lib commands packages scripts` green (worktree root).
- `bunx tsc --noEmit` zero errors.
- `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts e2e/tests/setup.test.ts e2e/tests/first-run.test.ts` green.
- `lib/__tests__/no-daemon-sync-exec.test.ts` green with the `user-path.ts` allowlist entry removed.
- `packages/rt-client`: `bun run build` before the final review (registry touched).
- Never start a daemon or run `dist/rt` against the real machine; any such run uses `env -i HOME=<temp dir>`.
