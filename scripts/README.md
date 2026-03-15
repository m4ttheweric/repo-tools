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
