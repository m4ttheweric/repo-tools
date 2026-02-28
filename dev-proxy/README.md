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
bun start        # run the proxy
bun dev          # run with --watch (auto-restart on file changes)
bun run typecheck # type-check without emitting
```

## How it works

1. The proxy listens on a single port (e.g. `4001`) that Auth0 recognizes as a valid callback origin.
2. Each worktree's dev server runs on its own port (e.g. `52001`, `52002`).
3. Visiting `/-/main` or `/-/feature` sets a `wt` cookie and redirects to `/`.
4. All subsequent requests are routed to the upstream matching the cookie value.
5. WebSocket connections (Parcel HMR) are transparently proxied.
6. A floating badge is injected into HTML responses showing which worktree is active, with one-click switching.

## Config

```typescript
import type { ProxyConfig } from "./dev-proxy";

const config: ProxyConfig = {
  port: 4001,
  worktrees: [
    {
      path: "/-/main",       // URL path to set this worktree active
      upstream: 52001,        // dev server port
      dir: "/path/to/repo",  // optional: filesystem path (enables branch display)
    },
    {
      path: "/-/feature",
      upstream: 52002,
      dir: "/path/to/repo-two",
    },
  ],
};

export default config;
```

## Templates

HTML templates live in `templates/` using [Eta](https://eta.js.org/) (`.eta` files). Edit these to customize the injected badge or status page.

| File | Purpose |
|------|---------|
| `badge.eta` | Floating pill + dropdown wrapper |
| `badge-item.eta` | Single worktree row in the dropdown |
| `status.eta` | `/status` page |
