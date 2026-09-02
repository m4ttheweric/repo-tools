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

The release workflow's `test-install` recipe: extract the zip → stamp `com.apple.quarantine` and assert Gatekeeper accepts the app the way a browser download would → `rt --post-install --non-interactive --team-of-one --no-launch` → `rt daemon install` → `rt verify --ci` → `rt-tray/check-bundle.sh --app`. Runnable locally against a release tag, a `mattstack-<ver>.zip`/`.dmg`, or an installed `mattstack.app`; `release.yml` calls it with the zip as a single positional argument.

The Gatekeeper assertion is conditional: where the xattr cannot be written, the run prints `Gatekeeper path NOT exercised` and carries on rather than failing, so a green run is not by itself proof that Gatekeeper was tested — read the line.

Refuses to run as a user who already has mattstack registered (without `--no-launch` the post-install would launch a second app) — use it inside the VM walkthrough (`rt-tray/vm/run/walkthrough.sh --scenario headless`), as the smoke user (`rt-tray/vm/run/second-user.sh run`), or on CI. Output lands in `rt-tray/vm/artifacts/cleanroom-<ts>/`. Under `CI=true` a daemon that is not booted is a warning, not a failure.

`rt-tray/check-bundle.sh --app <bundle>` asserts an existing bundle without rebuilding (the no-arg mode rebuilds both flavors in place). Support for it is probed by grepping the script rather than by running it: a checkout old enough to lack `--app` falls through to `./build.sh release && ./build.sh dev` on *any* invocation, `--help` included, so probing by execution would itself clobber the working tree this guards.

```sh
scripts/e2e-cleanroom.sh --tag v2.8.0
scripts/e2e-cleanroom.sh ~/Downloads/mattstack-2.8.0.zip --home "$(mktemp -d)"
scripts/e2e-cleanroom.sh --artifact ~/Downloads/mattstack-2.8.0.dmg --home "$(mktemp -d)"
```

## fetch-deps.sh

Fetches and sha256-verifies rt-tray's bundled third-party helper tools (Sparkle, plus every `Contents/Helpers` binary — jq, bun, node, gh, glab, gitq, age-keygen, sops, fast-browser) per `rt-tray/deps.lock`.

## release/

The mattstack.app release pipeline. Run in this order: `make-zip.sh` → `make-dmg.sh` → `notarize.sh` (each artifact) → `appcast.sh`. `marketplace.sh` is independent of all four — it publishes no build artifact — and the workflow runs it first, before the build.

- `make-zip.sh <app> <out.zip>` — the Sparkle update enclosure (`ditto -c -k --sequesterRsrc --keepParent`).
- `make-dmg.sh <app> <out.dmg> [signing-identity]` — the first-install APFS/LZFSE disk image with a drag-to-Applications symlink.
- `notarize.sh <path.app|path.dmg>` — submits to Apple's notary service, staples, and validates; orchestrator-only, needs `APPLE_ID`/`APPLE_ID_PASSWORD`/`APPLE_TEAM_ID`.
- `appcast.sh <archives-dir> <tag>` — generates the signed Sparkle appcast (with deltas against prior releases) from the zip(s) in `<archives-dir>`; needs `SPARKLE_ED_KEY`.
- `marketplace.sh [--refresh] [--dry-run] [<source-dir>]` — publishes `marketplace/` to `m4ttstack/mattstack-marketplace`, the Claude Code plugin catalog `plugins.install` adds on every machine rt sets up. The published repo is wholly generated: its tree is replaced by the staged one each run, so an edit made there survives until the next release. Needs `MARKETPLACE_TOKEN` only when the catalog actually changed. `--refresh` re-resolves each plugin's pinned `ref` to its current head and rewrites `marketplace/marketplace.json` for review; bumping a pin is a commit here, never an implicit follow-the-branch.
