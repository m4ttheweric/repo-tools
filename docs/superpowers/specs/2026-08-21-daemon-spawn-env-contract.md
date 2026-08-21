# Daemon spawn-env contract — design

**Status:** proposed
**Date:** 2026-08-21
**Trigger:** `rt worktree provision --repo assured-dev --ticket cv-2899` refused with
`create-failed:pnpm install / env: node: No such file or directory`, with the whole
assured-dev on-deck pool wedged behind the same failure.

## What happened

The daemon (pid 29465, SMAppService, started 15:32:10Z) cold-created tree `luna`,
ran the `pnpm install` ready step, and the step died before pnpm printed anything:

```
{"repo":"assured-dev","tree":"luna","failedStep":"pnpm install",
 "output":"env: node: No such file or directory","msg":"worktree create failed"}
```

`pnpm` is `/opt/homebrew/bin/pnpm`, whose shebang is `#!/usr/bin/env node`. The step
found pnpm and failed to find node.

## Root cause — two defects, both required

### Defect 1: the resolved PATH never reaches spawned steps

`lib/daemon.ts:91-94` reconstructs the user's full PATH at startup and assigns it:

```ts
// Resolve the user's full PATH once at startup, and overlay it onto the
// daemon's own env so direct execSync calls (setup commands, agent
// invocations) inherit pnpm/doppler/bun without re-resolving the shell
// themselves.
const resolvedPath = resolveUserPath(log);
if (resolvedPath) process.env.PATH = resolvedPath;
```

`execSync` reads `process.env` per call, so it sees this. `Bun.spawn` does not — it
does not observe assignments made to `process.env` after process start. Measured:

```
implicit env  → sentinel present: false
explicit env  → sentinel present: true    // { env: { ...process.env } }
```

`lib/subprocess.ts:29` calls `Bun.spawn` with no `env`, and `runReadySteps`
(`lib/worktree/ready.ts:52`) goes through it. So ready steps run with the daemon's
**original** environment — under SMAppService that is
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, confirmed by `ps eww -p 29465`.

This is a regression introduced by a correct change. `lib/subprocess.ts`'s own header
calls `runCapture` "the daemon-safe replacement for execSync" (execSync blocks Bun's
event loop). Daemon work migrated onto it, and the migration silently dropped the
`process.env` semantics the overlay was written to provide. The overlay comment is now
true only of the callers that never migrated.

### Defect 2: `~/.zshenv`'s fnm bootstrap is PATH-order dependent

Given a minimal PATH, `/bin/zsh -lc` proceeds:

1. `~/.zshenv:24` — `command -v fnm` **fails**; `/opt/homebrew/bin` is not on PATH
   yet, so the fnm block no-ops. `|| true` swallows the rest.
2. `/etc/zprofile` — `path_helper`.
3. `~/.zprofile:1` — `eval "$(/opt/homebrew/bin/brew shellenv zsh)"` finally puts
   `/opt/homebrew/bin` on PATH.
4. `~/.zshrc` — **never sourced**; `-lc` is non-interactive. The working fnm init
   lives here, and it carries a `|| fnm use default` fallback `.zshenv` lacks.
5. `pnpm` resolves via step 3; its `env node` shebang finds nothing.

Either defect alone is survivable. Defect 2 is why defect 1 is fatal rather than
merely wasteful.

**Why it broke now:** launched from a terminal, the daemon's original environment
already carried a full PATH, so defect 1 was invisible. SMAppService changed the
snapshot. `specs/research/2026-08-20-mattstack-app/research-local-inventory.md`
already lists this as clean-Mac breaker #4: *"launchd PATH capture (deck bakes PATH;
rt daemon reconstructs via `$SHELL -ilc`)"*.

## Why the whole pool wedged

