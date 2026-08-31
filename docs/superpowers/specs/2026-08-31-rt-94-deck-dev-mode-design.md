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
  provisional; fox owns `mattstack.deck.json`. board/console/chat set it today.
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

The guiding rule: there is never a non-working state.

```ts
function serveShape(record) {
  if (record.managedBy === "user") {
    // source is always workingDirectory; no bundle, no mode switch
    return { command: record.command, cwd: record.workingDirectory };
  }
  if (isDevMode() && record.dev?.workingDirectory) {
    const dir = record.dev.workingDirectory;
    const m = dirExists(dir) ? readDeckManifest(dir) : null;
    if (!m) {
      // truly broken link: dir gone or manifest unreadable
      addIssue(record.name, {
        source: "dev-link",
        message: `dev source ${dir} missing or invalid; running bundled`,
      });
    } else if (m.dev?.start) {
      return { command: argv(m.dev.start), cwd: dir };
    }
    // manifest present but no dev.start (e.g. deck itself): stay bundled, no issue
  }
  return { command: derivedBundleCommand(record.name), cwd: dataDir(record.name) };
}
```

A valid manifest that simply omits `dev.start` is not a broken link. It means the
app has no source serve shape (deck itself is the case: it refuses to run from
source), so deck stays on the bundled command with no issue raised, while its
`dev.deploy` button still surfaces. Only a missing directory or an unreadable
manifest raises the `dev-link` issue.

| Class | Mode | Dev link | Serves | build / deploy |
| --- | --- | --- | --- | --- |
| user | any | n/a (source = workingDirectory) | its source dir | always shown |
| mattstack | prod | (n/a) | bundle | hidden (refresh only) |
| mattstack | dev | never linked | bundle | hidden ("Link source") |
| mattstack | dev | linked, valid | source | shown |
| mattstack | dev | linked, bad | bundle + loud red issue | hidden ("fix link") |

A bad link (dir gone, no manifest, or no `dev.start`) falls back to the bundled
command and raises a `SyncIssue` that renders on the board row, rather than taking
the app down. This over-delivers on "never non-working": even the developer's own
bad path keeps the app up, but loudly, so they cannot silently run the bundle
while editing source.

## Command-route gating

The `/api/v1/apps/:name/commands/:key` route keeps returning 404 (indistinguishable
from absent) unless the command is genuinely runnable:

```ts
if (record.managedBy === "user") {
  // always runnable; runs in record.workingDirectory
} else {
  if (!isDevMode() || !record.dev?.workingDirectory) return 404;
  // runs in record.dev.workingDirectory, reading dev.build/deploy live from the manifest
}
```

Build/deploy for a mattstack app therefore surface only in dev mode with a valid
link, which is why deck (linked to its own repo) shows deploy on a dev machine but
not on a regular user's install.

## Trigger and selective restart

`rt settings dev-mode <mode>` already writes `mattstack.mode` and hands off the
tray. It gains one more step: poke deck once so managed apps react promptly (like
the existing tray poke), rather than waiting on deck's 2s `isDevMode` cache to
notice on the next incidental read.

- New deck endpoint (`POST /api/v1/apps/managed/reresolve`, or an extension of the
  existing `managed/restart`): recompute each managed app's serve shape and restart
  **only** those whose resolved command differs from what is actually running.
- Diff against the live running command, not merely "has a dev link", so a
  flip-then-flip-back before any restart does not churn.
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

User-app rows (`managedBy: "user"`) are untouched.

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
- **Command-route gating:** user app always runnable; mattstack app 404s in prod
  and when unlinked, runnable when dev + linked.
- **Live-read, no drift:** editing a manifest's `dev.build` is reflected on the next
  resolve/button without re-registering.
- **Selective restart:** only apps whose resolved command changed restart on a flag
  flip; a no-op flip restarts nothing.
- **Link validation:** wrong dir, missing manifest, and name mismatch are each
  rejected with a clear error, via both CLI and the board PATCH.
- **Migration:** an old-shape managed row rewrites correctly; a user-app row is
  left alone.

## Affected files (indicative, to be confirmed in the plan)

- deck: `src/registry/deck-manifest.ts` (parse `dev` node), `src/registry/records.ts`
  (record shape), `src/api/server.ts` (resolver, command-route gate, reresolve
  endpoint, link PATCH), `src/api/register-manifest.ts` (link flow), the board UI, a
  registry migration.
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
