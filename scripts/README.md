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

The release workflow's `test-install` recipe (extract the zip → `rt --post-install --non-interactive --team-of-one --no-launch` → `rt daemon install` → `rt verify --ci` → `rt-tray/check-bundle.sh --app`, only when that script's source advertises `--app` support — a static grep, never an execution, since the script has no argument parsing today and any invocation falls through to a full rebuild), runnable locally against a release tag, a `mattstack-<ver>.zip`/`.dmg`, or an installed `mattstack.app`. `release.yml` calls it with the zip as a single positional argument. Refuses to run as a user who already has mattstack registered (without `--no-launch` the post-install would launch a second app) — use it inside the VM walkthrough (`rt-tray/vm/run/walkthrough.sh --scenario headless`), as the smoke user (`rt-tray/vm/run/second-user.sh run`), or on CI. Output lands in `rt-tray/vm/artifacts/cleanroom-<ts>/`. Under `CI=true` a daemon that is not booted is a warning, not a failure. `rt-tray/check-bundle.sh` currently has no `--app` mode (its no-arg mode rebuilds the app in place) — until it gains one, this step is honestly skipped rather than run against the wrong bundle. `--non-interactive --team-of-one --no-launch` are not yet parsed by `rt --post-install` (pre-L1) and are currently inert.

```sh
scripts/e2e-cleanroom.sh --tag v2.8.0
scripts/e2e-cleanroom.sh ~/Downloads/mattstack-2.8.0.zip --home "$(mktemp -d)"
scripts/e2e-cleanroom.sh --artifact ~/Downloads/mattstack-2.8.0.dmg --home "$(mktemp -d)"
```