Freshen runs the same ready steps. Each failure stamps `nextRetryAt`
(`worktree-reconciler.ts:690`); `selectOnDeck` (`handlers/worktree.ts:156`) skips any
tree inside its backoff. All three on-deck trees were held (`dean` 16:35:05Z,
`dudley` 16:36:22Z, `cho` 16:52:42Z), so provision found nothing claimable and fell
through to a cold create that hit the identical wall. One root cause, presented as an
empty pool.

## Decisions

1. **`runCapture` gains `process.env` semantics by default.** It is documented as the
   execSync replacement, so it should behave like one; an opt-in `env` would leave 21
   of 22 call sites carrying the same latent bug. `opts.env` stays available for
   callers that need to override rather than inherit.

2. **`.zshenv` resolves fnm by absolute path, not via `command -v`.** It runs before
   `brew shellenv`, so it cannot depend on inherited PATH. It also gains `.zshrc`'s
   `|| fnm use default` fallback.

3. **Per-repo version resolution is kept; the `aliases/default` shortcut is
   rejected.** assured-dev's `.nvmrc` pins **22.22.0** while fnm's `default` alias is
   **v24.19.0**. Pointing non-interactive shells at the default alias would install
   assured-dev's dependencies under the wrong major.

4. **Accepted cost of decision 2:** every non-interactive zsh now creates an fnm
   multishell symlink. `~/.local/state/fnm_multishells/` already holds **147,755**
   entries (the directory's link count is saturated at 65535) because nothing prunes
   them. Correctness wins; the leak gets a prune.

## Observability gaps this exposed

- `freshen: ready step failed` (`worktree-reconciler.ts:753`) logs `failedStep` but
  not `output`; only `createTree` logs output. The freshen failures at 15:52, 16:06
  and 16:22 are therefore unattributable — the single `env: node` line that made this
  diagnosable exists only because a *cold create* happened to fail.
- `resolveUserPath` logs `hasPnpm` and `hasDoppler` but not `hasNode` — the one tool
  that was missing.
- Provision's refusal never mentioned that on-deck trees existed but were all inside a
  retry backoff, which is the difference between "one create failed" and "the pool is
  systematically broken".

## Long-term direction (not implemented here)

The app-shell plan commits the daemon to `SMAppService`
(`plans/2026-08-21-mattstack-app-shell.md:9`), so a minimal launch environment becomes
the only case, and `$SHELL -ilc` scraping becomes the load-bearing path for every
spawned step. That primitive is weak: it is slow, order-dependent, and it bakes an
*ephemeral* `fnm_multishells/<pid>_<ts>` entry into a long-lived process — the same
class as two landmines already tracked, DECK-58 ("portless bakes fnm path") and
DECK-57 ("stale interpreter path").

`research-dependency-inventory.md:12` already decides the split: bundle a private
pinned node for suite-internal use (fast-browser, portless), while *"team dev needs
its own node anyway"*, with pnpm listed under Team-specific as pack-declared. So the
bundled node will not cover `pnpm install` in an assured-dev worktree — this exact
spawn still needs the developer's toolchain after the app ships.

The direction worth pursuing with the setup-verbs work: resolve a **toolchain
contract** at setup — absolute paths persisted to settings, doctor-verified by
`tool.node` / `tool.pnpm` rows beside the existing `tool.path`
(`plans/2026-08-21-rt-setup-verbs.md:453`) — and where per-repo version switching
matters, invoke the manager explicitly (`fnm exec --using-file -- pnpm install`)
rather than trusting a scraped login shell. `installZshenvPrecedence()`
(`plans/2026-08-21-rt-setup-verbs.md:1043`) already owns a `~/.zshenv` block, so
decision 2 belongs in a block setup installs and verifies rather than a hand-edited
dotfile.

## Explicitly out of scope

- **gitlab.com fetch failures.** The same logs show `git fetch` returning HTTP 403
  repeatedly (14:54–15:32) and 502 at 16:05, which wedged freshens before the node
  problem did. Different subsystem, different cause (credential/remote), and the 502
  is server-side.
- A recurring prune for the fnm leak. This spec prunes once and records the need.
