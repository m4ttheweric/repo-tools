# Future Improvements

## Planned Views

| View | Key | Description |
|---|---|---|
| **Log Viewer** | `l` | Streaming logs per-resource from TiltClient watch events |
| **Resource Actions** | `r` | Restart/trigger individual Tilt resources |
| **Port Overview** | `p` | All assigned ports at a glance |
| **Help Bar** | always | Persistent footer showing keyboard shortcuts |
| **Proxy Status** | future | Health, request counts, latency from dev-proxy |

## Architecture Notes

- Follow View/Connector/Hook convention (see `DashboardView.tsx` / `Dashboard.tsx`)
- Views are pure presentational (`*View.tsx`) — testable in `ui/dev.tsx`
- React never calls `Bun.spawn()` — orchestrator passes callbacks
- Each view should have a dev harness state in `ui/dev.tsx`
