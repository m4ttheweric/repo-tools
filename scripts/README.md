# scripts

Standalone CLI tools. MCP servers live in `mcp-servers/`.

## check-circular-deps.sh

Checks for circular dependencies using `madge` (install globally: `npm install -g madge`). Run from the monorepo root. With no arguments it reads staged files from git; pass specific files to check those instead. Also called automatically by the `pre-push` hook.

```sh
./scripts/check-circular-deps.sh
./scripts/check-circular-deps.sh apps/backend/src/types/foo.ts
```

## cursor-dual-account.mjs

Manages switching between multiple Cursor accounts/profiles.

```sh
node scripts/cursor-dual-account.mjs
```

## set-app-icon.swift / tint-icon.swift

macOS utilities for customizing app icons. `tint-icon.swift` applies a color tint to an icon image; `set-app-icon.swift` applies it to an app bundle.

```sh
swift scripts/tint-icon.swift <input> <output> <color>
swift scripts/set-app-icon.swift <app-path> <icon-path>
```

## e2e-cleanroom.sh

The release workflow's `test-install` recipe (extract the zip → `rt --post-install --non-interactive --team-of-one --no-launch` → `rt daemon install` → `rt verify --ci` → `rt-tray/check-bundle.sh --app` when present), runnable locally against a release tag, a `mattstack-<ver>.zip`/`.dmg`, or an installed `mattstack.app`. `release.yml` calls it with the zip as a single positional argument. Refuses to run as a user who already has mattstack registered (without `--no-launch` the post-install would launch a second app) — use it inside the VM walkthrough (`rt-tray/vm/run/walkthrough.sh --scenario headless`), as the smoke user (`rt-tray/vm/run/second-user.sh run`), or on CI. Output lands in `rt-tray/vm/artifacts/cleanroom-<ts>/`. Under `CI=true` a daemon that is not booted is a warning, not a failure.

```sh
scripts/e2e-cleanroom.sh --tag v2.8.0
scripts/e2e-cleanroom.sh ~/Downloads/mattstack-2.8.0.zip --home "$(mktemp -d)"
scripts/e2e-cleanroom.sh --artifact ~/Downloads/mattstack-2.8.0.dmg --home "$(mktemp -d)"
```
