# @mattstack/settings-kit

Embed a viewable, editable mattstack settings surface in any app. Two halves,
both thin: a framework-neutral server handler over `@mattstack/rt-client`,
and headless React hooks — you bring the UI.

## Server

Mount early in your fetch handler; `null` means "not mine, fall through":

```ts
import { settingsHandler } from "@mattstack/settings-kit/server";

// Bun.serve / hand-rolled router:
const settingsRes = await settingsHandler(req);
if (settingsRes) return settingsRes;

// Hono:
app.all("/api/settings/*", async (c) => (await settingsHandler(c.req.raw)) ?? c.notFound());
```

Routes: `GET {base}/defs?prefix=board.`, `GET {base}/explain/{key}`,
`POST {base}/set`. Writes are refused for non-local Hosts by default; pass
`allowWrite` with your own predicate when your server knows the real peer
address (and always when the app has any non-local exposure). Secret keys
never put values on the wire; composite (object/array) and unmigrated keys
are read-only through this surface.

## React

```tsx
import { useSettingsScope, useSettingKey } from "@mattstack/settings-kit/react";

const { defs, loading } = useSettingsScope("board.");
const key = useSettingKey("board.title");
// key.rows            — layer stack with provenance
// key.stage(scope, v) — stage an edit at one scope
// key.apply()         — write through the resolver; false + key.applyError on refusal
```

Hooks return state and actions only. Scope semantics are the resolver's:
`machine` writes apply immediately; `user`/`team` writes land in the home
repo's working copy and are local until committed and pushed.
