# RT-94: Deck-managed apps follow rt's dev-mode flag

**Ticket:** RT-94
**Date:** 2026-08-31
**Repos touched:** `deck`, `repo-tools` (rt), and the three app repos (chat, console, mr-board)
**Status:** design ratified, ready for implementation plan

## Problem

rt itself solves "run the installed binary vs. run from local source, switchable
by one flag" via RT-67 (`mattstack.mode`, the source-shim bundle, the tray
handoff). Deck-managed apps (board, console, chat, ...) do not follow that flag:
each keeps running whatever serve shape it was registered with, and flipping
`rt settings dev-mode` does nothing for them.

The intended behavior (confirmed by reading Matt's live machine, not assumed):
deck always runs a **built/bundled** app for a regular user. In dev mode, a
developer who has an app's source checked out gets that app's **build/deploy
buttons**, which build from their local source and hand the result back to deck
to run. Deck is never pointed at a live dev/watch server unless the developer
overrides the config or uses an alt port.

Two ground-truth findings that shaped this design:

- On a dev machine, the managed apps were registered running their **source**
  entry (`bun src/server/index.ts`) from the repo dir, with `sourceDirectory`
  null. Only deck itself used the built-binary + `sourceDirectory` pattern. rt's
  own setup step (`deck add --cmd <bundledBin>`) matched neither. Three-way drift.
- The build/deploy action commands already exist in every app's
  `mattstack.deck.json`, and the `/commands/:key` route is already dev-mode
  gated. The missing pieces are the per-app source location and a bundled-vs-source
  serve switch, not the buttons themselves.

## Goals

- One flag (`mattstack.mode`) switches every `includeInBundle` mattstack app
  between its bundled serve shape (prod) and its source serve shape (dev), the
  way it already switches rt itself.
- Build/deploy buttons surface only when a developer has actually linked the
  app's source, and act on that source.
- No serve configuration is hand-authored or duplicated. The manifest in each
  app repo is the single source of truth; the deck record stores only what the
  manifest cannot know.
- A regular user (prod, no source checkouts) is never in a non-working state.
- Deck's second audience (user-registered apps) keeps working exactly as today,
  and is never gated by the mattstack flag.

## Non-goals

- Building the CI job that produces each app's bundle, or the
  `mattstack-apps.json` app list. This design consumes the bundle path through
  rt's existing `bundledToolPath` seam and does not depend on that work landing.
- Running apps from a live/watch dev server. That stays a manual config or
  alt-port override, unchanged.
- gitq and boxscore. They are not bundle-ready (`includeInBundle` is false), so
  they are out of scope until their bundling work is done. The mechanism applies
  to them for free once they are ready.

## The two app classes

The gate keys on record ownership, not on dev mode alone.

- **mattstack-managed** (`managedBy` is `rt`, `deck`, or the platform): ships in
  the `.app` bundle for regular users, so it gets the dev/prod serve switch.
  Build/deploy are dev-only and require a valid source link.
- **user apps** (`managedBy: "user"`): the developer registered them pointing at
  their own checkout, so the source is always present by definition. Build/deploy
  are **always** shown and `mattstack.mode` is never consulted. This corrects a
  current over-gate: today the `/commands` route hides a user app's buttons
  whenever the machine is in prod mode.

## Manifest schema (`mattstack.deck.json`)

All dev-only serve information consolidates under one `dev` node. The repo
directory is implicit (the manifest's own location).

```jsonc
{
  "name": "chat",
  "port": 11002,
  "includeInBundle": true,
  "dev": {
    "start":  "bun src/server/index.ts",
    "build":  "bun run build",
    "deploy": "bun install && bun run build && deck restart chat"
  }
}
```

- `dev.start` is the source serve command, run in the repo dir when dev mode is
  on and the app is linked.
- `dev.build` / `dev.deploy` are the dev-gated action buttons, run in the repo dir.
- `includeInBundle` marks the app as bundle-ready and in scope for the switch.
  This is the same field the (future) CI-bundling work keys on. The field name is
  provisional; fox owns `mattstack.deck.json`. It does **not** exist in any manifest
  or in deck/rt source today: adding it to board/console/chat is new work
  (Rollout step 1), not something they already declare.
- deck's own manifest omits `dev.start` (deck refuses to run from source) but may
  carry `dev.deploy`. The model handles this with no special case: an absent
  `dev.start` means deck stays on its built binary even in dev mode, while still
  exposing its deploy button.

Deck's existing top-level `commands` (with `start` plus action commands) stays as
the shape user apps and non-bundle apps use. The `dev` node is additive and
mattstack-app-only.

## Deck record schema

The record stores only machine-resolved pointers. Everything the manifest owns is
read live from the manifest; everything convention-derivable is derived.

```jsonc
{
  "name": "chat",
  "managedBy": "rt",
  "dev": { "workingDirectory": "<absolute path to the developer's checkout>" }
}
```

- Prod `command` (bundled path) and prod data dir (`~/.mattstack/<name>`): derived
  from `name` plus conventions, not stored. Prod serve args a bundle needs (e.g.
  gitq's `board` subcommand) are declared in the manifest; rt supplies only the
  bundle path.
- `dev.start` / `dev.build` / `dev.deploy`: read live from
  `<dev.workingDirectory>/mattstack.deck.json` at the moment deck computes the
  serve shape or runs a button. Never copied onto the record, so they cannot
  drift.
- `dev.workingDirectory`: the one stored value. It is resolved from an explicit
  link (see Linking), not from an assumed directory layout, and is regenerable by
  re-linking.

`sourceDirectory` retires for the managed-app case: `dev.workingDirectory` is the
single directory used for both the source serve and the build/deploy commands,
which removes the `sourceDirectory` / `workingDirectory` duplication.

## Resolver and fallback

The guiding rule: there is never a non-working state, which means the resolver
**never returns a command that does not exist on disk**. It resolves two candidate
shapes and picks by mode, verifying existence before returning:

- `sourceShape(record)`: `{ command: argv(m.dev.start), cwd: dev.workingDirectory }`
  when the link is present, the dir exists, its manifest parses, and it has a
  `dev.start`. Otherwise null.
- `bundleShape(record)`: `{ command: derivedBundleCommand(name), cwd: dataDir(name) }`
  **only when that bundle binary is actually installed** (`bundleExists`). Otherwise
  null. This is the fix for the transition window: a machine that has not yet had a
  bundle installed for an app must not fall through to a path that isn't there.

```ts
function serveShape(record) {
  if (record.managedBy === "user") {
    clearIssues(record.name, "dev-link");
    return { command: record.command, cwd: record.workingDirectory };
  }

  const source = sourceShape(record);   // null unless linked + valid + has dev.start
  const bundle = bundleShape(record);   // null unless the bundle binary is installed
  const linkBroken = !!record.dev?.workingDirectory && !source && linkIsBroken(record);

  // Preferred pick by mode; only ever return something that exists.
  const chosen = isDevMode() ? (source ?? bundle) : (bundle ?? source);

  if (!chosen) {
    addIssue(record.name, { source: "dev-link", message: `no runnable shape for ${record.name} (no bundle, no valid source)` });
    return null; // deck does not stand up a command that isn't there
  }
  if (chosen === bundle && linkBroken) {
    addIssue(record.name, { source: "dev-link", message: `dev source ${record.dev.workingDirectory} missing or invalid; running bundled` });
  } else if (chosen === source && !bundle && !isDevMode()) {
    addIssue(record.name, { source: "dev-link", message: `bundle for ${record.name} not installed; serving source` });
  } else {
    clearIssues(record.name, "dev-link"); // resolved cleanly to its intended shape
  }
  return chosen;
}
```

Notes:

- **Issue lifecycle (finding #2):** every clean resolution calls
  `clearIssues(name, "dev-link")`, so a `dev-link` issue disappears from the board
  row as soon as the developer fixes the path or the bundle appears. It is raised
  only while a fallback is actually in effect.
- **`dev.start` absent is not broken.** A valid manifest that simply omits
  `dev.start` (deck itself, which refuses to run from source) is not a broken link:
  `linkIsBroken` is false, `source` is null, and the app resolves to `bundle`
  cleanly with no issue, while its `dev.deploy` button still surfaces. `linkIsBroken`
  is true only for a missing dir or an unreadable/unparseable manifest.
- **Never a phantom bundle (finding #1):** because `bundleShape` returns null when
  the binary is not installed, a machine mid-transition (source running, no bundle
  yet) keeps serving its source (loudly, if in prod) rather than pointing launchd at
  a nonexistent path. This makes the rollout order-independent; see Rollout.

| Class | Mode | Dev link | Serves | build / deploy |
| --- | --- | --- | --- | --- |
| user | any | n/a (source = workingDirectory) | its source dir | always shown |
| mattstack | prod | (n/a) | bundle | hidden (refresh only) |
| mattstack | dev | never linked | bundle | hidden ("Link source") |
| mattstack | dev | linked, valid | source | shown |
| mattstack | dev | linked, bad | bundle + loud red issue | hidden ("fix link") |

The "bundle" cells above assume the bundle is installed. When it is not (transition
window), the resolver's no-candidate path applies instead: it serves the
still-present source loudly, or returns null with a loud issue if neither a bundle
nor a source exists. See the resolver's existence check.

A bad link (the dir is gone, or the manifest is unreadable/unparseable) falls back
to the bundled command and raises a `SyncIssue` that renders on the board row,
rather than taking the app down. A valid manifest that merely omits `dev.start` is
not a bad link (deck itself is that case). This over-delivers on "never
non-working": even the developer's own bad path keeps the app up, but loudly, so
they cannot silently run the bundle while editing source.

## Command-route gating

The `/api/v1/apps/:name/commands/:key` route keeps returning 404 (indistinguishable
from absent) unless the command is genuinely runnable. It performs the **same
directory + manifest validity check** the resolver does, so a broken link hides the
buttons (matching the "linked, bad" row) rather than passing the gate and failing
later (finding #3):

```ts
if (record.managedBy === "user") {
  if (!record.commands?.[key]) return 404;  // unchanged from today: user apps keep record.commands
  // runnable; runs in record.workingDirectory (shell = record.commands[key])
} else {
  if (!isDevMode() || !record.dev?.workingDirectory) return 404;   // prod, or unlinked
  const dir = record.dev.workingDirectory;
  const m = dirExists(dir) ? readDeckManifest(dir) : null;
  if (!m?.dev?.[key]) return 404;           // broken link OR key absent -> 404
  // runnable; runs in dir, reading m.dev[key] live
}
```

Only the mattstack branch switches to the live manifest read. **User apps are
unchanged**: they keep reading `record.commands` exactly as the route does today,
so no user-app row needs a rewrite and no user app risks a regression from the
live-read path. The gate keys on a **valid link plus the key's presence**, not on
`dev.start`, so
deck itself (valid manifest, `dev.deploy` present, no `dev.start`) shows its deploy
button while an unlinked or broken-linked app shows none. Build/deploy for a
mattstack app therefore surface only in dev mode with a valid link, which is why
deck shows deploy on a dev machine but not on a regular user's install. The
dir+manifest validity check is shared with `serveShape` (one helper) so the two
cannot diverge.

## Trigger and selective restart

`rt settings dev-mode <mode>` already writes `mattstack.mode` and hands off the
tray. It gains one more step: poke deck once so managed apps react promptly (like
the existing tray poke), rather than waiting on deck's 2s `isDevMode` cache to
notice on the next incidental read.

- New deck endpoint (`POST /api/v1/apps/managed/reresolve`, or an extension of the
  existing `managed/restart`): recompute each managed app's serve shape and restart
  **only** those whose resolved command differs from what is actually running.
- **Diff target (finding #4):** the command currently written into the app's
  launchd plist, which deck composed and wrote at a path it knows. Deck has **no
  plist-read path today** (`src/services/plist.ts` only renders; `launchd.ts` only
  load/unload/kickstart), so the plan budgets a small new helper that parses
  `ProgramArguments` back out of the app's installed plist. No last-resolved command
  is stored on the record; the installed plist stays the source of truth for "what
  is actually running". A flip-then-flip-back that lands on the same command the
  plist already holds is a no-op, so nothing churns.
- No poll loop: deck is the single supervisor of every managed child, so RT-67's
  park loop (which exists only because launchd runs two uncoordinated daemons) does
  not apply. The 2s cache is the self-heal fallback for the case where the poke did
  not fire.

## Linking a repo (layout-agnostic)

`dev.workingDirectory` is supplied by the developer, never guessed from a layout
convention (another machine may keep repos anywhere). Two front doors to the same
PATCH that writes the single stored path:

- **CLI:** `deck register <path-to-repo>` (reusing deck's existing register flow,
  which already takes an explicit dir and reads the manifest). Deck validates: the
  dir exists, has a `mattstack.deck.json`, and its `name` matches the target app.
- **Board UI (dev mode only):** a per-app "Link source" control. Click reveals an
  inline field; paste the repo path; deck validates server-side and, on success,
  swaps the row to build/deploy. A "Unlink" control clears `dev.workingDirectory`
  and returns the app to bundled. A browser cannot read a real filesystem path from
  a native folder picker, so this is a validated paste-the-path input; the
  server-side dir + manifest + name-match check catches typos immediately.

## rt setup and dev-mode enable

- rt's setup step (`lib/setup/steps/deck.ts`) registers each `includeInBundle` app
  in its prod (bundled) shape, as the shipped install does today.
- `rt settings dev-mode dev` additionally, for each `includeInBundle` app that is
  both linked and present on disk, confirms `dev.workingDirectory` and pokes deck to
  re-resolve. Apps whose source is not linked or not present stay on the bundled
  command (fail-closed) with a one-line surfaced note.
- Regular users never link anything, so they stay fully bundled in prod with no
  repos required.

## Migration

Existing registry rows for the managed apps (board, console, chat, gitq) currently
store the old source-run shape (`command` = a source entry, `workingDirectory` =
the repo, `sourceDirectory` = null, `commands` = build/deploy copied onto the
record). A one-time migration rewrites each managed row to the slim shape:

- Move the repo path into `dev.workingDirectory`.
- Drop the copied `commands` (now read live from the manifest).
- Let prod `command` / data dir become derived.

Deck's own row (`managedBy: "deck"`) already carries `sourceDirectory` = its repo;
the migration moves that into `dev.workingDirectory`, which is what makes deck's own
deploy button surface (finding #5). Going forward, deck's `bootstrapSelf` sets its
`dev.workingDirectory` the same way it sets `sourceDirectory` today, so a fresh
install self-links without a manual `deck register`.

User-app rows (`managedBy: "user"`) are untouched and need no rewrite: the command
route keeps reading their `record.commands`, so the live-manifest-read path applies
only to mattstack apps.

## Rollout sequencing (finding #1)

The migration and the new resolver are safe to land in any order because the
resolver never selects a bundle that isn't installed (`bundleShape` returns null
otherwise) and falls back to the still-present source. Concretely, on a dev machine
where board/console/chat run from source today with no bundle yet installed:

- If the resolver lands first, those apps keep serving their source (loudly, since
  prod mode would flag "bundle not installed; serving source"), never a phantom
  bundle path.
- Bundles become the prod shape only once rt setup has actually installed them and
  `bundleExists` returns true.

The natural, lowest-noise order is still: (1) app repos add the `dev` node +
`includeInBundle`; (2) rt setup registers real bundled commands for these apps;
(3) the migration rewrites existing rows. But correctness does not depend on it. The
migration must not delete an app's currently-working source information until
`dev.workingDirectory` is set, so no app is ever left with neither a bundle nor a
source to fall back to.

This ordering is uptime-critical, not just cosmetic: the resolver's `chosen == null`
branch (no bundle and no valid source) is a genuine app-down state, correctly
fail-closed (deck refuses to stand up a phantom command) but real. The migration
task must therefore carry an **explicit assertion** that `dev.workingDirectory` is
set before it clears any legacy source command, so a future edit cannot reorder the
steps and silently reintroduce the app-down window. The implementation plan pins
this as a named guard in the migration task.

## Error handling

- Missing / malformed manifest at a linked path: treated as a bad link (bundled
  fallback + loud issue), never a crash.
- Bundle path unresolved on a machine that should have it: rt's concern at setup;
  surfaced as a setup issue. The resolver still fails closed.
- Command run failures (build/deploy): reported through the existing command-run
  status machinery; unchanged by this design.

## Testing surface

- **Resolver unit tests:** every row of the fallback matrix, both classes,
  including the bad-link issue path.
- **No phantom bundle:** bundle not installed + source linked resolves to source
  (never a nonexistent path), raising the "bundle not installed" issue in prod;
  neither present resolves to null with a loud issue.
- **Issue lifecycle:** a `dev-link` issue raised on a bad link or missing bundle is
  cleared on the next clean resolve (link fixed or bundle installed).
- **Command-route gating:** user app runnable when its key is declared; mattstack
  app 404s in prod, when unlinked, and on a broken link; runnable when dev + valid
  link + key present; deck-self (no `dev.start`) still runs its declared `deploy`.
- **Live-read, no drift:** editing a manifest's `dev.build` is reflected on the next
  resolve/button without re-registering.
- **Selective restart:** only apps whose resolved command differs from the installed
  launchd `ProgramArguments` restart on a flag flip; a no-op flip restarts nothing.
- **Link validation:** wrong dir, missing manifest, and name mismatch are each
  rejected with a clear error, via both CLI and the board PATCH.
- **Migration:** an old-shape managed row rewrites correctly (including deck's
  `sourceDirectory` -> `dev.workingDirectory`); a user-app row is left alone.

## Affected files (indicative, to be confirmed in the plan)

- deck: `src/registry/deck-manifest.ts` (parse `dev` node), `src/registry/records.ts`
  (record shape), `src/api/server.ts` (resolver, command-route gate, reresolve
  endpoint, link PATCH), `src/api/register-manifest.ts` (link flow), a new
  plist-read helper (`src/services/plist.ts` / `launchd.ts`) for the reresolve diff,
  the board UI, and a registry migration.
- rt: `lib/setup/steps/deck.ts` (prod registration), `commands/settings.ts`
  (dev-mode toggle pokes deck).
- app repos: `mattstack.deck.json` for chat, console, mr-board (add the `dev` node
  and `includeInBundle`).

## Open items carried into the plan

- `includeInBundle` field name is provisional; confirm with fox against the
  CI-bundling manifest work.
- Exact seam for the prod bundle path in deck (derive from deck's own bundle
  location vs. rt supplying it at adopt). Both avoid a hand-authored path.
- Whether the reresolve endpoint is new or an extension of `managed/restart`.
