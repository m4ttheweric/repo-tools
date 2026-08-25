# rt chat viewer — design reference

The approved mockups for plan 2 (`docs/superpowers/plans/2026-08-23-rt-chat-viewer.md`),
kept here until the viewer repo exists; plan 2 Task 1 moves them to that repo's `design/`.

Canvas (editable, hosted): https://claude.ai/code/artifact/933b24c5-9edd-4c70-9930-f5afbf14c9a9

| file | what it is |
| --- | --- |
| `artboards/*.dc.html` | the design source — `Main`, `DaemonDown`, `DirectMessage` (Matt inside an agent↔agent DM), `Phone`, `PhoneRooms`, `Roster` (the AIM-style buddy list), `Indicators` |
| `canvas.json` | layout and the three notes (identity contract, what was matched, the laws) |
| `build.py` | regenerates the artboards from one shared CSS block; edit it, not the outputs |

Every value is lifted from console, not eyeballed: palette, grid and `@font-face` from
`src/app/styles/tokyo-theme.css`; font sizes, spacing, radii from
`src/ui/design-system/app-theme.ts`; rail 68px, header 64px, page bar 64px with the 26px
title from `RailShell` + `ConsoleChrome`; row anatomy, 28px action icons and badge wash from
`RunRow.tsx`. The artboards load JetBrains Mono from Google Fonts because the canvas is
hosted; the app uses the vendored woff2.

Deliberate departures: phone controls are 44px (the hit-target floor at 375px); status dots
are 8px, not the 6px health dots, because they carry the page's main signal; the mention badge
uses accent shade 7 in light and bg-on-accent in dark so it passes contrast at 10px.

Revised 2026-08-25 for the presence design (`docs/superpowers/specs/2026-08-24-rt-chat-presence-design.md`):
the third column is the fleet buddy roster (listening/idle/deaf/offline, away messages, room tags,
per-session buddies), the rail gains a DIRECT section, the page bar counts the fleet and shows the
room's wake mode, and the picker offers DM-instead for buddies outside the room.

Rooms, handles and paths are the shape of this machine's worktree pool; the conversations are
illustrative. Two drawn affordances are not in plan 2 and are marked as such there: the
`not joined` badge on a room (needs an all-rooms source the store does not have yet) and
focusing a herdr pane from a member row (no route addresses a pane by id).
