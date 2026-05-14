# Runner Cloudflare Tunnel

Publish each `rt runner` lane's canonical port to the public internet through a single Cloudflare tunnel. Toggle per lane from inside the runner.

## Prerequisites

- `cloudflared` installed and logged in (`cloudflared tunnel login`).
- An existing Cloudflare tunnel (`cloudflared tunnel create <my-tunnel>`).
- A wildcard CNAME on your apex domain pointing at the tunnel:
  ```
  cloudflared tunnel route dns <my-tunnel> "*.<your-domain>"
  ```
  Cloudflare DNS specific records win over the wildcard, so existing subdomains keep working.

## One-time setup (per machine)

Inside `rt runner`, press `[u][s]`. The setup popup prompts for:
- Tunnel (lists `cloudflared tunnel list` output).
- Base domain (e.g. `m4tthew.dev`).
- Hostname prefix (default `p`, empty for pure-numeric like `4000.m4tthew.dev`).

Settings persist to `~/.rt/tunnels/config.json`. The same config serves every runner board on the machine.

You can re-run `rt pick-tunnel` from a shell at any time to swap tunnels or change the domain.

## Daily usage

From inside the runner:

| Keys | Action |
|---|---|
| `[u][t]` | Toggle publishing for the focused lane |
| `[u][a]` | Toggle publishing for all lanes |
| `[u][s]` | Re-run setup (change tunnel/domain) |
| `[u][c]` | Copy the focused lane's public URL to clipboard |
| `[u][esc]` | Leave tunnel scope |

A `🌐 p<port>.<domain>` line appears on each lane card when its tunnel is live.

Tunnels persist across runner restarts — the next `rt runner` invocation re-publishes whatever you had on.

## How it works

The daemon spawns a single `cloudflared` child per runner board. When you toggle a lane, the daemon rewrites a generated ingress config at `~/.rt/tunnels/runtime-<board>.yml` and sends SIGHUP — cloudflared reloads without dropping connections to other lanes.

Closing the runner board stops its `cloudflared` child; other boards' tunnels keep running.

## Troubleshooting

- **"cloudflared not found on PATH"** — install it (`brew install cloudflared`).
- **"cloudflared tunnel list failed"** — log in (`cloudflared tunnel login`).
- **"no tunnel configured"** — run setup first via `[u][s]`.
- **URLs resolve but return 502** — the lane has tunnel on but no upstream service running on `localhost:<port>`. Start the lane's service first.
- **URLs fail to resolve** — check that `*.<your-domain>` CNAME exists in Cloudflare DNS.
