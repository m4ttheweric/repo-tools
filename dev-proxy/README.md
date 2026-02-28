# dev-proxy

Reverse proxy for running multiple worktree dev servers behind a single Auth0-approved `localhost` port. Routes traffic based on a browser cookie, with WebSocket passthrough for HMR.

## Setup

```bash
bun install
cp dev-proxy.config.example.ts dev-proxy.config.ts
```

Edit `dev-proxy.config.ts` with your worktree paths, upstream ports, and filesystem directories.

## Usage

```bash
bun run orchestrate.ts  # interactive worktree selection → spawns tilt + proxy
bun run dev-proxy.ts    # run the proxy standalone
bun run typecheck       # type-check without emitting
bun test                # run tests
```

## How it works

1. The orchestrator detects all git worktrees and lets you select which to run.
2. Each worktree gets its own Tilt instance with auto-assigned ports for each app.
3. For apps with `proxy` set, a reverse proxy listens on a single Auth0-approved port and routes traffic based on a `wt` cookie.
4. Visiting a worktree path (e.g. `/main`, `/feature`) sets the cookie and redirects to `/`.
5. WebSocket connections (Parcel HMR) are transparently proxied.
6. A floating badge is injected into HTML responses showing which worktree is active, with one-click switching.

## Config

```typescript
import type { DevConfig } from "./lib";

const config: DevConfig = {
  repoDir: "/path/to/your/repo",

  setup: [
    { name: "install", cmd: "cd {repo} && npm install" },
  ],

  apps: [
    {
      name: "api",
      cmd: "cd {repo}/apps/api && PORT={port} npm start",
      deps: ["install"],
      links: ["http://localhost:{port}"],
    },
    {
      name: "web",
      cmd: "cd {repo}/apps/web && PORT={port} npm start",
      proxy: { port: 4001 },
      deps: ["install"],
      links: ["http://localhost:{port}"],
    },
  ],

  tools: [
    { name: "lint", cmd: "cd {repo} && npm run lint" },
  ],
};

export default config;
```

**Placeholders:** `{repo}` = worktree root, `{port}` = this app's port, `{port_<name>}` = another app's port.

**Sections:** `setup` runs once (one-shot), `apps` are long-running servers (`serve_cmd`), `tools` are manual-trigger only.

## Templates

HTML templates live in `templates/` using [Eta](https://eta.js.org/) (`.eta` files). Edit these to customize the injected badge or status page.

| File | Purpose |
|------|---------|
| `badge.eta` | Floating pill + dropdown wrapper |
| `badge-item.eta` | Single worktree row in the dropdown |
| `status.eta` | `/status` page |
