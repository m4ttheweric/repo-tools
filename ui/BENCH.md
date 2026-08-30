# rt-ui bench

Measured with `scripts/bench-rt-ui.py` on the machine named below, 120x40 pty,
`rt-ui prompt` with a two-option select. Re-run after any change to
`cmd/rt-ui` or `internal/prompt`.

| date | stack | machine | first-paint ms (min / median / max) |
|---|---|---|---|
| 2026-08-30 | bubbletea v2.0.9, lipgloss v2.0.6, huh v2.0.3 | Matthews-MacBook-Pro.local, Apple M5 Max | 21 / 34 / 53 |

Budget from the spec: median under 40 ms. Spike baseline (bubbletea v1.3.10,
throwaway board, not this binary): 22 / 24 ms.
