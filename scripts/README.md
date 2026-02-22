# scripts

Standalone CLI tools. Run directly with `node`, `swift`, or `sh`.

## build-select.mjs

Interactive TUI for selecting which monorepo packages to build with turbo. Tracks recently built packages and sorts them to the top.

```
node scripts/build-select.mjs
```

Expects to be run from the monorepo root (reads `pnpm-workspace.yaml`).

## clear-stuck-reviews.mjs

Fixes Cursor's "stuck review" state where the editor thinks there are pending file reviews that can't be dismissed. Scans `chatEditingSessions`, backs up state, and clears unresolved entries.

```
node scripts/clear-stuck-reviews.mjs
```

Cursor needs to be closed before running (the tool will offer to quit it for you).

## cursor-dual-account.mjs

Manages switching between multiple Cursor accounts/profiles.

## check-circular-deps.sh

Checks for circular dependencies using `madge` (installed globally: `npm install -g madge`). Run from the monorepo root. With no arguments it reads staged files from git. Pass specific files to check those instead. Also called automatically by the `pre-push` hook.

```
./scripts/check-circular-deps.sh
./scripts/check-circular-deps.sh apps/backend/src/types/OverviewData/querySelectors.ts apps/backend/src/types/OverviewData/contactExtraction.ts
```

Exits non-zero if any circular dependencies are found.

## set-app-icon.swift / tint-icon.swift

macOS utilities for customizing app icons. `tint-icon.swift` applies a color tint to an icon image, `set-app-icon.swift` applies it to an app bundle.

```
swift scripts/tint-icon.swift <input> <output> <color>
swift scripts/set-app-icon.swift <app-path> <icon-path>
```
